const { app, BrowserWindow, dialog, shell } = require('electron');
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
if (process.env.APP_USER_DATA_DIR) {
    app.setPath('userData', path.resolve(process.env.APP_USER_DATA_DIR));
}
let mainWindow = null;
let backendProcess = null;
let backendLogStream = null;
let backendErrorLogStream = null;
let desktopErrorLogStream = null;
let logCleanupTimer = null;
let backendPort = null;
let backendShutdownToken = null;
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

    if (!fs.existsSync(databaseConfigFile)) {
        fs.writeFileSync(databaseConfigFile, JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2), 'utf8');
    }

    return { dataDir, uploadsDir, logsDir };
}

function configureAutoStart() {
    if (!app.isPackaged || process.platform !== 'win32' || process.env.DISABLE_AUTO_START === 'true') return;
    app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: false,
        path: process.execPath,
        args: ['--autostart']
    });
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

function createMainWindow(url) {
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
        if (!targetUrl.startsWith(url)) event.preventDefault();
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
        mainWindow.maximize();
        mainWindow.show();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(url);
}

async function launchApplication() {
    const writable = initializeWritableData();
    desktopErrorLogStream = guardLogStream(
        await createRotatingLogWriter(writable.logsDir, 'desktop-error.log'),
        '桌面错误日志'
    );
    startLogMaintenance(writable.logsDir);
    const port = await findAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    await startBackend(port, writable);
    await waitForHealth(`${origin}/api/health`);
    createMainWindow(origin);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(() => {
        configureAutoStart();
        return launchApplication();
    }).catch((error) => {
        logDesktopError('application-start', error);
        dialog.showErrorBox(APP_NAME, `${error.message}\n请查看用户数据目录中的 logs/desktop-error.log 和 logs/backend-error.log。`);
        app.quit();
    });

    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', (event) => {
        if (quitReady) return;
        event.preventDefault();
        isQuitting = true;
        stopBackend().finally(() => {
            if (logCleanupTimer) clearInterval(logCleanupTimer);
            logCleanupTimer = null;
            desktopErrorLogStream?.end();
            desktopErrorLogStream = null;
            quitReady = true;
            app.quit();
        });
    });
}
