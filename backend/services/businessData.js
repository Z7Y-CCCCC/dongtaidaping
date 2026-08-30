const {
    executeReadOnlyQuery,
    resolveConnection
} = require('./dataSources');

const CONTRACT_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const BUSINESS_SECTIONS = Object.freeze({
    batches: {
        label: '批次与工艺执行',
        sourceTables: ['produce_batch', 'produce_batch_step', 'technology_execution'],
        description: '只读读取排产系统中的批次、工艺执行和步骤状态'
    },
    compliance: {
        label: '温度/碳势曲线',
        sourceTables: ['rc_furnace_attr_history'],
        description: '只读读取排产系统归档的温度、碳势等历史信号'
    },
    oee: {
        label: '设备运行统计',
        sourceTables: ['device_statistics_daily', 'production_statistics_daily'],
        description: '展示外部系统已汇总的运行、利用率和批次统计，不在本系统重新计算生产业务数据'
    },
    energy: {
        label: '单批次能耗',
        sourceTables: ['energy_consumption', 'energy_consumption_daily', 'batch_energy'],
        description: '预留外部系统能耗表；未提供标准表时明确显示“暂无数据”'
    },
    maintenance: {
        label: '维护记录',
        sourceTables: ['maintenance_record', 'maintenance_order', 'maintenance_log', 'repair_order'],
        description: '预留外部系统维护记录表；本系统只读展示，不创建或修改维护工单'
    }
});

function boundedLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(MAX_LIMIT, Math.round(parsed)));
}

