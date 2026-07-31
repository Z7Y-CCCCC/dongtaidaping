const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const appDataDir = path.join(projectDir, 'tmp', 'packaged-native-smoke');
const executable = path.join(
    projectDir,
    '安装包',
    'win-unpacked',
    '热处理数字孪生大屏.exe'
);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Packaged desktop did not exit in time.')), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function readLog(name) {
    const filename = path.join(appDataDir, 'logs', name);
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
}

async function main() {
    if (!fs.existsSync(executable)) throw new Error(`Missing unpacked desktop executable: ${executable}`);
    fs.rmSync(appDataDir, { recursive: true, force: true });
    fs.mkdirSync(appDataDir, { recursive: true });

    const desktop = spawn(executable, [], {
        cwd: path.dirname(executable),
        windowsHide: true,
        env: {
            ...process.env,
            APP_USER_DATA_DIR: appDataDir,
            DISABLE_AUTO_START: 'true',
            NATIVE_CLIENT_SMOKE_MODE: 'true',
            DESKTOP_SMOKE_EXIT_AFTER_MS: '22000'
        },
        stdio: 'ignore'
    });

    let exit;
    try {
        exit = await waitForExit(desktop, 90000);
    } catch (error) {
        try { desktop.kill(); } catch (killError) { /* ignore */ }
        throw error;
    }
    await wait(1500);

    const nativeLog = readLog('native-client.log');
    const nativeErrorLog = readLog('native-client-error.log');
    const backendLog = readLog('backend.log');
    const backendErrorLog = readLog('backend-error.log');
    const desktopErrorLog = readLog('desktop-error.log');
    const databasePath = path.join(appDataDir, 'data', 'factory.db');
    const Database = require(path.join(projectDir, 'backend', 'node_modules', 'better-sqlite3'));
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    let modelCounts;
    let integrity;
    try {
        modelCounts = database.prepare(
            'SELECT model_type, COUNT(*) AS count FROM devices GROUP BY model_type ORDER BY model_type'
        ).all();
        integrity = database.pragma('quick_check', { simple: true });
    } finally {
        database.close();
    }

    const readyLine = nativeLog.split(/\r?\n/).find(line =>
        line.includes('[FactoryRuntime] Native factory ready')
    ) || '';
    const loadedLine = nativeLog.split(/\r?\n/).find(line =>
        line.includes('[RuntimeModelLibrary] Loaded photo_multipurpose_furnace_v5')
    ) || '';
    const runtimeExceptions = (nativeLog + nativeErrorLog).match(
        /(?:InvalidCast|NullReference|Argument|IndexOutOfRange)Exception:/g
    ) || [];
    const success = exit.code === 0
        && Boolean(readyLine)
        && Boolean(loadedLine)
        && !nativeLog.includes('one or more model files used fallback geometry')
        && runtimeExceptions.length === 0
        && backendErrorLog.trim() === ''
        && desktopErrorLog.trim() === ''
        && integrity === 'ok'
        && modelCounts.length === 1
        && modelCounts[0].model_type === 'photo_multipurpose_furnace_v5'
        && modelCounts[0].count === 20
        && backendLog.includes('备份完成');

    const result = {
        success,
        desktopExitCode: exit.code,
        desktopExitSignal: exit.signal,
        readyLine,
        loadedLine,
        runtimeExceptionCount: runtimeExceptions.length,
        backendErrorBytes: Buffer.byteLength(backendErrorLog),
        desktopErrorBytes: Buffer.byteLength(desktopErrorLog),
        databaseIntegrity: integrity,
        modelCounts,
        userDataDirectory: appDataDir
    };
    console.log(JSON.stringify(result, null, 2));
    if (!success) throw new Error('Packaged desktop smoke test failed.');
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
