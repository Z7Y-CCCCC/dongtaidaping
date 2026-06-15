import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import gsap from 'gsap';

/**
 * 多用炉 3D 模型 (Multipurpose Furnace)
 * 
 * 结构布局 (从后到前，Z轴正方向为前):
 *   [排烟管] [加热室(主炉膛)] [中门] [前室] [前门] [淬火槽]
 *              ↑循环风扇                          ↑搅拌电机
 *       料盘在炉膛内，推拉链贯穿底部
 * 
 * 所有部件都存为实例属性，可被 updateData() 驱动动画
 */
export class FurnaceModel extends THREE.Group {
    constructor(id, name) {
        super();
        this.furnaceId = id;
        this.furnaceName = name;
        this.userData.isDevice = true;
        this.userData.id = id;

        // 动画状态缓存
        this.fanRunning = false;
        this.stirRunning = false;
        this.oilPumpOn = false;

        this.buildModel();
        this.createLabel();
    }

    // ===================== 模型构建 =====================

    buildModel() {
        // --- 参照现场真实照片的工业涂装材质 ---
        
        // 主体外壳/控制柜 (照片中是非常亮的灰白色)
        this.matBody = new THREE.MeshStandardMaterial({
            color: 0xe8eaed, roughness: 0.7, metalness: 0.1,
            depthWrite: true
        });
        
        // 顶部排烟罩/深色结构 (照片中是哑光黑色)
        this.matBodyDark = new THREE.MeshStandardMaterial({
            color: 0x222222, roughness: 0.8, metalness: 0.2,
            depthWrite: true
        });
        
        // 炉门 (照片中炉门区域是深色偏黑的金属)
        this.matDoor = new THREE.MeshStandardMaterial({
            color: 0x333333, roughness: 0.6, metalness: 0.5,
            depthWrite: true
        });
        
        // 电机 (标准银灰色)
        this.matMotor = new THREE.MeshStandardMaterial({
            color: 0x9ca3af, roughness: 0.4, metalness: 0.6
        });
        
        // 推拉链机构 (深金属色)
        this.matChain = new THREE.MeshStandardMaterial({
            color: 0x555555, roughness: 0.5, metalness: 0.8
        });
        
        // 底部淬火槽基座 (照片中是鲜艳的工业蓝)
        this.matQuench = new THREE.MeshStandardMaterial({
            color: 0x0055a4, roughness: 0.6, metalness: 0.2,
            depthWrite: true
        });
        
        // 淬火油 (内部液体)
        this.matOil = new THREE.MeshStandardMaterial({
            color: 0x2c1e16, roughness: 0.2, transparent: true, opacity: 0.8
        });
        
        // 料盘
        this.matTray = new THREE.MeshStandardMaterial({
            color: 0x888888, roughness: 0.6, metalness: 0.5
        });
        
        // 管道及安全护栏 (照片中带有显眼的安全黄/橙色)
        this.matPipe = new THREE.MeshStandardMaterial({
            color: 0xf59e0b, roughness: 0.5, metalness: 0.3,
            depthWrite: true
        });
        this.matIndicator = new THREE.MeshStandardMaterial({
            color: 0x333333, roughness: 0.3
        });

        // ===== 1. 加热室 (主炉膛) =====
        // 外壳
        const heatingChamber = new THREE.Mesh(
            new THREE.BoxGeometry(4, 3, 5),
            this.matBody
        );
        heatingChamber.position.set(0, 1.5, -2);
        this.add(heatingChamber);
        this.heatingChamber = heatingChamber;

        // 炉膛内壁 (耐火砖，橙红色调)
        const innerWall = new THREE.Mesh(
            new THREE.BoxGeometry(3.6, 2.6, 4.6),
            new THREE.MeshStandardMaterial({
                color: 0x8b4513, roughness: 0.9, metalness: 0.0,
                emissive: 0x331100, emissiveIntensity: 0.2
            })
        );
        innerWall.position.set(0, 1.5, -2);
        this.add(innerWall);
        this.innerWall = innerWall;

        // 加热室顶部加强筋 (装饰细节)
        for (let i = -1; i <= 1; i++) {
            const rib = new THREE.Mesh(
                new THREE.BoxGeometry(4.2, 0.15, 0.15),
                this.matBodyDark
            );
            rib.position.set(0, 3.05, -2 + i * 1.5);
            this.add(rib);
        }

        // ===== 2. 前室 =====
        const frontChamber = new THREE.Mesh(
            new THREE.BoxGeometry(4, 2.5, 2.5),
            this.matBodyDark
        );
        frontChamber.position.set(0, 1.25, 1.25);
        this.add(frontChamber);

        // ===== 3. 淬火槽 (前室前方) =====
        // 槽体外壳
        const quenchTank = new THREE.Mesh(
            new THREE.BoxGeometry(4.5, 2, 2),
            this.matQuench
        );
        quenchTank.position.set(0, 1, 3.5);
        this.add(quenchTank);
        this.quenchTank = quenchTank;

        // 油液面
        const oilSurface = new THREE.Mesh(
            new THREE.BoxGeometry(4.2, 0.05, 1.7),
            this.matOil
        );
        oilSurface.position.set(0, 1.8, 3.5);
        this.add(oilSurface);
        this.oilSurface = oilSurface;

        // ===== 4. 前门 (垂直升降) =====
        const frontDoorGroup = new THREE.Group();
        const frontDoorPanel = new THREE.Mesh(
            new THREE.BoxGeometry(4.3, 2.6, 0.15),
            this.matDoor
        );
        frontDoorPanel.position.set(0, 0, 0);
        frontDoorGroup.add(frontDoorPanel);

        // 门上的把手/加强条
        const doorHandle = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.3, 0.25),
            this.matMotor
        );
        doorHandle.position.set(0, 0, 0.1);
        frontDoorGroup.add(doorHandle);

        frontDoorGroup.position.set(0, 1.3, 2.45);
        this.add(frontDoorGroup);
        this.frontDoor = frontDoorGroup;
        this._frontDoorClosedY = 1.3;

        // ===== 5. 中门 (垂直升降) =====
        const middleDoorGroup = new THREE.Group();
        const middleDoorPanel = new THREE.Mesh(
            new THREE.BoxGeometry(4.1, 2.8, 0.12),
            this.matDoor
        );
        middleDoorGroup.add(middleDoorPanel);
        middleDoorGroup.position.set(0, 1.4, -0.25);
        this.add(middleDoorGroup);
        this.middleDoor = middleDoorGroup;
        this._middleDoorClosedY = 1.4;

        // ===== 6. 后门 (可选) =====
        const rearDoor = new THREE.Mesh(
            new THREE.BoxGeometry(4.1, 2.8, 0.12),
            this.matDoor
        );
        rearDoor.position.set(0, 1.4, -4.55);
        this.add(rearDoor);
        this.rearDoor = rearDoor;

        // ===== 7. 循环风扇电机 (加热室顶部) =====
        const fanMotorGroup = new THREE.Group();
        // 电机本体 (圆柱)
        const motorBody = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.45, 0.8, 16),
            this.matMotor.clone()
        );
        motorBody.position.y = 0;
        fanMotorGroup.add(motorBody);
        this.fanMotorBody = motorBody;

        // 电机底座
        const motorBase = new THREE.Mesh(
            new THREE.CylinderGeometry(0.55, 0.55, 0.15, 16),
            this.matBodyDark
        );
        motorBase.position.y = -0.45;
        fanMotorGroup.add(motorBase);

        // 风扇叶片 (十字形)
        this.fanBladesGroup = new THREE.Group();
        for (let i = 0; i < 4; i++) {
            const blade = new THREE.Mesh(
                new THREE.BoxGeometry(1.2, 0.06, 0.2),
                this.matChain
            );
            blade.rotation.y = (Math.PI / 2) * i;
            this.fanBladesGroup.add(blade);
        }
        this.fanBladesGroup.position.y = -0.7;
        fanMotorGroup.add(this.fanBladesGroup);

        fanMotorGroup.position.set(0, 3.5, -2);
        this.add(fanMotorGroup);
        this.fanMotorGroup = fanMotorGroup;

        // ===== 8. 搅拌电机 (淬火槽顶部/侧面) =====
        const stirMotorGroup = new THREE.Group();
        const stirBody = new THREE.Mesh(
            new THREE.CylinderGeometry(0.35, 0.35, 0.6, 12),
            this.matMotor.clone()
        );
        stirMotorGroup.add(stirBody);
        this.stirMotorBody = stirBody;

        // 搅拌轴
        const stirShaft = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.06, 1.5, 8),
            this.matChain
        );
        stirShaft.position.y = -1.0;
        stirMotorGroup.add(stirShaft);

        // 搅拌桨叶
        this.stirBlades = new THREE.Group();
        for (let i = 0; i < 3; i++) {
            const paddle = new THREE.Mesh(
                new THREE.BoxGeometry(0.8, 0.05, 0.12),
                this.matChain
            );
            paddle.rotation.y = (Math.PI / 1.5) * i;
            this.stirBlades.add(paddle);
        }
        this.stirBlades.position.y = -1.6;
        stirMotorGroup.add(this.stirBlades);

        stirMotorGroup.position.set(1.5, 2.8, 3.5);
        this.add(stirMotorGroup);
        this.stirMotorGroup = stirMotorGroup;

        // ===== 9. 推拉链 (底部贯穿) =====
        const chainGroup = new THREE.Group();

        // 链条主体 (长条)
        const chainBar = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 0.12, 6),
            this.matChain
        );
        chainBar.position.set(0, 0, 0);
        chainGroup.add(chainBar);

        // 链条上的齿/节 (装饰)
        for (let z = -2.5; z <= 2.5; z += 0.8) {
            const tooth = new THREE.Mesh(
                new THREE.BoxGeometry(0.9, 0.06, 0.15),
                this.matMotor
            );
            tooth.position.set(0, 0.08, z);
            chainGroup.add(tooth);
        }

        chainGroup.position.set(0, 0.12, 0);
        this.add(chainGroup);
        this.pushChain = chainGroup;
        this._chainBaseZ = 0;

        // ===== 10. 料盘/料框 (放在推拉链上) =====
        const tray = new THREE.Mesh(
            new THREE.BoxGeometry(2.8, 0.6, 2),
            this.matTray
        );
        tray.position.set(0, 0.5, 0);
        chainGroup.add(tray); // 料盘跟着推拉链一起动
        this.tray = tray;

        // 料框上的工件 (简化为几个小柱)
        for (let row = -0.6; row <= 0.6; row += 0.6) {
            for (let col = -0.5; col <= 0.5; col += 0.5) {
                const workpiece = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8),
                    new THREE.MeshStandardMaterial({
                        color: 0xb0b0b0, roughness: 0.4, metalness: 0.7
                    })
                );
                workpiece.position.set(col, 0.75, row);
                chainGroup.add(workpiece);
            }
        }

        // ===== 11. 排烟管 (加热室后方顶部) =====
        const exhaustPipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.2, 2, 8),
            this.matPipe
        );
        exhaustPipe.position.set(-1.2, 4, -4);
        this.add(exhaustPipe);

        // 排烟管顶部帽
        const exhaustCap = new THREE.Mesh(
            new THREE.CylinderGeometry(0.35, 0.25, 0.3, 8),
            this.matPipe
        );
        exhaustCap.position.set(-1.2, 5.1, -4);
        this.add(exhaustCap);

        // ===== 12. 油泵指示灯 (淬火槽侧面) =====
        const oilPumpIndicator = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 12, 12),
            this.matIndicator.clone()
        );
        oilPumpIndicator.position.set(2.3, 1.8, 3.5);
        this.add(oilPumpIndicator);
        this.oilPumpIndicator = oilPumpIndicator;

        // ===== 13. 控制柜 (侧面小装饰) =====
        const controlBox = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 1.2, 0.8),
            this.matBodyDark
        );
        controlBox.position.set(2.5, 0.6, -2);
        this.add(controlBox);

        // 控制柜面板上的小灯
        const panelLight = new THREE.Mesh(
            new THREE.SphereGeometry(0.06, 8, 8),
            new THREE.MeshStandardMaterial({ color: 0x00ff00, emissive: 0x00ff00, emissiveIntensity: 0.5 })
        );
        panelLight.position.set(2.76, 0.9, -2);
        this.add(panelLight);

        // ===== 14. 支撑腿 =====
        for (let x of [-1.6, 1.6]) {
            for (let z of [-3.5, -0.5, 3]) {
                const leg = new THREE.Mesh(
                    new THREE.BoxGeometry(0.2, 0.3, 0.2),
                    this.matBodyDark
                );
                leg.position.set(x, -0.15, z);
                this.add(leg);
            }
        }

        // ===== 15. 标签锚点 =====
        this.labelAnchor = new THREE.Object3D();
        this.labelAnchor.position.set(0, 5.5, 0);
        this.add(this.labelAnchor);

        // ===== 16. 开启全局阴影 =====
        this.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
    }

    // ===================== CSS2D 标签 =====================

    createLabel() {
        const div = document.createElement('div');
        div.className = 'furnace-label';
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.5s';

        div.innerHTML = `
            <div class="header">${this.furnaceName}</div>
            <div class="data-row">温度: <span id="temp-${this.furnaceId}">--</span> °C</div>
            <div class="data-row">碳势: <span id="carbon-${this.furnaceId}">--</span> %</div>
        `;

        this.labelObj = new CSS2DObject(div);
        this.labelDiv = div;
        this.labelAnchor.add(this.labelObj);
    }

    setLabelVisible(visible) {
        if (this.labelDiv) {
            this.labelDiv.style.opacity = visible ? '1' : '0';
        }
    }

    setXRayMode(enable) {
        const targetOpacity = enable ? 0.15 : 1.0;
        const targetDepthWrite = !enable;

        const materialsToFade = [this.matBody, this.matBodyDark, this.matDoor, this.matPipe];
        
        materialsToFade.forEach(mat => {
            mat.transparent = enable;
            mat.depthWrite = targetDepthWrite;
            gsap.to(mat, { opacity: targetOpacity, duration: 1.0 });
        });
    }

    // ===================== 数据驱动更新 =====================

    updateData(data) {
        // 更新标签数字
        const tempEl = document.getElementById(`temp-${this.furnaceId}`);
        const carbonEl = document.getElementById(`carbon-${this.furnaceId}`);
        if (tempEl) tempEl.innerText = data.analog?.actual_temp || '--';
        if (carbonEl) carbonEl.innerText = data.analog?.actual_carbon || '--';

        // 电机状态 → 颜色 + 旋转标记
        this.fanRunning = data.motors?.fan_motor;
        this.stirRunning = data.motors?.stir_motor;
        this.oilPumpOn = data.motors?.oil_pump;

        this.updateMotorColor(this.fanMotorBody, this.fanRunning);
        this.updateMotorColor(this.stirMotorBody, this.stirRunning);
        this.updateIndicator(this.oilPumpIndicator, this.oilPumpOn);

        // 门动画
        this.animateDoor(this.frontDoor, data.doors?.front_door_open, this._frontDoorClosedY);
        this.animateDoor(this.middleDoor, data.doors?.middle_door_open, this._middleDoorClosedY);

        // 推拉链 + 料盘
        this.animateChain(data.mechanisms?.push_chain_forward);

        // 炉膛内壁温度发光
        const temp = parseFloat(data.analog?.actual_temp);
        if (!isNaN(temp)) {
            // 温度越高，内壁的橙红色发光越强
            const intensity = Math.min((temp - 600) / 400, 1.0);
            this.innerWall.material.emissiveIntensity = Math.max(0.1, intensity * 0.6);
        }

        // 报警 → 整机变红
        if (data.status?.alarm) {
            this.heatingChamber.material.emissive.setHex(0x550000);
        } else {
            this.heatingChamber.material.emissive.setHex(0x000000);
        }
    }

    updateMotorColor(motorMesh, isRunning) {
        if (isRunning) {
            motorMesh.material.emissive.setHex(0x00cc44);
            motorMesh.material.emissiveIntensity = 0.6;
        } else {
            motorMesh.material.emissive.setHex(0x000000);
            motorMesh.material.emissiveIntensity = 0;
        }
    }

    updateIndicator(indicatorMesh, isOn) {
        if (isOn) {
            indicatorMesh.material.color.setHex(0x00ff88);
            indicatorMesh.material.emissive.setHex(0x00ff88);
            indicatorMesh.material.emissiveIntensity = 0.8;
        } else {
            indicatorMesh.material.color.setHex(0x333333);
            indicatorMesh.material.emissive.setHex(0x000000);
            indicatorMesh.material.emissiveIntensity = 0;
        }
    }

    animateDoor(doorGroup, isOpen, closedY) {
        // 门打开 = 向上升起到炉顶上方
        const targetY = isOpen ? closedY + 2.8 : closedY;
        gsap.to(doorGroup.position, { y: targetY, duration: 1.2, ease: "power2.inOut" });
    }

    animateChain(isForward) {
        // 推拉链推到前室 = Z轴正向移动
        const targetZ = isForward ? 3 : this._chainBaseZ;
        gsap.to(this.pushChain.position, { z: targetZ, duration: 2.0, ease: "power1.inOut" });
    }

    // ===================== 帧更新 (旋转动画) =====================

    update(delta) {
        // 循环风扇旋转
        if (this.fanRunning && this.fanBladesGroup) {
            this.fanBladesGroup.rotation.y += delta * 8;
        }
        // 搅拌电机旋转
        if (this.stirRunning && this.stirBlades) {
            this.stirBlades.rotation.y += delta * 5;
        }
    }

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
