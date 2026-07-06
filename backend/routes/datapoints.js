const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function nullableNumber(value) {
    return value === undefined || value === null || value === '' ? null : Number(value);
}

function numberWithDefault(value, defaultValue) {
    return value === undefined || value === null || value === '' ? defaultValue : Number(value);
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const { device_id } = req.query;
        const points = device_id
            ? await db.all('SELECT * FROM data_points WHERE device_id = ?', [device_id])
            : await db.all('SELECT * FROM data_points ORDER BY device_id');
        res.json(points);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const {
        device_id, name, label, plc_tag, data_type, category, value_role,
        quality, scale, offset, expression, display_format, unit,
        sample_interval_ms, access_type, db_number, db_byte_offset, bit_offset,
        alarm_high, alarm_low
    } = req.body;
    if (!device_id || !name || !label || (!plc_tag && (db_number === undefined || db_byte_offset === undefined))) {
        return res.status(400).json({ error: '设备ID、数据项名称、显示标签和PLC地址不能为空' });
    }
    try {
        const db = await getDb();
        const result = await db.run(`INSERT INTO data_points (
            device_id, name, label, plc_tag, data_type, category, value_role,
            quality, scale, offset, expression, display_format, unit,
            sample_interval_ms, access_type, db_number, db_byte_offset, bit_offset,
            alarm_high, alarm_low
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            device_id,
            name,
            label,
            plc_tag || '',
            data_type || 'WORD',
            category || '',
            value_role || '',
            quality || 'good',
            numberWithDefault(scale, 1),
            numberWithDefault(offset, 0),
            expression || '',
            display_format || '',
            unit || '',
            numberWithDefault(sample_interval_ms, 1000),
            access_type || 'READ',
            nullableNumber(db_number),
            nullableNumber(db_byte_offset),
            nullableNumber(bit_offset),
            nullableNumber(alarm_high),
            nullableNumber(alarm_low)
        ]);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const {
        name, label, plc_tag, data_type, category, value_role,
        quality, scale, offset, expression, display_format, unit,
        sample_interval_ms, access_type, db_number, db_byte_offset, bit_offset,
        alarm_high, alarm_low
    } = req.body;
    try {
        const db = await getDb();
        await db.run(`UPDATE data_points SET
            name=?, label=?, plc_tag=?, data_type=?, category=?, value_role=?, quality=?,
            scale=?, offset=?, expression=?, display_format=?, unit=?, sample_interval_ms=?,
            access_type=?, db_number=?, db_byte_offset=?, bit_offset=?, alarm_high=?, alarm_low=?
            WHERE id=?`, [
            name,
            label,
            plc_tag || '',
            data_type || 'WORD',
            category || '',
            value_role || '',
            quality || 'good',
            numberWithDefault(scale, 1),
            numberWithDefault(offset, 0),
            expression || '',
            display_format || '',
            unit || '',
            numberWithDefault(sample_interval_ms, 1000),
            access_type || 'READ',
            nullableNumber(db_number),
            nullableNumber(db_byte_offset),
            nullableNumber(bit_offset),
            nullableNumber(alarm_high),
            nullableNumber(alarm_low),
            req.params.id
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        await db.run('DELETE FROM data_points WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/batch', async (req, res) => {
    const { device_id, points } = req.body;
    if (!device_id || !Array.isArray(points)) {
        return res.status(400).json({ error: '需要 device_id 和 points 数组' });
    }

    try {
        const db = await getDb();
        await db.transaction(async (tx) => {
            await tx.run('DELETE FROM data_points WHERE device_id = ?', [device_id]);
            for (const p of points) {
                await tx.run(`INSERT INTO data_points (
                    device_id, name, label, plc_tag, data_type, category, value_role,
                    quality, scale, offset, expression, display_format, unit,
                    sample_interval_ms, access_type, db_number, db_byte_offset, bit_offset,
                    alarm_high, alarm_low
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    device_id,
                    p.name,
                    p.label,
                    p.plc_tag || '',
                    p.data_type || 'WORD',
                    p.category || '',
                    p.value_role || '',
                    p.quality || 'good',
                    numberWithDefault(p.scale, 1),
                    numberWithDefault(p.offset, 0),
                    p.expression || '',
                    p.display_format || '',
                    p.unit || '',
                    numberWithDefault(p.sample_interval_ms, 1000),
                    p.access_type || 'READ',
                    nullableNumber(p.db_number),
                    nullableNumber(p.db_byte_offset),
                    nullableNumber(p.bit_offset),
                    nullableNumber(p.alarm_high),
                    nullableNumber(p.alarm_low)
                ]);
            }
        });
        res.json({ success: true, count: points.length });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
