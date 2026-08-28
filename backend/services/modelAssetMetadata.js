const VALID_DELIVERY_STATUS = new Set(['draft', 'review', 'accepted', 'released']);
const VALID_BINDING_ACTIONS = new Set(['rotate_speed', 'rotate_angle', 'translate', 'visibility', 'color']);
const VALID_AXES = new Set(['x', 'y', 'z']);

const DEFAULT_MODEL_ASSET_SPEC = {
    version: '1.0.0',
    device_family: '',
    unit: 'm',
    axis_rule: 'Y-up / Z-forward',
    max_triangles: 200000,
    max_nodes: 800,
    max_texture_size: 2048,
    lod_policy: 'LOD0 必须可用，LOD1/LOD2 可选',
    node_naming_rule: 'role_part_action，例如 fan_rear_rotate、door_front_lift、valve_gas_01',
    delivery_status: 'draft',
    owner: '',
    notes: ''
};

const DEFAULT_MODEL_OPTIMIZATION = {
    mode: 'auto',
    mergeStatic: true,
    instanceRepeated: true,
    preserveAnimated: true,
    materialEnhancement: 'auto',
    contactShadow: true,
    environmentIntensity: 0.85
};

const DEFAULT_INSPECTION_CAMERA = { yaw: 238, pitch: 19, distance_scale: 1.12, target_offset: [0, 0, 0] };
const DEFAULT_INSPECTION = {
    enabled: true,
    shell: { node_paths: [], node_names: [], opacity: 0.18, wireframe: false },
    solid: { view_id: '', camera: { ...DEFAULT_INSPECTION_CAMERA } },
    xray: { view_id: '', camera: { ...DEFAULT_INSPECTION_CAMERA, distance_scale: 1.08 } },
    exploded: { view_id: '', camera: { ...DEFAULT_INSPECTION_CAMERA, pitch: 22, distance_scale: 1.22 } },
    animation_duration: 0.65,
    parts: []
};

function parseMetadata(input) {
    if (!input) return {};
    if (typeof input === 'object') return { ...input };
    try {
        return JSON.parse(input);
    } catch (error) {
        const nextError = new Error('模型元数据 JSON 格式不正确');
        nextError.cause = error;
        throw nextError;
    }
}

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function deliveryStatus(value, fallback = 'draft') {
    return VALID_DELIVERY_STATUS.has(value) ? value : fallback;
}

function normalizeAssetSpec(spec = {}, fallbackName = '') {
    const delivery_status = deliveryStatus(spec.delivery_status);
    return {
        ...DEFAULT_MODEL_ASSET_SPEC,
        ...spec,
        version: String(spec.version || DEFAULT_MODEL_ASSET_SPEC.version),
        device_family: String(spec.device_family || fallbackName || ''),
        max_triangles: Math.max(1000, numberOr(spec.max_triangles, DEFAULT_MODEL_ASSET_SPEC.max_triangles)),
        max_nodes: Math.max(1, numberOr(spec.max_nodes, DEFAULT_MODEL_ASSET_SPEC.max_nodes)),
        max_texture_size: Math.max(256, numberOr(spec.max_texture_size, DEFAULT_MODEL_ASSET_SPEC.max_texture_size)),
        delivery_status
    };
}

function normalizeBinding(binding = {}, index = 0) {
    const action = VALID_BINDING_ACTIONS.has(binding.action) ? binding.action : 'rotate_speed';
    const axis = VALID_AXES.has(binding.axis) ? binding.axis : 'y';
    return {
        id: String(binding.id || `binding_${index + 1}`),
        name: String(binding.name || ''),
        node_path: String(binding.node_path || ''),
        node_name: String(binding.node_name || binding.nodeName || ''),
        source_group: String(binding.source_group || binding.category || 'analog'),
        source_key: String(binding.source_key || binding.value_role || binding.key || ''),
        action,
        axis,
        input_min: numberOr(binding.input_min, 0),
        input_max: numberOr(binding.input_max, 100),
        output_min: numberOr(binding.output_min, 0),
        output_max: numberOr(binding.output_max, 90),
        speed_factor: numberOr(binding.speed_factor, 0.10472),
        on_color: String(binding.on_color || '#00ff88'),
        off_color: String(binding.off_color || '#666666'),
        invert: !!binding.invert
    };
}

function normalizeAcceptance(acceptance = {}, status = 'draft') {
    return {
        status: deliveryStatus(acceptance.status, status),
        checked_at: acceptance.checked_at || '',
        stats: acceptance.stats || {},
        checks: Array.isArray(acceptance.checks) ? acceptance.checks : []
    };
}

function normalizeRelease(release = {}, assetSpec, acceptanceStatus) {
    return {
        version: String(release.version || assetSpec.version || '1.0.0'),
        status: deliveryStatus(release.status, acceptanceStatus || assetSpec.delivery_status),
        published_at: release.published_at || '',
        history: Array.isArray(release.history) ? release.history : []
    };
}

