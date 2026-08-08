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
    sleep,
    startLoggedProcess,
    waitForExit,
    waitForHttp,
    waitUntil
} = require('./integration-test-utils.cjs');

const SOURCE_DB = path.resolve(process.env.PLC_TEST_SOURCE_DB || path.join(BACKEND_DIR, 'data', 'factory.db'));
const SIMULATOR_DIR = path.resolve(
    process.env.PLC_SIMULATOR_DIR || path.join(REPO_DIR, '..', 'PLC仿真调试器')
);
const PYTHON = process.env.PYTHON || 'python';
const MODBUS_ENGINE = path.join(SIMULATOR_DIR, 'modbus_engine.py');
const OPCUA_ENGINE = path.join(SIMULATOR_DIR, 'opcua_engine.py');
const MODBUS_DEVICE = 'Furnace_01';
const OPCUA_DEVICE = 'Furnace_02';
const MODBUS_POINTS = {
    temperature: { node: 'HR40001', area: 'holding', offset: 0, type: 'word' },
    pressure: { node: 'HR40002', area: 'holding', offset: 1, type: 'real' },
    running: { node: 'C00001', area: 'coil', offset: 0, type: 'bool' }
};
const OPCUA_POINTS = {
    temperature: { node: 'ns=2;s=Factory.Furnace02.Temperature', type: 'real' },
    running: { node: 'ns=2;s=Factory.Furnace02.Running', type: 'bool' }
};
const SHUTDOWN_TOKEN = `plc-simulator-protocol-${process.pid}-${Date.now()}`;

let runDirectory;
let backend;
let backendOrigin;
let modbusSimulator;
let opcuaSimulator;
let socket;

function configureDatabase(filename, modbusPort, opcuaPort) {
    const db = new Database(filename);
    try {
        const deviceColumns = new Set(db.prepare('PRAGMA table_info(devices)').all().map(column => column.name));
        if (!deviceColumns.has('plc_options')) db.exec("ALTER TABLE devices ADD COLUMN plc_options TEXT DEFAULT '{}'");
        db.transaction(() => {
            db.prepare("INSERT INTO settings (key, value) VALUES ('data_mode', 'integrated_plc') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
            db.prepare('UPDATE devices SET plc_enabled=0').run();
            db.prepare(`UPDATE devices SET
                plc_enabled=1, plc_protocol='MODBUS_TCP', plc_ip='127.0.0.1', plc_port=?,
                plc_timeout=3000, plc_retry_interval=500, plc_max_retries=0,
                plc_options=? WHERE id=?`).run(
                modbusPort,
                JSON.stringify({ unitId: 1, addressBase: 1, byteOrder: 'BE', wordOrder: 'BE' }),
                MODBUS_DEVICE
            );
            db.prepare(`UPDATE devices SET
                plc_enabled=1, plc_protocol='OPC_UA', plc_ip='127.0.0.1', plc_port=?,
                plc_timeout=5000, plc_retry_interval=500, plc_max_retries=0,
                plc_options=? WHERE id=?`).run(
                opcuaPort,
                JSON.stringify({
                    endpointPath: '/UA/PLC-Simulator',
                    securityMode: 'None',
                    securityPolicy: 'None',
                    trustServerCertificate: false
                }),
                OPCUA_DEVICE
            );
            db.prepare('DELETE FROM data_points').run();
            const insert = db.prepare(`INSERT INTO data_points (
                device_id, name, label, plc_tag, data_type, unit, category, value_role,
                quality, scale, offset, expression, display_format, sample_interval_ms,
                access_type, point_kind, alarm_record_role, alarm_level, alarm_condition
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', 1, 0, '', '', ?, 'READ', 'normal', '', 'WARNING', '=1')`);
            insert.run(MODBUS_DEVICE, 'modbus_temperature', 'Modbus 温度', MODBUS_POINTS.temperature.node, 'WORD', '℃', 'analog', 'actual_temp', 250);
            insert.run(MODBUS_DEVICE, 'modbus_pressure', 'Modbus 压力', MODBUS_POINTS.pressure.node, 'REAL', 'bar', 'analog', 'pressure', 250);
            insert.run(MODBUS_DEVICE, 'modbus_running', 'Modbus 运行', MODBUS_POINTS.running.node, 'BOOL', '', 'status', 'running', 500);
            insert.run(OPCUA_DEVICE, 'opc_temperature', 'OPC 温度', OPCUA_POINTS.temperature.node, 'REAL', '℃', 'analog', 'actual_temp', 250);
            insert.run(OPCUA_DEVICE, 'opc_running', 'OPC 运行', OPCUA_POINTS.running.node, 'BOOL', '', 'status', 'running', 500);
        })();
        if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('集成测试数据库完整性检查失败');
    } finally {
        db.close();
    }
}

function startSimulator(engine, protocolPort, controlPort, logName, extra = []) {
    const protocol = engine === MODBUS_ENGINE ? 'MODBUS_TCP' : 'OPC_UA';
    return startLoggedProcess(PYTHON, [
        engine,
        '--bind', '127.0.0.1',
        protocol === 'MODBUS_TCP' ? '--modbus-port' : '--opc-port', String(protocolPort),
        '--control-port', String(controlPort),
        ...extra
    ], {
        cwd: SIMULATOR_DIR,
        env: { ...process.env, PYTHONUTF8: '1' },
        logFile: path.join(runDirectory, logName)
    });
}

async function writeModbus(controlPort, point, value) {
    return requestJson(`http://127.0.0.1:${controlPort}/value`, {
        method: 'POST',
        body: JSON.stringify({ area: point.area, offset: point.offset, type: point.type, value })
    });
}

async function writeOpcUa(controlPort, point, value) {
    return requestJson(`http://127.0.0.1:${controlPort}/value`, {
        method: 'POST',
        body: JSON.stringify({ nodeId: point.node, type: point.type, value })
    });
}

function connectWebSocket(port, frames, statuses) {
    return new Promise((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => {
            client.terminate();
            reject(new Error('WebSocket 连接超时'));
        }, 10000);
        client.once('open', () => {
            clearTimeout(timer);
            client.on('message', raw => {
                try {
                    const message = JSON.parse(String(raw));
                    const entry = { receivedAt: Date.now(), message };
                    if (message.type === 'realtime_frame') frames.push(entry);
                    if (message.type === 'plc_status') statuses.push(entry);
                } catch (error) {
                    // Ignore non-JSON diagnostic frames.
                }
            });
            resolve(client);
        });
        client.once('error', reject);
    });
}

