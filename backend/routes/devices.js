const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/devices - 获取所有设备（可按产线过滤）
router.get('/', (req, res) => {
    const db = getDb();
    const { line_id } = req.query;
    let devices;
    if (line_id) {
        devices = db.prepare('SELECT * FROM devices WHERE line_id = ? ORDER BY sort_order ASC').all(line_id);
    } else {
        devices = db.prepare('SELECT * FROM devices ORDER BY line_id, sort_order ASC').all();
    }
    res.json(devices);
});

// GET /api/devices/:id - 获取单个设备详情（含点位映射）
router.get('/:id', (req, res) => {
    const db = getDb();
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
    if (!device) return res.status(404).json({ error: '设备不存在' });
    
    const dataPoints = db.prepare('SELECT * FROM data_points WHERE device_id = ?').all(req.params.id);
    res.json({ ...device, dataPoints });
});

// POST /api/devices - 创建设备
router.post('/', (req, res) => {
    const db = getDb();
    const { id, name, line_id, model_type, model_file, pos_x, pos_y, pos_z, rotation_y, scale, sort_order } = req.body;
    if (!id || !name || !line_id) {
        return res.status(400).json({ error: '设备ID、名称和所属产线不能为空' });
    }
    try {
        db.prepare(`INSERT INTO devices (id, name, line_id, model_type, model_file, pos_x, pos_y, pos_z, rotation_y, scale, sort_order) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, name, line_id, 
            model_type || 'builtin_furnace', 
            model_file || null,
            pos_x || 0, pos_y || 0, pos_z || 0, 
            rotation_y || 0, scale || 1.0, sort_order || 0
        );
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/devices/:id - 更新设备
router.put('/:id', (req, res) => {
    const db = getDb();
    const { name, line_id, model_type, model_file, pos_x, pos_y, pos_z, rotation_y, scale, sort_order } = req.body;
    db.prepare(`UPDATE devices SET name=?, line_id=?, model_type=?, model_file=?, 
                pos_x=?, pos_y=?, pos_z=?, rotation_y=?, scale=?, sort_order=? WHERE id=?`).run(
        name, line_id, model_type, model_file,
        pos_x || 0, pos_y || 0, pos_z || 0,
        rotation_y || 0, scale || 1.0, sort_order || 0,
        req.params.id
    );
    res.json({ success: true });
});

// DELETE /api/devices/:id - 删除设备
router.delete('/:id', (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