function booleanOr(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeOptimization(optimization = {}) {
    const mode = ['auto', 'off'].includes(optimization.mode) ? optimization.mode : DEFAULT_MODEL_OPTIMIZATION.mode;
    const materialEnhancement = ['auto', 'original'].includes(optimization.materialEnhancement || optimization.material_enhancement)
        ? (optimization.materialEnhancement || optimization.material_enhancement)
        : DEFAULT_MODEL_OPTIMIZATION.materialEnhancement;
    return {
        mode,
        mergeStatic: booleanOr(optimization.mergeStatic ?? optimization.merge_static, DEFAULT_MODEL_OPTIMIZATION.mergeStatic),
        instanceRepeated: booleanOr(optimization.instanceRepeated ?? optimization.instance_repeated, DEFAULT_MODEL_OPTIMIZATION.instanceRepeated),
        preserveAnimated: true,
        materialEnhancement,
        contactShadow: booleanOr(optimization.contactShadow ?? optimization.contact_shadow, DEFAULT_MODEL_OPTIMIZATION.contactShadow),
        environmentIntensity: Math.max(0, Math.min(2, numberOr(
            optimization.environmentIntensity ?? optimization.environment_intensity,
            DEFAULT_MODEL_OPTIMIZATION.environmentIntensity
        )))
    };
}

function normalizeInspectionCamera(camera = {}, fallback = DEFAULT_INSPECTION_CAMERA) {
    const targetOffset = Array.isArray(camera.target_offset || camera.targetOffset)
        ? (camera.target_offset || camera.targetOffset).slice(0, 3).map(value => numberOr(value, 0))
        : [...fallback.target_offset];
    while (targetOffset.length < 3) targetOffset.push(0);
    return {
        yaw: Math.max(-360, Math.min(360, numberOr(camera.yaw, fallback.yaw))),
        pitch: Math.max(6, Math.min(82, numberOr(camera.pitch, fallback.pitch))),
        distance_scale: Math.max(.1, Math.min(10, numberOr(camera.distance_scale ?? camera.distanceScale, fallback.distance_scale))),
        target_offset: targetOffset
    };
}

function normalizeInspection(inspection = {}, partBindings = []) {
    const shell = inspection.shell || {};
    const normalizeStrings = value => (Array.isArray(value) ? value : [])
        .map(item => String(item || '').trim()).filter(Boolean).slice(0, 100);
    const normalizeStage = (stage, fallback) => ({
        view_id: String(stage?.view_id ?? stage?.viewId ?? ''),
        camera: normalizeInspectionCamera(stage?.camera || {}, fallback)
    });
    const rawParts = Array.isArray(inspection.parts) && inspection.parts.length
        ? inspection.parts
        : partBindings.map((binding, index) => ({
            id: binding.id || `part_${index + 1}`,
            name: binding.name || binding.node_name || binding.node_path || `部件 ${index + 1}`,
            node_path: binding.node_path || '',
            node_name: binding.node_name || '',
            point_keys: binding.source_key ? [`${binding.source_group || 'analog'}.${binding.source_key}`] : []
        }));
    return {
        enabled: booleanOr(inspection.enabled, DEFAULT_INSPECTION.enabled),
        shell: {
            node_paths: normalizeStrings(shell.node_paths || shell.nodePaths),
            node_names: normalizeStrings(shell.node_names || shell.nodeNames),
            opacity: Math.max(.03, Math.min(.95, numberOr(shell.opacity, DEFAULT_INSPECTION.shell.opacity))),
            wireframe: booleanOr(shell.wireframe, false)
        },
        solid: normalizeStage(inspection.solid, DEFAULT_INSPECTION.solid.camera),
        xray: normalizeStage(inspection.xray, DEFAULT_INSPECTION.xray.camera),
        exploded: normalizeStage(inspection.exploded, DEFAULT_INSPECTION.exploded.camera),
        animation_duration: Math.max(.05, Math.min(5, numberOr(inspection.animation_duration ?? inspection.animationDuration, .65))),
        parts: rawParts.slice(0, 64).map((part, index) => ({
            id: String(part.id || `part_${index + 1}`),
            name: String(part.name || part.node_name || part.nodeName || `部件 ${index + 1}`),
            node_path: String(part.node_path || part.nodePath || ''),
            node_name: String(part.node_name || part.nodeName || ''),
            explode_offset: (Array.isArray(part.explode_offset || part.explodeOffset) ? (part.explode_offset || part.explodeOffset) : [0, 0, 0]).slice(0, 3).map(value => numberOr(value, 0)),
            label_offset: (Array.isArray(part.label_offset || part.labelOffset) ? (part.label_offset || part.labelOffset) : [0, .35, 0]).slice(0, 3).map(value => numberOr(value, 0)),
            description: String(part.description || ''),
            point_ids: normalizeStrings(part.point_ids || part.pointIds),
            point_keys: normalizeStrings(part.point_keys || part.pointKeys),
            detail_view_id: String(part.detail_view_id || part.detailViewId || '')
        }))
    };
}

function normalizeModelMetadata(input, options = {}) {
    const raw = parseMetadata(input);
    const assetSpec = normalizeAssetSpec(raw.assetSpec || raw.asset_spec || {}, options.name);
    const partBindings = Array.isArray(raw.partBindings)
        ? raw.partBindings.map((binding, index) => normalizeBinding(binding, index))
        : [];
    const acceptance = normalizeAcceptance(raw.acceptance || {}, assetSpec.delivery_status);
    const release = normalizeRelease(raw.release || {}, assetSpec, acceptance.status);
    const optimization = normalizeOptimization(
        raw.optimization || (raw.batchable === false ? { mode: 'off' } : {})
    );
    const inspection = normalizeInspection(raw.inspection || {}, partBindings);

    return {
        ...raw,
        schema_version: 1,
        batchable: raw.batchable ?? true,
        optimization,
        inspection,
        assetSpec,
        partBindings,
        acceptance,
        release,
        runtime: {
            ...(raw.runtime || {}),
            enableGenericBindings: partBindings.length > 0
        }
    };
}

function stringifyModelMetadata(input, options = {}) {
    return JSON.stringify(normalizeModelMetadata(input, options));
}

module.exports = {
    DEFAULT_MODEL_ASSET_SPEC,
    DEFAULT_MODEL_OPTIMIZATION,
    normalizeModelMetadata,
    stringifyModelMetadata
};
