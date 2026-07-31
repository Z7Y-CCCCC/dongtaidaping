// 通用纯函数:数值/排序工具、JSON 与设备实例配置解析。
// 无任何响应式依赖,可被 admin 下的 utils 与 composables 共享。

export function sortByOrder(list) {
    return [...list].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
}

export function numberOrDefault(value, fallback = 0) {
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
}

export function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value))
}

export function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === ''
}

export function optionalNumber(value) {
    return isBlank(value) ? null : Number(value)
}

export function parseInstanceConfig(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    try {
        return JSON.parse(value)
    } catch (e) {
        return {}
    }
}

export function parseEditableInstanceConfig(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    return JSON.parse(value)
}

export function stringifyInstanceConfigForEdit(value, defaultConfig = {}) {
    if (!value) return JSON.stringify(defaultConfig, null, 2)
    if (typeof value === 'string') {
        try {
            return JSON.stringify({ ...defaultConfig, ...JSON.parse(value) }, null, 2)
        } catch (e) {
            return value
        }
    }
    try {
        return JSON.stringify({ ...defaultConfig, ...value }, null, 2)
    } catch (e) {
        return JSON.stringify(defaultConfig, null, 2)
    }
}

export function isAuxiliaryDeviceConfig(device) {
    const config = parseInstanceConfig(device?.instance_config)
    return device?.model_type === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true
}
