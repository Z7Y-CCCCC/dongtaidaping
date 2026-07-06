const BUILTIN_MODELS = [
    {
        id: 'builtin_furnace',
        name: '内置多用炉模型（程序化几何体）',
        file_path: null,
        asset_type: 'model',
        tags: JSON.stringify(['builtin', 'heat_treatment']),
        thumbnail: null,
        default_scale: 1.0,
        metadata: JSON.stringify({ source: 'procedural', batchable: false }),
        is_builtin: true
    },
    {
        id: 'transfer_cart',
        name: '轨道料车 / 取料小车（程序化低模）',
        file_path: null,
        asset_type: 'model',
        tags: JSON.stringify(['builtin', 'transfer_cart', 'rail']),
        thumbnail: null,
        default_scale: 1.0,
        metadata: JSON.stringify({
            source: 'procedural',
            intendedUse: 'line_between_transfer',
            batchable: true
        }),
        is_builtin: true
    }
];

function getBuiltinModels() {
    return BUILTIN_MODELS.map(model => ({ ...model }));
}

function mergeBuiltinModels(models = []) {
    const merged = new Map(getBuiltinModels().map(model => [model.id, model]));
    models.forEach(model => {
        const builtin = merged.get(model.id);
        merged.set(model.id, {
            ...(builtin || {}),
            ...model,
            is_builtin: !!builtin || !!model.is_builtin
        });
    });
    return Array.from(merged.values());
}

module.exports = {
    getBuiltinModels,
    mergeBuiltinModels
};
