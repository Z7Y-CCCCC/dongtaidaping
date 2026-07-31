const { app, BrowserWindow, dialog, Menu, shell, Tray } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const {
    cleanupLogArchives,
    createRotatingLogWriter
} = require('./logManager.cjs');

const APP_NAME = '热处理数字孪生大屏';
// 现场大屏需要在无人值守时自动播报，Electron 默认的 Chromium 音频自动播放限制会阻止这一点。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.APP_USER_DATA_DIR) {
    app.setPath('userData', path.resolve(process.env.APP_USER_DATA_DIR));
}
let mainWindow = null;
let tray = null;
let backendProcess = null;
let nativeProcess = null;
let backendLogStream = null;
let backendErrorLogStream = null;
let nativeLogStream = null;
let nativeErrorLogStream = null;
let desktopErrorLogStream = null;
let logCleanupTimer = null;
let backendPort = null;
let backendShutdownToken = null;
let applicationOrigin = null;
let writablePaths = null;
let desktopSettingsTimer = null;
let appliedAutoStartSetting = null;
let isQuitting = false;
let quitReady = false;

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function copyDirectoryIfMissing(source, destination) {
    if (fs.existsSync(destination) || !fs.existsSync(source)) return;
    fs.cpSync(source, destination, { recursive: true });
}

function initializeWritableData() {
    const root = app.getPath('userData');
    const dataDir = ensureDirectory(path.join(root, 'data'));
    const uploadsDir = path.join(root, 'uploads');
    const logsDir = ensureDirectory(path.join(root, 'logs'));
    const databaseFile = path.join(dataDir, 'factory.db');
    const databaseConfigFile = path.join(dataDir, 'database-config.json');
    const templateRoot = path.join(process.resourcesPath, 'templates');

    if (!fs.existsSync(databaseFile)) {
        fs.copyFileSync(path.join(templateRoot, 'factory-template.db'), databaseFile);
    }
    copyDirectoryIfMissing(path.join(templateRoot, 'uploads'), uploadsDir);
    ensureDirectory(path.join(uploadsDir, 'models'));
    ensureDirectory(path.join(uploadsDir, 'audio'));

    if (!fs.existsSync(databaseConfigFile)) {
        fs.writeFileSync(databaseConfigFile, JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2), 'utf8');
    }

    return { dataDir, uploadsDir, logsDir };
}

function configureAutoStart(enabled) {
    if (!app.isPackaged || process.platform !== 'win32' || process.env.DISABLE_AUTO_START === 'true') return false;
    try {
        app.setLoginItemSettings({
            openAtLogin: Boolean(enabled),
            openAsHidden: false,
            path: process.execPath,
            args: ['--autostart']
        });
        return true;
    } catch (error) {
        logDesktopError('auto-start', error);
        return false;
    }
}

function findAvailablePort(startPort = 3001) {
    return new Promise((resolve, reject) => {
        const tryPort = (port) => {
            const server = net.createServer();
            server.unref();
            server.once('error', (error) => {
                if (error.code === 'EADDRINUSE' && port < startPort + 50) {
                    tryPort(port + 1);
                    return;
                }
                reject(error);
            });
            server.listen(port, '127.0.0.1', () => {
                const selected = server.address().port;
                server.close(() => resolve(selected));
            });
        };
        tryPort(startPort);
    });
}

function waitForHealth(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const check = () => {
            const request = http.get(url, (response) => {
                response.resume();
                if (response.statusCode === 200) {
                    resolve();
                    return;
                }
                retry();
            });
            request.setTimeout(1500, () => request.destroy());
            request.on('error', retry);
        };
        const retry = () => {
            if (Date.now() >= deadline) {
                reject(new Error('本地服务启动超时'));
                return;
            }
            setTimeout(check, 300);
        };
        check();
    });
}

