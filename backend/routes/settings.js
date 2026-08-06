const express = require('express');
const { getDb } = require('../db/database');

const MAX_DASHBOARD_CONFIG_BYTES = 256 * 1024;
const JSON_OBJECT_SETTING_LABELS = {
    native_dashboard_config: 'Unity 大屏组件配置',
    native_environment_config: 'Unity 场景与光效配置'
};

function normalizeSettingValue(key, value) {
    const label = JSON_OBJECT_SETTING_LABELS[key];
    if (!label) return String(value);

    const text = typeof value === 'string' ? value : JSON.stringify(value || {});
    if (Buffer.byteLength(text, 'utf8') > MAX_DASHBOARD_CONFIG_BYTES) {
        throw new Error(`${label}过大`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`${label}不是有效 JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label}必须是 JSON 对象`);
    }
    return JSON.stringify(parsed);
}

module.exports = function createSettingsRouter(controller = {}) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const db = await getDb();
            const rows = await db.all('SELECT * FROM settings');
            const settings = {};
            rows.forEach(r => { settings[r.key] = r.value; });
            res.json(settings);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.put('/', async (req, res) => {
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                throw new Error('设置内容必须是 JSON 对象');
            }
            const db = await getDb();
            const changed = {};
            for (const [key, value] of Object.entries(req.body)) {
                const normalized = normalizeSettingValue(key, value);
                await db.upsert('settings', { key, value: normalized }, 'key');
                changed[key] = normalized;
            }
            controller.wsServer?.broadcast('configuration_changed', {
                keys: Object.keys(changed),
                settings: changed,
                timestamp: Date.now()
            });
            res.json({ success: true, changedKeys: Object.keys(changed) });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    return router;
};
