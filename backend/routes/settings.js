const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

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
        const db = await getDb();
        for (const [key, value] of Object.entries(req.body)) {
            await db.upsert('settings', { key, value: String(value) }, 'key');
        }
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
