const express = require('express');
const crypto = require('crypto');
const { getDb, getDbStatus } = require('../db/database');
const { isLoopbackAddress } = require('../middleware/security');
const { normalizeWorkshopLayout, normalizeLineLayout } = require('../utils/spatialLayout');
const {
    loadDesignerState,
    saveDraft,
    publishDraft
} = require('../services/dashboardDocuments');
const { mergeBuiltinModels } = require('../services/builtinModels');
const { getHeatTreatmentTemplatePacks } = require('../services/heatTreatmentTemplates');
const { getLicenseStatus } = require('../services/license');

const PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = {
    name: 'digital-twin-control-mcp',
    version: '1.0.0'
};

function safeTokenEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length > 0
        && leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function suppliedToken(req) {
    const direct = String(req.get('x-mcp-token') || '');
    if (direct) return direct;
    const authorization = String(req.get('authorization') || '');
    return authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : '';
}

function isAuthorized(req) {
    if (isLoopbackAddress(req.socket?.remoteAddress)) return true;
    const configured = String(process.env.MCP_API_TOKEN || process.env.ADMIN_API_TOKEN || '');
    return !!configured && safeTokenEqual(suppliedToken(req), configured);
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        return fallback;
    }
}

function text(value, fallback = '') {
    const result = String(value ?? fallback).trim();
    return result;
}

function identifier(value, label, max = 128) {
    const result = text(value);
    if (!result || result.length > max || !/^[a-zA-Z0-9_-]+$/.test(result)) {
        throw new Error(`${label}只能使用字母、数字、下划线和短横线，长度不超过 ${max}`);
    }
    return result;
}

function numberOr(value, fallback) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

function boolOr(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).toLowerCase());
}

function toolDefinitions() {
    return [
        {
            name: 'get_project_state',
            description: '读取当前数字孪生项目的车间、产线、设备、点位、模型、运行状态和大屏设计稿。',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: 'set_data_mode',
            description: '切换数据引擎到 simulation（演示/验收）或 integrated_plc（现场 PLC），并可设置模拟轮询周期。',
            inputSchema: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['simulation', 'integrated_plc'] },
                    simulationIntervalMs: { type: 'integer', minimum: 250, maximum: 60000 }
                },
                required: ['mode'],
                additionalProperties: false
            }
        },
        {
            name: 'upsert_workshop',
            description: '创建或更新车间及其空间边界。',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    sortOrder: { type: 'number' },
                    layout: { type: 'object' }
                },
                required: ['id', 'name'],
                additionalProperties: false
            }
        },
        {
            name: 'upsert_line',
            description: '创建或更新产线、设备线和导轨布局。',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    workshopId: { type: 'string' },
                    sortOrder: { type: 'number' },
                    layout: { type: 'object' }
                },
                required: ['id', 'name', 'workshopId'],
                additionalProperties: false
            }
        },
        {
            name: 'upsert_device',
            description: '创建或更新设备实例、模型、空间坐标和 PLC 连接参数。',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    lineId: { type: ['string', 'null'] },
                    modelType: { type: 'string' },
                    instanceConfig: { type: 'object' },
                    position: { type: 'object' },
                    rotationY: { type: 'number' },
                    scale: { type: 'number' },
                    sortOrder: { type: 'number' },
                    plcEnabled: { type: 'boolean' },
                    plcIp: { type: 'string' },
                    plcPort: { type: 'number' }
                },
                required: ['id', 'name'],
                additionalProperties: false
            }
        },
        {
            name: 'sync_device_points',
            description: '以整组方式保存一台设备的只读 PLC 点位。',
            inputSchema: {
                type: 'object',
                properties: {
                    deviceId: { type: 'string' },
                    points: { type: 'array' }
                },
                required: ['deviceId', 'points'],
                additionalProperties: false
            }
        },
        {
            name: 'save_dashboard_draft',
            description: '保存低代码设计器的完整大屏草稿，可修改多级设备视角、组件显隐和部件详情面板。',
            inputSchema: {
                type: 'object',
                properties: {
                    sceneId: { type: 'string' },
                    document: { type: 'object' },
                    expectedRevision: { type: 'integer' }
                },
                required: ['document'],
                additionalProperties: false
            }
        },
        {
            name: 'publish_dashboard',
            description: '发布当前场景草稿为可运行版本。',
            inputSchema: {
                type: 'object',
                properties: {
                    sceneId: { type: 'string' },
                    version: { type: 'string' },
                    notes: { type: 'string' }
                },
                additionalProperties: false
            }
        },
        {
            name: 'configure_demo_site',
            description: '幂等创建一套南区热处理示范车间：两条产线、三台设备、关键点位、模拟数据和多级设备巡检大屏，并发布运行版本。',
            inputSchema: {
                type: 'object',
                properties: {
                    publish: { type: 'boolean', description: '是否在保存草稿后立即发布，默认 true' },
                    simulationIntervalMs: { type: 'integer', minimum: 250, maximum: 60000 }
                },
                additionalProperties: false
            }
        },
        {
            name: 'run_acceptance_checks',
            description: '执行受控验收：数据库、运行引擎、空间层级、设备模型、四级视角和部件详情绑定检查。',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: 'get_heat_treatment_template_library',
            description: '读取热处理数字孪生模板库：设备模板、只读点位包、展示报警规则、模型部件绑定和外部业务数据区块。不会修改现场配置。',
            inputSchema: {
                type: 'object',
                properties: {
                    category: { type: 'string', enum: ['furnace', 'washer'] }
                },
                additionalProperties: false
            }
        },
        {
            name: 'get_license_status',
            description: '读取离线许可证状态、客户、有效期和授权功能，不会修改许可证。',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: 'install_license',
            description: '安装已由交付方签名的离线许可证；公钥校验失败时拒绝写入。',
            inputSchema: {
                type: 'object',
                properties: { license: { type: 'object' } },
                required: ['license'],
                additionalProperties: false
            }
        }
    ];
}

