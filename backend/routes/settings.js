const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/settings - 获取所有设置
router.get('/', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
});

// PUT /api/settings - 批量更新设置
router.put('/', (req, res) => {
    const db = getDb();
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const batchUpdate = db.transaction((entries) => {
        for (const [key, value] of entries) {
            upsert.run(key, String(value));
        }
    });

    try {
        batchUpdate(Object.entries(req.body));
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
