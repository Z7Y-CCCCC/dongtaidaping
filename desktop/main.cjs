const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const APP_NAME = '热处理数字孪生大屏';
let mainWindow = null;
let backendProcess = null;
let backendLogStream = null;
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

function startBackend(port, writable) {
    const backendDir = path.join(process.resourcesPath, 'backend');
    const nodeBinary = path.join(process.resourcesPath, 'runtime', 'node.exe');
    const frontendDir = path.join(process.resourcesPath, 'frontend');
    const logPath = path.join(writable.logsDir, 'backend.log');
    backendPort = port;
    backendShutdownToken = crypto.randomBytes(32).toString('hex');
    backendLogStream = fs.createWriteStream(logPath, { flags: 'a' });

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
    backendProcess.stderr.pipe(backendLogStream, { end: false });
    backendProcess.once('exit', (code) => {
        backendProcess = null;
        if (!isQuitting && code !== 0) {
            dialog.showErrorBox(APP_NAME, `本地数据服务异常退出（代码 ${code}）。\n日志：${logPath}`);
            app.quit();
        }
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
        if (backendLogStream) backendLogStream.end();
        backendLogStream = null;
        return Promise.resolve();
    }

    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            if (backendLogStream) backendLogStream.end();
            backendLogStream = null;
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
    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();
        mainWindow.show();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(url);
}

async function launchApplication() {
    const writable = initializeWritableData();
    const port = await findAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    startBackend(port, writable);
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
        dialog.showErrorBox(APP_NAME, `${error.message}\n请查看用户数据目录中的 logs/backend.log。`);
        app.quit();
    });

    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', (event) => {
        if (quitReady) return;
        event.preventDefault();
        isQuitting = true;
        stopBackend().finally(() => {
            quitReady = true;
            app.quit();
        });
    });
}