function result(value) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false
    };
}

function errorResult(message) {
    return {
        content: [{ type: 'text', text: String(message) }],
        isError: true
    };
}

function rpcResult(id, value) {
    return { jsonrpc: '2.0', id, result: value };
}

function rpcError(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function createMcpRouter({ port = 3001 } = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!isAuthorized(req)) {
            res.status(403).json({ success: false, error: 'MCP 接口仅允许本机访问；远程访问需配置 MCP_API_TOKEN' });
            return;
        }
        next();
    });

    async function localApi(path, options = {}) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            ...options,
            headers: {
                'content-type': 'application/json',
                ...(options.headers || {})
            }
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `内部接口 ${path} 返回 ${response.status}`);
        return body;
    }

    async function loadState() {
        const db = await getDb();
        const [workshops, lines, devices, points, models, settings, designer] = await Promise.all([
            db.all('SELECT * FROM workshops ORDER BY sort_order ASC, id ASC'),
            db.all('SELECT * FROM `lines` ORDER BY sort_order ASC, id ASC'),
            db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC, id ASC'),
            db.all('SELECT * FROM data_points ORDER BY device_id, id ASC'),
            db.all('SELECT * FROM models ORDER BY id ASC'),
            db.all('SELECT * FROM settings ORDER BY `key` ASC'),
            loadDesignerState(db)
        ]);
        const settingsObject = {};
        settings.forEach(row => { settingsObject[row.key] = row.value; });
        return {
            db: getDbStatus(),
            engine: global.dataEngine?.getStatus?.() || null,
            settings: settingsObject,
            workshops: workshops.map(row => ({ ...row, layout: normalizeWorkshopLayout(row.layout_json) })),
            lines: lines.map(row => ({ ...row, layout: normalizeLineLayout(row.layout_json) })),
            devices,
            dataPoints: points,
            models: mergeBuiltinModels(models).map(model => ({
                id: model.id,
                name: model.name,
                file_path: model.file_path,
                asset_type: model.asset_type,
                is_builtin: !!model.is_builtin,
                metadata: parseJson(model.metadata, {})
            })),
            designer: {
                project: designer.project,
                scene: designer.scene,
                revision: designer.revision,
                document: designer.document,
                releases: designer.releases,
                currentRelease: designer.currentRelease
            }
        };
    }

    async function upsertWorkshop(args) {
        const id = identifier(args.id, '车间 ID', 64);
        const name = text(args.name);
        if (!name) throw new Error('车间名称不能为空');
        const db = await getDb();
        const layout = normalizeWorkshopLayout(args.layout);
        await db.upsert('workshops', {
            id,
            name,
            sort_order: numberOr(args.sortOrder, 0),
            layout_json: JSON.stringify(layout)
        }, 'id');
        return { success: true, workshop: await db.get('SELECT * FROM workshops WHERE id = ?', [id]) };
    }

    async function upsertLine(args) {
        const id = identifier(args.id, '产线 ID', 64);
        const workshopId = identifier(args.workshopId, '所属车间 ID', 64);
        const name = text(args.name);
        if (!name) throw new Error('产线名称不能为空');
        const db = await getDb();
        if (!await db.get('SELECT id FROM workshops WHERE id = ?', [workshopId])) {
            throw new Error(`车间不存在：${workshopId}`);
        }
        const layout = normalizeLineLayout(args.layout);
        await db.upsert('lines', {
            id,
            name,
            workshop_id: workshopId,
            layout_json: JSON.stringify(layout),
            sort_order: numberOr(args.sortOrder, 0)
        }, 'id');
        return { success: true, line: await db.get('SELECT * FROM `lines` WHERE id = ?', [id]) };
    }

    async function upsertDevice(args) {
        const id = identifier(args.id, '设备 ID', 128);
        const name = text(args.name);
        if (!name) throw new Error('设备名称不能为空');
        const current = await localApi(`/api/devices/${encodeURIComponent(id)}`).catch(() => null);
        const position = args.position && typeof args.position === 'object' ? args.position : {};
        const existing = current || {};
        const body = {
            ...existing,
            id,
            name,
            line_id: args.lineId === undefined ? (existing.line_id || null) : (args.lineId || null),
            model_type: args.modelType || existing.model_type || 'builtin_furnace',
            model_file: args.modelFile ?? existing.model_file ?? null,
            template_id: args.templateId ?? existing.template_id ?? '',
            instance_config: args.instanceConfig ?? existing.instance_config ?? {},
            pos_x: position.x ?? args.pos_x ?? existing.pos_x ?? 0,
            pos_y: position.y ?? args.pos_y ?? existing.pos_y ?? 0,
            pos_z: position.z ?? args.pos_z ?? existing.pos_z ?? 0,
            rotation_y: args.rotationY ?? existing.rotation_y ?? 0,
            scale: args.scale ?? existing.scale ?? 1,
            coordinate_space: args.coordinateSpace || existing.coordinate_space || (args.lineId ? 'line_local' : 'workshop_local'),
            sort_order: args.sortOrder ?? existing.sort_order ?? 0,
            plc_enabled: args.plcEnabled ?? existing.plc_enabled ?? false,
            plc_protocol: args.plcProtocol || existing.plc_protocol || 'S7',
            plc_ip: args.plcIp ?? existing.plc_ip ?? '127.0.0.1',
            plc_port: args.plcPort ?? existing.plc_port ?? 1102,
            plc_rack: args.plcRack ?? existing.plc_rack ?? 0,
            plc_slot: args.plcSlot ?? existing.plc_slot ?? 1,
            plc_timeout: args.plcTimeout ?? existing.plc_timeout ?? 3000,
            plc_retry_interval: args.plcRetryInterval ?? existing.plc_retry_interval ?? 2000,
            plc_max_retries: args.plcMaxRetries ?? existing.plc_max_retries ?? 0,
            plc_options: args.plcOptions ?? existing.plc_options ?? {}
        };
        delete body.dataPoints;
        const saved = current
            ? await localApi(`/api/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
            : await localApi('/api/devices', { method: 'POST', body: JSON.stringify(body) });
        return { success: true, id, created: !current, response: saved };
    }

    async function syncDevicePoints(args) {
        const deviceId = identifier(args.deviceId, '设备 ID', 128);
        if (!Array.isArray(args.points)) throw new Error('points 必须是数组');
        const payload = await localApi('/api/datapoints/sync', {
            method: 'POST',
            body: JSON.stringify({ device_id: deviceId, points: args.points })
        });
        return { ...payload, deviceId };
    }

    async function setDataMode(args) {
        const mode = text(args.mode).toLowerCase();
        if (!['simulation', 'integrated_plc'].includes(mode)) throw new Error('mode 只能是 simulation 或 integrated_plc');
        const db = await getDb();
        await db.upsert('settings', { key: 'data_mode', value: mode }, 'key');
        if (args.simulationIntervalMs !== undefined) {
            const interval = Math.max(250, Math.min(60000, Math.round(numberOr(args.simulationIntervalMs, 2000))));
            await db.upsert('settings', { key: 'simulation_interval_ms', value: String(interval) }, 'key');
        }
        if (global.dataEngine?.restart) await global.dataEngine.restart();
        return { success: true, mode, engine: global.dataEngine?.getStatus?.() || null };
    }

    async function saveDashboardDraft(args) {
        const db = await getDb();
        const saved = await saveDraft(db, {
            sceneId: args.sceneId || '',
            document: args.document,
            expectedRevision: args.expectedRevision
        });
        return { success: true, revision: saved.revision, document: saved.document };
    }

    async function publishDashboard(args) {
        const db = await getDb();
        const published = await publishDraft(db, {
            sceneId: args.sceneId || '',
            version: args.version,
            notes: args.notes || 'MCP 现场样板验收发布'
        });
        global.wsServer?.broadcast?.('dashboard_release_changed', {
            releaseId: published.release.id,
            version: published.release.version,
            timestamp: Date.now()
        });
        return { success: true, release: published.release };
    }

    async function configureDemoSite(args = {}) {
        const workshopLayout = {
            version: 2,
            coordinateSpace: 'factory_world',
            transform: { x: 118, y: 0, z: 0, rotationY: 0 },
            size: { width: 100, depth: 82, height: 8 },
            boundary: { enabled: true }
        };
        const lineOneLayout = {
            version: 2,
            coordinateSpace: 'workshop_local',
            placementPending: false,
            transform: { x: 0, y: 0, z: -22, rotationY: 0 },
            flowDirection: 'right',
            lanes: [{ id: 'demo_lane_a', name: '淬火设备线', type: 'device_lane', offsetZ: 0, length: 68, sort_order: 0 }],
            rails: [{ id: 'demo_rail_a', name: '转运导轨', type: 'cart_rail', offsetZ: 12, length: 68, sort_order: 0 }]
        };
        const lineTwoLayout = {
            version: 2,
            coordinateSpace: 'workshop_local',
            placementPending: false,
            transform: { x: 0, y: 0, z: 22, rotationY: 0 },
            flowDirection: 'right',
            lanes: [{ id: 'demo_lane_b', name: '回火清洗线', type: 'device_lane', offsetZ: 0, length: 68, sort_order: 0 }],
            rails: []
        };
        await upsertWorkshop({ id: 'ws_demo_south', name: '南区热处理示范车间', sortOrder: 10, layout: workshopLayout });
        await upsertLine({ id: 'line_demo_quench', name: '1# 淬火线', workshopId: 'ws_demo_south', sortOrder: 0, layout: lineOneLayout });
        await upsertLine({ id: 'line_demo_temper', name: '2# 回火清洗线', workshopId: 'ws_demo_south', sortOrder: 1, layout: lineTwoLayout });

        const furnaceConfig = {
            labelY: 3.6,
            caption: '示范炉',
            laneId: 'demo_lane_a',
            laneName: '淬火设备线',
            laneLineId: 'line_demo_quench',
            dataProfile: 'heat_treatment',
            animationProfile: 'multipurpose_furnace_native_v1',
            scaleMultiplier: 1,
            statusLightY: 3.0
        };
        await upsertDevice({
            id: 'demo_furnace_01', name: '南区 1# 箱式气氛炉', lineId: 'line_demo_quench',
            modelType: 'photo_multipurpose_furnace_v5', instanceConfig: { ...furnaceConfig, caption: '南区 1# 箱式气氛炉' },
            position: { x: -22, y: 0, z: 0 }, rotationY: 0, scale: 2, sortOrder: 0,
            plcEnabled: false, plcIp: '127.0.0.1', plcPort: 1102
        });
        await upsertDevice({
            id: 'demo_furnace_02', name: '南区 2# 箱式气氛炉', lineId: 'line_demo_quench',
            modelType: 'photo_multipurpose_furnace_v5', instanceConfig: { ...furnaceConfig, caption: '南区 2# 箱式气氛炉' },
            position: { x: 2, y: 0, z: 0 }, rotationY: 0, scale: 2, sortOrder: 1,
            plcEnabled: false, plcIp: '127.0.0.1', plcPort: 1102
        });
        await upsertDevice({
            id: 'demo_washer_01', name: '南区清洗机', lineId: 'line_demo_temper',
            modelType: 'builtin_furnace', instanceConfig: {
                labelY: 2.8, caption: '南区清洗机', laneId: 'demo_lane_b', laneName: '回火清洗线',
                laneLineId: 'line_demo_temper', dataProfile: 'heat_treatment', animationProfile: 'furnace', scaleMultiplier: 0.9
            },
            position: { x: -5, y: 0, z: 0 }, rotationY: 0, scale: 1.4, sortOrder: 0,
            plcEnabled: false, plcIp: '127.0.0.1', plcPort: 1102
        });

        await syncDevicePoints({
            deviceId: 'demo_furnace_01',
            points: [
                { name: 'actual_temp', label: '实际温度', plc_tag: 'DB20.DBW0', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'setpoint_temp', label: '设定温度', plc_tag: 'DB20.DBW2', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'actual_carbon', label: '实际碳势', plc_tag: 'DB20.DBW4', data_type: 'REAL', category: 'analog', unit: '%', sample_interval_ms: 1000, access_type: 'READ' },
                { name: 'front_door_open', label: '前门开到位', plc_tag: 'DB20.DBX8.0', data_type: 'BOOL', category: 'status', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'rear_fan_speed', label: '后室风扇转速', plc_tag: 'DB20.DBW10', data_type: 'WORD', category: 'motors', unit: 'rpm', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'oil_stir_1_speed', label: '油搅拌 1 转速', plc_tag: 'DB20.DBW12', data_type: 'WORD', category: 'motors', unit: 'rpm', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'bj1', label: '超温报警', plc_tag: 'DB20.DBX14.0', data_type: 'BOOL', category: 'status', point_kind: 'alarm', alarm_text: '超温报警', sample_interval_ms: 500, access_type: 'READ' }
            ]
        });
        await syncDevicePoints({
            deviceId: 'demo_furnace_02',
            points: [
                { name: 'actual_temp', label: '实际温度', plc_tag: 'DB21.DBW0', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'actual_carbon', label: '实际碳势', plc_tag: 'DB21.DBW4', data_type: 'REAL', category: 'analog', unit: '%', sample_interval_ms: 1000, access_type: 'READ' },
                { name: 'front_door_open', label: '前门开到位', plc_tag: 'DB21.DBX8.0', data_type: 'BOOL', category: 'status', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'rear_fan_speed', label: '后室风扇转速', plc_tag: 'DB21.DBW10', data_type: 'WORD', category: 'motors', unit: 'rpm', sample_interval_ms: 500, access_type: 'READ' }
            ]
        });
        await syncDevicePoints({
            deviceId: 'demo_washer_01',
            points: [
                { name: 'actual_temp', label: '清洗槽温度', plc_tag: 'DB22.DBW0', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 1000, access_type: 'READ' },
                { name: 'running', label: '运行状态', plc_tag: 'DB22.DBX4.0', data_type: 'BOOL', category: 'status', sample_interval_ms: 500, access_type: 'READ' }
            ]
        });

        const db = await getDb();
        const designer = await loadDesignerState(db);
        const document = designer.document;
        document.name = '南区热处理示范车间巡检大屏';
        document.scene = {
            ...document.scene,
            name: '南区热处理示范车间巡检大屏',
            theme: { ...document.scene?.theme, title: '南区热处理示范车间 · 设备巡检中心' },
            defaultViewId: 'factory_overview',
            views: (Array.isArray(document.scene?.views) ? document.scene.views : []).map(view => {
                const names = {
                    device_detail: '设备实体视图',
                    device_xray: '外壳透视视图',
                    device_exploded: '内部部件拆解视图',
                    device_part: '关键部件详情视图'
                };
                return { ...view, name: names[view.id] || view.name };
            })
        };
        document.theme = { ...document.theme, title: '南区热处理示范车间 · 设备巡检中心', accentColor: '#42a5f5' };
        document.metadata = { ...parseJson(document.metadata, {}), scenario: 'south-area-heat-treatment-demo', configuredBy: 'mcp-agent' };
        const draft = await saveDraft(db, {
            sceneId: designer.scene?.id,
            document,
            expectedRevision: designer.revision
        });
        let release = null;
        if (args.publish !== false) {
            release = (await publishDraft(db, {
                sceneId: designer.scene?.id,
                notes: 'MCP 自动配置的南区热处理示范车间现场样板'
            })).release;
        }
        await setDataMode({ mode: 'simulation', simulationIntervalMs: args.simulationIntervalMs || 1000 });
        await db.run(`INSERT INTO event_logs (event_type, level, source_id, title, message, value, quality)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            'system', 'info', 'mcp', '南区热处理示范项目已配置',
            '车间、产线、设备、点位和多级设备巡检视角已完成并进入模拟运行',
            release?.version || 'draft', 'good'
        ]);
        return {
            success: true,
            scenario: 'south-area-heat-treatment-demo',
            workshopId: 'ws_demo_south',
            lineIds: ['line_demo_quench', 'line_demo_temper'],
            deviceIds: ['demo_furnace_01', 'demo_furnace_02', 'demo_washer_01'],
            draftRevision: draft.revision,
            release,
            engine: global.dataEngine?.getStatus?.() || null
        };
    }

    async function runAcceptanceChecks() {
        const state = await loadState();
        const views = state.designer.document?.scene?.views || [];
        const checks = [
            { id: 'database', label: '数据库连接', passed: !!state.db.connected, detail: state.db.type },
            { id: 'engine', label: '数据引擎', passed: ['simulation', 'integrated_plc'].includes(state.engine?.mode), detail: state.engine?.mode || '未启动' },
            { id: 'workshop', label: '空间车间', passed: state.workshops.some(item => item.id === 'ws_demo_south'), detail: `${state.workshops.length} 个车间` },
            { id: 'lines', label: '示范产线', passed: ['line_demo_quench', 'line_demo_temper'].every(id => state.lines.some(item => item.id === id)), detail: `${state.lines.length} 条产线` },
            { id: 'devices', label: '示范设备', passed: ['demo_furnace_01', 'demo_furnace_02', 'demo_washer_01'].every(id => state.devices.some(item => item.id === id)), detail: `${state.devices.length} 台设备` },
            { id: 'model', label: '原生 PBR 模型', passed: state.devices.some(item => item.id === 'demo_furnace_01' && item.model_type === 'photo_multipurpose_furnace_v5'), detail: 'photo_multipurpose_furnace_v5' },
            { id: 'points', label: '关键点位', passed: state.dataPoints.filter(item => item.device_id === 'demo_furnace_01').length >= 6, detail: `${state.dataPoints.filter(item => item.device_id === 'demo_furnace_01').length} 个点位` },
            { id: 'views', label: '多级视角链路', passed: ['device_detail', 'device_xray', 'device_exploded', 'device_part'].every(id => views.some(view => view.id === id)), detail: views.map(view => view.id).join(' → ') },
            { id: 'part-panel', label: '部件详情面板', passed: state.designer.document?.widgets?.some(widget => widget.id === 'widget_device_part_panel' || widget.groupId === 'group_device_part_detail'), detail: 'selectedPart 上下文' },
            (() => { const license = getLicenseStatus(); return { id: 'license', label: '离线授权', passed: !license.enforce || license.valid, detail: license.reason }; })(),
            { id: 'release', label: '运行版本', passed: !!state.designer.currentRelease, detail: state.designer.currentRelease?.version || '未发布' }
        ];
        return { success: checks.every(check => check.passed), checks, checkedAt: new Date().toISOString() };
    }

    async function getHeatTreatmentTemplateLibrary(args = {}) {
        const category = text(args.category).toLowerCase();
        const packs = getHeatTreatmentTemplatePacks().filter(pack => !category || pack.category === category);
        return { success: true, readOnly: true, contractVersion: 1, packs, count: packs.length };
    }

    async function installLicense(args = {}) {
        if (!args.license || typeof args.license !== 'object') throw new Error('license 必须是对象');
        return await localApi('/api/license', { method: 'PUT', body: JSON.stringify({ license: args.license }) });
    }

    async function callTool(name, args = {}) {
        switch (name) {
            case 'get_project_state': return result(await loadState());
            case 'set_data_mode': return result(await setDataMode(args));
            case 'upsert_workshop': return result(await upsertWorkshop(args));
            case 'upsert_line': return result(await upsertLine(args));
            case 'upsert_device': return result(await upsertDevice(args));
            case 'sync_device_points': return result(await syncDevicePoints(args));
            case 'save_dashboard_draft': return result(await saveDashboardDraft(args));
            case 'publish_dashboard': return result(await publishDashboard(args));
            case 'configure_demo_site': return result(await configureDemoSite(args));
            case 'run_acceptance_checks': return result(await runAcceptanceChecks());
            case 'get_heat_treatment_template_library': return result(await getHeatTreatmentTemplateLibrary(args));
            case 'get_license_status': return result({ success: true, readOnly: true, ...getLicenseStatus() });
            case 'install_license': return result(await installLicense(args));
            default: throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 });
        }
    }

    async function handleRpc(request) {
        if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
            return rpcError(request?.id ?? null, -32600, '无效的 JSON-RPC 2.0 请求');
        }
        const id = request.id;
        if (request.method.startsWith('notifications/')) return null;
        try {
            switch (request.method) {
                case 'initialize': {
                    const requested = text(request.params?.protocolVersion, '2024-11-05');
                    const protocolVersion = PROTOCOL_VERSIONS.has(requested) ? requested : '2024-11-05';
                    return rpcResult(id, {
                        protocolVersion,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: SERVER_INFO,
                        instructions: '使用 configure_demo_site 创建可重复的现场样板，使用 run_acceptance_checks 验收。'
                    });
                }
                case 'ping':
                    return rpcResult(id, {});
                case 'tools/list':
                    return rpcResult(id, { tools: toolDefinitions() });
                case 'tools/call': {
                    const name = text(request.params?.name);
                    if (!toolDefinitions().some(tool => tool.name === name)) {
                        return rpcError(id, -32602, `未知工具：${name}`);
                    }
                    return rpcResult(id, await callTool(name, request.params?.arguments || {}));
                }
                case 'resources/list':
                    return rpcResult(id, { resources: [] });
                default:
                    return rpcError(id, -32601, `不支持的方法：${request.method}`);
            }
        } catch (error) {
            const code = Number(error.code);
            if (Number.isInteger(code) && code <= -32000) return rpcError(id, code, error.message);
            return rpcResult(id, errorResult(error.message));
        }
    }

    router.get('/', (req, res) => {
        res.json({ success: true, name: SERVER_INFO.name, version: SERVER_INFO.version, transport: 'streamable-http-json-rpc', endpoint: '/api/mcp' });
    });

    router.post('/', async (req, res) => {
        const body = req.body;
        if (Array.isArray(body)) {
            const responses = (await Promise.all(body.map(handleRpc))).filter(Boolean);
            if (!responses.length) {
                res.status(202).end();
                return;
            }
            res.json(responses);
            return;
        }
        const response = await handleRpc(body);
        if (!response) {
            res.status(202).end();
            return;
        }
        res.json(response);
    });

    return router;
}

module.exports = createMcpRouter;
