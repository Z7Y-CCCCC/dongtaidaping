const express = require('express');

const MAX_DEVICES = 500;
const MAX_LINES = 120;
const MAX_LAYOUT_ITEMS = 120;

function finiteNumber(value, fallback = 0, min = -100000, max = 100000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function safeObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function shortText(value, maxLength = 160) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeLayoutItems(items, type) {
    const isRail = type === 'rail';
    return (Array.isArray(items) ? items : []).slice(0, MAX_LAYOUT_ITEMS).map((item, index) => ({
        id: shortText(item?.id || `${isRail ? 'rail' : 'lane'}_${index + 1}`, 100),
        name: shortText(item?.name || `${isRail ? '小车导轨' : '设备线'} ${index + 1}`, 160),
        type: isRail ? 'cart_rail' : 'device_lane',
        offsetZ: finiteNumber(item?.offsetZ ?? item?.offset_z ?? item?.z, isRail ? 4 : 0, -10000, 10000),
        length: finiteNumber(item?.length, 60, 1, 10000),
        sort_order: finiteNumber(item?.sort_order, index, -10000, 10000)
    }));
}

function normalizeLayout(value) {
    const source = safeObject(value);
    const lanes = normalizeLayoutItems(source.lanes, 'lane');
    if (!lanes.length) {
        lanes.push({ id: 'lane_1', name: '设备线 1', type: 'device_lane', offsetZ: 0, length: 60, sort_order: 0 });
    }
    return {
        version: 1,
        flowDirection: ['right', 'left', 'none'].includes(source.flowDirection) ? source.flowDirection : 'right',
        lanes,
        rails: normalizeLayoutItems(source.rails, 'rail')
    };
}

function normalizeDevice(device) {
    const instanceConfig = safeObject(device?.instance_config);
    return {
        id: shortText(device?.id, 120),
        name: shortText(device?.name || device?.id, 180),
        line_id: shortText(device?.line_id, 120),
        model_type: shortText(device?.model_type || 'builtin_furnace', 160),
        pos_x: finiteNumber(device?.pos_x, 0),
        pos_y: finiteNumber(device?.pos_y, 0),
        pos_z: finiteNumber(device?.pos_z, 0),
        rotation_y: finiteNumber(device?.rotation_y, 0, -100000, 100000),
        scale: finiteNumber(device?.scale, 1, 0.0001, 1000),
        instance_config: instanceConfig
    };
}

function normalizeFocus(value) {
    const source = safeObject(value);
    const mode = ['factory', 'workshop', 'line', 'device'].includes(source.mode) ? source.mode : 'factory';
    return {
        mode,
        workshopId: shortText(source.workshopId, 120),
        lineId: shortText(source.lineId, 120),
        deviceId: shortText(source.deviceId, 120)
    };
}

module.exports = function createNativePreviewRouter(controller) {
    const router = express.Router();

    router.get('/status', (req, res) => {
        res.json({
            success: true,
            unityClients: controller.wsServer?.countClients?.('unity') || 0,
            timestamp: Date.now()
        });
    });

    router.post('/', (req, res) => {
        const action = ['apply', 'reset', 'reload', 'camera'].includes(req.body?.action)
            ? req.body.action
            : 'apply';
        const devices = (Array.isArray(req.body?.devices) ? req.body.devices : [])
            .slice(0, MAX_DEVICES)
            .map(normalizeDevice)
            .filter(device => device.id);
        const lines = (Array.isArray(req.body?.lines) ? req.body.lines : [])
            .slice(0, MAX_LINES)
            .map(line => ({
                id: shortText(line?.id, 120),
                layout_json: normalizeLayout(line?.layout_json ?? line?.layout)
            }))
            .filter(line => line.id);
        const payload = {
            version: 1,
            action,
            sessionId: shortText(req.body?.sessionId, 120),
            sequence: finiteNumber(req.body?.sequence, 0, 0, Number.MAX_SAFE_INTEGER),
            source: shortText(req.body?.source || 'admin', 80),
            includeLayout: !!req.body?.includeLayout,
            devices,
            lines,
            focus: normalizeFocus(req.body?.focus),
            cameraAction: ['rotateLeft', 'rotateRight', 'zoomIn', 'zoomOut', 'fit'].includes(req.body?.cameraAction)
                ? req.body.cameraAction
                : '',
            timestamp: Date.now()
        };
        const sent = controller.wsServer?.broadcastToRole?.('native_scene_preview', payload, 'unity') || 0;
        res.json({ success: true, sent, unityClients: sent, timestamp: payload.timestamp });
    });

    return router;
};