function readRuntimeSettings(port) {
    return new Promise((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1',
            port,
            path: '/api/system/runtime',
            headers: { Accept: 'application/json' }
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`读取运行配置失败: HTTP ${response.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`运行配置响应格式错误: ${error.message}`));
                }
            });
        });
        request.setTimeout(2500, () => request.destroy(new Error('读取运行配置超时')));
        request.on('error', reject);
    });
}

async function syncDesktopSettings() {
    if (!backendPort) return;
    try {
        const runtime = await readRuntimeSettings(backendPort);
        if (runtime?.auto_start_supported) {
            const enabled = runtime.auto_start_enabled === true;
            if (appliedAutoStartSetting !== enabled && configureAutoStart(enabled)) {
                appliedAutoStartSetting = enabled;
            }
        }
    } catch (error) {
        // 后端刚启动、正在重启或开发版不支持时，不打断桌面程序。
        logDesktopError('runtime-settings-sync', error);
    }
}

function startDesktopSettingsSync() {
    if (desktopSettingsTimer) clearInterval(desktopSettingsTimer);
    desktopSettingsTimer = setInterval(() => {
        syncDesktopSettings();
    }, 4000);
    desktopSettingsTimer.unref?.();
    syncDesktopSettings();
}

function logDesktopError(context, error) {
    const message = error?.stack || error?.message || String(error || '未知错误');
    desktopErrorLogStream?.write(`[${new Date().toISOString()}] [${context}] ${message}\n`);
}

function startLogMaintenance(logsDir) {
    cleanupLogArchives(logsDir);
    if (logCleanupTimer) clearInterval(logCleanupTimer);
    logCleanupTimer = setInterval(() => cleanupLogArchives(logsDir), 6 * 60 * 60 * 1000);
    logCleanupTimer.unref?.();
}

function closeBackendLogStreams() {
    backendLogStream?.end();
    backendErrorLogStream?.end();
    backendLogStream = null;
    backendErrorLogStream = null;
}

function guardLogStream(stream, label) {
    stream.on('error', error => {
        try {
            dialog.showErrorBox(APP_NAME, `${label}写入失败：${error.message}`);
        } catch (dialogError) { /* application may already be shutting down */ }
    });
    return stream;
}

function nativeClientDirectory() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'native-client')
        : path.resolve(__dirname, '..', 'unity-client', 'Builds', 'Windows');
}

function closeNativeLogStreams() {
    nativeLogStream?.end();
    nativeErrorLogStream?.end();
    nativeLogStream = null;
    nativeErrorLogStream = null;
}

async function startNativeClient(origin, writable) {
    if (nativeProcess) return;
    const clientDir = nativeClientDirectory();
    const executable = path.join(clientDir, 'HeatTreatmentDigitalTwin.exe');
    if (!fs.existsSync(executable)) {
        throw new Error(`原生大屏程序不存在：${executable}`);
    }

    const logStreams = await Promise.all([
        createRotatingLogWriter(writable.logsDir, 'native-client.log'),
        createRotatingLogWriter(writable.logsDir, 'native-client-error.log')
    ]);
    nativeLogStream = guardLogStream(logStreams[0], '原生客户端日志');
    nativeErrorLogStream = guardLogStream(logStreams[1], '原生客户端错误日志');

    const webSocketOrigin = origin.replace(/^http/i, 'ws');
    const noProxy = [process.env.NO_PROXY, 'localhost', '127.0.0.1']
        .filter(Boolean)
        .join(',');
    const nativeArgs = process.env.NATIVE_CLIENT_SMOKE_MODE === 'true'
        ? [
            '-batchmode',
            '-force-d3d11',
            '-screen-fullscreen', '0',
            '-screen-width', '960',
            '-screen-height', '540',
            '-logFile', '-'
        ]
        : ['-screen-fullscreen', '1', '-logFile', '-'];
    const child = spawn(executable, nativeArgs, {
        cwd: clientDir,
        windowsHide: false,
        env: {
            ...process.env,
            NO_PROXY: noProxy,
            DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: `${webSocketOrigin}/ws`
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    nativeProcess = child;
    child.stdout?.pipe(nativeLogStream, { end: false });
    child.stderr?.pipe(nativeErrorLogStream, { end: false });
    child.once('exit', code => {
        const wasCurrent = nativeProcess === child;
        if (wasCurrent) nativeProcess = null;
        closeNativeLogStreams();
        updateTrayMenu();
        if (!isQuitting && wasCurrent) {
            if (code !== 0) {
                const error = new Error(`Unity 原生大屏异常退出（代码 ${code}）`);
                logDesktopError('native-client-exit', error);
                dialog.showErrorBox(
                    APP_NAME,
                    `${error.message}。\n错误日志：${path.join(writable.logsDir, 'native-client-error.log')}`
                );
            }
            showAdminWindow();
        }
    });
    await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
    });
    updateTrayMenu();
}

function stopNativeClient() {
    const processToStop = nativeProcess;
    nativeProcess = null;
    updateTrayMenu();
    if (!processToStop || processToStop.killed) {
        closeNativeLogStreams();
        return Promise.resolve();
    }

    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            closeNativeLogStreams();
            resolve();
        };
        const forceTimer = setTimeout(() => {
            try { processToStop.kill(); } catch (error) { /* ignore */ }
            finish();
        }, 5000);
        processToStop.once('exit', finish);
        try { processToStop.kill(); } catch (error) { finish(); }
    });
}

async function restartNativeClient() {
    if (!applicationOrigin || !writablePaths) return;
    try {
        await stopNativeClient();
        await startNativeClient(applicationOrigin, writablePaths);
    } catch (error) {
        logDesktopError('native-client-restart', error);
        dialog.showErrorBox(APP_NAME, `原生大屏启动失败：${error.message}`);
        showAdminWindow();
    }
}

async function startBackend(port, writable) {
    const backendDir = path.join(process.resourcesPath, 'backend');
    const nodeBinary = path.join(process.resourcesPath, 'runtime', 'node.exe');
    const frontendDir = path.join(process.resourcesPath, 'frontend');
    const errorLogPath = path.join(writable.logsDir, 'backend-error.log');
    backendPort = port;
    backendShutdownToken = crypto.randomBytes(32).toString('hex');
    const logStreams = await Promise.all([
        createRotatingLogWriter(writable.logsDir, 'backend.log'),
        createRotatingLogWriter(writable.logsDir, 'backend-error.log')
    ]);
    backendLogStream = guardLogStream(logStreams[0], '运行日志');
    backendErrorLogStream = guardLogStream(logStreams[1], '后端错误日志');

    backendProcess = spawn(nodeBinary, [path.join(backendDir, 'server.js')], {
        cwd: backendDir,
        windowsHide: true,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: String(port),
            APP_DATA_DIR: writable.dataDir,
            UPLOADS_DIR: writable.uploadsDir,
            FRONTEND_DIST: frontendDir,
            ENABLE_CORS: 'false',
            DESKTOP_PACKAGED: app.isPackaged ? 'true' : 'false',
            DESKTOP_AUTO_START_SUPPORTED: app.isPackaged && process.platform === 'win32' && process.env.DISABLE_AUTO_START !== 'true' ? 'true' : 'false',
            SQLITE_RECOVERY_TEMPLATE: path.join(process.resourcesPath, 'templates', 'factory-template.db'),
            DESKTOP_SHUTDOWN_TOKEN: backendShutdownToken,
            NODE_PATH: path.join(process.resourcesPath, 'backend-dependencies')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    backendProcess.stdout.pipe(backendLogStream, { end: false });
    backendProcess.stderr.pipe(backendErrorLogStream, { end: false });
    backendProcess.once('exit', (code) => {
        backendProcess = null;
        if (!isQuitting && code !== 0) {
            const error = new Error(`本地数据服务异常退出（代码 ${code}）`);
            logDesktopError('backend-exit', error);
            dialog.showErrorBox(APP_NAME, `${error.message}。\n错误日志：${errorLogPath}`);
            app.quit();
        }
    });
    await new Promise((resolve, reject) => {
        backendProcess.once('spawn', resolve);
        backendProcess.once('error', reject);
    });
}

function requestBackendShutdown(port, token) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port,
            path: '/api/internal/shutdown',
            method: 'POST',
            headers: {
                'x-shutdown-token': token,
                'content-length': '0'
            }
        }, response => {
            response.resume();
            if (response.statusCode === 202) {
                resolve();
                return;
            }
            reject(new Error(`安全退出请求失败: HTTP ${response.statusCode}`));
        });
        request.setTimeout(2000, () => request.destroy(new Error('安全退出请求超时')));
        request.on('error', reject);
        request.end();
    });
}

function stopBackend() {
    const processToStop = backendProcess;
    const port = backendPort;
    const token = backendShutdownToken;
    backendProcess = null;
    backendPort = null;
    backendShutdownToken = null;
    if (!processToStop || processToStop.killed) {
        closeBackendLogStreams();
        return Promise.resolve();
    }

    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            closeBackendLogStreams();
            resolve();
        };
        const forceTimer = setTimeout(() => {
            try { processToStop.kill(); } catch (error) { /* ignore */ }
            finish();
        }, 14000);
        processToStop.once('exit', finish);
        requestBackendShutdown(port, token).catch(() => {
            try { processToStop.kill(); } catch (error) { finish(); }
        });
    });
}

function showAdminWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        if (applicationOrigin) createMainWindow(applicationOrigin, true);
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
}

function updateTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: '打开后台管理',
            click: showAdminWindow
        },
        {
            label: nativeProcess ? '重启 Unity 原生大屏' : '启动 Unity 原生大屏',
            click: restartNativeClient
        },
        {
            label: '用默认浏览器打开后台',
            click: () => {
                if (applicationOrigin) shell.openExternal(`${applicationOrigin}/admin`);
            }
        },
        {
            label: '打开现场数据目录',
            click: () => shell.openPath(app.getPath('userData'))
        },
        { type: 'separator' },
        {
            label: '退出整套软件',
            click: () => app.quit()
        }
    ]));
}

function createTray() {
    if (tray) return;
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
    tray.setToolTip(APP_NAME);
    tray.on('double-click', showAdminWindow);
    updateTrayMenu();
}

function createMainWindow(origin, showInitially = false) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (showInitially) showAdminWindow();
        return;
    }
    const adminUrl = `${origin}/admin`;
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 960,
        minWidth: 1180,
        minHeight: 720,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#111820',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        if (/^https?:\/\//i.test(targetUrl)) shell.openExternal(targetUrl);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
        if (!targetUrl.startsWith(origin)) event.preventDefault();
    });
    mainWindow.webContents.session.on('will-download', async (event, item, webContents) => {
        if (webContents !== mainWindow?.webContents) return;
        item.pause();
        try {
            const result = await dialog.showSaveDialog(mainWindow, {
                title: '保存备份文件',
                defaultPath: item.getFilename(),
                filters: [
                    { name: '备份文件', extensions: ['zip', 'db'] },
                    { name: '所有文件', extensions: ['*'] }
                ]
            });
            if (result.canceled || !result.filePath) {
                item.cancel();
                return;
            }
            item.setSavePath(result.filePath);
            item.resume();
        } catch (error) {
            item.cancel();
            dialog.showErrorBox(APP_NAME, `备份文件保存失败：${error.message}`);
        }
    });
    mainWindow.once('ready-to-show', () => {
        if (showInitially) showAdminWindow();
    });
    mainWindow.on('close', event => {
        if (isQuitting) return;
        event.preventDefault();
        mainWindow.hide();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(adminUrl);
}

async function launchApplication() {
    const writable = initializeWritableData();
    writablePaths = writable;
    desktopErrorLogStream = guardLogStream(
        await createRotatingLogWriter(writable.logsDir, 'desktop-error.log'),
        '桌面错误日志'
    );
    startLogMaintenance(writable.logsDir);
    const port = await findAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    applicationOrigin = origin;
    await startBackend(port, writable);
    await waitForHealth(`${origin}/api/health`);
    startDesktopSettingsSync();
    createMainWindow(origin, process.argv.includes('--admin'));
    createTray();
    try {
        await startNativeClient(origin, writable);
    } catch (error) {
        logDesktopError('native-client-start', error);
        dialog.showErrorBox(APP_NAME, `原生大屏启动失败：${error.message}`);
        showAdminWindow();
    }
    const smokeExitAfterMs = Number(process.env.DESKTOP_SMOKE_EXIT_AFTER_MS || 0);
    if (Number.isFinite(smokeExitAfterMs) && smokeExitAfterMs > 0)
    {
        setTimeout(() => app.quit(), smokeExitAfterMs).unref?.();
    }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', showAdminWindow);

    app.whenReady().then(() => {
        return launchApplication();
    }).catch((error) => {
        logDesktopError('application-start', error);
        dialog.showErrorBox(APP_NAME, `${error.message}\n请查看用户数据目录中的 logs/desktop-error.log 和 logs/backend-error.log。`);
        app.quit();
    });

    // Windows 上关闭后台窗口只隐藏到托盘，Unity 大屏和后端继续运行。
    app.on('window-all-closed', () => {});
    app.on('before-quit', (event) => {
        if (quitReady) return;
        event.preventDefault();
        isQuitting = true;
        if (desktopSettingsTimer) clearInterval(desktopSettingsTimer);
        desktopSettingsTimer = null;
        stopNativeClient().then(() => stopBackend()).finally(() => {
            if (logCleanupTimer) clearInterval(logCleanupTimer);
            logCleanupTimer = null;
            tray?.destroy();
            tray = null;
            desktopErrorLogStream?.end();
            desktopErrorLogStream = null;
            quitReady = true;
            app.quit();
        });
    });
}
