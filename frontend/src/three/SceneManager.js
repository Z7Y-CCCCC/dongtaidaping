import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import gsap from 'gsap';

export class SceneManager {
    constructor(containerElement, onLevelChange, onDeviceSelect) {
        this.container = containerElement;
        this.width = window.innerWidth;
        this.height = window.innerHeight;

        this.onLevelChange = onLevelChange; // Callback 通知 Vue 层级变化
        this.onDeviceSelect = onDeviceSelect; // Callback 传递选中的设备数据

        this.currentLevel = 0; // 0: 全局, 1: 产线, 2: 单机
        this.furnaces = [];
        this.batchRenderers = [];
        this.lineConfig = []; // 产线配置（由 setLineConfig 注入）
        this.lineDeviceRanges = []; // 每条产线在 furnaces 数组中的起止索引
        this.disposed = false;
        this.animationFrameId = null;
        this.boundOnWindowResize = this.onWindowResize.bind(this);
        this.labelsVisible = false;
        this.frameCount = 0;
        this.lastFrameTime = performance.now();

        this.initScene();
        this.initCamera();
        this.initRenderer();
        this.initCSS2DRenderer();
        this.initControls();
        this.initLights();
        this.initRaycaster();

        this.updatables = [];

        window.addEventListener('resize', this.boundOnWindowResize);
    }

    initScene() {
        this.scene = new THREE.Scene();
        
        // 真实车间观感：偏暖灰环境、环氧地坪、通道标线和尺度网格。
        const envColor = 0x59636c;
        this.scene.background = new THREE.Color(envColor);
        this.scene.fog = new THREE.FogExp2(envColor, 0.0035);

        const groundGeo = new THREE.PlaneGeometry(500, 500);
        const groundMat = new THREE.MeshStandardMaterial({
            color: 0x3f464d,
            roughness: 0.52,
            metalness: 0.1,
            depthWrite: true
        });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.1;
        ground.receiveShadow = true;
        this.scene.add(ground);

        const grid = new THREE.GridHelper(420, 42, 0x6f7b84, 0x4c545c);
        grid.position.y = -0.085;
        grid.material.opacity = 0.32;
        grid.material.transparent = true;
        this.scene.add(grid);

        const aisleMat = new THREE.MeshStandardMaterial({ color: 0x2d3338, roughness: 0.65, metalness: 0.05 });
        const aisle = new THREE.Mesh(new THREE.PlaneGeometry(420, 8), aisleMat);
        aisle.rotation.x = -Math.PI / 2;
        aisle.position.set(0, -0.075, 8);
        aisle.receiveShadow = true;
        this.scene.add(aisle);

        const lineMat = new THREE.MeshBasicMaterial({ color: 0xf0b35a });
        [-4.1, 4.1].forEach(z => {
            const line = new THREE.Mesh(new THREE.PlaneGeometry(420, 0.18), lineMat);
            line.rotation.x = -Math.PI / 2;
            line.position.set(0, -0.065, 8 + z);
            this.scene.add(line);
        });
    }

    initCamera() {
        this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
        // Level 0 初始相机位置：上帝视角，看全景
        this.camera.position.set(0, 30, 40);
        this.camera.lookAt(0, 0, 0);
    }

    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0; // 有了真实环境光后，曝光度降回标准值
        
        // 多设备大屏优先保证帧率，默认关闭实时阴影，后续可做质量档位。
        this.renderer.shadowMap.enabled = false;
        
