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
let desktopControlServer = null;
let desktopControlOrigin = null;
let desktopControlToken = null;
let isQuitting = false;
let quitReady = false;
let hasShownTrayHint = false;
let mainWindowClosePromptActive = false;
let backendRestartTimer = null;
let backendRestartResetTimer = null;
let backendRestartAttempts = 0;
let backendHealthFailures = 0;
let backendRestartInProgress = false;
let applicationShutdownForceTimer = null;
const BACKEND_RESTART_DELAYS_MS = [1000, 3000, 10000];
const BACKEND_RESTART_RESET_MS = 60 * 1000;

function resourcePath(...parts) {
    const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
    return path.join(root, ...parts);
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function copyMissingDirectoryContents(source, destination) {
    if (!fs.existsSync(source)) return;
    ensureDirectory(destination);
    fs.cpSync(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false
    });
}

function initializeWritableData() {
    const root = app.getPath('userData');
    const dataDir = ensureDirectory(path.join(root, 'data'));
    const uploadsDir = path.join(root, 'uploads');
    const logsDir = ensureDirectory(path.join(root, 'logs'));
    const databaseFile = path.join(dataDir, 'factory.db');
    const databaseConfigFile = path.join(dataDir, 'database-config.json');
    const templateRoot = resourcePath('templates');

    if (!fs.existsSync(databaseFile)) {
        fs.copyFileSync(path.join(templateRoot, 'factory-template.db'), databaseFile);
    }
    copyMissingDirectoryContents(path.join(templateRoot, 'uploads'), uploadsDir);
    ensureDirectory(path.join(uploadsDir, 'models'));
    ensureDirectory(path.join(uploadsDir, 'audio'));

    if (!fs.existsSync(databaseConfigFile)) {
        fs.writeFileSync(databaseConfigFile, JSON.stringify({
            type: 'mysql',
            host: process.env.DESKTOP_MYSQL_HOST || process.env.MYSQL_HOST || '127.0.0.1',
            port: Number(process.env.DESKTOP_MYSQL_PORT || process.env.MYSQL_PORT || 3307),
            user: process.env.DESKTOP_MYSQL_USER || process.env.MYSQL_USER || 'root',
            password: process.env.DESKTOP_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || 'root',
            database: process.env.DESKTOP_MYSQL_DATABASE || process.env.MYSQL_DATABASE || 'dongtai_daping',
            // 保留随安装包生成的 SQLite 快照，供离线应急、迁移或人工切换时使用。
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

function waitForHealth(url, timeoutMs = 30000, processToWatch = null) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const check = () => {
            if (processToWatch && (
                processToWatch.killed
                || processToWatch.exitCode !== null
                || processToWatch.signalCode
            )) {
                reject(new Error('后端进程在健康探测完成前已退出'));
                return;
            }
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

function isLoopbackAddress(address) {
    return address === '::1' || /^(::ffff:)?127\.0\.0\.1$/.test(String(address || ''));
}

function startDesktopControlServer() {
    if (desktopControlServer) return Promise.resolve(desktopControlOrigin);
    desktopControlToken = crypto.randomBytes(32).toString('hex');
    desktopControlServer = http.createServer((request, response) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if (request.method === 'GET' && pathname === '/health') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            return;
        }

        const suppliedToken = String(request.headers['x-desktop-control-token'] || '');
        if (!isLoopbackAddress(request.socket.remoteAddress) || suppliedToken !== desktopControlToken) {
            response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: false, error: '拒绝访问' }));
            return;
        }

        if (request.method === 'POST' && pathname === '/open-admin') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(showNativeAdminPanel);
            return;
        }

        if (request.method === 'POST' && pathname === '/show-dashboard') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(showNativeDashboard);
            return;
        }

        if (request.method === 'POST' && pathname === '/minimize-to-tray') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(minimizeApplicationToTray);
            return;
        }

        if (request.method === 'POST' && pathname === '/quit') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(() => app.quit());
            return;
        }

        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ success: false, error: '未找到桌面控制命令' }));
    });

    return new Promise((resolve, reject) => {
        const server = desktopControlServer;
        server.once('error', error => {
            if (desktopControlServer === server) {
                desktopControlServer = null;
                desktopControlOrigin = null;
                desktopControlToken = null;
            }
            reject(error);
        });
        server.listen(0, '127.0.0.1', () => {
            desktopControlOrigin = `http://127.0.0.1:${server.address().port}`;
            resolve(desktopControlOrigin);
        });
    });
}

