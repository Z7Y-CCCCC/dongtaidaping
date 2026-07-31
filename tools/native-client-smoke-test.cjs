const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const backendDir = path.join(projectDir, 'backend');
const tmpDir = path.join(projectDir, 'tmp');
const port = Number(process.env.NATIVE_SMOKE_PORT || 3421);
const shutdownToken = `native-smoke-${process.pid}-${Date.now()}`;
const backendStdout = path.join(tmpDir, 'native-smoke-backend.out.log');
const backendStderr = path.join(tmpDir, 'native-smoke-backend.err.log');
const unityLog = path.join(tmpDir, 'native-smoke-unity.log');
const unityExe = path.join(
    projectDir,
    'unity-client',
    'Builds',
    'Windows',
    'HeatTreatmentDigitalTwin.exe'
);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForHealth(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch (error) { /* retry */ }
        await wait(300);
    }
    throw new Error(`Backend health timeout: ${url}`);
}

async function waitForUnityReady(child, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const text = fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
        if (text.includes('[FactoryRuntime] Native factory ready')) {
            await wait(2500);
            return fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : text;
        }
        if (text.includes('Factory ready; one or more model files used fallback geometry')) return text;
        if (child.exitCode !== null) return text;
        await wait(500);
    }
    return fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
}

function terminate(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    try { child.kill(); } catch (error) { /* ignore */ }
}

async function main() {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const filename of [backendStdout, backendStderr, unityLog]) {
        fs.rmSync(filename, { force: true });
    }
    if (!fs.existsSync(unityExe)) throw new Error(`Missing Unity player: ${unityExe}`);

    const stdoutFd = fs.openSync(backendStdout, 'a');
    const stderrFd = fs.openSync(backendStderr, 'a');
    const origin = `http://127.0.0.1:${port}`;
    let backend;
    let unity;
    try {
        backend = spawn(process.execPath, ['server.js'], {
            cwd: backendDir,
            windowsHide: true,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                HOST: '127.0.0.1',
                PORT: String(port),
                APP_DATA_DIR: path.join(backendDir, 'data'),
                UPLOADS_DIR: path.join(backendDir, 'uploads'),
                FRONTEND_DIST: path.join(projectDir, 'frontend', 'dist'),
                DB_TYPE: 'sqlite',
                SQLITE_FILE: path.join(backendDir, 'data', 'factory.db'),
                ENABLE_CORS: 'true',
                DESKTOP_SHUTDOWN_TOKEN: shutdownToken
            },
            stdio: ['ignore', stdoutFd, stderrFd]
        });
        await waitForHealth(`${origin}/api/health`);

        const configResponse = await fetch(`${origin}/api/config`);
        if (!configResponse.ok) throw new Error(`Config HTTP ${configResponse.status}`);
        const config = await configResponse.json();
        const devices = (config.workshops || []).flatMap(workshop =>
            (workshop.lines || []).flatMap(line => line.devices || [])
        );
        const deviceModels = [...new Set(devices.map(device => device.model_type))];

        const modelResponse = await fetch(`${origin}/assets/models/photo_multipurpose_furnace_v5.glb`);
        const modelBytes = (await modelResponse.arrayBuffer()).byteLength;
        if (!modelResponse.ok) throw new Error(`Model HTTP ${modelResponse.status}`);

        unity = spawn(unityExe, [
            '-batchmode',
            '-force-d3d11',
            '-screen-fullscreen', '0',
            '-screen-width', '960',
            '-screen-height', '540',
            '-logFile', unityLog
        ], {
            cwd: path.dirname(unityExe),
            windowsHide: true,
            env: {
                ...process.env,
                NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1']
                    .filter(Boolean)
                    .join(','),
                DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
                DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace(/^http/i, 'ws') + '/ws'
            },
            stdio: 'ignore'
        });
        const unityText = await waitForUnityReady(unity);
        const loadedLine = unityText.split(/\r?\n/).find(line =>
            line.includes('[RuntimeModelLibrary] Loaded photo_multipurpose_furnace_v5')
        ) || '';
        const readyLine = unityText.split(/\r?\n/).find(line =>
            line.includes('[FactoryRuntime] Native factory ready')
        ) || '';
        const usedFallback = unityText.includes('one or more model files used fallback geometry');
        const runtimeExceptions = unityText.match(/(?:InvalidCast|NullReference|Argument|IndexOutOfRange)Exception:/g) || [];
        const result = {
            success: deviceModels.length === 1
                && deviceModels[0] === 'photo_multipurpose_furnace_v5'
                && modelResponse.status === 200
                && modelBytes > 0
                && Boolean(loadedLine)
                && Boolean(readyLine)
                && !usedFallback
                && runtimeExceptions.length === 0,
            backendPort: port,
            deviceCount: devices.length,
            deviceModels,
            modelHttpStatus: modelResponse.status,
            modelContentType: modelResponse.headers.get('content-type'),
            modelBytes,
            loadedLine,
            readyLine,
            usedFallback,
            runtimeExceptionCount: runtimeExceptions.length,
            unityExitedEarly: unity.exitCode !== null
        };
        console.log(JSON.stringify(result, null, 2));
        if (!result.success) throw new Error(`Native smoke test failed; inspect ${unityLog}`);
    } finally {
        terminate(unity);
        if (backend) {
            try {
                await fetch(`${origin}/api/internal/shutdown`, {
                    method: 'POST',
                    headers: { 'x-shutdown-token': shutdownToken }
                });
                await wait(1200);
            } catch (error) { /* force close below */ }
            terminate(backend);
        }
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
