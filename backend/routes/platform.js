const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function safeJsonParse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function stringifyJson(value, fallback = {}) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value ?? fallback);
}

function numberOrDefault(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

function loadPlatformSnapshot() {
    const db = getDb();
    const projects = db.prepare('SELECT * FROM projects ORDER BY is_active DESC, created_at ASC').all();
    const activeProject = projects.find(p => p.is_active) || projects[0] || null;
    const scenes = activeProject
        ? db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY is_active DESC, sort_order ASC').all(activeProject.id)
        : [];
    const activeScene = scenes.find(s => s.is_active) || scenes[0] || null;
    const widgets = activeScene
        ? db.prepare('SELECT * FROM widgets WHERE scene_id = ? ORDER BY sort_order ASC').all(activeScene.id)
        : [];
    const widgetIds = widgets.map(w => w.id);
    const bindings = widgetIds.length
        ? db.prepare(`SELECT * FROM bindings WHERE widget_id IN (${widgetIds.map(() => '?').join(',')})`).all(...widgetIds)
        : [];
    const releases = activeProject
        ? db.prepare('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC').all(activeProject.id)
        : [];
    const currentRelease = releases.find(r => r.is_current) || releases[0] || null;
    const assets = db.prepare('SELECT * FROM models ORDER BY created_at DESC').all();
    const deviceTemplates = db.prepare('SELECT * FROM device_templates ORDER BY created_at ASC').all();
    const datapointTemplates = db.prepare('SELECT * FROM datapoint_templates ORDER BY device_template_id, sort_order ASC').all();
    const recentEvents = db.prepare('SELECT * FROM event_logs ORDER BY occurred_at DESC, id DESC LIMIT 20').all();
    const latestMetrics = db.prepare('SELECT * FROM metric_snapshots ORDER BY snapshot_time DESC, id DESC LIMIT 1').get() || null;

    return {
        projects,
        activeProject,
        scenes: scenes.map(scene => ({
            ...scene,
            layout: safeJsonParse(scene.layout_json, {}),
            camera: safeJsonParse(scene.camera_json, {}),
            theme: safeJsonParse(scene.theme_json, {})
        })),
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
        })),
        bindings,
        assets: assets.map(asset => ({
            ...asset,
            tags: safeJsonParse(asset.tags, []),
            metadata: safeJsonParse(asset.metadata, {})
        })),
        deviceTemplates: deviceTemplates.map(template => ({
            ...template,
            default_config: safeJsonParse(template.default_config, {})
        })),
        datapointTemplates,
        releases: releases.map(release => ({
            ...release,
            snapshot: safeJsonParse(release.snapshot_json, {})
        })),
        currentRelease: currentRelease ? {
            ...currentRelease,
            snapshot: safeJsonParse(currentRelease.snapshot_json, {})
        } : null,
        recentEvents,
        latestMetrics
    };
}

router.get('/', (req, res) => {
    res.json(loadPlatformSnapshot());
});

router.put('/scenes/:id', (req, res) => {
    const db = getDb();
    const { name, scene_type, layout, camera, theme, is_active, sort_order } = req.body;
    const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.id);
    if (!scene) return res.status(404).json({ error: '场景不存在' });

    const update = db.prepare(`UPDATE scenes SET
        name = ?, scene_type = ?, layout_json = ?, camera_json = ?, theme_json = ?,
        is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`);

    const tx = db.transaction(() => {
        const activeValue = is_active === undefined ? scene.is_active : (is_active ? 1 : 0);
        if (activeValue) {
            db.prepare('UPDATE scenes SET is_active = 0 WHERE project_id = ?').run(scene.project_id);
        }
        update.run(
            name || scene.name,
            scene_type || scene.scene_type,
            stringifyJson(layout, safeJsonParse(scene.layout_json, {})),
            stringifyJson(camera, safeJsonParse(scene.camera_json, {})),
            stringifyJson(theme, safeJsonParse(scene.theme_json, {})),
            activeValue,
            numberOrDefault(sort_order, scene.sort_order),
            req.params.id
        );
    });

    tx();
    res.json({ success: true });
});

router.put('/widgets/:id', (req, res) => {
    const db = getDb();
    const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
    if (!widget) return res.status(404).json({ error: '组件不存在' });

    const {
        widget_type, title, config, binding, x, y, w, h, sort_order, visible
    } = req.body;

    db.prepare(`UPDATE widgets SET
        widget_type = ?, title = ?, config_json = ?, binding_json = ?,
        x = ?, y = ?, w = ?, h = ?, sort_order = ?, visible = ?
        WHERE id = ?`).run(
        widget_type || widget.widget_type,
        title ?? widget.title,
        stringifyJson(config, safeJsonParse(widget.config_json, {})),
        stringifyJson(binding, safeJsonParse(widget.binding_json, {})),
        numberOrDefault(x, widget.x),
        numberOrDefault(y, widget.y),
        numberOrDefault(w, widget.w),
        numberOrDefault(h, widget.h),
        numberOrDefault(sort_order, widget.sort_order),
        visible === undefined ? widget.visible : (visible === false || visible === 0 ? 0 : 1),
        req.params.id
    );

    res.json({ success: true });
});

router.post('/widgets', (req, res) => {
    const db = getDb();
    const {
        id, scene_id, widget_type, title, config, binding, x, y, w, h, sort_order, visible
    } = req.body;
    if (!id || !scene_id || !widget_type) {
        return res.status(400).json({ error: '组件 ID、场景 ID 和组件类型不能为空' });
    }

    const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(scene_id);
    if (!scene) return res.status(404).json({ error: '场景不存在' });

    try {
        db.prepare(`INSERT INTO widgets (
            id, scene_id, widget_type, title, config_json, binding_json,
            x, y, w, h, sort_order, visible
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id,
            scene_id,
            widget_type,
            title || '',
            stringifyJson(config, {}),
            stringifyJson(binding, {}),
            numberOrDefault(x, 0),
            numberOrDefault(y, 0),
            numberOrDefault(w, 4),
            numberOrDefault(h, 2),
            numberOrDefault(sort_order, 0),
            visible === false || visible === 0 ? 0 : 1
        );
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/widgets/:id', (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM widgets WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

router.post('/events', (req, res) => {
    const db = getDb();
    const { event_type, level, source_id, title, message, value, quality } = req.body;
    if (!title) return res.status(400).json({ error: '事件标题不能为空' });

    const result = db.prepare(`INSERT INTO event_logs (
        event_type, level, source_id, title, message, value, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        event_type || 'manual',
        level || 'info',
        source_id || '',
        title,
        message || '',
        value ?? '',
        quality || 'good'
    );
    res.json({ success: true, id: result.lastInsertRowid });
});

router.get('/events', (req, res) => {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const rows = db.prepare('SELECT * FROM event_logs ORDER BY occurred_at DESC, id DESC LIMIT ?').all(limit);
    res.json(rows);
});

router.get('/metrics/latest', (req, res) => {
    const db = getDb();
    const metrics = db.prepare('SELECT * FROM metric_snapshots ORDER BY snapshot_time DESC, id DESC LIMIT 1').get();
    res.json(metrics || {});
});

module.exports = router;
