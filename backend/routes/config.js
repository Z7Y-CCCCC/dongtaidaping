const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { mergeBuiltinModels } = require('../services/builtinModels');

function safeJsonParse(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function isAuxiliaryDevice(device) {
    const config = safeJsonParse(device?.instance_config, {});
    return device?.model_type === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true;
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();

        const settingsRows = await db.all('SELECT * FROM settings');
        const settings = {};
        settingsRows.forEach(r => { settings[r.key] = r.value; });

        const workshops = await db.all('SELECT * FROM workshops ORDER BY sort_order ASC');
        const lines = await db.all('SELECT * FROM `lines` ORDER BY sort_order ASC');
        const allDevices = await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC');
        const allPoints = await db.all('SELECT * FROM data_points ORDER BY device_id');

        const pointsByDevice = {};
        allPoints.forEach(p => {
            if (!pointsByDevice[p.device_id]) pointsByDevice[p.device_id] = [];
            pointsByDevice[p.device_id].push(p);
        });

        const linesWithDevices = lines.map(line => {
            const devices = allDevices
                .filter(d => d.line_id === line.id && !isAuxiliaryDevice(d))
                .map(d => ({
                    ...d,
                    dataPoints: pointsByDevice[d.id] || []
                }));
            return { ...line, devices };
        });

        const workshopsWithLines = workshops.map(ws => {
            const wsLines = linesWithDevices.filter(l => l.workshop_id === ws.id);
            const wsLineIds = new Set(wsLines.map(line => line.id));
            const devices = allDevices
                .filter(d => {
                    if (!isAuxiliaryDevice(d)) return false;
                    const config = safeJsonParse(d.instance_config, {});
                    return config.workshop_id === ws.id
                        || config.workshopId === ws.id
                        || (d.line_id && wsLineIds.has(d.line_id));
                })
                .map(d => ({
                    ...d,
                    dataPoints: pointsByDevice[d.id] || []
                }));
            return { ...ws, lines: wsLines, devices };
        });

        const models = mergeBuiltinModels(await db.all('SELECT * FROM models'));
        const activeProject = await db.get('SELECT * FROM projects WHERE is_active = 1 LIMIT 1')
            || await db.get('SELECT * FROM projects ORDER BY created_at ASC LIMIT 1');
        const activeScene = activeProject
            ? (await db.get('SELECT * FROM scenes WHERE project_id = ? AND is_active = 1 LIMIT 1', [activeProject.id])
                || await db.get('SELECT * FROM scenes WHERE project_id = ? ORDER BY sort_order ASC LIMIT 1', [activeProject.id]))
            : null;
        const widgets = activeScene
            ? await db.all('SELECT * FROM widgets WHERE scene_id = ? ORDER BY sort_order ASC', [activeScene.id])
            : [];

        res.json({
            settings,
            workshops: workshopsWithLines,
            models,
            platform: {
                activeProject,
                activeScene: activeScene ? {
                    ...activeScene,
                    layout: safeJsonParse(activeScene.layout_json, {}),
                    camera: safeJsonParse(activeScene.camera_json, {}),
                    theme: safeJsonParse(activeScene.theme_json, {})
                } : null,
                widgets: widgets.map(widget => ({
                    ...widget,
                    config: safeJsonParse(widget.config_json, {}),
                    binding: safeJsonParse(widget.binding_json, {})
                }))
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
