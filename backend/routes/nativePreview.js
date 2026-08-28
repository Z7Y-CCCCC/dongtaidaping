const express = require('express');
const { normalizeWorkshopLayout, normalizeLineLayout } = require('../utils/spatialLayout');

const MAX_DEVICES = 500;
const MAX_LINES = 120;
const MAX_WORKSHOPS = 40;

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
        coordinate_space: ['line_local', 'workshop_local'].includes(device?.coordinate_space)
            ? device.coordinate_space
            : 'line_local',
        instance_config: instanceConfig
    };
}

function normalizeFocus(value) {
    const source = safeObject(value);
    const mode = ['factory', 'workshop', 'line', 'device', 'custom'].includes(source.mode) ? source.mode : 'factory';
    return {
        mode,
        workshopId: shortText(source.workshopId, 120),
        lineId: shortText(source.lineId, 120),
        deviceId: shortText(source.deviceId, 120),
        inspectionStage: shortText(source.inspectionStage, 32),
        partId: shortText(source.partId, 128)
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
        const action = ['apply', 'reset', 'reload', 'camera', 'focus', 'view', 'inspection_back'].includes(req.body?.action)
            ? req.body.action
            : 'apply';
        const normalizedLines = (Array.isArray(req.body?.lines) ? req.body.lines : [])
            .slice(0, MAX_LINES)
            .map(line => ({
                id: shortText(line?.id, 120),
                workshop_id: shortText(line?.workshop_id, 120),
                layout_json: normalizeLineLayout(line?.layout_json ?? line?.layout)
            }))
            .filter(line => line.id);
        const pendingLineIds = new Set(
            normalizedLines.filter(line => line.layout_json.placementPending).map(line => String(line.id))
        );
        const lines = normalizedLines.filter(line => !line.layout_json.placementPending);
        const devices = (Array.isArray(req.body?.devices) ? req.body.devices : [])
            .slice(0, MAX_DEVICES)
            .map(normalizeDevice)
            .filter(device => {
                if (!device.id) return false;
                const config = safeObject(device.instance_config);
                return !pendingLineIds.has(String(device.line_id || ''))
                    && !pendingLineIds.has(String(config.laneLineId || ''))
                    && !pendingLineIds.has(String(config.railLineId || ''));
            });
        const workshops = (Array.isArray(req.body?.workshops) ? req.body.workshops : [])
            .slice(0, MAX_WORKSHOPS)
            .map(workshop => ({
                id: shortText(workshop?.id, 120),
                layout_json: normalizeWorkshopLayout(workshop?.layout_json ?? workshop?.layout)
            }))
            .filter(workshop => workshop.id);
        const payload = {
            version: 2,
            action,
            sessionId: shortText(req.body?.sessionId, 120),
            sequence: finiteNumber(req.body?.sequence, 0, 0, Number.MAX_SAFE_INTEGER),
            source: shortText(req.body?.source || 'admin', 80),
            viewId: shortText(req.body?.viewId, 128),
            view: safeObject(req.body?.view),
            includeLayout: !!req.body?.includeLayout,
            devices,
            lines,
            workshops,
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
