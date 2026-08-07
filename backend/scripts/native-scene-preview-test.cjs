const WebSocket = require('ws');

const port = Number(process.env.PORT || 3001);
const baseUrl = `http://127.0.0.1:${port}`;

function waitForEvent(socket, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`未收到 ${type}`)), timeoutMs);
        const onMessage = raw => {
            const message = JSON.parse(String(raw));
            if (message.type !== type) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(message);
        };
        socket.on('message', onMessage);
    });
}

async function main() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));

    const eventPromise = waitForEvent(socket, 'native_scene_preview');
    const response = await fetch(`${baseUrl}/api/native-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'apply',
            sessionId: 'native-preview-test',
            sequence: 7,
            source: 'test',
            includeLayout: true,
            devices: [{
                id: 'preview_device',
                name: '预览设备',
                model_type: 'builtin_furnace',
                pos_x: 12.5,
                pos_y: 0,
                pos_z: -3.5,
                rotation_y: 1.5708,
                scale: 1.2,
                instance_config: { mirrorX: true }
            }],
            lines: [{
                id: 'preview_line',
                layout: {
                    flowDirection: 'left',
                    lanes: [{ id: 'lane_1', name: '设备线 1', offsetZ: -5, length: 72 }],
                    rails: [{ id: 'rail_1', name: '导轨 1', offsetZ: 2, length: 60 }]
                }
            }],
            focus: { mode: 'device', deviceId: 'preview_device' }
        })
    });
    const result = await response.json();
    const event = await eventPromise;
    if (!result.success || result.unityClients < 1) throw new Error('Unity 客户端计数不正确');
    if (event.payload?.devices?.[0]?.pos_x !== 12.5) throw new Error('设备实时位置未正确转发');
    if (event.payload?.lines?.[0]?.layout_json?.rails?.[0]?.length !== 60) throw new Error('产线布局未正确转发');

    const returnEventPromise = waitForEvent(socket, 'native_scene_preview');
    const returnResponse = await fetch(`${baseUrl}/api/native-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'focus',
            source: 'dashboard_overlay',
            focus: { mode: 'line', lineId: '' }
        })
    });
    const returnResult = await returnResponse.json();
    const returnEvent = await returnEventPromise;
    if (!returnResult.success || returnEvent.payload?.focus?.mode !== 'line') {
        throw new Error('返回产线视角指令未正确转发');
    }

    socket.close();
    console.log(JSON.stringify({
        success: true,
        type: event.type,
        action: event.payload.action,
        unityClients: result.unityClients,
        deviceX: event.payload.devices[0].pos_x,
        lineId: event.payload.lines[0].id,
        returnMode: returnEvent.payload.focus.mode
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
