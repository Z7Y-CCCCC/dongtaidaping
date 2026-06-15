import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneObject3D } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FurnaceModel } from './FurnaceModel.js';

const loader = new GLTFLoader();
const modelCache = new Map();

export function resolveBackendAssetUrl(filePath) {
    if (!filePath) return '';
    if (/^https?:\/\//i.test(filePath)) return filePath;

    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const host = window.location.hostname || 'localhost';
    const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    return `${protocol}//${host}:3001${normalizedPath}`;
}

export function loadGltf(url) {
    if (!modelCache.has(url)) {
        const promise = new Promise((resolve, reject) => {
            loader.load(url, (gltf) => {
                const root = gltf.scene || gltf.scenes?.[0];
                if (!root) {
                    reject(new Error('模型文件中没有可用场景'));
                    return;
                }
                normalizeModelRoot(root);
                resolve(root);
            }, undefined, reject);
        });
        modelCache.set(url, promise);
    }
    return modelCache.get(url);
}

function normalizeModelRoot(root) {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.y -= box.min.y;
    root.position.z -= center.z;
}

function collectMaterials(object, targetSet) {
    object.traverse((child) => {
        if (!child.isMesh) return;

        child.castShadow = false;
        child.receiveShadow = false;

        if (Array.isArray(child.material)) {
            child.material = child.material.map((mat) => mat.clone());
            child.material.forEach((mat) => targetSet.add(mat));
        } else if (child.material) {
            child.material = child.material.clone();
            targetSet.add(child.material);
        }
    });
}

class ImportedDeviceModel extends THREE.Group {
    constructor(deviceConfig, modelInfo) {
        super();
        this.deviceConfig = deviceConfig;
        this.modelInfo = modelInfo;
        this.furnaceId = deviceConfig.id;
        this.furnaceName = deviceConfig.name;
        this.userData.isDevice = true;
        this.userData.id = deviceConfig.id;
        this.userData.defaultScale = Number(modelInfo.default_scale || 1);

        this.materials = new Set();
        this.lastTempText = null;
        this.lastCarbonText = null;
        this.lastVisualState = null;
        this.xRayEnabled = null;
        this.createStatusLight();
        this.createLabel();
    }

    async load() {
        const url = resolveBackendAssetUrl(this.modelInfo.file_path);
        const cachedRoot = await loadGltf(url);
        const root = cloneObject3D(cachedRoot);

        collectMaterials(root, this.materials);
        this.modelRoot = root;
        this.add(root);
        return this;
    }

    createStatusLight() {
        const geometry = new THREE.SphereGeometry(0.18, 16, 16);
        const material = new THREE.MeshStandardMaterial({
            color: 0x666666,
            emissive: 0x000000,
            emissiveIntensity: 0
        });
        this.statusLight = new THREE.Mesh(geometry, material);
        this.statusLight.position.set(0, 2.8, 0);
        this.add(this.statusLight);
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
        this.labelObj = new CSS2DObject(div);
        this.labelDiv = div;

        this.labelAnchor = new THREE.Object3D();
        this.labelAnchor.position.set(0, 3.3, 0);
        this.add(this.labelAnchor);
        this.labelAnchor.add(this.labelObj);
    }

    setLabelVisible(visible) {
        if (this.labelDiv) {
            this.labelDiv.style.opacity = visible ? '1' : '0';
        }
    }

    setXRayMode(enable) {
        if (this.xRayEnabled === enable) return;
        this.xRayEnabled = enable;

        const opacity = enable ? 0.25 : 1;
        this.materials.forEach((mat) => {
            mat.transparent = enable;
            mat.opacity = opacity;
            mat.depthWrite = !enable;
            mat.needsUpdate = true;
        });
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

        const deviceQuality = this.resolveDeviceQuality(data);
        const isAlarm = !!data.status?.alarm;
        const isRunning = !!data.status?.running;
        const visualState = `${deviceQuality}:${isAlarm}:${isRunning}`;
        if (this.lastVisualState === visualState) return;
        this.lastVisualState = visualState;

        if (deviceQuality === 'bad') {
            this.statusLight.material.color.setHex(0xd96060);
            this.statusLight.material.emissive.setHex(0xd96060);
            this.statusLight.material.emissiveIntensity = 0.75;
        } else if (deviceQuality === 'stale') {
            this.statusLight.material.color.setHex(0xf0b35a);
            this.statusLight.material.emissive.setHex(0xf0b35a);
            this.statusLight.material.emissiveIntensity = 0.55;
        } else if (isAlarm) {
            this.statusLight.material.color.setHex(0xff3333);
            this.statusLight.material.emissive.setHex(0xff3333);
            this.statusLight.material.emissiveIntensity = 0.9;
        } else if (isRunning) {
            this.statusLight.material.color.setHex(0x00ff88);
            this.statusLight.material.emissive.setHex(0x00ff88);
            this.statusLight.material.emissiveIntensity = 0.6;
        } else {
            this.statusLight.material.color.setHex(0x666666);
            this.statusLight.material.emissive.setHex(0x000000);
            this.statusLight.material.emissiveIntensity = 0;
        }
    }

    resolveDeviceQuality(data) {
        const values = Object.values(data.quality || {}).flatMap(group => Object.values(group || {}));
        if (values.includes('bad')) return 'bad';
        if (values.includes('stale')) return 'stale';
        return 'good';
    }

    update() {}

    dispose() {
        this.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose());
            } else if (child.material) {
                child.material.dispose();
            }
        });
    }
}

export async function createDeviceModel(deviceConfig, models = []) {
    const modelInfo = models.find((item) => item.id === deviceConfig.model_type);
    if (!modelInfo || modelInfo.id === 'builtin_furnace' || !modelInfo.file_path) {
        return new FurnaceModel(deviceConfig.id, deviceConfig.name);
    }

    try {
        return await new ImportedDeviceModel(deviceConfig, modelInfo).load();
    } catch (error) {
        console.warn(`[ModelFactory] 模型 ${modelInfo.id} 加载失败，回退到内置炉子模型:`, error);
        return new FurnaceModel(deviceConfig.id, deviceConfig.name);
    }
}
