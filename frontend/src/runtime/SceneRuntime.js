import { SceneManager } from '../three/SceneManager.js';
import { applyRealtimeToDeviceModel, createConfiguredDeviceModel } from './DeviceRenderer.js';
import { createBatchedDeviceRenderer, getBatchableModelInfo } from './BatchDeviceRenderer.js';

function flattenDeviceDefinitions(workshops) {
    const definitions = [];
    let gLineIdx = 0;

    workshops.forEach((ws, wsIdx) => {
        (ws.lines || []).forEach((line) => {
            const lineDevices = line.devices || [];
            lineDevices.forEach((deviceCfg, devIdx) => {
                definitions.push({ deviceCfg, devIdx, wsIdx, gLineIdx });
            });
            gLineIdx++;
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
            onDeviceRegistered
        } = this.options;

        this.sceneManager = new SceneManager(this.containerElement, onLevelChange, onDeviceSelect);

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

        results.forEach(({ deviceCfg, deviceModel }) => {
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
