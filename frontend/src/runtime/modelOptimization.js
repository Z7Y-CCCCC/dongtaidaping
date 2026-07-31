const DEFAULTS = Object.freeze({
    mode: 'auto',
    mergeStatic: true,
    instanceRepeated: true,
    preserveAnimated: true,
    materialEnhancement: 'auto',
    contactShadow: true,
    environmentIntensity: 0.85
});

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function boolValue(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.max(min, Math.min(max, next));
}

export function resolveModelOptimization(modelInfoOrMetadata = {}) {
    const metadata = modelInfoOrMetadata?.metadata !== undefined
        ? parseJson(modelInfoOrMetadata.metadata, {})
        : parseJson(modelInfoOrMetadata, {});
    const raw = metadata.optimization || metadata.runtime?.optimization || null;
    const hasExplicitConfig = !!raw && typeof raw === 'object';
    const mode = ['auto', 'off'].includes(raw?.mode)
        ? raw.mode
        : (!hasExplicitConfig && metadata.batchable === false ? 'off' : DEFAULTS.mode);
    const materialEnhancement = ['auto', 'original'].includes(raw?.materialEnhancement || raw?.material_enhancement)
        ? (raw.materialEnhancement || raw.material_enhancement)
        : DEFAULTS.materialEnhancement;

    return {
        mode,
        enabled: mode !== 'off',
        mergeStatic: boolValue(raw?.mergeStatic ?? raw?.merge_static, DEFAULTS.mergeStatic),
        instanceRepeated: boolValue(raw?.instanceRepeated ?? raw?.instance_repeated, DEFAULTS.instanceRepeated),
        preserveAnimated: true,
        materialEnhancement,
        contactShadow: boolValue(raw?.contactShadow ?? raw?.contact_shadow, DEFAULTS.contactShadow),
        environmentIntensity: clampNumber(
            raw?.environmentIntensity ?? raw?.environment_intensity,
            0,
            2,
            DEFAULTS.environmentIntensity
        )
    };
}

function nameIncludes(name, terms) {
    const normalized = String(name || '').toLowerCase();
    return terms.some(term => normalized.includes(term));
}

export function enhanceModelMaterial(material, optimization) {
    if (!material) return material;
    if ('envMapIntensity' in material) {
        material.envMapIntensity = optimization.environmentIntensity;
    }
    if (optimization.materialEnhancement !== 'auto' || !material.isMeshStandardMaterial) {
        material.needsUpdate = true;
        return material;
    }

    // Authored PBR textures are authoritative. Heuristics only repair plain,
    // texture-less materials that otherwise render with generic defaults.
    const hasAuthoredSurface = !!(
        material.map
        || material.normalMap
        || material.roughnessMap
        || material.metalnessMap
        || material.aoMap
    );
    if (hasAuthoredSurface) {
        material.needsUpdate = true;
        return material;
    }

    const name = material.name || '';
    if (nameIncludes(name, ['stainless', 'steel', 'metal', 'iron', 'aluminium', 'aluminum', '不锈钢', '钢', '金属'])) {
        material.metalness = Math.max(Number(material.metalness) || 0, 0.72);
        material.roughness = Math.min(Math.max(Number(material.roughness) || 0.34, 0.22), 0.48);
    } else if (nameIncludes(name, ['brass', 'copper', 'bronze', '黄铜', '紫铜', '铜'])) {
        material.metalness = Math.max(Number(material.metalness) || 0, 0.68);
        material.roughness = Math.min(Math.max(Number(material.roughness) || 0.32, 0.24), 0.5);
    } else if (nameIncludes(name, ['rubber', 'hose', 'gasket', '橡胶', '胶管', '密封'])) {
        material.metalness = 0;
        material.roughness = Math.max(Number(material.roughness) || 0, 0.74);
    } else if (nameIncludes(name, ['paint', 'panel', 'cabinet', 'cover', 'body', '漆', '面板', '柜', '外壳'])) {
        material.metalness = Math.min(Number(material.metalness) || 0, 0.08);
        material.roughness = Math.min(Math.max(Number(material.roughness) || 0.42, 0.32), 0.58);
    }

    material.needsUpdate = true;
    return material;
}

export function shouldOptimizeModelGroup(modelInfo, instanceCount) {
    const optimization = resolveModelOptimization(modelInfo);
    if (!optimization.enabled) return false;
    if (optimization.mergeStatic) return true;
    return optimization.instanceRepeated && instanceCount > 1;
}

export const DEFAULT_MODEL_OPTIMIZATION = DEFAULTS;
