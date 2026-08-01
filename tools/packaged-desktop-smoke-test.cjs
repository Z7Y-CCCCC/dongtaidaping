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
            DESKTOP_MYSQL_HOST: process.env.PACKAGED_SMOKE_MYSQL_HOST || '127.0.0.1',
            DESKTOP_MYSQL_PORT: process.env.PACKAGED_SMOKE_MYSQL_PORT || '3307',
            DESKTOP_MYSQL_USER: process.env.PACKAGED_SMOKE_MYSQL_USER || 'root',
            DESKTOP_MYSQL_PASSWORD: process.env.PACKAGED_SMOKE_MYSQL_PASSWORD || 'root',
            DESKTOP_MYSQL_DATABASE: process.env.PACKAGED_SMOKE_MYSQL_DATABASE || 'dongtai_daping',
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
    const databaseConfigPath = path.join(appDataDir, 'data', 'database-config.json');
    const databaseConfig = JSON.parse(fs.readFileSync(databaseConfigPath, 'utf8'));
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
    const configuredModels = modelCounts.map(item => item.model_type);
    const loadedModels = configuredModels.filter(modelId =>
        nativeLog.includes(`[RuntimeModelLibrary] Loaded ${modelId}`)
    );
    const runtimeExceptions = (nativeLog + nativeErrorLog).match(
        /(?:InvalidCast|NullReference|Argument|IndexOutOfRange)Exception:/g
    ) || [];
    const unexpectedBackendErrors = backendErrorLog
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !line.includes('EADDRINUSE') || !line.includes('8787'))
        .filter(line => !line.startsWith('[PlcReader]') || !line.includes('连接失败:'));
    const totalTemplateDevices = modelCounts.reduce((sum, item) => sum + Number(item.count || 0), 0);
    const success = exit.code === 0
        && Boolean(readyLine)
        && configuredModels.length > 0
        && loadedModels.length === configuredModels.length
        && !nativeLog.includes('one or more model files used fallback geometry')
        && runtimeExceptions.length === 0
        && unexpectedBackendErrors.length === 0
        && desktopErrorLog.trim() === ''
        && integrity === 'ok'
        && totalTemplateDevices === 8
        && databaseConfig.type === 'mysql'
        && Number(databaseConfig.port) === 3307
        && databaseConfig.database === 'dongtai_daping'
        && backendLog.includes('Database:    mysql');

    const result = {
        success,
        desktopExitCode: exit.code,
        desktopExitSignal: exit.signal,
        readyLine,
        loadedModels,
        runtimeExceptionCount: runtimeExceptions.length,
        backendErrorBytes: Buffer.byteLength(backendErrorLog),
        unexpectedBackendErrors,
        desktopErrorBytes: Buffer.byteLength(desktopErrorLog),
        databaseIntegrity: integrity,
        databaseConfig: {
            type: databaseConfig.type,
            host: databaseConfig.host,
            port: databaseConfig.port,
            database: databaseConfig.database
        },
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
