const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function numberWithDefault(value, defaultValue) {
    return value === undefined || value === null || value === '' ? defaultValue : Number(value);
}

function boolWithDefault(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    const text = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(text) ? 1 : 0;
}

function stringifyJson(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value || {});
}

function parseJson(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return {};
    }
}

function isAuxiliaryDevice(modelType, instanceConfig) {
    const config = parseJson(instanceConfig);
    return modelType === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true;
}

function restartDataEngineSoon(reason) {
    if (!global.dataEngine?.restart) return;
    setTimeout(() => {
        global.dataEngine.restart().catch(e => {
            console.warn(`[Devices] 数据引擎重启失败(${reason}):`, e.message);
        });
    }, 80);
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const { line_id } = req.query;
        const devices = line_id
            ? await db.all('SELECT * FROM devices WHERE line_id = ? ORDER BY sort_order ASC', [line_id])
            : await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC');
        res.json(devices);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const device = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!device) return res.status(404).json({ error: '设备不存在' });

        const dataPoints = await db.all('SELECT * FROM data_points WHERE device_id = ?', [req.params.id]);
        res.json({ ...device, dataPoints });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const {
        id, name, line_id, model_type, model_file, template_id, instance_config,
        pos_x, pos_y, pos_z, rotation_y, scale, sort_order,
        plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
        plc_timeout, plc_retry_interval, plc_max_retries
    } = req.body;
    const nextModelType = model_type || 'builtin_furnace';
    if (!id || !name) {
        return res.status(400).json({ error: '设备ID和名称不能为空' });
    }
    if (!isAuxiliaryDevice(nextModelType, instance_config) && !line_id) {
        return res.status(400).json({ error: '普通设备必须选择所属产线' });
    }
    try {
        const db = await getDb();
        await db.run(`INSERT INTO devices (
            id, name, line_id, model_type, model_file, template_id, instance_config,
            pos_x, pos_y, pos_z, rotation_y, scale, sort_order,
            plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
            plc_timeout, plc_retry_interval, plc_max_retries
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            name,
            line_id || null,
            nextModelType,
            model_file || null,
            template_id || '',
            stringifyJson(instance_config),
            numberWithDefault(pos_x, 0),
            numberWithDefault(pos_y, 0),
            numberWithDefault(pos_z, 0),
            numberWithDefault(rotation_y, 0),
            numberWithDefault(scale, 1.0),
            numberWithDefault(sort_order, 0),
            boolWithDefault(plc_enabled, 0),
            plc_protocol || 'S7',
            plc_ip || '',
            numberWithDefault(plc_port, 102),
            numberWithDefault(plc_rack, 0),
            numberWithDefault(plc_slot, 1),
            numberWithDefault(plc_timeout, 5000),
            numberWithDefault(plc_retry_interval, 10000),
            numberWithDefault(plc_max_retries, 0)
        ]);
        restartDataEngineSoon('create device');
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const {
        name, line_id, model_type, model_file, template_id, instance_config,
        pos_x, pos_y, pos_z, rotation_y, scale, sort_order,
        plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
        plc_timeout, plc_retry_interval, plc_max_retries
    } = req.body;
    if (!name) return res.status(400).json({ error: '设备名称不能为空' });
    if (!isAuxiliaryDevice(model_type, instance_config) && !line_id) {
        return res.status(400).json({ error: '普通设备必须选择所属产线' });
    }
    try {
        const db = await getDb();
        const existing = await db.get('SELECT id FROM devices WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: '设备不存在，可能已经被删除或 ID 未正确编码' });

        await db.run(`UPDATE devices SET name=?, line_id=?, model_type=?, model_file=?,
            template_id=?, instance_config=?, pos_x=?, pos_y=?, pos_z=?,
            rotation_y=?, scale=?, sort_order=?, plc_enabled=?, plc_protocol=?, plc_ip=?,
            plc_port=?, plc_rack=?, plc_slot=?, plc_timeout=?, plc_retry_interval=?,
            plc_max_retries=? WHERE id=?`, [
            name,
            line_id || null,
            model_type,
            model_file,
            template_id || '',
            stringifyJson(instance_config),
            numberWithDefault(pos_x, 0),
            numberWithDefault(pos_y, 0),
            numberWithDefault(pos_z, 0),
            numberWithDefault(rotation_y, 0),
            numberWithDefault(scale, 1.0),
            numberWithDefault(sort_order, 0),
            boolWithDefault(plc_enabled, 0),
            plc_protocol || 'S7',
            plc_ip || '',
            numberWithDefault(plc_port, 102),
            numberWithDefault(plc_rack, 0),
            numberWithDefault(plc_slot, 1),
            numberWithDefault(plc_timeout, 5000),
            numberWithDefault(plc_retry_interval, 10000),
            numberWithDefault(plc_max_retries, 0),
            req.params.id
        ]);
        restartDataEngineSoon('update device');
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const existing = await db.get('SELECT id FROM devices WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: '设备不存在，可能已经被删除或 ID 未正确编码' });

        await db.transaction(async (tx) => {
            await tx.run('DELETE FROM data_points WHERE device_id = ?', [req.params.id]);
            const result = await tx.run('DELETE FROM devices WHERE id = ?', [req.params.id]);
            if (!result?.affectedRows && !result?.changes) throw new Error('设备删除失败：没有删除到任何记录');
        });
        restartDataEngineSoon('delete device');
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
