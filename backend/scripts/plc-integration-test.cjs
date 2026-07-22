const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const {
    BACKEND_DIR,
    REPO_DIR,
    copySqliteDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    percentile,
    requestJson,
    round,
    sleep,
    startLoggedProcess,
    waitForExit,
    waitForHttp,
    waitUntil
} = require('./integration-test-utils.cjs');

const SOURCE_DB = path.resolve(process.env.PLC_TEST_SOURCE_DB || path.join(BACKEND_DIR, 'data', 'factory.db'));
const SIMULATOR_DIR = path.resolve(
    process.env.PLC_SIMULATOR_DIR || path.join(REPO_DIR, '..', '排产', 'PLC仿真调试器')
);
const PYTHON = process.env.PYTHON || 'python';
const STABILITY_MS = Math.max(10000, Number(process.env.PLC_STABILITY_MS || 45000));
const LATENCY_SAMPLES = Math.max(5, Number(process.env.PLC_LATENCY_SAMPLES || 24));
const DEVICE_ID = 'Furnace_01';
const SHUTDOWN_TOKEN = `plc-test-${process.pid}-${Date.now()}`;

let simulator = null;
let backend = null;
let socket = null;
let runDirectory = null;
let backendOrigin = null;

function configureTestDatabase(filename, s7Port) {
    const db = new Database(filename);
    try {
        const configure = db.transaction(() => {
            db.prepare("INSERT INTO settings (key, value) VALUES ('data_mode', 'integrated_plc') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
            db.prepare('UPDATE devices SET plc_enabled=0').run();
            db.prepare(`UPDATE devices SET
                plc_enabled=1, plc_protocol='S7', plc_ip='127.0.0.1', plc_port=?,
                plc_rack=0, plc_slot=1, plc_timeout=3000, plc_retry_interval=1000,
                plc_max_retries=0 WHERE id=?`).run(s7Port, DEVICE_ID);
            db.prepare('DELETE FROM data_points').run();
            const insert = db.prepare(`INSERT INTO data_points (
                device_id, name, label, plc_tag, data_type, unit, category, value_role,
                quality, scale, offset, expression, display_format, sample_interval_ms,
                access_type, point_kind, alarm_record_role, alarm_level, alarm_condition
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', 1, 0, '', '', ?, 'READ', 'normal', '', 'WARNING', '=1')`);
            insert.run(DEVICE_ID, 'actual_temp', 'Test temperature', 'DB1.DBW0', 'WORD', 'C', 'analog', 'actual_temp', 250);
            insert.run(DEVICE_ID, 'running', 'Test running', 'DB1.DBX2.0', 'BOOL', '', 'status', 'running', 500);
            insert.run(DEVICE_ID, 'pressure', 'Test pressure', 'DB1.DBD4', 'REAL', 'bar', 'analog', 'pressure', 1000);
        });
        configure();
        const integrity = db.pragma('quick_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`Test database quick_check failed: ${integrity}`);
    } finally {
        db.close();
    }
}

function startSimulator(s7Port, controlPort, logName) {
    const engine = path.join(SIMULATOR_DIR, 'snap7_engine.py');
    const dll = path.join(SIMULATOR_DIR, 'runtime', 'snap7.dll');
    if (!fs.existsSync(engine) || !fs.existsSync(dll)) {
        throw new Error(`PLC simulator is incomplete: ${SIMULATOR_DIR}`);
    }
    return startLoggedProcess(PYTHON, [
        engine,
        '--bind', '127.0.0.1',
        '--s7-port', String(s7Port),
        '--control-port', String(controlPort),
        '--db', '1:4096'
    ], {
        cwd: SIMULATOR_DIR,
        env: { ...process.env, SNAP7_DLL: dll },
        logFile: path.join(runDirectory, logName)
    });
}

async function writePoint(controlPort, offset, type, value, bit = 0) {
    return requestJson(`http://127.0.0.1:${controlPort}/value`, {
        method: 'POST',
        body: JSON.stringify({ area: 'DB', db: 1, offset, type, bit, value })
    });
}

async function seedSimulator(controlPort, wordValue) {
    await writePoint(controlPort, 0, 'word', wordValue);
    await writePoint(controlPort, 2, 'bool', true, 0);
    await writePoint(controlPort, 4, 'real', 12.5);
}

function frameDevice(entry) {
    return entry.message?.payload?.devices?.find(device => device.furnace_id === DEVICE_ID);
}

function deviceStatus(entry) {
    return entry.message?.payload?.devices?.find(device => device.deviceId === DEVICE_ID);
}

function connectWebSocket(port, frames, statuses) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('WebSocket connection timed out'));
        }, 10000);
        ws.once('open', () => {
            clearTimeout(timer);
            resolve(ws);
        });
        ws.once('error', reject);
        ws.on('message', raw => {
            let message;
            try { message = JSON.parse(String(raw)); } catch (error) { return; }
            const entry = { receivedAt: Date.now(), message };
            if (message.type === 'realtime_frame') frames.push(entry);
            if (message.type === 'plc_status') statuses.push(entry);
        });
    });
}

