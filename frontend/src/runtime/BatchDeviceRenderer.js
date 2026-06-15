import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadGltf, resolveBackendAssetUrl } from '../three/ModelFactory.js';
import { resolveDeviceQuality } from './DeviceRenderer.js';

const STATUS_COLORS = {
    bad: new THREE.Color(0xd96060),
    stale: new THREE.Color(0xf0b35a),
    alarm: new THREE.Color(0xff3333),
    running: new THREE.Color(0x00ff88),
    idle: new THREE.Color(0x666666)
};

const tempMatrix = new THREE.Matrix4();
const tempPosition = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();
const tempScale = new THREE.Vector3();
const identityQuaternion = new THREE.Quaternion();

function parseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function numberOrDefault(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

function modelMetadata(modelInfo) {
    return parseJson(modelInfo?.metadata, {});
}

export function getBatchableModelInfo(deviceCfg, models = []) {
    const modelInfo = models.find(item => item.id === deviceCfg.model_type);
    if (!modelInfo || modelInfo.id === 'builtin_furnace' || !modelInfo.file_path) return null;

    const metadata = modelMetadata(modelInfo);
    if (metadata.batchable === false) return null;
    return modelInfo;
}

function collectMergedParts(root) {
    root.updateMatrixWorld(true);
    const grouped = new Map();
    const rootBox = new THREE.Box3().setFromObject(root);

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry || !child.material) return;
        const material = Array.isArray(child.material) ? child.material[0] : child.material;
        const key = material.name || material.uuid;
        if (!grouped.has(key)) {
            grouped.set(key, { material: material.clone(), geometries: [] });
        }

        const geometry = child.geometry.clone();
        geometry.applyMatrix4(child.matrixWorld);
        grouped.get(key).geometries.push(geometry);
    });

    const parts = [];
    grouped.forEach(({ material, geometries }, key) => {
        const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        material.transparent = false;
        material.depthWrite = true;
        parts.push({ key, geometry, material });
    });

    return { parts, rootBox };
}

function getDefinitionTransform(definition, modelInfo) {
    const { deviceCfg, devIdx, wsIdx, gLineIdx } = definition;
    const instanceConfig = parseJson(deviceCfg.instance_config, {});
    const defaultScale = numberOrDefault(modelInfo.default_scale, 1);
    const configuredScale = numberOrDefault(deviceCfg.scale, 1);
    const instanceScale = numberOrDefault(instanceConfig.scaleMultiplier, 1);
    return {
        position: new THREE.Vector3(
            numberOrDefault(deviceCfg.pos_x, (devIdx - 2) * 14),
            numberOrDefault(deviceCfg.pos_y, 0),
            numberOrDefault(deviceCfg.pos_z, -gLineIdx * 16 - wsIdx * 20)
        ),
        rotationY: numberOrDefault(deviceCfg.rotation_y, 0),
        scale: defaultScale * configuredScale * instanceScale,
        instanceConfig
    };
}

class BatchedDeviceProxy extends THREE.Group {
    constructor(definition, index, batchRenderer, modelInfo, rootBox) {
        super();
        const { deviceCfg } = definition;
        const transform = getDefinitionTransform(definition, modelInfo);

        this.deviceConfig = deviceCfg;
        this.batchRenderer = batchRenderer;
        this.instanceIndex = index;
        this.furnaceId = deviceCfg.id;
        this.furnaceName = deviceCfg.name;
        this.userData.isDevice = true;
        this.userData.id = deviceCfg.id;
        this.userData.renderedByBatch = true;
        this.userData.defaultScale = numberOrDefault(modelInfo.default_scale, 1);
        this.userData.instanceConfig = transform.instanceConfig;

        this.position.copy(transform.position);
        this.rotation.y = transform.rotationY;
        this.scale.setScalar(transform.scale);
        this.localBox = rootBox.clone();
        this.worldBox = new THREE.Box3();
        this.raycastPoint = new THREE.Vector3();
        this.xRayEnabled = false;
        this.lastTempText = null;
        this.lastCarbonText = null;

        this.installVisibleTracker();
        this.createLabel();
    }

    installVisibleTracker() {
        const initialVisible = this.visible;
        this._batchVisible = initialVisible;
        Object.defineProperty(this, 'visible', {
            configurable: true,
            enumerable: true,
            get: () => this._batchVisible,
            set: (visible) => {
                const nextVisible = !!visible;
                if (this._batchVisible === nextVisible) return;
                this._batchVisible = nextVisible;
                this.batchRenderer.markInstanceDirty(this.instanceIndex);
                this.batchRenderer.markXRayDirty();
            }
        });
    }

