const SCHEMA_VERSION = 1;
const DEFAULT_CANVAS = Object.freeze({
    width: 1920,
    height: 1080,
    gridSize: 10,
    background: 'transparent',
    safeArea: 24
});

const ALLOWED_WIDGET_TYPES = new Set([
    'text', 'value', 'status', 'trend', 'alarm_list', 'device_list', 'image',
    'container', 'metrics', 'marquee', 'navigation', 'device_label',
    'diagnostics', 'line_overview_cards'
]);
const UNITY_WIDGET_TYPES = new Set(['navigation', 'device_label', 'diagnostics', 'line_overview_cards']);
const ALLOWED_EVENT_ACTIONS = new Set([
    'enter_device', 'focus_factory', 'focus_line', 'focus_workshop',
    'play_voice', 'open_link', 'switch_scene'
]);
const ALLOWED_EVENT_TRIGGERS = new Set(['click', 'doubleClick']);
const FORBIDDEN_WRITE_KEYS = new Set([
    'write', 'writevalue', 'setvalue', 'command', 'plcwrite', 'writetoplc',
    'outputvalue', 'coilvalue', 'registervalue'
]);

function safeJsonParse(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function objectValue(value, fallback = {}) {
    const parsed = safeJsonParse(value, fallback);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

function arrayValue(value, fallback = []) {
    const parsed = safeJsonParse(value, fallback);
    return Array.isArray(parsed) ? parsed : fallback;
}

function finiteNumber(value, fallback, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function integer(value, fallback, min, max) {
    return Math.round(finiteNumber(value, fallback, min, max));
}

function shortText(value, fallback = '', maxLength = 255) {
    const text = String(value ?? fallback).trim();
    return (text || fallback).slice(0, maxLength);
}

function booleanValue(value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    return !(value === false || value === 0 || value === '0' || value === 'false');
}

function cleanId(value, fallback) {
    const cleaned = shortText(value, fallback, 128).replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned || fallback;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function stripDesignerConfig(config) {
    const source = objectValue(config, {});
    const content = { ...source };
    delete content.style;
    delete content.conditions;
    delete content.animation;
    delete content.events;
    delete content.__designer;
    return content;
}

function normalizeCanvas(source, legacyLayout = {}) {
    const canvas = objectValue(source, {});
    const legacy = objectValue(legacyLayout, {});
    return {
        ...DEFAULT_CANVAS,
        ...canvas,
        width: integer(canvas.width, 1920, 320, 7680),
        height: integer(canvas.height, 1080, 180, 4320),
        gridSize: integer(canvas.gridSize, 10, 1, 200),
        background: shortText(canvas.background, 'transparent', 512),
        safeArea: integer(canvas.safeArea, 24, 0, 400),
        legacyGrid: {
            columns: integer(canvas.legacyGrid?.columns ?? legacy.grid?.columns, 24, 1, 200),
            rows: integer(canvas.legacyGrid?.rows ?? legacy.grid?.rows, 12, 1, 200)
        }
    };
}

function normalizeFrame(source, canvas, legacyWidget = null) {
    const frame = objectValue(source, {});
    if (legacyWidget && frame.x === undefined && frame.width === undefined) {
        const columns = canvas.legacyGrid?.columns || 24;
        const rows = canvas.legacyGrid?.rows || 12;
        return {
            x: finiteNumber(legacyWidget.x, 0) / columns * canvas.width,
            y: finiteNumber(legacyWidget.y, 0) / rows * canvas.height,
            width: Math.max(20, finiteNumber(legacyWidget.w, 4) / columns * canvas.width),
            height: Math.max(20, finiteNumber(legacyWidget.h, 2) / rows * canvas.height),
            rotation: finiteNumber(legacyWidget.rotation, 0, -360, 360)
        };
    }
    return {
        x: finiteNumber(frame.x, 0, -canvas.width, canvas.width * 2),
        y: finiteNumber(frame.y, 0, -canvas.height, canvas.height * 2),
        width: finiteNumber(frame.width ?? frame.w, 320, 20, canvas.width * 2),
        height: finiteNumber(frame.height ?? frame.h, 180, 20, canvas.height * 2),
        rotation: finiteNumber(frame.rotation, 0, -360, 360)
    };
}

function normalizeDataBinding(source, legacyBinding = {}) {
    const data = objectValue(source, {});
    const binding = objectValue(legacyBinding, {});
    let mode = shortText(data.mode, '', 32);
    if (!['static', 'runtime', 'plc'].includes(mode)) {
        mode = (data.pointId || binding.pointId || binding.point_id)
            ? 'plc'
            : ((data.path || binding.path || binding.source) ? 'runtime' : 'static');
    }
    return {
        ...binding,
        ...data,
        mode,
        deviceId: shortText(data.deviceId ?? binding.deviceId ?? binding.device_id, '', 128),
        pointId: shortText(data.pointId ?? binding.pointId ?? binding.point_id, '', 128),
        path: shortText(data.path ?? binding.path, '', 255),
        source: shortText(data.source ?? binding.source, '', 128),
        unit: shortText(data.unit ?? binding.unit, '', 32),
        decimals: integer(data.decimals ?? binding.decimals, 1, 0, 8),
        readOnly: true
    };
}

function normalizeEvent(event) {
    const source = objectValue(event, {});
    const trigger = ALLOWED_EVENT_TRIGGERS.has(source.trigger) ? source.trigger : 'click';
    const action = ALLOWED_EVENT_ACTIONS.has(source.action) ? source.action : 'focus_factory';
    const result = { trigger, action };
    for (const [key, max] of Object.entries({
        deviceId: 128, lineId: 128, workshopId: 128, sceneId: 128,
        url: 2048, audioUrl: 2048, text: 500
    })) {
        const value = shortText(source[key], '', max);
        if (value) result[key] = value;
    }
    return result;
}

function normalizeWidget(source, canvas, index = 0) {
    const widget = objectValue(source, {});
    const legacyType = widget.widget_type;
    const requestedType = shortText(widget.type ?? legacyType, 'text', 64);
    const type = ALLOWED_WIDGET_TYPES.has(requestedType) ? requestedType : 'text';
    const config = objectValue(widget.config ?? widget.config_json, {});
    const binding = objectValue(widget.binding ?? widget.binding_json, {});
    const content = objectValue(widget.content, stripDesignerConfig(config));
    const style = objectValue(widget.style, objectValue(config.style, {}));
    const conditions = arrayValue(widget.conditions, arrayValue(config.conditions, []));
    const animation = objectValue(widget.animation, objectValue(config.animation, { type: 'none' }));
    const events = arrayValue(widget.events, arrayValue(config.events, [])).slice(0, 12).map(normalizeEvent);
    const designer = objectValue(config.__designer, {});
    return {
        id: cleanId(widget.id, `widget_${type}_${index + 1}`),
        type,
        title: shortText(widget.title, content.title || '', 255),
        visible: booleanValue(widget.visible, true),
        locked: booleanValue(widget.locked ?? designer.locked, false),
        zIndex: integer(widget.zIndex ?? widget.sort_order ?? designer.zIndex, index, -1000, 10000),
        runtimeTarget: ['overlay', 'unity', 'both'].includes(widget.runtimeTarget)
            ? widget.runtimeTarget
            : (UNITY_WIDGET_TYPES.has(type) ? 'unity' : 'overlay'),
        groupId: cleanId(widget.groupId ?? designer.groupId, ''),
        frame: normalizeFrame(widget.frame, canvas, legacyType ? widget : null),
        content,
        style,
        data: normalizeDataBinding(widget.data, binding),
        conditions: conditions.slice(0, 20).map(item => objectValue(item, {})),
        animation: {
            type: shortText(animation.type, 'none', 32),
            duration: finiteNumber(animation.duration, 1.2, 0.1, 60),
            delay: finiteNumber(animation.delay, 0, 0, 60),
            iteration: shortText(animation.iteration, 'infinite', 32)
        },
        events
    };
}

function createEmptyDocument(context = {}) {
    const project = objectValue(context.project, {});
    const scene = objectValue(context.scene, {});
    const legacyLayout = objectValue(scene.layout ?? scene.layout_json, {});
    const canvas = normalizeCanvas(context.canvas, legacyLayout);
    return {
        schemaVersion: SCHEMA_VERSION,
        projectId: shortText(context.projectId ?? project.id, 'project_default', 128),
        sceneId: shortText(context.sceneId ?? scene.id, 'scene_factory_overview', 128),
        name: shortText(context.name ?? scene.name, '工厂总览', 255),
        canvas,
        theme: {
            preset: 'industrial_twin',
            fontFamily: 'Microsoft YaHei UI',
            accentColor: '#42a5f5',
            ...objectValue(context.theme ?? scene.theme ?? scene.theme_json, {})
        },
        scene: {
            id: shortText(scene.id, context.sceneId || 'scene_factory_overview', 128),
            name: shortText(scene.name, context.name || '工厂总览', 255),
            type: shortText(scene.scene_type ?? scene.type, 'factory_overview', 64),
            layout: legacyLayout,
            camera: objectValue(scene.camera ?? scene.camera_json, {}),
            theme: objectValue(scene.theme ?? scene.theme_json, {})
        },
        widgets: [],
        metadata: {
            updatedAt: new Date().toISOString(),
            source: shortText(context.source, 'designer', 64)
        }
    };
}

function normalizeDocument(input, context = {}) {
    const source = objectValue(input, {});
    const base = createEmptyDocument({ ...context, canvas: source.canvas, theme: source.theme });
    const widgets = Array.isArray(source.widgets)
        ? source.widgets
        : (Array.isArray(context.widgets) ? context.widgets : []);
    const sceneSource = objectValue(source.scene, base.scene);
    const canvas = normalizeCanvas(source.canvas, sceneSource.layout || base.scene.layout);
    return {
        ...base,
        ...source,
        schemaVersion: SCHEMA_VERSION,
        projectId: shortText(source.projectId, base.projectId, 128),
        sceneId: shortText(source.sceneId, base.sceneId, 128),
        name: shortText(source.name, base.name, 255),
        canvas,
        theme: { ...base.theme, ...objectValue(source.theme, {}) },
        scene: {
            ...base.scene,
            ...sceneSource,
            id: shortText(sceneSource.id, base.scene.id, 128),
            name: shortText(sceneSource.name, base.scene.name, 255),
            type: shortText(sceneSource.type ?? sceneSource.scene_type, base.scene.type, 64),
            layout: objectValue(sceneSource.layout, base.scene.layout),
            camera: objectValue(sceneSource.camera, base.scene.camera),
            theme: objectValue(sceneSource.theme, base.scene.theme)
        },
        widgets: widgets.slice(0, 500).map((widget, index) => normalizeWidget(widget, canvas, index)),
        metadata: {
            ...objectValue(source.metadata, {}),
            updatedAt: new Date().toISOString(),
            source: shortText(source.metadata?.source, context.source || 'designer', 64)
        }
    };
}

function buildDocumentFromLegacy({ project, scene, widgets }) {
    return normalizeDocument({ widgets }, { project, scene, widgets, source: 'legacy_migration' });
}

function validateDocument(document, options = {}) {
    const errors = [];
    const input = objectValue(document, {});
    if (Number(input.schemaVersion) !== SCHEMA_VERSION) errors.push(`仅支持 Schema v${SCHEMA_VERSION}`);
    if (!shortText(input.projectId, '', 128)) errors.push('projectId 不能为空');
    if (!shortText(input.sceneId, '', 128)) errors.push('sceneId 不能为空');
    if (!Array.isArray(input.widgets)) errors.push('widgets 必须是数组');
    if (Array.isArray(input.widgets) && input.widgets.length > 500) errors.push('组件数量不能超过 500 个');

    const ids = new Set();
    for (const [index, widget] of (input.widgets || []).entries()) {
        const label = `第 ${index + 1} 个组件`;
        if (!widget?.id || !/^[a-zA-Z0-9_-]+$/.test(widget.id)) errors.push(`${label} ID 不合法`);
        if (ids.has(widget?.id)) errors.push(`组件 ID 重复：${widget.id}`);
        ids.add(widget?.id);
        if (!ALLOWED_WIDGET_TYPES.has(widget?.type)) errors.push(`${label} 类型不支持：${widget?.type}`);
        if (!widget?.frame || Number(widget.frame.width) < 20 || Number(widget.frame.height) < 20) errors.push(`${label} 尺寸不合法`);
        if (widget?.data?.readOnly === false) errors.push(`${label} 禁止启用 PLC 写入`);
        if (widget?.data?.mode === 'plc' && (!widget.data.deviceId || !widget.data.pointId)) {
            errors.push(`${label} 的 PLC 绑定必须同时选择设备和只读点位`);
        }
        for (const event of widget?.events || []) {
            if (!ALLOWED_EVENT_ACTIONS.has(event?.action)) errors.push(`${label} 包含不允许的点击动作`);
        }
        inspectForbiddenWriteIntent(widget, `${label}`, errors);
    }

    if (options.throwOnError !== false && errors.length) {
        const error = new Error(errors.join('；'));
        error.validationErrors = errors;
        throw error;
    }
    return errors;
}

function inspectForbiddenWriteIntent(value, path, errors, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => inspectForbiddenWriteIntent(item, `${path}[${index}]`, errors, seen));
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (FORBIDDEN_WRITE_KEYS.has(normalizedKey)) {
            errors.push(`${path} 包含禁止的 PLC 写入字段：${key}`);
        }
        if ((normalizedKey === 'action' || normalizedKey === 'method')
            && /write|setvalue|command|output/i.test(String(child || ''))) {
            errors.push(`${path} 包含禁止的 PLC 写入动作：${child}`);
        }
        inspectForbiddenWriteIntent(child, `${path}.${key}`, errors, seen);
    }
}

function documentWidgetToLegacy(widget, document, index = 0) {
    const canvas = document.canvas || DEFAULT_CANVAS;
    const columns = canvas.legacyGrid?.columns || 24;
    const rows = canvas.legacyGrid?.rows || 12;
    const frame = widget.frame || {};
    const config = {
        ...objectValue(widget.content, {}),
        style: objectValue(widget.style, {}),
        conditions: arrayValue(widget.conditions, []),
        animation: objectValue(widget.animation, { type: 'none' }),
        events: arrayValue(widget.events, []),
        __designer: {
            locked: !!widget.locked,
            zIndex: integer(widget.zIndex, index, -1000, 10000),
            runtimeTarget: widget.runtimeTarget || 'overlay',
            groupId: widget.groupId || '',
            frame: clone(frame)
        }
    };
    const data = normalizeDataBinding(widget.data, {});
    return {
        id: widget.id,
        scene_id: document.sceneId,
        widget_type: widget.type,
        title: widget.title || '',
        config_json: JSON.stringify(config),
        binding_json: JSON.stringify(data),
        x: finiteNumber(frame.x, 0) / canvas.width * columns,
        y: finiteNumber(frame.y, 0) / canvas.height * rows,
        w: finiteNumber(frame.width, 320) / canvas.width * columns,
        h: finiteNumber(frame.height, 180) / canvas.height * rows,
        sort_order: integer(widget.zIndex, index, -1000, 10000),
        visible: widget.visible === false ? 0 : 1
    };
}

function documentToLegacyWidgets(document) {
    return (document.widgets || []).map((widget, index) => documentWidgetToLegacy(widget, document, index));
}

function documentToRuntimeWidgets(document) {
    return documentToLegacyWidgets(document).map((row, index) => {
        const widget = document.widgets[index];
        return {
            ...row,
            config: safeJsonParse(row.config_json, {}),
            binding: safeJsonParse(row.binding_json, {}),
            type: widget.type,
            frame: clone(widget.frame),
            content: clone(widget.content),
            style: clone(widget.style),
            data: clone(widget.data),
            conditions: clone(widget.conditions),
            animation: clone(widget.animation),
            events: clone(widget.events),
            locked: widget.locked,
            zIndex: widget.zIndex,
            runtimeTarget: widget.runtimeTarget,
            groupId: widget.groupId || ''
        };
    });
}

function isCanonicalDocument(value) {
    const parsed = objectValue(value, {});
    return Number(parsed.schemaVersion) === SCHEMA_VERSION
        && Array.isArray(parsed.widgets)
        && parsed.canvas && typeof parsed.canvas === 'object';
}

module.exports = {
    SCHEMA_VERSION,
    DEFAULT_CANVAS,
    ALLOWED_WIDGET_TYPES,
    ALLOWED_EVENT_ACTIONS,
    safeJsonParse,
    objectValue,
    createEmptyDocument,
    normalizeDocument,
    normalizeWidget,
    buildDocumentFromLegacy,
    validateDocument,
    documentToLegacyWidgets,
    documentToRuntimeWidgets,
    isCanonicalDocument
};
