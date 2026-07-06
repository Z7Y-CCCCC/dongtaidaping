import { SceneManager } from '../three/SceneManager.js';
import { applyRealtimeToDeviceModel, createConfiguredDeviceModel } from './DeviceRenderer.js';
import { createBatchedDeviceRenderer, getBatchableModelInfo } from './BatchDeviceRenderer.js';

function parseInstanceConfig(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

function isAuxiliaryDevice(deviceCfg) {
    const instanceConfig = parseInstanceConfig(deviceCfg?.instance_config);
    return deviceCfg?.model_type === 'transfer_cart'
        || instanceConfig.role === 'transfer_cart'
        || instanceConfig.role === 'auxiliary'
        || instanceConfig.sceneObject === true;
}

function flattenDeviceDefinitions(workshops) {
    const definitions = [];
    let gLineIdx = 0;

    workshops.forEach((ws, wsIdx) => {
        const firstWorkshopLineIdx = gLineIdx;
        (ws.lines || []).forEach((line) => {
            const lineDevices = line.devices || [];
            lineDevices.forEach((deviceCfg, devIdx) => {
                definitions.push({
                    deviceCfg,
                    devIdx,
                    wsIdx,
                    gLineIdx,
                    lineId: line.id,
                    isLineMember: !isAuxiliaryDevice(deviceCfg)
                });
            });
            gLineIdx++;
        });
        const workshopAuxLineIdx = Math.max(firstWorkshopLineIdx, gLineIdx - 1);
        (ws.devices || []).forEach((deviceCfg, devIdx) => {
            definitions.push({
                deviceCfg,
                devIdx,
                wsIdx,
                gLineIdx: workshopAuxLineIdx,
                lineId: deviceCfg.line_id || '',
                isLineMember: false
            });
        });
    });

    return definitions;
}

export class SceneRuntime {
    constructor(containerElement, options) {
        this.containerElement = containerElement;
        this.options = options;
        this.furnaces = new Map();
        this.sceneManager = null;
    }

    async start() {
        const {
            workshops,
            models,
            cameraMode,
            onLevelChange,
            onDeviceSelect,
            onDeviceRegistered,
            interactionOptions
        } = this.options;

        this.sceneManager = new SceneManager(this.containerElement, onLevelChange, onDeviceSelect, interactionOptions);

        const definitions = flattenDeviceDefinitions(workshops || []);
        const results = new Array(definitions.length);
        const batchGroups = new Map();

        definitions.forEach((definition, index) => {
            const modelInfo = getBatchableModelInfo(definition.deviceCfg, models || []);
            if (!modelInfo) return;
            const batchKey = `${modelInfo.id}:${modelInfo.file_path}`;
            if (!batchGroups.has(batchKey)) {
                batchGroups.set(batchKey, { modelInfo, items: [] });
            }
            batchGroups.get(batchKey).items.push({ definition, index });
        });

        const batchedIndexes = new Set();
        for (const group of batchGroups.values()) {
            if (group.items.length < 2) continue;
            const batch = await createBatchedDeviceRenderer(
                group.modelInfo,
                group.items.map(item => item.definition)
            );
            this.sceneManager.addBatchRenderer(batch.batchRenderer);
            group.items.forEach((item, localIndex) => {
                results[item.index] = {
                    ...item.definition,
                    deviceModel: batch.deviceModels[localIndex]
                };
                batchedIndexes.add(item.index);
            });
        }

        await Promise.all(definitions.map(async (definition, index) => {
            if (batchedIndexes.has(index)) return;
            results[index] = {
                ...definition,
                deviceModel: await createConfiguredDeviceModel(definition, models || [])
            };
        }));

        results.forEach(({ deviceCfg, deviceModel, wsIdx, gLineIdx, lineId, isLineMember }) => {
            Object.assign(deviceModel.userData, {
                workshopIdx: wsIdx,
                globalLineIndex: gLineIdx,
                lineId,
                isLineMember
            });
            this.sceneManager.addFurnace(deviceModel);
            this.furnaces.set(deviceCfg.id, deviceModel);
            if (onDeviceRegistered) onDeviceRegistered(deviceCfg);
        });

        this.sceneManager.setTopologyConfig(workshops || [], cameraMode || 'auto');
        this.sceneManager.animate();
        return this;
    }

    applyDeviceData(data) {
        const deviceModel = this.furnaces.get(data?.furnace_id);
        applyRealtimeToDeviceModel(deviceModel, data);
    }

    flyToFactory() {
        this.sceneManager?.flyToFactory();
    }

    flyToWorkshop(index) {
        this.sceneManager?.flyToWorkshop(index);
    }

    flyToLine(index) {
        this.sceneManager?.flyToLine(index);
    }

    goUp() {
        this.sceneManager?.goUp();
    }

    controlCamera(action) {
        if (!this.sceneManager) return;
        switch (action) {
            case 'rotateLeft':
                this.sceneManager.rotateCamera(Math.PI / 8);
                break;
            case 'rotateRight':
                this.sceneManager.rotateCamera(-Math.PI / 8);
                break;
            case 'zoomIn':
                this.sceneManager.zoomCamera(true);
                break;
            case 'zoomOut':
                this.sceneManager.zoomCamera(false);
                break;
            default:
                break;
        }
    }

    dispose() {
        this.sceneManager?.dispose();
        this.sceneManager = null;
        this.furnaces.clear();
    }
}