    createLabel() {
        const div = document.createElement('div');
        div.className = 'furnace-label';
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.5s';
        div.innerHTML = `
            <div class="header">${this.furnaceName}</div>
            <div class="data-row">温度: <span data-field="temp">--</span> °C</div>
            <div class="data-row">碳势: <span data-field="carbon">--</span> %</div>
        `;

        this.tempEl = div.querySelector('[data-field="temp"]');
        this.carbonEl = div.querySelector('[data-field="carbon"]');
        this.labelDiv = div;
        this.labelObj = new CSS2DObject(div);
        this.labelAnchor = new THREE.Object3D();
        this.labelAnchor.position.set(0, numberOrDefault(this.userData.instanceConfig.labelY, 3.3), 0);
        this.add(this.labelAnchor);
        this.labelAnchor.add(this.labelObj);
    }

    setLabelVisible(visible) {
        if (this.labelDiv) this.labelDiv.style.opacity = visible ? '1' : '0';
    }

    setXRayMode(enable) {
        const nextEnabled = !!enable;
        if (this.xRayEnabled === nextEnabled) return;
        this.xRayEnabled = nextEnabled;
        this.batchRenderer.markXRayDirty();
    }

    updateData(data) {
        const tempText = data.analog?.actual_temp ?? '--';
        const carbonText = data.analog?.actual_carbon ?? '--';
        if (this.tempEl && this.lastTempText !== tempText) {
            this.tempEl.innerText = tempText;
            this.lastTempText = tempText;
        }
        if (this.carbonEl && this.lastCarbonText !== carbonText) {
            this.carbonEl.innerText = carbonText;
            this.lastCarbonText = carbonText;
        }
        this.batchRenderer.updateInstanceState(this.instanceIndex, data);
    }

    raycast(raycaster, intersects) {
        if (!this.visible) return;
        this.updateMatrixWorld(true);
        this.worldBox.copy(this.localBox).applyMatrix4(this.matrixWorld);
        const hitPoint = raycaster.ray.intersectBox(this.worldBox, this.raycastPoint);
        if (!hitPoint) return;

        const distance = raycaster.ray.origin.distanceTo(hitPoint);
        if (distance < raycaster.near || distance > raycaster.far) return;
        intersects.push({
            distance,
            point: hitPoint.clone(),
            object: this
        });
    }

    dispose() {}
}

class DeviceBatchRenderer extends THREE.Group {
    constructor(modelInfo, parts, rootBox, definitions) {
        super();
        this.modelInfo = modelInfo;
        this.rootBox = rootBox;
        this.definitions = definitions;
        this.proxies = [];
        this.instancedMeshes = [];
        this.statusColorHexes = new Array(definitions.length).fill(null);
        this.statusLightOffsets = definitions.map(definition => {
            const cfg = parseJson(definition.deviceCfg.instance_config, {});
            return numberOrDefault(cfg.statusLightY, 2.8);
        });
        this.dirtyIndexes = new Set();
        this.transformSnapshots = definitions.map(() => ({
            visible: null,
            px: NaN,
            py: NaN,
            pz: NaN,
            rx: NaN,
            ry: NaN,
            rz: NaN,
            sx: NaN,
            sy: NaN,
            sz: NaN
        }));
        this.lastXRayMode = null;
        this.xRayDirty = true;

        parts.forEach(({ geometry, material, key }) => {
            const mesh = new THREE.InstancedMesh(geometry, material, definitions.length);
            mesh.name = `batch_${modelInfo.id}_${key}`;
            mesh.frustumCulled = false;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            this.instancedMeshes.push(mesh);
            this.add(mesh);
        });

        this.createStatusLights(definitions.length);
    }