function safeText(value, max = 240) {
    return String(value ?? '').trim().slice(0, max);
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function queryError(error) {
    const message = safeText(error?.message || error, 180);
    const missingTable = /doesn't exist|does not exist|no such table|invalid object name|undefined table|relation .* does not exist/i.test(message);
    return {
        available: false,
        rows: [],
        errorCode: missingTable ? 'TABLE_NOT_AVAILABLE' : 'QUERY_FAILED',
        message: missingTable ? '外部数据库未提供该类标准数据表' : `外部数据读取失败：${message}`
    };
}

function sqlDialect(connectionId) {
    const connection = resolveConnection(connectionId);
    const type = String(connection.type || 'mysql').toLowerCase();
    return type === 'mariadb' ? 'mysql' : type;
}

function placeholder(type, index) {
    return type === 'postgres' ? `$${index}` : type === 'sqlserver' ? `@p${index}` : '?';
}

function limitClause(type, limit) {
    return type === 'sqlserver' ? ` TOP ${boundedLimit(limit)} ` : ` LIMIT ${boundedLimit(limit)}`;
}

function castIdentifier(column, type) {
    if (type === 'mysql') return `CAST(${column} AS CHAR)`;
    if (type === 'sqlserver') return `CAST(${column} AS VARCHAR(128))`;
    return `CAST(${column} AS TEXT)`;
}

function quoteIdentifier(value, type) {
    const name = String(value || '');
    if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('业务数据表名不合法');
    if (type === 'mysql') return `\`${name}\``;
    if (type === 'sqlserver') return `[${name}]`;
    return `"${name}"`;
}

function normalizeDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function normalizeRows(rows) {
    return (Array.isArray(rows) ? rows : []).map(row => {
        const normalized = {};
        Object.entries(row || {}).forEach(([key, value]) => {
            normalized[key] = value instanceof Date ? value.toISOString() : value;
        });
        return normalized;
    });
}

async function readQuery(connectionId, query, params = []) {
    const rows = await executeReadOnlyQuery(connectionId, query, params);
    return normalizeRows(rows);
}

async function readOptional(connectionId, query, params = []) {
    try {
        const rows = await readQuery(connectionId, query, params);
        return { available: true, rows, fetchedAt: new Date().toISOString() };
    } catch (error) {
        return queryError(error);
    }
}

function normalizeBatch(row) {
    return {
        id: row.id ?? null,
        batchNo: row.batch_no ?? row.batchNo ?? null,
        batchName: row.batch_name ?? row.batchName ?? null,
        productName: row.product_name ?? row.productName ?? null,
        operator: row.operator ?? null,
        workpieceCount: numberOrNull(row.workpiece_count),
        workpieceWeight: numberOrNull(row.workpiece_weight),
        templateId: row.template_id ?? null,
        status: row.status ?? null,
        currentStep: numberOrNull(row.current_step),
        progress: numberOrNull(row.progress),
        planStartTime: normalizeDate(row.plan_start_time),
        actualStartTime: normalizeDate(row.actual_start_time),
        actualFinishTime: normalizeDate(row.actual_finish_time),
        updatedAt: normalizeDate(row.update_time || row.create_time)
    };
}

function normalizeCompliance(row) {
    return {
        deviceId: row.device_id ?? null,
        batchId: row.batch_id ?? null,
        signalId: row.signal_id ?? null,
        signalName: row.signal_name ?? null,
        value: numberOrNull(row.actual_value ?? row.value),
        rawValue: row.actual_value ?? row.value ?? null,
        recordTime: normalizeDate(row.record_time)
    };
}

function normalizeOee(row) {
    return {
        deviceId: row.furnace_id ?? row.device_id ?? null,
        date: normalizeDate(row.stat_date),
        runtimeMinutes: numberOrNull(row.total_runtime),
        idleMinutes: numberOrNull(row.idle_time),
        alarmMinutes: numberOrNull(row.alarm_time),
        offlineMinutes: numberOrNull(row.offline_time),
        batchCount: numberOrNull(row.batch_count),
        alarmCount: numberOrNull(row.alarm_count),
        utilizationRate: numberOrNull(row.utilization_rate),
        // The external schema currently exposes utilization, not a full
        // availability × performance × quality OEE decomposition.
        metricKind: 'utilization_rate'
    };
}

async function readBatches(connectionId, options = {}) {
    const type = sqlDialect(connectionId);
    const limit = boundedLimit(options.limit);
    const params = [];
    let where = '';
    if (options.deviceId) {
        // produce_batch itself has no device column. The scheduling system
        // associates a batch with furnaces in produce_batch_step, so filter
        // through the step table when a furnace/device context is provided.
        params.push(String(options.deviceId));
        where = ` WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier('produce_batch_step', type)} s WHERE s.batch_id = b.id AND s.furnace_id = ${placeholder(type, params.length)})`;
    }
    const top = type === 'sqlserver' ? `TOP ${limit} ` : '';
    const tail = type === 'sqlserver' ? '' : ` LIMIT ${limit}`;
    const result = await readOptional(connectionId,
        `SELECT ${top}b.id, b.batch_no, b.batch_name, b.product_name, b.operator,
            b.workpiece_count, b.workpiece_weight, b.template_id, b.status,
            b.current_step, b.progress, b.plan_start_time, b.actual_start_time,
            b.actual_finish_time, b.update_time, b.create_time
         FROM ${quoteIdentifier('produce_batch', type)} b${where}
         ORDER BY COALESCE(b.update_time, b.create_time) DESC${tail}`,
        params);
    if (!result.available) return result;
    return { ...result, rows: result.rows.map(normalizeBatch) };
}

async function readBatchDetail(connectionId, batchId) {
    const type = sqlDialect(connectionId);
    const id = String(batchId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('批次ID必须是数字');
    const batch = await readOptional(connectionId,
        `SELECT b.id, b.batch_no, b.batch_name, b.product_name, b.operator,
            b.workpiece_count, b.workpiece_weight, b.template_id, b.status,
            b.current_step, b.progress, b.plan_start_time, b.actual_start_time,
            b.actual_finish_time, b.update_time, b.create_time
         FROM ${quoteIdentifier('produce_batch', type)} b
         WHERE b.id = ${placeholder(type, 1)}`,
        [Number(id)]);
    if (!batch.available || !batch.rows.length) return { ...batch, row: null, steps: [] };
    const steps = await readOptional(connectionId,
        `SELECT id, batch_id, step_index, step_name, furnace_id, furnace_type_id,
            technology_id, actual_begin_time, actual_end_time, status, create_time
         FROM ${quoteIdentifier('produce_batch_step', type)}
         WHERE batch_id = ${placeholder(type, 1)} ORDER BY step_index ASC`,
        [Number(id)]);
    return {
        available: true,
        fetchedAt: batch.fetchedAt,
        row: normalizeBatch(batch.rows[0]),
        steps: steps.available ? steps.rows.map(step => ({
            ...step,
            actualBeginTime: normalizeDate(step.actual_begin_time),
            actualEndTime: normalizeDate(step.actual_end_time)
        })) : [],
        stepsAvailable: steps.available
    };
}

async function readCompliance(connectionId, options = {}) {
    const type = sqlDialect(connectionId);
    const params = [];
    const predicates = [];
    if (options.deviceId) { params.push(String(options.deviceId)); predicates.push(`device_id = ${placeholder(type, params.length)}`); }
    if (options.batchId && /^\d+$/.test(String(options.batchId))) { params.push(Number(options.batchId)); predicates.push(`batch_id = ${placeholder(type, params.length)}`); }
    // Keep the standard adapter intentionally conservative: the scheduling
    // database stores signal names, so the display only asks for temperature
    // and carbon-potential series and does not invent values.
    params.push('%温度%');
    const temperaturePlaceholder = placeholder(type, params.length);
    params.push('%碳%');
    const carbonPlaceholder = placeholder(type, params.length);
    predicates.push(`(signal_name LIKE ${temperaturePlaceholder} OR signal_name LIKE ${carbonPlaceholder} OR LOWER(signal_name) LIKE '%temp%' OR LOWER(signal_name) LIKE '%carbon%')`);
    const limit = boundedLimit(options.limit);
    const top = type === 'sqlserver' ? `TOP ${limit} ` : '';
    const tail = type === 'sqlserver' ? '' : ` LIMIT ${limit}`;
    const result = await readOptional(connectionId,
        `SELECT ${top}device_id, signal_id, signal_name, actual_value, batch_id, record_time
         FROM ${quoteIdentifier('rc_furnace_attr_history', type)}
         WHERE ${predicates.join(' AND ')} ORDER BY record_time DESC${tail}`,
        params);
    return result.available ? { ...result, rows: result.rows.map(normalizeCompliance) } : result;
}

async function readOee(connectionId, options = {}) {
    const type = sqlDialect(connectionId);
    const params = [];
    const predicates = [];
    if (options.deviceId) { params.push(String(options.deviceId)); predicates.push(`${castIdentifier('furnace_id', type)} = ${placeholder(type, params.length)}`); }
    const limit = boundedLimit(options.limit || 90);
    const top = type === 'sqlserver' ? `TOP ${limit} ` : '';
    const tail = type === 'sqlserver' ? '' : ` LIMIT ${limit}`;
    const result = await readOptional(connectionId,
        `SELECT ${top}furnace_id, stat_date, total_runtime, idle_time, alarm_time,
            offline_time, batch_count, alarm_count, utilization_rate
         FROM ${quoteIdentifier('device_statistics_daily', type)}
         ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
         ORDER BY stat_date DESC${tail}`,
        params);
    return result.available ? { ...result, rows: result.rows.map(normalizeOee) } : result;
}

async function readCandidateRows(connectionId, candidates, options = {}) {
    const type = sqlDialect(connectionId);
    const limit = boundedLimit(options.limit);
    const top = type === 'sqlserver' ? `TOP ${limit} ` : '';
    const tail = type === 'sqlserver' ? '' : ` LIMIT ${limit}`;
    let lastError = null;
    for (const candidate of candidates) {
        try {
            const rows = await readQuery(connectionId,
                `SELECT ${top}* FROM ${quoteIdentifier(candidate, type)} ORDER BY 1 DESC${tail}`);
            return { available: true, table: candidate, rows, fetchedAt: new Date().toISOString() };
        } catch (error) {
            lastError = error;
        }
    }
    return queryError(lastError || new Error('外部数据库未提供该类标准数据表'));
}

async function readBusinessSnapshot(connectionId, options = {}) {
    const id = String(connectionId || '').trim();
    if (!id) throw new Error('请指定外部业务数据源 connectionId');
    // resolveConnection also rejects disabled/deleted connections before any
    // external query is attempted.
    resolveConnection(id);
    const [batches, compliance, oee, energy, maintenance] = await Promise.all([
        readBatches(id, options),
        readCompliance(id, options),
        readOee(id, options),
        readCandidateRows(id, BUSINESS_SECTIONS.energy.sourceTables, options),
        readCandidateRows(id, BUSINESS_SECTIONS.maintenance.sourceTables, options)
    ]);
    return {
        contractVersion: CONTRACT_VERSION,
        readOnly: true,
        source: { connectionId: id },
        fetchedAt: new Date().toISOString(),
        sections: { batches, compliance, oee, energy, maintenance }
    };
}

async function readBusinessManifest(connectionId) {
    const id = String(connectionId || '').trim();
    if (!id) throw new Error('请指定外部业务数据源 connectionId');
    resolveConnection(id);
    return {
        contractVersion: CONTRACT_VERSION,
        readOnly: true,
        source: { connectionId: id },
        sections: Object.fromEntries(Object.entries(BUSINESS_SECTIONS).map(([key, value]) => [key, {
            key,
            ...value,
            mode: 'external-read-only'
        }]))
    };
}

module.exports = {
    BUSINESS_SECTIONS,
    CONTRACT_VERSION,
    readBatchDetail,
    readBusinessManifest,
    readBusinessSnapshot,
    readBatches,
    readCompliance,
    readOee
};
