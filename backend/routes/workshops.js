const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const workshops = await db.all('SELECT * FROM workshops ORDER BY sort_order ASC');
        res.json(workshops);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const { id, name, sort_order } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: '车间ID和名称不能为空' });
    }
    try {
        const db = await getDb();
        await db.run('INSERT INTO workshops (id, name, sort_order) VALUES (?, ?, ?)', [id, name, sort_order || 0]);
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const { name, sort_order } = req.body;
    try {
        const db = await getDb();
        await db.run('UPDATE workshops SET name = ?, sort_order = ? WHERE id = ?', [name, sort_order || 0, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        await db.transaction(async (tx) => {
            const lines = await tx.all('SELECT id FROM `lines` WHERE workshop_id = ?', [req.params.id]);
            const lineIds = lines.map(line => line.id);
            if (lineIds.length) {
                const placeholders = lineIds.map(() => '?').join(',');
                await tx.run(
                    `DELETE FROM data_points WHERE device_id IN (SELECT id FROM devices WHERE line_id IN (${placeholders}))`,
                    lineIds
                );
                await tx.run(`DELETE FROM devices WHERE line_id IN (${placeholders})`, lineIds);
                await tx.run(`DELETE FROM \`lines\` WHERE id IN (${placeholders})`, lineIds);
            }
            await tx.run('DELETE FROM workshops WHERE id = ?', [req.params.id]);
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
