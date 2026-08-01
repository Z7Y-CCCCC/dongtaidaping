const path = require('path');
const WebSocket = require('ws');
const {
    BACKEND_DIR,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    waitForHttp
} = require('./integration-test-utils.cjs');

function waitForOpen(socket, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function waitForConfigurationChanged(socket, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('未收到 configuration_changed')), timeoutMs);
        const onMessage = raw => {
            const message = JSON.parse(String(raw));
            if (message.type !== 'configuration_changed') return;
            if (!message.payload?.keys?.includes('native_dashboard_config')) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(message);
        };
        socket.on('message', onMessage);
    });
}

async function main() {
    const runDirectory = createRunDirectory('native-dashboard-config');
    const port = await findFreePort(Number(process.env.TEST_BACKEND_PORT || 3011));
    const origin = `http://127.0.0.1:${port}`;
    const backend = startLoggedProcess(process.execPath, ['server.js'], {
        cwd: BACKEND_DIR,
        logFile: path.join(runDirectory, 'backend.log'),
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            DB_TYPE: 'mysql',
            MYSQL_HOST: process.env.TEST_MYSQL_HOST || '127.0.0.1',
            MYSQL_PORT: process.env.TEST_MYSQL_PORT || '3307',
            MYSQL_USER: process.env.TEST_MYSQL_USER || 'root',
            MYSQL_PASSWORD: process.env.TEST_MYSQL_PASSWORD || 'root',
            MYSQL_DATABASE: process.env.TEST_MYSQL_DATABASE || 'dongtai_daping'
        }
    });

    let socket;
    let originalText;
    try {
        const health = await waitForHttp(`${origin}/api/health`, 35000);
        const originalSettings = await requestJson(`${origin}/api/settings`);
        originalText = originalSettings.native_dashboard_config || '{}';
        const original = JSON.parse(originalText);
        const changed = {
            ...original,
            sideMargin: Number(original.sideMargin || 24) === 31 ? 32 : 31
        };

        socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await waitForOpen(socket);
        const eventPromise = waitForConfigurationChanged(socket);
        const saved = await requestJson(`${origin}/api/settings`, {
            method: 'PUT',
            body: JSON.stringify({ native_dashboard_config: JSON.stringify(changed) })
        });
        const event = await eventPromise;
        const persisted = await requestJson(`${origin}/api/settings`);
        const persistedConfig = JSON.parse(persisted.native_dashboard_config);
        const config = await requestJson(`${origin}/api/config`);
        const devices = (config.workshops || []).flatMap(workshop => [
            ...(workshop.devices || []),
            ...(workshop.lines || []).flatMap(line => line.devices || [])
        ]);
        const points = devices.reduce((sum, device) => sum + (device.dataPoints || []).length, 0);

        if (saved.success !== true) throw new Error('设置保存接口未返回 success');
        if (event.type !== 'configuration_changed') throw new Error('WebSocket 配置事件类型不正确');
        if (persistedConfig.sideMargin !== changed.sideMargin) throw new Error('MySQL 配置未持久化');
        if (health.db?.type !== 'mysql') throw new Error(`测试后端未使用 MySQL: ${health.db?.type}`);
        if (devices.length === 0 || points === 0) throw new Error('MySQL 中未读到设备或点位配置');

        console.log(JSON.stringify({
            success: true,
            database: health.db?.type,
            eventType: event.type,
            changedKeys: event.payload.keys,
            persistedSideMargin: persistedConfig.sideMargin,
            devices: devices.length,
            points,
            output: runDirectory
        }, null, 2));
    } finally {
        if (originalText !== undefined) {
            try {
                await requestJson(`${origin}/api/settings`, {
                    method: 'PUT',
                    body: JSON.stringify({ native_dashboard_config: originalText })
                });
            } catch (error) {
                console.error(`原配置恢复失败: ${error.message}`);
            }
        }
        try { socket?.close(); } catch (error) { /* ignore */ }
        await forceStop(backend);
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
