const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function nullableNumber(value) {
    return value === undefined || value === null || value === '' ? null : Number(value);
}

function numberWithDefault(value, defaultValue) {
    return value === undefined || value === null || value === '' ? defaultValue : Number(value);
}

// GET /api/datapoints?device_id=xxx - 获取设备的所有点位映射
router.get('/', (req, res) => {
    const db = getDb();
    const { device_id } = req.query;
    let points;
    if (device_id) {
        points = db.prepare('SELECT * FROM data_points WHERE device_id = ?').all(device_id);
    } else {
        points = db.prepare('SELECT * FROM data_points ORDER BY device_id').all();
    }
    res.json(points);
});

// POST /api/datapoints - 创建点位映射
router.post('/', (req, res) => {
    const db = getDb();
    const {
        device_id, name, label, plc_tag, data_type, category, value_role,
        scale, offset, display_format, unit, alarm_high, alarm_low
    } = req.body;
    if (!device_id || !name || !label || !plc_tag) {
        return res.status(400).json({ error: '设备ID、数据项名称、显示标签和PLC地址不能为空' });
    }
    try {
        const result = db.prepare(`INSERT INTO data_points (
                        device_id, name, label, plc_tag, data_type, category, value_role,
                        scale, offset, display_format, unit, alarm_high, alarm_low
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            device_id, name, label, plc_tag,
            data_type || 'WORD',
            category || '',
            value_role || '',
            numberWithDefault(scale, 1),
            numberWithDefault(offset, 0),
            display_format || '',
            unit || '',
            nullableNumber(alarm_high),
            nullableNumber(alarm_low)
        );
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/datapoints/:id - 更新点位映射
router.put('/:id', (req, res) => {
    const db = getDb();
    const {
        name, label, plc_tag, data_type, category, value_role,
        scale, offset, display_format, unit, alarm_high, alarm_low
    } = req.body;
    db.prepare(`UPDATE data_points SET
                name=?, label=?, plc_tag=?, data_type=?, category=?, value_role=?,
                scale=?, offset=?, display_format=?, unit=?, alarm_high=?, alarm_low=?
                WHERE id=?`).run(
        name, label, plc_tag, data_type || 'WORD',
        category || '',
        value_role || '',
        numberWithDefault(scale, 1),
        numberWithDefault(offset, 0),
        display_format || '',
        unit || '',
        nullableNumber(alarm_high),
        nullableNumber(alarm_low),
        req.params.id
    );
    res.json({ success: true });
});

// DELETE /api/datapoints/:id - 删除点位映射
router.delete('/:id', (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM data_points WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// POST /api/datapoints/batch - 批量保存某设备的所有点位（先删后插）
router.post('/batch', (req, res) => {
    const db = getDb();
    const { device_id, points } = req.body;
    if (!device_id || !Array.isArray(points)) {
        return res.status(400).json({ error: '需要 device_id 和 points 数组' });
    }

    const batchSave = db.transaction(() => {
        db.prepare('DELETE FROM data_points WHERE device_id = ?').run(device_id);
        const insert = db.prepare(`INSERT INTO data_points (
                                    device_id, name, label, plc_tag, data_type, category, value_role,
                                    scale, offset, display_format, unit, alarm_high, alarm_low
                                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const p of points) {
            insert.run(
                device_id,
                p.name,
                p.label,
                p.plc_tag,
                p.data_type || 'WORD',
                p.category || '',
                p.value_role || '',
                numberWithDefault(p.scale, 1),
                numberWithDefault(p.offset, 0),
                p.display_format || '',
                p.unit || '',
                nullableNumber(p.alarm_high),
                nullableNumber(p.alarm_low)
            );
        }
    });

    try {
        batchSave();
        res.json({ success: true, count: points.length });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
