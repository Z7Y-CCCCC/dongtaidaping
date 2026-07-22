const PROFILE_DEFINITIONS = {
    compatibility: {
        label: '低配兼容',
        targetFps: 30,
        renderScale: 0.75,
        antialias: false,
        labelFps: 8,
        description: '适合无独显、4K 大屏或较老的现场电脑。'
    },
    balanced: {
        label: '均衡',
        targetFps: 45,
        renderScale: 1,
        antialias: false,
        labelFps: 12,
        description: '保持原始渲染分辨率，兼顾清晰度和操作流畅度。'
    },
    smooth: {
        label: '流畅',
        targetFps: 60,
        renderScale: 1,
        antialias: false,
        labelFps: 20,
        description: '适合性能较好的核显或普通独显，优先镜头流畅度。'
    },
    quality: {
        label: '高画质',
        targetFps: 60,
        renderScale: 1.25,
        antialias: true,
        labelFps: 30,
        description: '启用超采样和抗锯齿，适合有独显的展示电脑。'
    }
};

export const RENDER_PROFILE_OPTIONS = [
    ...Object.entries(PROFILE_DEFINITIONS).map(([value, definition]) => ({
        value,
        ...definition
    })),
    {
        value: 'custom',
        label: '自定义',
        description: '由工程师按现场硬件手动设置各项参数。'
    }
];

function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.max(min, Math.min(max, next));
}

function booleanValue(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function normalizeRenderSettings(settings = {}) {
    const requestedProfile = String(settings.render_profile || 'balanced');
    const profile = requestedProfile === 'custom' || PROFILE_DEFINITIONS[requestedProfile]
        ? requestedProfile
        : 'balanced';
    const preset = PROFILE_DEFINITIONS[profile] || PROFILE_DEFINITIONS.balanced;
    const custom = profile === 'custom';

    return {
        profile,
        profileLabel: custom ? '自定义' : preset.label,
        targetFps: Math.round(clampNumber(
            custom ? settings.render_target_fps : preset.targetFps,
            15,
            144,
            preset.targetFps
        )),
        renderScale: Number(clampNumber(
            custom ? settings.render_scale : preset.renderScale,
            0.5,
            1.5,
            preset.renderScale
        ).toFixed(2)),
        antialias: custom
            ? booleanValue(settings.render_antialias, preset.antialias)
            : preset.antialias,
        labelFps: Math.round(clampNumber(
            custom ? settings.render_label_fps : preset.labelFps,
            1,
            30,
            preset.labelFps
        ))
    };
}
