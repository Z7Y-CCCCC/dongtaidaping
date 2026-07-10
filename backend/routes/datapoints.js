const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function nullableNumber(value) {
    return value === undefined || value === null || value === '' ? null : Number(value);
}

function numberWithDefault(value, defaultValue) {
    return value === undefined || value === null || value === '' ? defaultValue : Number(value);
}

function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === '';
}

const ALLOWED_DATA_TYPES = new Set(['BOOL', 'BYTE', 'WORD', 'INT', 'DWORD', 'DINT', 'REAL', 'LREAL', 'STRING', 'CHAR', 'DT', 'DTZ', 'DTL', 'DTLZ']);
const ALLOWED_ACCESS_TYPES = new Set(['READ', 'READ_WRITE', 'WRITE']);

function simpleHash(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function pointDisplayName(point) {
    return String(point.label || point.point_name || point.display_name || point.name || '').trim();
}

function toInternalPointName(label, fallback = '') {
    const raw = String(label || '').trim();
    const ascii = raw
        .replace(/[\u4e00-\u9fa5]+/g, '')
        .replace(/[^a-zA-Z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
    if (ascii) return ascii.slice(0, 96);
    return `point_${simpleHash(raw || fallback || Date.now())}`;
}

function normalizeUsage(point) {
    const role = String(point.alarm_record_role || point.value_role || point.name || '').trim().toLowerCase();
    if (role === 'txt_record' || role === 'alarm_text_record') return 'alarm_text_record';
    if (role === 'date1_record' || role === 'alarm_start_record') return 'alarm_start_record';
    if (role === 'date2_record' || role === 'alarm_end_record') return 'alarm_end_record';
    if (role === 'num_record' || role === 'alarm_number_record') return 'alarm_number_record';
    if (role === 'state_record' || role === 'alarm_state_record') return 'alarm_state_record';
    if (point.point_kind === 'alarm' || point.is_alarm || /^bj\d+$/i.test(String(point.name || point.label || '').trim())) return 'alarm_trigger';
    return 'normal';
}

function roleFromUsage(usage, internalName) {
    if (usage === 'alarm_text_record') return 'txt_record';
    if (usage === 'alarm_start_record') return 'date1_record';
    if (usage === 'alarm_end_record') return 'date2_record';
    if (usage === 'alarm_number_record') return 'num_record';
    if (usage === 'alarm_state_record') return 'state_record';
    return internalName;
}

function inferCategory(point, usage) {
    if (usage !== 'normal') return 'status';
    const name = pointDisplayName(point).toLowerCase();
    const type = String(point.data_type || '').toUpperCase();
    if (type === 'BOOL' || name.includes('报警') || name.includes('故障') || name.includes('状态') || name.includes('运行')) return 'status';
    if (name.includes('气') || name.includes('阀') || name.includes('流量')) return 'gas';
    if (name.includes('门')) return 'doors';
    if (name.includes('风机') || name.includes('风扇') || name.includes('搅拌') || name.includes('泵') || name.includes('电机')) return 'motors';
    if (name.includes('链') || name.includes('推') || name.includes('拉') || name.includes('机构')) return 'mechanisms';
    return 'analog';
}

function normalizePointPayload(point, fallback = '') {
    const displayName = pointDisplayName(point);
    const usage = normalizeUsage(point);
    const internalName = String(point.name || '').trim() || toInternalPointName(displayName, fallback);
    const dataType = String(point.data_type || 'WORD').toUpperCase();
    const accessType = String(point.access_type || 'READ').toUpperCase();
    const role = roleFromUsage(usage, internalName);
    const plcTag = String(point.plc_tag || '').trim();

    return {
        ...point,
        name: internalName,
        label: displayName,
        plc_tag: plcTag,
        data_type: dataType,
        category: point.category || inferCategory(point, usage),
        value_role: point.value_role || role,
        quality: point.quality || 'good',
        scale: numberWithDefault(point.scale, 1),
        offset: numberWithDefault(point.offset, 0),
        expression: point.expression || '',
        display_format: point.display_format || '',
        unit: dataType === 'BOOL' ? '' : (point.unit || ''),
        sample_interval_ms: numberWithDefault(point.sample_interval_ms, 1000),
        access_type: accessType,
        db_number: plcTag ? null : nullableNumber(point.db_number),
        db_byte_offset: plcTag ? null : nullableNumber(point.db_byte_offset),
        bit_offset: plcTag ? null : nullableNumber(point.bit_offset),
        point_kind: usage === 'normal' ? 'normal' : 'alarm',
        alarm_record_role: usage === 'normal' || usage === 'alarm_trigger' ? '' : role,
        alarm_text: String(point.alarm_text || '').trim(),
        alarm_level: point.alarm_level || 'WARNING',
        alarm_condition: point.alarm_condition || '=1',
        alarm_high: nullableNumber(point.alarm_high),
        alarm_low: nullableNumber(point.alarm_low)
    };
}

function validatePointPayload(point, rowLabel = '点位') {
    const errors = [];
    const normalized = normalizePointPayload(point, rowLabel);

    if (isBlank(normalized.label)) errors.push(`${rowLabel}: 点位名称不能为空`);

    const hasPlcTag = !isBlank(normalized.plc_tag);
    const hasDbNumber = !isBlank(normalized.db_number);
    const hasDbByte = !isBlank(normalized.db_byte_offset);
    if (!hasPlcTag && (!hasDbNumber || !hasDbByte)) {
        errors.push(`${rowLabel}: 必须填写 PLC 地址`);
    }
    if (['STRING', 'CHAR'].includes(normalized.data_type) && !hasPlcTag) {
        errors.push(`${rowLabel}: 文本点位请填写完整 PLC 地址，例如 DB10,S20.30`);
    }

    if (!hasPlcTag && hasDbNumber) {
        const dbNumber = Number(normalized.db_number);
        if (!Number.isInteger(dbNumber) || dbNumber < 0) errors.push(`${rowLabel}: DB块必须是大于等于 0 的整数`);
    }
    if (!hasPlcTag && hasDbByte) {
        const dbByte = Number(normalized.db_byte_offset);
        if (!Number.isInteger(dbByte) || dbByte < 0) errors.push(`${rowLabel}: 字节必须是大于等于 0 的整数`);
    }
    if (!hasPlcTag && !isBlank(normalized.bit_offset)) {
        const bit = Number(normalized.bit_offset);
        if (!Number.isInteger(bit) || bit < 0 || bit > 7) errors.push(`${rowLabel}: 位偏移必须是 0-7 的整数`);
    }

    if (!ALLOWED_DATA_TYPES.has(normalized.data_type)) errors.push(`${rowLabel}: 数据类型不正确`);

    const interval = Number(normalized.sample_interval_ms ?? 1000);
    if (!Number.isFinite(interval) || interval < 100 || interval > 60000) {
        errors.push(`${rowLabel}: 采集周期必须在 100-60000ms 之间`);
    }

    if (!ALLOWED_ACCESS_TYPES.has(normalized.access_type)) errors.push(`${rowLabel}: 读写类型不正确`);

    return errors;
}

function restartDataEngineSoon(reason) {
    if (!global.dataEngine?.restart) return;
    setTimeout(() => {
        global.dataEngine.restart().catch(e => {
            console.warn(`[DataPoints] 数据引擎重启失败(${reason}):`, e.message);
        });
    }, 80);
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
    const device_id = req.body.device_id;
    if (!device_id) {
        return res.status(400).json({ error: '设备ID不能为空' });
    }
    const validationErrors = validatePointPayload(req.body);
    if (validationErrors.length) {
        return res.status(400).json({ error: validationErrors.join('\n') });
    }
    const point = normalizePointPayload(req.body, device_id);
    try {
        const db = await getDb();
        const result = await db.run(`INSERT INTO data_points (
            device_id, name, label, plc_tag, data_type, category, value_role,
            quality, scale, offset, expression, display_format, unit,
            sample_interval_ms, access_type, db_number, db_byte_offset, bit_offset,
            point_kind, alarm_record_role, alarm_text, alarm_level, alarm_condition,
            alarm_high, alarm_low
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            device_id,
            point.name,
            point.label,
            point.plc_tag,
            point.data_type,
            point.category,
            point.value_role,
            point.quality,
            point.scale,
            point.offset,
            point.expression,
            point.display_format,
            point.unit,
            point.sample_interval_ms,
            point.access_type,
            point.db_number,
            point.db_byte_offset,
            point.bit_offset,
            point.point_kind,
            point.alarm_record_role,
            point.alarm_text,
            point.alarm_level,
            point.alarm_condition,
            point.alarm_high,
            point.alarm_low
        ]);
        restartDataEngineSoon('create data point');
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const validationErrors = validatePointPayload(req.body);
    if (validationErrors.length) {
        return res.status(400).json({ error: validationErrors.join('\n') });
    }
    const point = normalizePointPayload(req.body, req.params.id);
    try {
        const db = await getDb();
        const existing = await db.get('SELECT id FROM data_points WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: '点位不存在，可能已经被删除或 ID 未正确编码' });

        await db.run(`UPDATE data_points SET
            name=?, label=?, plc_tag=?, data_type=?, category=?, value_role=?, quality=?,
            scale=?, offset=?, expression=?, display_format=?, unit=?, sample_interval_ms=?,
            access_type=?, db_number=?, db_byte_offset=?, bit_offset=?,
            point_kind=?, alarm_record_role=?, alarm_text=?, alarm_level=?, alarm_condition=?,
            alarm_high=?, alarm_low=?
            WHERE id=?`, [
            point.name,
            point.label,
            point.plc_tag,
            point.data_type,
            point.category,
            point.value_role,
            point.quality,
            point.scale,
            point.offset,
            point.expression,
            point.display_format,
            point.unit,
            point.sample_interval_ms,
            point.access_type,
            point.db_number,
            point.db_byte_offset,
            point.bit_offset,
            point.point_kind,
            point.alarm_record_role,
            point.alarm_text,
            point.alarm_level,
            point.alarm_condition,
            point.alarm_high,
            point.alarm_low,
            req.params.id
        ]);
        restartDataEngineSoon('update data point');
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const existing = await db.get('SELECT id FROM data_points WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: '点位不存在，可能已经被删除或 ID 未正确编码' });

        await db.run('DELETE FROM data_points WHERE id = ?', [req.params.id]);
        restartDataEngineSoon('delete data point');
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

    const validationErrors = [];
    points.forEach((point, index) => {
        validationErrors.push(...validatePointPayload(point, `第 ${index + 1} 行`));
    });
    if (validationErrors.length) {
        return res.status(400).json({ error: validationErrors.join('\n') });
    }

    try {
        const db = await getDb();
        const device = await db.get('SELECT id FROM devices WHERE id = ?', [device_id]);
        if (!device) return res.status(404).json({ error: '设备不存在，无法保存点位配置' });

        await db.transaction(async (tx) => {
            await tx.run('DELETE FROM data_points WHERE device_id = ?', [device_id]);
            for (let index = 0; index < points.length; index += 1) {
                const p = normalizePointPayload(points[index], `${device_id}_${index + 1}`);
                await tx.run(`INSERT INTO data_points (
                    device_id, name, label, plc_tag, data_type, category, value_role,
                    quality, scale, offset, expression, display_format, unit,
                    sample_interval_ms, access_type, db_number, db_byte_offset, bit_offset,
                    point_kind, alarm_record_role, alarm_text, alarm_level, alarm_condition,
                    alarm_high, alarm_low
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    device_id,
                    p.name,
                    p.label,
                    p.plc_tag,
                    p.data_type,
                    p.category,
                    p.value_role,
                    p.quality,
                    p.scale,
                    p.offset,
                    p.expression,
                    p.display_format,
                    p.unit,
                    p.sample_interval_ms,
                    p.access_type,
                    p.db_number,
                    p.db_byte_offset,
                    p.bit_offset,
                    p.point_kind,
                    p.alarm_record_role,
                    p.alarm_text,
                    p.alarm_level,
                    p.alarm_condition,
                    p.alarm_high,
                    p.alarm_low
                ]);
            }
        });
        restartDataEngineSoon('save data point batch');
        res.json({ success: true, count: points.length });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
