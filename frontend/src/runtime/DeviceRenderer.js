import { createDeviceModel } from '../three/ModelFactory.js';

function parseInstanceConfig(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

function numberOrDefault(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

export async function createConfiguredDeviceModel(definition, models = []) {
    const { deviceCfg, devIdx, wsIdx, gLineIdx } = definition;
    const deviceModel = await createDeviceModel(deviceCfg, models);
    const instanceConfig = parseInstanceConfig(deviceCfg.instance_config);
    deviceModel.userData.instanceConfig = instanceConfig;

    deviceModel.position.set(
        numberOrDefault(deviceCfg.pos_x, (devIdx - 2) * 14),
        numberOrDefault(deviceCfg.pos_y, 0),
        numberOrDefault(deviceCfg.pos_z, -gLineIdx * 16 - wsIdx * 20)
    );

    const rotationY = Number(deviceCfg.rotation_y);
    if (Number.isFinite(rotationY)) deviceModel.rotation.y = rotationY;

    const defaultScale = deviceModel.userData?.defaultScale || 1;
    const configuredScale = numberOrDefault(deviceCfg.scale, 1);
    const instanceScale = Number(instanceConfig.scaleMultiplier || 1);
    const finalScale = defaultScale * configuredScale * (Number.isFinite(instanceScale) ? instanceScale : 1);
    if (finalScale !== 1) {
        deviceModel.scale.setScalar(finalScale);
    }

    if (deviceModel.labelAnchor && Number.isFinite(Number(instanceConfig.labelY))) {
        deviceModel.labelAnchor.position.y = Number(instanceConfig.labelY);
    }

    if (deviceModel.statusLight && Number.isFinite(Number(instanceConfig.statusLightY))) {
        deviceModel.statusLight.position.y = Number(instanceConfig.statusLightY);
    }

    return deviceModel;
}

export function applyRealtimeToDeviceModel(deviceModel, data) {
    if (!deviceModel || !data) return;
    deviceModel.updateData(data);
    deviceModel.userData.lastRealtimeAt = Date.now();
    deviceModel.userData.quality = resolveDeviceQuality(data);
}

export function resolveDeviceQuality(data) {
    const groups = data?.quality || {};
    const values = Object.values(groups).flatMap(group => Object.values(group || {}));
    if (values.includes('bad')) return 'bad';
    if (values.includes('stale')) return 'stale';
    return 'good';
}
