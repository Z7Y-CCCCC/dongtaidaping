const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const electron = path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const outputDir = path.join(projectDir, 'output', `backend-supervisor-${Date.now()}-${process.pid}`);

function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('桌面进程自愈测试超时')), timeoutMs);
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

async function main() {
    if (!fs.existsSync(electron)) throw new Error(`找不到 Electron：${electron}`);
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const child = spawn(electron, [path.join(desktopDir, 'main.cjs')], {
        cwd: desktopDir,
        windowsHide: true,
        env: {
            ...process.env,
            APP_USER_DATA_DIR: outputDir,
            DISABLE_AUTO_START: 'true',
            NATIVE_CLIENT_SMOKE_MODE: 'true',
            DESKTOP_SMOKE_CRASH_BACKEND_AFTER_MS: '7000',
            // A production-style MySQL startup can take 15-25 seconds on a low-end
            // Windows PC with antivirus/OneDrive enabled.  Leave enough time after
            // the injected crash to observe a real healthy restart before quitting.
            DESKTOP_SMOKE_EXIT_AFTER_MS: '45000',
            DESKTOP_MYSQL_HOST: process.env.DESKTOP_MYSQL_HOST || '127.0.0.1',
            DESKTOP_MYSQL_PORT: process.env.DESKTOP_MYSQL_PORT || '3307',
            DESKTOP_MYSQL_USER: process.env.DESKTOP_MYSQL_USER || 'root',
            DESKTOP_MYSQL_PASSWORD: process.env.DESKTOP_MYSQL_PASSWORD || 'root',
            DESKTOP_MYSQL_DATABASE: process.env.DESKTOP_MYSQL_DATABASE || 'dongtai_daping'
        },
        stdio: 'ignore'
    });
    let exit;
    try {
        exit = await waitForExit(child, 120000);
    } catch (error) {
        try { child.kill(); } catch (killError) { /* ignore */ }
        throw error;
    }

    const logFile = path.join(outputDir, 'logs', 'desktop-error.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const checks = {
        desktopExitedCleanly: exit.code === 0,
        crashDetected: log.includes('[backend-exit]'),
        restartScheduled: log.includes('[backend-restart-scheduled]'),
        restartSucceeded: log.includes('[backend-restart-success]'),
        retryLimitNotExhausted: !log.includes('[backend-restart-exhausted]')
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const result = { success: failed.length === 0, checks, outputDir, exit };
    console.log(JSON.stringify(result, null, 2));
    if (failed.length) throw new Error(`后端自愈检查失败：${failed.join(', ')}`);
    process.exit(0);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