        this.container.appendChild(this.renderer.domElement);
    }

    initCSS2DRenderer() {
        this.labelRenderer = new CSS2DRenderer();
        this.labelRenderer.setSize(this.width, this.height);
        this.labelRenderer.domElement.style.position = 'absolute';
        this.labelRenderer.domElement.style.top = '0px';
        this.labelRenderer.domElement.style.pointerEvents = 'none';
        this.container.appendChild(this.labelRenderer.domElement);
    }

    initControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.1;
    }

    initLights() {
        // 使用半球光提供基础的体积感和漫反射（天光白，地光深灰蓝）
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x445566, 1.5);
        this.scene.add(hemiLight);

        // 主光源，产生基础阴影
        const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
        dirLight.position.set(30, 40, 20); // 侧上方的厂房顶灯视角
        dirLight.castShadow = false;
        this.scene.add(dirLight);
    }

    initRaycaster() {
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.boundOnCanvasClick = this.handleCanvasClick.bind(this);
        this.renderer.domElement.addEventListener('click', this.boundOnCanvasClick);
    }

    handleCanvasClick(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        
        // 找出所有可以被点击的炉子
        const visibleFurnaces = this.furnaces.filter(furnace => furnace.visible);
        const intersects = this.raycaster.intersectObjects(visibleFurnaces, true);

        if (intersects.length > 0) {
            // 点击到了模型
            let object = intersects[0].object;
            while (object.parent && !object.userData.isDevice) { object = object.parent; }
            if (!object.userData.isDevice) return;

            const idx = this.furnaces.indexOf(object);
            const info = this.getDeviceLineInfo(idx);
            if (!info) return;

            if (this.currentLevel === 0) {
                // 全局视角点击，进入对应车间
                this.flyToWorkshop(info.workshopIdx);
                window.dispatchEvent(new CustomEvent('workshop-selected', { detail: info.workshopIdx }));
            } else if (this.currentLevel === 1) {
                // 车间视角点击，进入对应产线
                this.flyToLine(info.globalLineIndex);
                window.dispatchEvent(new CustomEvent('line-selected', { detail: info.globalLineIndex }));
            } else if (this.currentLevel === 2) {
                // 产线视角点击，进入设备详情
                this.flyToDevice(object);
            }
        }
    }

    addFurnace(furnace) {
        this.scene.add(furnace);
        this.updatables.push(furnace);
        this.furnaces.push(furnace);
    }

    addBatchRenderer(batchRenderer) {
        this.scene.add(batchRenderer);
        this.updatables.push(batchRenderer);
        this.batchRenderers.push(batchRenderer);
    }

    /**
     * 接收车间、产线、设备的拓扑结构
     */
    setTopologyConfig(workshops, cameraMode) {
        this.workshops = workshops;
        this.cameraMode = cameraMode || 'auto';
        
        this.lineDeviceRanges = [];
        let startIdx = 0;
        workshops.forEach((ws, wsIdx) => {
            (ws.lines || []).forEach((line, lineIdx) => {
                const count = (line.devices || []).length;
                this.lineDeviceRanges.push({ 
                    startIdx, 
                    endIdx: startIdx + count - 1, 
                    lineId: line.id,
                    workshopIdx: wsIdx,
                    globalLineIndex: this.lineDeviceRanges.length
                });
                startIdx += count;
            });
        });
        
        if (this.cameraMode === '4level' || (this.cameraMode === 'auto' && workshops.length > 1)) {
            this.topLevel = 0; // Factory
        } else {
            this.topLevel = 1; // Workshop
        }
    }

    /**
     * 获取某条产线的设备列表（内部产线全局索引）
     */
    getLineDevices(globalLineIndex) {
        const range = this.lineDeviceRanges[globalLineIndex];
        if (!range) return [];
        return this.furnaces.slice(range.startIdx, range.endIdx + 1);
    }
    
    /**
     * 获取某个车间的设备列表
     */
    getWorkshopDevices(workshopIdx) {
        const ranges = this.lineDeviceRanges.filter(r => r.workshopIdx === workshopIdx);
        if (ranges.length === 0) return [];
        const start = ranges[0].startIdx;
        const end = ranges[ranges.length - 1].endIdx;
        return this.furnaces.slice(start, end + 1);
    }

    /**
     * 根据炉子索引判断其归属
     */
    getDeviceLineInfo(furnaceIdx) {
        for (let i = 0; i < this.lineDeviceRanges.length; i++) {
            const range = this.lineDeviceRanges[i];
            if (furnaceIdx >= range.startIdx && furnaceIdx <= range.endIdx) {
                return { globalLineIndex: i, workshopIdx: range.workshopIdx };
            }
        }
        return null;
    }

    // --- 运镜控制 ---

    flyToFactory() {
        if (this.topLevel > 0) {
            this.flyToWorkshop(0); // 跳过工厂视角，直接进第一个车间
            return;
        }
        this.currentLevel = 0;
        this.onLevelChange(0);
        this._flyToDevices(this.furnaces, 0, 0.8, 0.6);
        this.furnaces.forEach(f => {
            f.visible = true;
            f.setLabelVisible(false);
            f.setXRayMode(false);
        });
        this.labelsVisible = false;
    }

    flyToWorkshop(wsIdx) {
        this.activeWorkshopIdx = wsIdx;
        this.currentLevel = 1;
        this.onLevelChange(1);
        const wsDevices = this.getWorkshopDevices(wsIdx);
        if (wsDevices.length === 0) return;
        this._flyToDevices(wsDevices, 0, 0.6, 0.5);
        this.furnaces.forEach((f, idx) => {
            const info = this.getDeviceLineInfo(idx);
            f.visible = (info && info.workshopIdx === wsIdx);
            f.setXRayMode(false);
            f.setLabelVisible(false);
        });
        this.labelsVisible = false;
    }

    flyToLine(globalLineIndex) {
        this.activeLineIndex = globalLineIndex;
        this.currentLevel = 2;
        this.onLevelChange(2);
        
        const lineDevices = this.getLineDevices(globalLineIndex);
        if (lineDevices.length === 0) return;
        
        let sumX = 0, sumZ = 0;
        lineDevices.forEach(f => { sumX += f.position.x; sumZ += f.position.z; });
        const centerX = sumX / lineDevices.length;
        const centerZ = sumZ / lineDevices.length;
        
        // 镜头飞向该产线正前方
        gsap.to(this.camera.position, { x: centerX, y: 15, z: centerZ + 30, duration: 1.5, ease: "power2.inOut" });
        gsap.to(this.controls.target, { x: centerX, y: 2, z: centerZ, duration: 1.5, ease: "power2.inOut" });
        
        // 隐藏其他产线，只显示当前产线，并显示悬浮标签
        this.furnaces.forEach((f, idx) => {
            const info = this.getDeviceLineInfo(idx);
            const isMatch = (info && info.globalLineIndex === globalLineIndex);
            f.visible = isMatch;
            f.setXRayMode(false);
            f.setLabelVisible(isMatch);
        });
        this.labelsVisible = true;
    }

    flyToDevice(device) {
        this.activeDeviceId = device.userData.id;
        this.currentLevel = 3;
        this.onLevelChange(3);
        this.onDeviceSelect(device.userData.id);

        const targetX = device.position.x;
        const targetZ = device.position.z;

        // 极限特写镜头，拉近观察内部
        gsap.to(this.camera.position, { x: targetX + 5, y: 4, z: targetZ + 6, duration: 1.5, ease: "power2.inOut" });
        gsap.to(this.controls.target, { x: targetX, y: 1.5, z: targetZ, duration: 1.5, ease: "power2.inOut" });
        
        // 隐藏其他设备，选中的设备开启透明(X-Ray)模式并隐藏顶部悬浮标签
        this.furnaces.forEach(f => {
            if (f === device) {
                f.visible = true;
                f.setLabelVisible(false); 
                f.setXRayMode(true);
            } else {
                f.visible = false;
                f.setLabelVisible(false);
                f.setXRayMode(false);
            }
        });
        this.labelsVisible = false;
    }

    goUp() {
        if (this.currentLevel === 3) {
            // 从设备返回产线
            const activeFurnace = this.furnaces.find(f => f.userData.id === this.activeDeviceId);
            if (activeFurnace) {
                const idx = this.furnaces.indexOf(activeFurnace);
                const info = this.getDeviceLineInfo(idx);
                if(info) {
                    this.flyToLine(info.globalLineIndex);
                    window.dispatchEvent(new CustomEvent('line-selected', { detail: info.globalLineIndex }));
                }
            }
        } else if (this.currentLevel === 2) {
            // 从产线返回车间
            const range = this.lineDeviceRanges[this.activeLineIndex];
            if(range) {
                this.flyToWorkshop(range.workshopIdx);
                window.dispatchEvent(new CustomEvent('workshop-selected', { detail: range.workshopIdx }));
            }
        } else if (this.currentLevel === 1) {
            // 从车间返回工厂（如果允许）
            if (this.topLevel === 0) {
                this.flyToFactory();
                window.dispatchEvent(new CustomEvent('factory-selected'));
            }
        }
    }

    _flyToDevices(devicesList, yOffset, heightRatio, zRatio) {
        let minZ = 0, maxZ = 0, minX = 0, maxX = 0;
        if(devicesList.length > 0) {
            minZ = devicesList[0].position.z; maxZ = minZ;
            minX = devicesList[0].position.x; maxX = minX;
            devicesList.forEach(f => {
                minZ = Math.min(minZ, f.position.z);
                maxZ = Math.max(maxZ, f.position.z);
                minX = Math.min(minX, f.position.x);
                maxX = Math.max(maxX, f.position.x);
            });
        }
        const centerX = (minX + maxX) / 2;
        const centerZ = (minZ + maxZ) / 2;
        const spanZ = Math.max(20, maxZ - minZ);
        const cameraHeight = Math.max(50, spanZ * heightRatio);
        const cameraZ = maxZ + Math.max(40, spanZ * zRatio);
        
        gsap.to(this.camera.position, { x: centerX, y: cameraHeight + yOffset, z: cameraZ, duration: 2.0, ease: "power2.inOut" });
        gsap.to(this.controls.target, { x: centerX, y: 0, z: centerZ, duration: 2.0, ease: "power2.inOut" });
    }

    // --- 供 UI 调用的视角控制 API ---
    rotateCamera(angleDelta) {
        // 围绕 target 旋转
        const r = this.camera.position.distanceTo(this.controls.target);
        // 当前角度
        const theta = Math.atan2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z);
        const newTheta = theta + angleDelta;
        
        gsap.to(this.camera.position, {
            x: this.controls.target.x + r * Math.sin(newTheta),
            z: this.controls.target.z + r * Math.cos(newTheta),
            duration: 0.5,
            ease: "power1.out"
        });
    }

    zoomCamera(zoomIn) {
        const dir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
        const dist = zoomIn ? 3 : -3;
        gsap.to(this.camera.position, {
            x: this.camera.position.x + dir.x * dist,
            y: this.camera.position.y + dir.y * dist,
            z: this.camera.position.z + dir.z * dist,
            duration: 0.5,
            ease: "power1.out"
        });
    }

    onWindowResize() {
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.camera.aspect = this.width / this.height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.labelRenderer.setSize(this.width, this.height);
    }

    animate() {
        if (this.disposed) return;
        this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
        const now = performance.now();
        const delta = Math.min((now - this.lastFrameTime) / 1000, 0.05);
        this.lastFrameTime = now;
        for (const obj of this.updatables) {
            if (obj.visible && obj.update) obj.update(delta);
        }

        this.controls.update();
        // 恢复原生高性能渲染，不用 Composer
        this.renderer.render(this.scene, this.camera);
        this.frameCount += 1;
        if (this.frameCount % 15 === 0) {
            window.__DASHBOARD_RENDERER_INFO__ = {
                calls: this.renderer.info.render.calls,
                triangles: this.renderer.info.render.triangles,
                lines: this.renderer.info.render.lines,
                points: this.renderer.info.render.points,
                pixelRatio: this.renderer.getPixelRatio()
            };
        }
        if (this.labelsVisible) {
            this.labelRenderer.render(this.scene, this.camera);
        }
    }

    /**
     * 销毁渲染器和所有资源，防止路由切换时 WebGL 上下文泄漏
     */
    dispose() {
        this.disposed = true;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        window.removeEventListener('resize', this.boundOnWindowResize);
        if (this.renderer?.domElement && this.boundOnCanvasClick) {
            this.renderer.domElement.removeEventListener('click', this.boundOnCanvasClick);
        }
        
        // 销毁所有炉子模型的几何体和材质
        this.furnaces.forEach(f => {
            if (f.dispose) f.dispose();
        });
        this.batchRenderers.forEach(batchRenderer => {
            if (batchRenderer.dispose) batchRenderer.dispose();
        });

        // 销毁渲染器
        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }
        
        // 移除 CSS2D 渲染器
        if (this.labelRenderer && this.labelRenderer.domElement && this.labelRenderer.domElement.parentNode) {
            this.labelRenderer.domElement.parentNode.removeChild(this.labelRenderer.domElement);
        }

        // 销毁 OrbitControls
        if (this.controls) {
            this.controls.dispose();
        }
    }
}