async function gracefulStopBackend() {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    try {
        await requestJson(`${backendOrigin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
        await waitForExit(backend, 15000);
    } catch (error) {
        await forceStop(backend);
    }
}

async function cleanup() {
    if (socket) {
        try { socket.terminate(); } catch (error) { /* ignore */ }
        socket = null;
    }
    await gracefulStopBackend();
    await forceStop(simulator);
}

async function main() {
    runDirectory = createRunDirectory('plc-integration');
    const resultFile = path.join(runDirectory, 'result.json');
    const startedAt = Date.now();
    const frames = [];
    const statuses = [];
    let result;

    try {
        if (!fs.existsSync(SOURCE_DB)) throw new Error(`Source SQLite database not found: ${SOURCE_DB}`);
        const s7Port = await findFreePort(1102);
        const controlPort = await findFreePort(11020);
        const backendPort = await findFreePort(3101);
        backendOrigin = `http://127.0.0.1:${backendPort}`;

        const dataDir = path.join(runDirectory, 'data');
        const databaseFile = path.join(dataDir, 'factory.db');
        fs.mkdirSync(dataDir, { recursive: true });
        await copySqliteDatabase(SOURCE_DB, databaseFile);
        configureTestDatabase(databaseFile, s7Port);
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2));

        simulator = startSimulator(s7Port, controlPort, 'simulator-before-outage.log');
        await waitForHttp(`http://127.0.0.1:${controlPort}/health`, 15000);
        await seedSimulator(controlPort, 1200);

        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(backendPort),
                APP_DATA_DIR: dataDir,
                PLC_OFFLINE_AFTER_MS: '4000',
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
                DB_BACKUP_RETENTION: '10',
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${backendOrigin}/api/health`, 30000);
        socket = await connectWebSocket(backendPort, frames, statuses);

        await waitUntil(() => statuses.find(entry => {
            const status = deviceStatus(entry);
            return status?.status === 'connected';
        }), 15000, 'initial PLC connected status');
        await waitUntil(() => frames.find(entry => {
            const device = frameDevice(entry);
            return device?.analog?.actual_temp === 1200 && device?.quality?.analog?.actual_temp === 'good';
        }), 10000, 'initial good realtime value');

        const latencyMs = [];
        for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
            const value = 1300 + index;
            const sentAt = Date.now();
            await writePoint(controlPort, 0, 'word', value);
            const observed = await waitUntil(() => frames.find(entry => {
                if (entry.receivedAt < sentAt) return false;
                const device = frameDevice(entry);
                return device?.analog?.actual_temp === value && device?.quality?.analog?.actual_temp === 'good';
            }), 4000, `PLC value ${value} on WebSocket`);
            latencyMs.push(observed.receivedAt - sentAt);
            await sleep(80);
        }

        const stabilityStartedAt = Date.now();
        const writeErrors = [];
        let stabilityValue = 2000;
        let writeChain = Promise.resolve();
        const writer = setInterval(() => {
            stabilityValue += 1;
            const value = stabilityValue;
            writeChain = writeChain
                .then(() => writePoint(controlPort, 0, 'word', value))
                .catch(error => writeErrors.push(error.message));
        }, 400);
        await sleep(STABILITY_MS);
        clearInterval(writer);
        await writeChain;
        const stabilityEndedAt = Date.now();
        if (writeErrors.length) throw new Error(`Stability writer failed: ${writeErrors[0]}`);

        const stableFrames = frames.filter(entry => entry.receivedAt >= stabilityStartedAt && entry.receivedAt <= stabilityEndedAt);
        const frameGaps = stableFrames.slice(1).map((entry, index) => entry.receivedAt - stableFrames[index].receivedAt);
        const expectedMinimumFrames = Math.floor(STABILITY_MS / 600);

        const outageAt = Date.now();
        await forceStop(simulator);
        simulator = null;
        const badFrame = await waitUntil(() => frames.find(entry => {
            if (entry.receivedAt < outageAt) return false;
            return frameDevice(entry)?.quality?.analog?.actual_temp === 'bad';
        }), 8000, 'bad quality after PLC outage');
        const offlineStatus = await waitUntil(() => statuses.find(entry => {
            if (entry.receivedAt < outageAt) return false;
            return deviceStatus(entry)?.status === 'offline';
        }), 12000, 'offline status after PLC outage');

        const restartAt = Date.now();
        simulator = startSimulator(s7Port, controlPort, 'simulator-after-outage.log');
        await waitForHttp(`http://127.0.0.1:${controlPort}/health`, 15000);
        const recoveredValue = 3001;
        await seedSimulator(controlPort, recoveredValue);
        const recoveredFrame = await waitUntil(() => frames.find(entry => {
            if (entry.receivedAt < restartAt) return false;
            const device = frameDevice(entry);
            return device?.analog?.actual_temp === recoveredValue && device?.quality?.analog?.actual_temp === 'good';
        }), 12000, 'first good frame after PLC restart');
        const recoveredStatus = await waitUntil(() => statuses.find(entry => {
            if (entry.receivedAt < restartAt) return false;
            return deviceStatus(entry)?.status === 'connected';
        }), 12000, 'connected status after PLC restart');

        const postRecoveryLatencies = [];
        for (let index = 0; index < 8; index += 1) {
            const value = 3100 + index;
            const sentAt = Date.now();
            await writePoint(controlPort, 0, 'word', value);
            const observed = await waitUntil(() => frames.find(entry => {
                if (entry.receivedAt < sentAt) return false;
                const device = frameDevice(entry);
                return device?.analog?.actual_temp === value && device?.quality?.analog?.actual_temp === 'good';
            }), 4000, `post-recovery PLC value ${value}`);
            postRecoveryLatencies.push(observed.receivedAt - sentAt);
            await sleep(80);
        }

        const metrics = {
            latencyMs: {
                samples: latencyMs.length,
                min: Math.min(...latencyMs),
                p50: percentile(latencyMs, 50),
                p95: percentile(latencyMs, 95),
                max: Math.max(...latencyMs),
                average: round(latencyMs.reduce((sum, value) => sum + value, 0) / latencyMs.length)
            },
            stability: {
                durationMs: stabilityEndedAt - stabilityStartedAt,
                frames: stableFrames.length,
                expectedMinimumFrames,
                maxFrameGapMs: frameGaps.length ? Math.max(...frameGaps) : null,
                p95FrameGapMs: percentile(frameGaps, 95)
            },
            outage: {
                badQualityAfterMs: badFrame.receivedAt - outageAt,
                offlineAfterMs: offlineStatus.receivedAt - outageAt
            },
            recovery: {
                firstGoodFrameAfterMs: recoveredFrame.receivedAt - restartAt,
                connectedAfterMs: recoveredStatus.receivedAt - restartAt,
                postRecoverySamples: postRecoveryLatencies.length,
                postRecoveryP95Ms: percentile(postRecoveryLatencies, 95)
            }
        };
        const checks = {
            latencyP95Under1500Ms: metrics.latencyMs.p95 <= 1500,
            stableFrameCount: stableFrames.length >= expectedMinimumFrames,
            maxFrameGapUnder1500Ms: metrics.stability.maxFrameGapMs !== null && metrics.stability.maxFrameGapMs <= 1500,
            badQualityUnder4000Ms: metrics.outage.badQualityAfterMs <= 4000,
            offlineUnder9000Ms: metrics.outage.offlineAfterMs <= 9000,
            firstGoodFrameUnder10000Ms: metrics.recovery.firstGoodFrameAfterMs <= 10000,
            connectedUnder10000Ms: metrics.recovery.connectedAfterMs <= 10000,
            postRecoveryReadsComplete: postRecoveryLatencies.length === 8
        };
        result = {
            success: Object.values(checks).every(Boolean),
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            sourceDatabase: SOURCE_DB,
            simulatorDirectory: SIMULATOR_DIR,
            endpoints: { s7: `127.0.0.1:${s7Port}`, control: `127.0.0.1:${controlPort}`, backend: backendOrigin },
            points: ['DB1.DBW0/WORD/250ms', 'DB1.DBX2.0/BOOL/500ms', 'DB1.DBD4/REAL/1000ms'],
            metrics,
            checks
        };
        if (!result.success) throw new Error('One or more PLC reliability thresholds failed');
    } catch (error) {
        result = {
            ...(result || {}),
            success: false,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message
        };
        process.exitCode = 1;
    } finally {
        await cleanup();
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ resultFile, ...result }, null, 2));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
