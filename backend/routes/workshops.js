const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/workshops - 获取所有车间
router.get('/', (req, res) => {
    const db = getDb();
    const workshops = db.prepare('SELECT * FROM workshops ORDER BY sort_order ASC').all();
    res.json(workshops);
});

// POST /api/workshops - 创建车间
router.post('/', (req, res) => {
    const db = getDb();
    const { id, name, sort_order } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: '车间ID和名称不能为空' });
    }
    try {
        db.prepare('INSERT INTO workshops (id, name, sort_order) VALUES (?, ?, ?)').run(id, name, sort_order || 0);
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/workshops/:id - 更新车间
router.put('/:id', (req, res) => {
    const db = getDb();
    const { name, sort_order } = req.body;
    try {
        db.prepare('UPDATE workshops SET name = ?, sort_order = ? WHERE id = ?').run(name, sort_order || 0, req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// DELETE /api/workshops/:id - 删除车间
router.delete('/:id', (req, res) => {
    const db = getDb();
    try {
        db.prepare('DELETE FROM workshops WHERE id = ?').run(req.params.id);
        // lines table should have ON DELETE CASCADE or handle logic
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
