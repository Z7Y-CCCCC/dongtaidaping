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

function normalizeModelMetadata(input, options = {}) {
    const raw = parseMetadata(input);
    const assetSpec = normalizeAssetSpec(raw.assetSpec || raw.asset_spec || {}, options.name);
    const partBindings = Array.isArray(raw.partBindings)
        ? raw.partBindings.map((binding, index) => normalizeBinding(binding, index))
        : [];
    const acceptance = normalizeAcceptance(raw.acceptance || {}, assetSpec.delivery_status);
    const release = normalizeRelease(raw.release || {}, assetSpec, acceptance.status);

    return {
        ...raw,
        schema_version: 1,
        batchable: raw.batchable ?? true,
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
    normalizeModelMetadata,
    stringifyModelMetadata
};
