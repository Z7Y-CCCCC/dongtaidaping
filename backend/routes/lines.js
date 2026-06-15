const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/lines - 获取所有产线
router.get('/', (req, res) => {
    const db = getDb();
    const lines = db.prepare('SELECT * FROM lines ORDER BY sort_order ASC').all();
    res.json(lines);
});

// POST /api/lines - 创建产线
router.post('/', (req, res) => {
    const db = getDb();
    const { id, name, workshop_id, sort_order } = req.body;
    if (!id || !name || !workshop_id) {
        return res.status(400).json({ error: '产线ID、名称和所属车间不能为空' });
    }
    try {
        db.prepare('INSERT INTO lines (id, name, workshop_id, sort_order) VALUES (?, ?, ?, ?)').run(id, name, workshop_id, sort_order || 0);
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/lines/:id - 更新产线
router.put('/:id', (req, res) => {
    const db = getDb();
    const { name, workshop_id, sort_order } = req.body;
    db.prepare('UPDATE lines SET name = ?, workshop_id = ?, sort_order = ? WHERE id = ?').run(name, workshop_id, sort_order || 0, req.params.id);
    res.json({ success: true });
});

// DELETE /api/lines/:id - 删除产线（级联删除设备和点位）
router.delete('/:id', (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM lines WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
