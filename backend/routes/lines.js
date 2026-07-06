const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const lines = await db.all('SELECT * FROM `lines` ORDER BY sort_order ASC');
        res.json(lines);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const { id, name, workshop_id, sort_order } = req.body;
    if (!id || !name || !workshop_id) {
        return res.status(400).json({ error: '产线ID、名称和所属车间不能为空' });
    }
    try {
        const db = await getDb();
        await db.run('INSERT INTO `lines` (id, name, workshop_id, sort_order) VALUES (?, ?, ?, ?)', [id, name, workshop_id, sort_order || 0]);
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const { name, workshop_id, sort_order } = req.body;
    try {
        const db = await getDb();
        await db.run('UPDATE `lines` SET name = ?, workshop_id = ?, sort_order = ? WHERE id = ?', [name, workshop_id, sort_order || 0, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        await db.transaction(async (tx) => {
            await tx.run('DELETE FROM data_points WHERE device_id IN (SELECT id FROM devices WHERE line_id = ?)', [req.params.id]);
            await tx.run('DELETE FROM devices WHERE line_id = ?', [req.params.id]);
            await tx.run('DELETE FROM `lines` WHERE id = ?', [req.params.id]);
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