function deviceFrame(frames, deviceId, after = 0) {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
        const entry = frames[index];
        if (entry.receivedAt < after) break;
        if (entry.message?.payload?.devices?.some(device => device.deviceId === deviceId || device.furnace_id === deviceId)) {
            return entry;
        }
    }
    return null;
}

function frameDevice(entry, deviceId) {
    return entry?.message?.payload?.devices?.find(device => device.deviceId === deviceId || device.furnace_id === deviceId);
}

function deviceStatus(entry, deviceId) {
    return entry?.message?.payload?.devices?.find(device => device.deviceId === deviceId);
}

async function stopBackend() {
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
    try { socket?.terminate(); } catch (error) { /* ignore */ }
    socket = null;
    await stopBackend();
    await forceStop(modbusSimulator);
    await forceStop(opcuaSimulator);
    modbusSimulator = null;
    opcuaSimulator = null;
}

async function main() {
    const startedAt = Date.now();
    const frames = [];
    const statuses = [];
    let result;
    try {
        if (!fs.existsSync(MODBUS_ENGINE) || !fs.existsSync(OPCUA_ENGINE)) {
            throw new Error(`仿真器缺少协议引擎：${SIMULATOR_DIR}`);
        }
        runDirectory = createRunDirectory('plc-simulator-protocols');
        const modbusPort = await findFreePort(Number(process.env.MODBUS_TEST_PORT || 502));
        const opcuaPort = await findFreePort(Number(process.env.OPCUA_TEST_PORT || 4840));
        const modbusControlPort = await findFreePort(11502);
        const opcuaControlPort = await findFreePort(14840);
        const backendPort = await findFreePort(3521);
        backendOrigin = `http://127.0.0.1:${backendPort}`;
        const dataDirectory = path.join(runDirectory, 'data');
        const databaseFile = path.join(dataDirectory, 'factory.db');
        const uploadsDirectory = path.join(runDirectory, 'uploads');
        fs.mkdirSync(dataDirectory, { recursive: true });
        fs.mkdirSync(uploadsDirectory, { recursive: true });
        await copySqliteDatabase(SOURCE_DB, databaseFile);
        configureDatabase(databaseFile, modbusPort, opcuaPort);
        fs.writeFileSync(path.join(dataDirectory, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename: databaseFile }, null, 2));

        modbusSimulator = startSimulator(MODBUS_ENGINE, modbusPort, modbusControlPort, 'modbus-simulator.log', ['--unit-id', '1']);
        opcuaSimulator = startSimulator(OPCUA_ENGINE, opcuaPort, opcuaControlPort, 'opcua-simulator.log', [
            '--endpoint-path', '/UA/PLC-Simulator',
            '--namespace-uri', 'urn:heat-treatment:plc-simulator'
        ]);
        await waitForHttp(`http://127.0.0.1:${modbusControlPort}/health`, 30000);
        await waitForHttp(`http://127.0.0.1:${opcuaControlPort}/health`, 30000);
        await writeModbus(modbusControlPort, MODBUS_POINTS.temperature, 1200);
        await writeModbus(modbusControlPort, MODBUS_POINTS.pressure, 12.5);
        await writeModbus(modbusControlPort, MODBUS_POINTS.running, true);
        await writeOpcUa(opcuaControlPort, OPCUA_POINTS.temperature, 860.5);
        await writeOpcUa(opcuaControlPort, OPCUA_POINTS.running, true);

        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(backendPort),
                APP_DATA_DIR: dataDirectory,
                UPLOADS_DIR: uploadsDirectory,
                FRONTEND_DIST: path.resolve(BACKEND_DIR, '..', 'frontend', 'dist'),
                PLC_OFFLINE_AFTER_MS: '2500',
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${backendOrigin}/api/health`, 30000);
        socket = await connectWebSocket(backendPort, frames, statuses);
        await waitUntil(() => statuses.find(entry => deviceStatus(entry, MODBUS_DEVICE)?.status === 'connected'
            && deviceStatus(entry, OPCUA_DEVICE)?.status === 'connected'), 30000, '两种协议初始连接');
        const initialModbus = await waitUntil(() => {
            const entry = deviceFrame(frames, MODBUS_DEVICE);
            const device = frameDevice(entry, MODBUS_DEVICE);
            return device?.analog?.actual_temp === 1200 && device?.quality?.analog?.actual_temp === 'good' ? entry : null;
        }, 15000, 'Modbus 初始值');
        const initialOpcUa = await waitUntil(() => {
            const entry = deviceFrame(frames, OPCUA_DEVICE);
            const device = frameDevice(entry, OPCUA_DEVICE);
            return device?.analog?.actual_temp === 860.5 && device?.quality?.analog?.actual_temp === 'good' ? entry : null;
        }, 15000, 'OPC UA 初始值');

        const modbusLatencies = [];
        const opcuaLatencies = [];
        for (let index = 0; index < 8; index += 1) {
            const modbusValue = 1300 + index;
            const opcuaValue = 870.5 + index;
            const sentAt = Date.now();
            await writeModbus(modbusControlPort, MODBUS_POINTS.temperature, modbusValue);
            await writeOpcUa(opcuaControlPort, OPCUA_POINTS.temperature, opcuaValue);
            const modbusFrame = await waitUntil(() => {
                const device = frameDevice(deviceFrame(frames, MODBUS_DEVICE, sentAt), MODBUS_DEVICE);
                return device?.analog?.actual_temp === modbusValue ? deviceFrame(frames, MODBUS_DEVICE, sentAt) : null;
            }, 5000, `Modbus 连续值 ${modbusValue}`);
            const opcFrame = await waitUntil(() => {
                const device = frameDevice(deviceFrame(frames, OPCUA_DEVICE, sentAt), OPCUA_DEVICE);
                return device?.analog?.actual_temp === opcuaValue ? deviceFrame(frames, OPCUA_DEVICE, sentAt) : null;
            }, 5000, `OPC UA 连续值 ${opcuaValue}`);
            modbusLatencies.push(modbusFrame.receivedAt - sentAt);
            opcuaLatencies.push(opcFrame.receivedAt - sentAt);
            await sleep(100);
        }

        const modbusOutageAt = Date.now();
        await forceStop(modbusSimulator);
        modbusSimulator = null;
        const modbusOffline = await waitUntil(() => statuses.find(entry => entry.receivedAt >= modbusOutageAt
            && deviceStatus(entry, MODBUS_DEVICE)?.status === 'offline'), 10000, 'Modbus 断联离线');
        const opcStillConnected = await waitUntil(() => statuses.find(entry => entry.receivedAt >= modbusOutageAt
            && deviceStatus(entry, OPCUA_DEVICE)?.status === 'connected'), 8000, 'Modbus 断联时 OPC UA 保持连接');

        const modbusRecoveryAt = Date.now();
        modbusSimulator = startSimulator(MODBUS_ENGINE, modbusPort, modbusControlPort, 'modbus-simulator-recovery.log', ['--unit-id', '1']);
        await waitForHttp(`http://127.0.0.1:${modbusControlPort}/health`, 30000);
        await writeModbus(modbusControlPort, MODBUS_POINTS.temperature, 1500);
        const modbusRecovered = await waitUntil(() => {
            const entry = deviceFrame(frames, MODBUS_DEVICE, modbusRecoveryAt);
            const device = frameDevice(entry, MODBUS_DEVICE);
            return device?.analog?.actual_temp === 1500 && device?.quality?.analog?.actual_temp === 'good' ? entry : null;
        }, 15000, 'Modbus 重连恢复');

        const opcOutageAt = Date.now();
        await forceStop(opcuaSimulator);
        opcuaSimulator = null;
        const opcOffline = await waitUntil(() => statuses.find(entry => entry.receivedAt >= opcOutageAt
            && deviceStatus(entry, OPCUA_DEVICE)?.status === 'offline'), 12000, 'OPC UA 断联离线');
        const modbusStillConnected = await waitUntil(() => statuses.find(entry => entry.receivedAt >= opcOutageAt
            && deviceStatus(entry, MODBUS_DEVICE)?.status === 'connected'), 8000, 'OPC UA 断联时 Modbus 保持连接');

        const opcRecoveryAt = Date.now();
        opcuaSimulator = startSimulator(OPCUA_ENGINE, opcuaPort, opcuaControlPort, 'opcua-simulator-recovery.log', [
            '--endpoint-path', '/UA/PLC-Simulator',
            '--namespace-uri', 'urn:heat-treatment:plc-simulator'
        ]);
        await waitForHttp(`http://127.0.0.1:${opcuaControlPort}/health`, 30000);
        await writeOpcUa(opcuaControlPort, OPCUA_POINTS.temperature, 900.5);
        const opcRecovered = await waitUntil(() => {
            const entry = deviceFrame(frames, OPCUA_DEVICE, opcRecoveryAt);
            const device = frameDevice(entry, OPCUA_DEVICE);
            return device?.analog?.actual_temp === 900.5 && device?.quality?.analog?.actual_temp === 'good' ? entry : null;
        }, 20000, 'OPC UA 重连恢复');

        const metrics = {
            initial: { modbusAt: initialModbus.receivedAt, opcuaAt: initialOpcUa.receivedAt },
            modbusLatencyMs: { samples: modbusLatencies.length, p95: percentile(modbusLatencies, 95) },
            opcuaLatencyMs: { samples: opcuaLatencies.length, p95: percentile(opcuaLatencies, 95) },
            outage: {
                modbusOfflineAfterMs: modbusOffline.receivedAt - modbusOutageAt,
                opcuaOfflineAfterMs: opcOffline.receivedAt - opcOutageAt
            },
            recovery: {
                modbusGoodAfterMs: modbusRecovered.receivedAt - modbusRecoveryAt,
                opcuaGoodAfterMs: opcRecovered.receivedAt - opcRecoveryAt
            }
        };
        const checks = {
            modbusInitialValue: Boolean(initialModbus),
            opcuaInitialValue: Boolean(initialOpcUa),
            modbusContinuousReads: modbusLatencies.length === 8,
            opcuaContinuousReads: opcuaLatencies.length === 8,
            modbusP95Under5000Ms: metrics.modbusLatencyMs.p95 <= 5000,
            opcuaP95Under10000Ms: metrics.opcuaLatencyMs.p95 <= 10000,
            modbusOfflineUnder10000Ms: metrics.outage.modbusOfflineAfterMs <= 10000,
            opcuaOfflineUnder12000Ms: metrics.outage.opcuaOfflineAfterMs <= 12000,
            protocolIsolationDuringModbusOutage: Boolean(opcStillConnected),
            protocolIsolationDuringOpcUaOutage: Boolean(modbusStillConnected),
            modbusRecoveryGood: Boolean(modbusRecovered),
            opcuaRecoveryGood: Boolean(opcRecovered)
        };
        result = {
            success: Object.values(checks).every(Boolean),
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            simulatorDirectory: SIMULATOR_DIR,
            endpoints: {
                modbus: `127.0.0.1:${modbusPort}`,
                opcua: `opc.tcp://127.0.0.1:${opcuaPort}/UA/PLC-Simulator`,
                backend: backendOrigin
            },
            metrics,
            checks
        };
        if (!result.success) throw new Error('PLC 仿真器协议集成检查未全部通过');
    } catch (error) {
        result = {
            ...(result || {}),
            success: false,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message || String(error),
            diagnostics: {
                statuses: statuses.slice(-12),
                frames: frames.slice(-12)
            }
        };
        process.exitCode = 1;
    } finally {
        await cleanup();
        if (runDirectory) {
            const resultFile = path.join(runDirectory, 'result.json');
            fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
            console.log(JSON.stringify({ resultFile, ...result }, null, 2));
        } else {
            console.log(JSON.stringify(result, null, 2));
        }
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