function stopDesktopControlServer() {
    const server = desktopControlServer;
    desktopControlServer = null;
    desktopControlOrigin = null;
    desktopControlToken = null;
    if (!server) return Promise.resolve();
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            resolve();
        };
        const forceTimer = setTimeout(() => {
            // A WebView may leave a keep-alive request open while the desktop app
            // is quitting.  Do not let that connection block a production shutdown.
            try { server.closeIdleConnections?.(); } catch (error) { /* ignore */ }
            try { server.closeAllConnections?.(); } catch (error) { /* ignore */ }
            finish();
        }, 3000);
        try {
            server.close(finish);
            server.closeIdleConnections?.();
        } catch (error) {
            finish();
        }
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

function probeBackendHealth(port) {
    return new Promise((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1',
            port,
            path: '/api/health',
            headers: { Accept: 'application/json' }
        }, response => {
            response.resume();
            if (response.statusCode === 200) resolve();
            else reject(new Error(`后端健康探测失败: HTTP ${response.statusCode}`));
        });
        request.setTimeout(2500, () => request.destroy(new Error('后端健康探测超时')));
        request.on('error', reject);
    });
}

async function syncDesktopSettings() {
    if (!backendPort) return;
    try {
        const runtime = await readRuntimeSettings(backendPort);
        backendHealthFailures = 0;
        if (runtime?.auto_start_supported) {
            const enabled = runtime.auto_start_enabled === true;
            if (appliedAutoStartSetting !== enabled && configureAutoStart(enabled)) {
                appliedAutoStartSetting = enabled;
            }
        }
    } catch (error) {
        // 后端刚启动、正在重启或开发版不支持时，不打断桌面程序。
        logDesktopError('runtime-settings-sync', error);
        if (backendRestartInProgress) return;
        try {
            // Runtime settings may be delayed by a MySQL backup or PLC refresh.
            // Only restart the process when the lightweight health endpoint also
            // fails, otherwise a busy but healthy backend would be killed.
            await probeBackendHealth(backendPort);
            backendHealthFailures = 0;
            return;
        } catch (healthError) {
            logDesktopError('backend-health-probe', healthError);
        }
        backendHealthFailures += 1;
        if (backendHealthFailures >= 3 && backendProcess && !isQuitting) {
            backendHealthFailures = 0;
            logDesktopError('backend-watchdog', new Error('后端健康探测连续失败，准备自动重启'));
            try { backendProcess.kill(); } catch (killError) { /* exit handler will retry */ }
        }
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

function clearBackendRestartTimers() {
    if (backendRestartTimer) clearTimeout(backendRestartTimer);
    if (backendRestartResetTimer) clearTimeout(backendRestartResetTimer);
    backendRestartTimer = null;
    backendRestartResetTimer = null;
}

function scheduleBackendRestart(writable, port, reason) {
    if (isQuitting || backendRestartTimer) return;
    if (backendRestartAttempts >= BACKEND_RESTART_DELAYS_MS.length) {
        const message = `本地数据服务连续 ${backendRestartAttempts} 次自动恢复失败`;
        logDesktopError('backend-restart-exhausted', new Error(`${message}：${reason || '未知原因'}`));
        try {
            dialog.showErrorBox(APP_NAME, `${message}。\n请查看用户数据目录中的 logs/backend-error.log。`);
        } catch (error) { /* app may already be closing */ }
        app.quit();
        return;
    }

    const attempt = backendRestartAttempts;
    const delay = BACKEND_RESTART_DELAYS_MS[attempt];
    backendRestartAttempts += 1;
    logDesktopError('backend-restart-scheduled', new Error(`第 ${backendRestartAttempts} 次自动恢复将在 ${delay}ms 后执行：${reason || '进程退出'}`));
    backendRestartTimer = setTimeout(async () => {
        backendRestartTimer = null;
        if (isQuitting) return;
        backendRestartInProgress = true;
        backendHealthFailures = 0;
        try {
            const restartedProcess = await startBackend(port, writable);
            await waitForHealth(`${applicationOrigin}/api/health`, 60000, restartedProcess);
            if (backendProcess !== restartedProcess || restartedProcess.exitCode !== null) {
                throw new Error('后端进程在健康探测完成前已退出');
            }
            backendHealthFailures = 0;
            logDesktopError('backend-restart-success', new Error(`后端已自动恢复（第 ${attempt + 1} 次尝试）`));
            if (backendRestartResetTimer) clearTimeout(backendRestartResetTimer);
            backendRestartResetTimer = setTimeout(() => {
                backendRestartAttempts = 0;
                backendRestartResetTimer = null;
            }, BACKEND_RESTART_RESET_MS);
            backendRestartResetTimer.unref?.();
        } catch (error) {
            logDesktopError('backend-restart-failed', error);
            backendRestartInProgress = false;
            scheduleBackendRestart(writable, port, error.message);
            return;
        }
        backendRestartInProgress = false;
    }, delay);
    backendRestartTimer.unref?.();
}

function nativeClientDirectory() {
    return app.isPackaged
        ? resourcePath('native-client')
        : path.resolve(__dirname, '..', 'unity-client', 'Builds', 'Windows');
}

function nativeAdminHostExecutable() {
    return path.join(nativeClientDirectory(), 'AdminHost', 'HeatTreatmentAdminHost.exe');
}

function launchNativeAdminHost(showAdmin) {
    const executable = nativeAdminHostExecutable();
    if (!nativeProcess || nativeProcess.killed || !applicationOrigin || !fs.existsSync(executable)) {
        showAdminWindow();
        return;
    }

    const fixedRuntime = path.join(path.dirname(executable), 'WebView2Runtime');
    const args = [
        '--url', `${applicationOrigin}/admin?embedded=unity`,
        '--parent-pid', String(nativeProcess.pid),
        '--user-data', path.join(app.getPath('userData'), 'webview2')
    ];
    if (fs.existsSync(fixedRuntime)) args.push('--fixed-runtime', fixedRuntime);
    if (desktopControlOrigin) args.push('--desktop-control-url', desktopControlOrigin);
    if (desktopControlToken) args.push('--desktop-control-token', desktopControlToken);
    if (!showAdmin) args.push('--dashboard-mode');
    const child = spawn(executable, args, {
        cwd: path.dirname(executable),
        windowsHide: false,
        detached: false,
        env: {
            ...process.env,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
            NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',')
        },
        stdio: 'ignore'
    });
    child.once('error', error => {
        logDesktopError(showAdmin ? 'native-admin-panel' : 'native-dashboard-restore', error);
        showAdminWindow();
    });
    child.unref();
}

function showNativeAdminPanel() {
    launchNativeAdminHost(true);
}

function showNativeDashboard() {
    launchNativeAdminHost(false);
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
        : [
            '-screen-fullscreen', '0',
            '-screen-width', '1600',
            '-screen-height', '900',
            '-logFile', '-'
        ];
    const child = spawn(executable, nativeArgs, {
        cwd: clientDir,
        windowsHide: false,
        env: {
            ...process.env,
            NO_PROXY: noProxy,
            no_proxy: noProxy,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
            DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: `${webSocketOrigin}/ws`,
            DIGITAL_TWIN_ADMIN_URL: `${origin}/admin`,
            DIGITAL_TWIN_ADMIN_HOST_PATH: nativeAdminHostExecutable(),
            DIGITAL_TWIN_ADMIN_FIXED_RUNTIME: path.join(path.dirname(nativeAdminHostExecutable()), 'WebView2Runtime'),
            DIGITAL_TWIN_DESKTOP_CONTROL_URL: desktopControlOrigin || '',
            DIGITAL_TWIN_DESKTOP_CONTROL_TOKEN: desktopControlToken || '',
            DIGITAL_TWIN_MAXIMIZE_WINDOW: 'true'
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
    const backendDir = app.isPackaged
        ? resourcePath('backend')
        : path.resolve(__dirname, '..', 'backend');
    const nodeBinary = resourcePath('runtime', 'node.exe');
    const frontendDir = app.isPackaged
        ? resourcePath('frontend')
        : path.resolve(__dirname, '..', 'frontend', 'dist');
    backendPort = port;
    backendShutdownToken = crypto.randomBytes(32).toString('hex');
    const logStreams = await Promise.all([
        createRotatingLogWriter(writable.logsDir, 'backend.log'),
        createRotatingLogWriter(writable.logsDir, 'backend-error.log')
    ]);
    backendLogStream = guardLogStream(logStreams[0], '运行日志');
    backendErrorLogStream = guardLogStream(logStreams[1], '后端错误日志');

    const child = spawn(nodeBinary, [path.join(backendDir, 'server.js')], {
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
            SQLITE_RECOVERY_TEMPLATE: resourcePath('templates', 'factory-template.db'),
            SQLITE_UPGRADE_TEMPLATE: resourcePath('templates', 'factory-template.db'),
            DESKTOP_SHUTDOWN_TOKEN: backendShutdownToken,
            DESKTOP_CONTROL_URL: desktopControlOrigin || '',
            DESKTOP_CONTROL_TOKEN: desktopControlToken || '',
            FFMPEG_PATH: resourcePath('ffmpeg', 'ffmpeg.exe'),
            CAST_WINDOW_TITLE: process.env.CAST_WINDOW_TITLE || 'Heat Treatment Digital Twin',
            NODE_PATH: resourcePath('backend-dependencies')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    backendProcess = child;
    child.stdout.pipe(backendLogStream, { end: false });
    child.stderr.pipe(backendErrorLogStream, { end: false });
    child.once('exit', (code, signal) => {
        const wasCurrent = backendProcess === child;
        if (wasCurrent) backendProcess = null;
        if (wasCurrent) closeBackendLogStreams();
        if (!isQuitting && wasCurrent) {
            const error = new Error(`本地数据服务异常退出（代码 ${code ?? 'null'}，信号 ${signal || 'none'}）`);
            logDesktopError('backend-exit', error);
            // During an active recovery attempt the awaiting health probe owns the
            // retry chain.  Let it fail fast and schedule the next backoff once.
            if (!backendRestartInProgress) scheduleBackendRestart(writable, port, error.message);
        }
    });
    try {
        await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
    } catch (error) {
        if (backendProcess === child) backendProcess = null;
        try { child.kill(); } catch (killError) { /* ignore */ }
        closeBackendLogStreams();
        throw error;
    }
    return child;
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
    clearBackendRestartTimers();
    backendRestartAttempts = 0;
    backendHealthFailures = 0;
    backendRestartInProgress = false;
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
    // Unity normally occupies the full screen. Lift the bundled settings window above it
    // long enough to transfer focus, then restore normal z-order behavior.
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 800).unref?.();
}

function minimizeApplicationToTray() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    if (!tray || hasShownTrayHint) return;
    hasShownTrayHint = true;
    try {
        tray.displayBalloon({
            title: APP_NAME,
            content: '程序仍在后台运行。双击右下角托盘图标可恢复 Unity 实时大屏。',
            iconType: 'info'
        });
    } catch (error) {
        logDesktopError('tray-hint', error);
    }
}

function updateTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: '显示 Unity 实时大屏',
            click: showNativeDashboard
        },
        {
            label: '打开后台管理',
            click: showNativeAdminPanel
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
    tray.on('double-click', showNativeDashboard);
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
    mainWindow.on('close', async event => {
        if (isQuitting) return;
        event.preventDefault();
        if (mainWindowClosePromptActive) return;
        mainWindowClosePromptActive = true;
        try {
            const result = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                title: APP_NAME,
                message: '请选择关闭方式',
                buttons: ['最小化到系统托盘（推荐）', '完全退出程序'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            });
            if (result.response === 1) app.quit();
            else minimizeApplicationToTray();
        } finally {
            mainWindowClosePromptActive = false;
        }
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
    // The backend needs this loopback channel in its environment so a DLNA
    // cast can switch the embedded host back to the Unity dashboard before
    // the desktop region is captured.
    await startDesktopControlServer();
    const initialBackendProcess = await startBackend(port, writable);
    await waitForHealth(`${origin}/api/health`, 60000, initialBackendProcess);
    startDesktopSettingsSync();
    createTray();
    try {
        await startNativeClient(origin, writable);
    } catch (error) {
        logDesktopError('native-client-start', error);
        dialog.showErrorBox(APP_NAME, `原生大屏启动失败：${error.message}`);
        showAdminWindow();
    }
    if (process.argv.includes('--admin')) showNativeAdminPanel();
    const smokeCrashBackendAfterMs = Number(process.env.DESKTOP_SMOKE_CRASH_BACKEND_AFTER_MS || 0);
    if (Number.isFinite(smokeCrashBackendAfterMs) && smokeCrashBackendAfterMs > 0) {
        setTimeout(() => {
            if (backendProcess && !isQuitting) backendProcess.kill();
        }, smokeCrashBackendAfterMs);
    }
    const smokeExitAfterMs = Number(process.env.DESKTOP_SMOKE_EXIT_AFTER_MS || 0);
    if (Number.isFinite(smokeExitAfterMs) && smokeExitAfterMs > 0)
    {
        setTimeout(() => app.quit(), smokeExitAfterMs);
    }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', showNativeAdminPanel);

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
        if (!applicationShutdownForceTimer) {
            applicationShutdownForceTimer = setTimeout(() => {
                logDesktopError('forced-shutdown', new Error('安全退出超过 25 秒，强制结束残留进程'));
                try { backendProcess?.kill(); } catch (error) { /* ignore */ }
                try { nativeProcess?.kill(); } catch (error) { /* ignore */ }
                try { desktopControlServer?.closeIdleConnections?.(); } catch (error) { /* ignore */ }
                try { desktopControlServer?.closeAllConnections?.(); } catch (error) { /* ignore */ }
                app.exit(0);
            }, 25000);
        }
        clearBackendRestartTimers();
        if (desktopSettingsTimer) clearInterval(desktopSettingsTimer);
        desktopSettingsTimer = null;
        stopNativeClient().then(() => Promise.all([
            stopDesktopControlServer(),
            stopBackend()
        ])).finally(() => {
            if (applicationShutdownForceTimer) clearTimeout(applicationShutdownForceTimer);
            applicationShutdownForceTimer = null;
            if (logCleanupTimer) clearInterval(logCleanupTimer);
            logCleanupTimer = null;
            tray?.destroy();
            tray = null;
            desktopErrorLogStream?.end();
            desktopErrorLogStream = null;
            quitReady = true;
            // All managed children and local servers are already stopped.  Exit
            // directly so stray Chromium/Node handles cannot keep the tray process
            // alive for another minute after the user chose "完全退出".
            app.exit(0);
        });
    });
}