    createStatusLights(count) {
        const geometry = new THREE.SphereGeometry(0.18, 10, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.name = `batch_${this.modelInfo.id}_status_lights`;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
        this.statusLightMesh = mesh;
        this.add(mesh);
    }

    createProxy(definition, index) {
        const proxy = new BatchedDeviceProxy(definition, index, this, this.modelInfo, this.rootBox);
        this.proxies[index] = proxy;
        this.markInstanceDirty(index);
        this.updateInstanceColor(index, STATUS_COLORS.idle);
        return proxy;
    }

    markInstanceDirty(index) {
        if (index < 0 || index >= this.definitions.length) return;
        this.dirtyIndexes.add(index);
    }

    markXRayDirty() {
        this.xRayDirty = true;
    }

    hasTransformChanged(index) {
        const proxy = this.proxies[index];
        const snapshot = this.transformSnapshots[index];
        if (!proxy || !snapshot) return false;

        return snapshot.visible !== proxy.visible
            || snapshot.px !== proxy.position.x
            || snapshot.py !== proxy.position.y
            || snapshot.pz !== proxy.position.z
            || snapshot.rx !== proxy.rotation.x
            || snapshot.ry !== proxy.rotation.y
            || snapshot.rz !== proxy.rotation.z
            || snapshot.sx !== proxy.scale.x
            || snapshot.sy !== proxy.scale.y
            || snapshot.sz !== proxy.scale.z;
    }

    rememberTransform(index) {
        const proxy = this.proxies[index];
        const snapshot = this.transformSnapshots[index];
        if (!proxy || !snapshot) return;

        snapshot.visible = proxy.visible;
        snapshot.px = proxy.position.x;
        snapshot.py = proxy.position.y;
        snapshot.pz = proxy.position.z;
        snapshot.rx = proxy.rotation.x;
        snapshot.ry = proxy.rotation.y;
        snapshot.rz = proxy.rotation.z;
        snapshot.sx = proxy.scale.x;
        snapshot.sy = proxy.scale.y;
        snapshot.sz = proxy.scale.z;
    }

    updateInstanceState(index, data) {
        const quality = resolveDeviceQuality(data);
        const color = quality === 'bad'
            ? STATUS_COLORS.bad
            : quality === 'stale'
                ? STATUS_COLORS.stale
                : data.status?.alarm
                    ? STATUS_COLORS.alarm
                    : data.status?.running
                        ? STATUS_COLORS.running
                        : STATUS_COLORS.idle;
        this.updateInstanceColor(index, color);
    }

    updateInstanceColor(index, color) {
        const colorHex = color.getHex();
        if (this.statusColorHexes[index] === colorHex) return;
        this.statusColorHexes[index] = colorHex;
        this.statusLightMesh.setColorAt(index, color);
        this.statusLightMesh.instanceColor.needsUpdate = true;
    }

    updateInstanceMatrix(index) {
        const proxy = this.proxies[index];
        if (!proxy) return;

        const visibleScale = proxy.visible ? 1 : 0;
        tempPosition.copy(proxy.position);
        tempQuaternion.setFromEuler(proxy.rotation);
        tempScale.copy(proxy.scale).multiplyScalar(visibleScale);
        tempMatrix.compose(tempPosition, tempQuaternion, tempScale);

        this.instancedMeshes.forEach(mesh => {
            mesh.setMatrixAt(index, tempMatrix);
        });

        tempPosition.set(0, this.statusLightOffsets[index], 0).applyMatrix4(tempMatrix);
        tempScale.setScalar(visibleScale);
        tempMatrix.compose(tempPosition, identityQuaternion, tempScale);
        this.statusLightMesh.setMatrixAt(index, tempMatrix);
        this.rememberTransform(index);
    }

    detectTransformChanges() {
        this.proxies.forEach((_, index) => {
            if (this.hasTransformChanged(index)) {
                this.markInstanceDirty(index);
                this.markXRayDirty();
            }
        });
    }

    flushMatrixUpdates() {
        if (this.dirtyIndexes.size === 0) return;

        this.dirtyIndexes.forEach(index => this.updateInstanceMatrix(index));
        this.dirtyIndexes.clear();

        this.instancedMeshes.forEach(mesh => {
            mesh.instanceMatrix.needsUpdate = true;
        });
        this.statusLightMesh.instanceMatrix.needsUpdate = true;
    }

    reconcileXRayMode() {
        if (!this.xRayDirty) return;
        this.xRayDirty = false;
        const enable = this.proxies.some(proxy => proxy?.visible && proxy.xRayEnabled);
        if (this.lastXRayMode === enable) return;
        this.lastXRayMode = enable;
        this.instancedMeshes.forEach(mesh => {
            mesh.material.transparent = enable;
            mesh.material.opacity = enable ? 0.25 : 1;
            mesh.material.depthWrite = !enable;
            mesh.material.needsUpdate = true;
        });
    }

    update() {
        this.detectTransformChanges();
        this.flushMatrixUpdates();
        this.reconcileXRayMode();
    }

    dispose() {
        this.instancedMeshes.forEach(mesh => {
            mesh.geometry.dispose();
            mesh.material.dispose();
        });
        if (this.statusLightMesh) {
            this.statusLightMesh.geometry.dispose();
            this.statusLightMesh.material.dispose();
        }
    }
}

export async function createBatchedDeviceRenderer(modelInfo, definitions) {
    const root = await loadGltf(resolveBackendAssetUrl(modelInfo.file_path));
    const { parts, rootBox } = collectMergedParts(root);
    const batchRenderer = new DeviceBatchRenderer(modelInfo, parts, rootBox, definitions);
    const deviceModels = definitions.map((definition, index) => batchRenderer.createProxy(definition, index));
    return { batchRenderer, deviceModels };
}
