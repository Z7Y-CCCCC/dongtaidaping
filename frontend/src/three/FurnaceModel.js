import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import gsap from 'gsap';
import { buildDeviceLabelMarkup, updateDeviceLabelElements, applyDeviceLabelStyle } from '../runtime/uiConfig.js';

const GAS_DEFS = [
    { key: 'valve_1', label: 'N2', aliases: ['n2', 'nitrogen'] },
    { key: 'valve_2', label: '甲醇', aliases: ['methanol'] },
    { key: 'valve_3', label: '丙烷', aliases: ['propane'] },
    { key: 'valve_4', label: '氨气', aliases: ['ammonia'] },
    { key: 'valve_5', label: 'RX', aliases: ['rx', 'endogas'] },
    { key: 'valve_6', label: '空气', aliases: ['air'] },
    { key: 'valve_7', label: '富化', aliases: ['enrich'] },
    { key: 'valve_8', label: '排气', aliases: ['exhaust'] },
    { key: 'valve_9', label: '置换', aliases: ['purge'] },
    { key: 'valve_10', label: '备用', aliases: ['spare'] }
];

function makeMaterial(color, options = {}) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness: options.roughness ?? 0.62,
        metalness: options.metalness ?? 0.2,
        emissive: options.emissive ?? 0x000000,
        emissiveIntensity: options.emissiveIntensity ?? 0,
        transparent: options.transparent ?? false,
        opacity: options.opacity ?? 1,
        depthWrite: options.depthWrite ?? true
    });
}

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function toNumber(value, fallback = 0) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

function toBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'on', 'open', 'opened', 'running', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'close', 'closed', 'stop', 'stopped', 'no'].includes(normalized)) return false;
    return fallback;
}

function readField(data, group, names) {
    const source = data?.[group] || {};
    for (const name of names) {
        if (source[name] !== undefined && source[name] !== null && source[name] !== '') return source[name];
    }
    return undefined;
}

function makeBox(name, size, position, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...position);
    return mesh;
}

function makeInstancedBoxes(name, size, positions, material) {
    const geometry = new THREE.BoxGeometry(...size);
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    const matrix = new THREE.Matrix4();
    positions.forEach((position, index) => {
        matrix.makeTranslation(position[0], position[1], position[2]);
        mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = name;
    return mesh;
}

function makeCylinder(name, radiusTop, radiusBottom, height, position, material, segments = 16, rotation = [0, 0, 0]) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    return mesh;
}

function makeBladeGroup(material, count = 4, radius = 0.72) {
    const group = new THREE.Group();
    const bladeGeometry = new THREE.BoxGeometry(radius, 0.045, 0.16);
    const blades = new THREE.InstancedMesh(bladeGeometry, material, count);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3(radius * 0.35, 0, 0);
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
        quaternion.setFromEuler(new THREE.Euler(0, (Math.PI * 2 / count) * i, 0));
        matrix.compose(position, quaternion, scale);
        blades.setMatrixAt(i, matrix);
    }
    blades.instanceMatrix.needsUpdate = true;
    blades.name = 'rotating_blades';
    group.add(blades);
    return group;
}

export class FurnaceModel extends THREE.Group {
    constructor(id, name, options = {}) {
        super();
        this.furnaceId = id;
        this.furnaceName = name;
        this.userData.isDevice = true;
        this.userData.id = id;

        this.state = {};
        this.gasValves = [];
        this.oilAgitators = [];
        this.fans = {};
        this.partLabels = [];
        this.partLabelsVisible = false;
        this.detailObjects = [];
        this.detailVisible = true;
        this.xRayEnabled = false;
        this.labelConfig = {
            ...(options.labelConfig || {}),
            ...(options.instanceConfig?.labelConfig || {})
        };
        this.labelElements = new Map();
        this.lastLabelValues = new Map();
        this.lastDeviceQuality = null;
        this.lastAlarm = null;

        this.buildMaterials();
        this.buildModel();
        this.createMainLabel();
        this.setDetailVisible(false);
        this.setPartLabelsVisible(false);
    }

    buildMaterials() {
        this.matShell = makeMaterial(0xe0e3df, { roughness: 0.72, metalness: 0.08 });
        this.matDark = makeMaterial(0x2a2f31, { roughness: 0.76, metalness: 0.25 });
        this.matDoor = makeMaterial(0x202427, { roughness: 0.58, metalness: 0.48 });
        this.matBlue = makeMaterial(0x0b4f83, { roughness: 0.6, metalness: 0.16 });
        this.matOil = makeMaterial(0x2a1b11, { roughness: 0.24, metalness: 0.05, transparent: true, opacity: 0.86 });
        this.matHot = makeMaterial(0xb45b22, { roughness: 0.82, metalness: 0, emissive: 0x7a2500, emissiveIntensity: 0.35 });
        this.matMetal = makeMaterial(0x8f99a1, { roughness: 0.42, metalness: 0.64 });
        this.matRail = makeMaterial(0x4d545b, { roughness: 0.5, metalness: 0.58 });
        this.matPipe = makeMaterial(0xf0b13e, { roughness: 0.45, metalness: 0.32 });
        this.matGlass = makeMaterial(0xff9d2e, {
            roughness: 0.2,
            metalness: 0,
            emissive: 0x8c3b00,
            emissiveIntensity: 0.35,
            transparent: true,
            opacity: 0.72
        });
        this.matInactive = makeMaterial(0x555b61, { roughness: 0.48, metalness: 0.42 });
        this.matActive = makeMaterial(0x2fd27f, { roughness: 0.35, metalness: 0.24, emissive: 0x2fd27f, emissiveIntensity: 0.65 });
        this.matAlarm = makeMaterial(0xff3b30, { roughness: 0.35, metalness: 0.18, emissive: 0xff3b30, emissiveIntensity: 0.85 });
        this.matStale = makeMaterial(0xf0b35a, { roughness: 0.35, metalness: 0.18, emissive: 0xf0b35a, emissiveIntensity: 0.55 });

        this.fadeMaterials = [this.matShell, this.matDark, this.matDoor, this.matPipe, this.matBlue];
    }

    buildModel() {
        this.buildChambers();
        this.buildDoors();
        this.buildQuenchTank();
        this.buildCoolingChamber();
        this.buildFans();
        this.buildGasManifold();
        this.buildRailsAndTray();
        this.buildControlCabinet();
        this.buildSupportsAndDetails();

        this.labelAnchor = new THREE.Object3D();
        this.labelAnchor.position.set(0, 5.7, -0.4);
        this.add(this.labelAnchor);

        this.partLabelAnchor = new THREE.Object3D();
        this.partLabelAnchor.position.set(0, 4.9, 2.9);
        this.add(this.partLabelAnchor);

        this.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = false;
                child.receiveShadow = false;
            }
        });
    }

    registerDetailObject(object) {
        if (object) this.detailObjects.push(object);
        return object;
    }

    buildChambers() {
        this.rearChamber = makeBox('rear_heat_chamber_shell', [4.35, 3.0, 4.9], [0, 1.55, -2.25], this.matShell);
        this.add(this.rearChamber);
        this.add(makeBox('rear_chamber_top_black_cover', [4.55, 0.26, 5.08], [0, 3.16, -2.25], this.matDark));
        this.rearInnerGlow = makeBox('rear_hot_chamber_reveal', [3.55, 2.12, 0.08], [0, 1.56, 0.18], this.matHot);
        this.add(this.rearInnerGlow);

        this.frontChamber = makeBox('front_transfer_chamber_shell', [4.25, 2.45, 2.25], [0, 1.28, 1.26], this.matDark);
        this.add(this.frontChamber);
        this.add(makeBox('front_chamber_service_panel', [4.0, 0.08, 1.72], [0, 2.58, 1.26], this.matShell));
        this.add(makeBox('front_chamber_window_band', [3.25, 0.42, 0.08], [0, 1.76, 2.42], this.matGlass));
    }

    buildDoors() {
        this.middleDoor = this.createLiftDoor('middle_door_between_front_and_rear', -0.04, 1.42, 4.15, 2.55);
        this.frontDoor = this.createLiftDoor('front_lift_door', 2.48, 1.34, 4.3, 2.36);
        this._middleDoorClosedY = this.middleDoor.position.y;
        this._frontDoorClosedY = this.frontDoor.position.y;
    }

    createLiftDoor(name, z, y, width, height) {
        const group = new THREE.Group();
        group.name = name;
        group.position.set(0, y, z);
        group.add(makeBox(`${name}_panel`, [width, height, 0.16], [0, 0, 0], this.matDoor));
        [
            makeBox(`${name}_top_frame`, [width + 0.35, 0.16, 0.24], [0, height * 0.5 + 0.15, 0.02], this.matDark),
            makeBox(`${name}_bottom_frame`, [width + 0.35, 0.16, 0.24], [0, -height * 0.5 - 0.15, 0.02], this.matDark),
            makeBox(`${name}_observation_window`, [1.0, 0.38, 0.22], [0, 0.32, 0.1], this.matGlass),
            makeBox(`${name}_handle`, [1.35, 0.08, 0.28], [0, -0.28, 0.15], this.matMetal)
        ].forEach(mesh => {
            this.registerDetailObject(mesh);
            group.add(mesh);
        });
        this.add(group);
        return group;
    }

    buildQuenchTank() {
        this.quenchTank = makeBox('oil_quench_tank_below_front_chamber', [4.8, 1.55, 2.05], [0, 0.68, 3.24], this.matBlue);
        this.add(this.quenchTank);
        this.oilSurface = makeBox('quench_oil_surface', [4.46, 0.06, 1.72], [0, 1.45, 3.24], this.matOil);
        this.add(this.oilSurface);
        this.add(makeBox('quench_tank_lip', [4.9, 0.16, 2.16], [0, 1.55, 3.24], this.matDark));

        const xPositions = [-1.55, -0.52, 0.52, 1.55];
        xPositions.forEach((x, index) => {
            const group = new THREE.Group();
            group.name = `oil_agitator_${index + 1}`;
            group.position.set(x, 2.03, 3.24);

            const motor = makeCylinder(`oil_agitator_${index + 1}_motor`, 0.28, 0.28, 0.52, [0, 0, 0], this.matMetal.clone(), 14);
            const shaft = makeCylinder(`oil_agitator_${index + 1}_shaft`, 0.045, 0.045, 1.35, [0, -0.72, 0], this.matRail, 8);
            const blades = makeBladeGroup(this.matRail, 3, 0.66);
            blades.name = `oil_agitator_${index + 1}_blades`;
            blades.position.y = -1.38;
            this.registerDetailObject(shaft);
            this.registerDetailObject(blades);

            group.add(motor, shaft, blades);
            this.add(group);

            const label = this.createPartLabel(`搅拌${index + 1}: -- rpm`, [x, 2.92, 3.24]);
            this.oilAgitators.push({
                group,
                motor,
                blades,
                label,
                running: false,
                rpm: 0
            });
        });
    }

    buildCoolingChamber() {
        this.coolingChamber = new THREE.Group();
        this.coolingChamber.name = 'optional_slow_cooling_chamber';
        this.coolingChamber.position.set(0, 3.18, 1.28);
        this.coolingChamber.add(makeBox('slow_cooling_room_shell', [3.58, 1.08, 1.72], [0, 0, 0], this.matShell));
        this.coolingChamber.add(makeBox('slow_cooling_room_dark_top', [3.72, 0.16, 1.86], [0, 0.62, 0], this.matDark));
        this.coolingChamber.add(makeCylinder('slow_cooling_exhaust_pipe', 0.13, 0.13, 1.02, [-1.22, 1.15, 0.45], this.matPipe, 10));
        this.add(this.coolingChamber);
    }

    buildFans() {
        this.fans.rear = this.createTopFan('rear_chamber_top_fan', [0, 3.78, -2.25]);
        this.fans.front = this.createTopFan('front_chamber_top_fan', [0.92, 3.03, 1.28], 0.78);
    }

    createTopFan(name, position, scale = 1) {
        const group = new THREE.Group();
        group.name = name;
        group.position.set(...position);
        group.scale.setScalar(scale);

        const motor = makeCylinder(`${name}_motor`, 0.38, 0.38, 0.66, [0, 0, 0], this.matMetal.clone(), 14);
        const flange = makeCylinder(`${name}_base`, 0.52, 0.52, 0.12, [0, -0.38, 0], this.matDark, 14);
        const blades = makeBladeGroup(this.matRail, 4, 0.92);
        blades.name = `${name}_blades`;
        blades.position.y = -0.72;

        group.add(motor, flange, blades);
        this.add(group);
        return { group, motor, blades, running: false, rpm: 0 };
    }

    buildGasManifold() {
        const manifold = new THREE.Group();
        manifold.name = 'gas_valve_manifold';
        manifold.position.set(-2.72, 2.28, -0.75);
        manifold.add(makeCylinder('main_gas_manifold_pipe', 0.055, 0.055, 7.15, [0, 0, 0], this.matPipe, 8, [Math.PI / 2, 0, 0]));
        this.add(manifold);

        GAS_DEFS.forEach((def, index) => {
            const z = -3.22 + index * 0.72;
            const valveMat = this.matInactive.clone();
            const flowMat = this.matActive.clone();
            flowMat.transparent = true;
            flowMat.opacity = 0.9;

            const valveGroup = new THREE.Group();
            valveGroup.name = `gas_${def.key}_assembly`;
            valveGroup.position.set(0, 0, z);

            valveGroup.add(makeCylinder(`gas_${def.key}_branch_pipe`, 0.034, 0.034, 0.92, [0.42, 0, 0], this.matPipe, 8, [0, 0, Math.PI / 2]));
            const body = makeCylinder(`gas_${def.key}_solenoid_valve`, 0.13, 0.13, 0.26, [0.92, 0, 0], valveMat, 12, [0, 0, Math.PI / 2]);
            const coil = makeBox(`gas_${def.key}_coil`, [0.2, 0.28, 0.28], [1.05, 0.22, 0], valveMat);
            const flowBar = makeBox(`gas_${def.key}_flow_bar`, [0.09, 0.12, 0.12], [1.28, 0.02, 0], flowMat);
            flowBar.scale.y = 0.05;
            flowBar.position.y = -0.06;
            valveGroup.add(body, coil, flowBar);
            manifold.add(valveGroup);
            this.registerDetailObject(valveGroup);

            this.gasValves.push({
                ...def,
                group: valveGroup,
                body,
                coil,
                flowBar,
                valveMat,
                flowMat,
                on: false,
                flow: 0
            });
        });

        this.gasSummaryLabel = this.createPartLabel('气体阀组: --', [-2.72, 3.15, 2.96]);
    }

    buildRailsAndTray() {
        this.pushChain = new THREE.Group();
        this.pushChain.name = 'push_pull_chain_and_tray';
        this.pushChain.position.set(0, 0.14, 0.14);
        this.pushChain.add(makeBox('left_floor_rail', [0.18, 0.12, 7.75], [-0.64, 0, 0], this.matRail));
        this.pushChain.add(makeBox('right_floor_rail', [0.18, 0.12, 7.75], [0.64, 0, 0], this.matRail));
        this.pushChain.add(makeBox('load_tray', [2.68, 0.28, 1.52], [0, 0.28, 1.05], this.matMetal));
        const chainTeeth = [];
        for (let z = -3; z <= 3.4; z += 0.62) {
            chainTeeth.push([0, 0.12, z]);
        }
        this.pushChain.add(makeInstancedBoxes('chain_teeth', [1.46, 0.052, 0.1], chainTeeth, this.matMetal));
        this.add(this.pushChain);
        this._chainBaseZ = this.pushChain.position.z;
    }

    buildControlCabinet() {
        this.add(makeBox('right_control_cabinet', [0.74, 1.9, 1.12], [2.56, 1.02, -1.18], this.matDark));
        this.add(makeBox('control_panel_face', [0.05, 1.32, 0.76], [2.95, 1.12, -1.18], this.matShell));
        this.add(makeBox('operator_screen', [0.06, 0.38, 0.46], [2.99, 1.5, -1.18], this.matGlass));
        this.statusIndicator = makeCylinder('cabinet_status_indicator', 0.07, 0.07, 0.04, [3.02, 0.94, -1.5], this.matActive.clone(), 12, [0, 0, Math.PI / 2]);
        this.add(this.statusIndicator);
    }

    buildSupportsAndDetails() {
        this.add(makeCylinder('rear_exhaust_stack', 0.18, 0.18, 1.72, [-1.38, 3.86, -4.48], this.matPipe, 10));
        this.add(makeCylinder('rear_exhaust_cap', 0.34, 0.24, 0.22, [-1.38, 4.84, -4.48], this.matPipe, 10));
        this.add(makeBox('maintenance_platform', [4.86, 0.08, 0.42], [0, 3.34, -4.72], this.matRail));

        const supportLegs = [];
        [-1.9, 1.9].forEach((x) => {
            [-4.2, -1.4, 1.4, 3.7].forEach((z, index) => {
                supportLegs.push([x, -0.04, z]);
            });
        });
        this.add(makeInstancedBoxes('support_legs', [0.22, 0.38, 0.22], supportLegs, this.matDark));
    }

    createMainLabel() {
        const div = document.createElement('div');
        div.className = 'furnace-label';
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.25s ease';
        applyDeviceLabelStyle(div, this.labelConfig);
        div.innerHTML = buildDeviceLabelMarkup(this.furnaceName, this.labelConfig, { isTransferCart: false, deviceId: this.furnaceId });
        div.querySelectorAll('[data-label-row]').forEach((valueEl) => {
            const key = valueEl.getAttribute('data-label-row');
            const unitEl = div.querySelector(`[data-label-unit="${key}"]`) || null;
            this.labelElements.set(key, { valueEl, unitEl });
        });

        this.labelDiv = div;
        this.labelObj = new CSS2DObject(div);
        this.labelObj.visible = false;
        this.labelAnchor.add(this.labelObj);
    }

    createPartLabel(text, position) {
        const div = document.createElement('div');
        div.className = 'furnace-part-label';
        div.textContent = text;
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.2s ease';
        const object = new CSS2DObject(div);
        object.position.set(...position);
        this.add(object);
        const label = { object, div };
        this.partLabels.push(label);
        return label;
    }

    setLabelVisible(visible) {
        const nextVisible = !!visible && this.labelConfig?.enabled !== false;
        if (this.labelObj) this.labelObj.visible = nextVisible;
        if (this.labelDiv) this.labelDiv.style.opacity = nextVisible ? '1' : '0';
    }

    setPartLabelsVisible(visible) {
        this.partLabelsVisible = !!visible;
        this.partLabels.forEach(label => {
            label.object.visible = this.partLabelsVisible;
            label.div.style.opacity = this.partLabelsVisible ? '1' : '0';
        });
    }

    setDetailVisible(visible) {
        const nextVisible = !!visible;
        if (this.detailVisible === nextVisible) return;
        this.detailVisible = nextVisible;
        this.detailObjects.forEach(object => {
            object.visible = nextVisible;
        });
    }

    setXRayMode(enable) {
        const nextEnabled = !!enable;
        if (this.xRayEnabled === nextEnabled) {
            this.setDetailVisible(nextEnabled);
            this.setPartLabelsVisible(nextEnabled);
            return;
        }
        this.xRayEnabled = nextEnabled;

        const targetOpacity = nextEnabled ? 0.24 : 1;
        this.fadeMaterials.forEach((mat) => {
            gsap.killTweensOf(mat);
            mat.transparent = nextEnabled;
            mat.depthWrite = !nextEnabled;
            gsap.to(mat, { opacity: targetOpacity, duration: 0.5 });
        });
        this.setDetailVisible(nextEnabled);
        this.setPartLabelsVisible(nextEnabled);
    }

    updateData(data) {
        this.updateMainLabel(data);
        this.updateMotors(data);
        this.updateDoors(data);
        this.updateGasValves(data);
        this.updateChain(data);
        this.updateThermalState(data);
        this.updateDeviceState(data);
    }

    updateMainLabel(data) {
        updateDeviceLabelElements(
            this.labelElements,
            data || {},
            this.labelConfig,
            { isTransferCart: false },
            this.lastLabelValues
        );
    }

    updateMotors(data) {
        const rearFanOn = toBool(firstDefined(
            readField(data, 'motors', ['rear_fan', 'rear_circulation_fan', 'fan_motor']),
            readField(data, 'status', ['rear_fan_running'])
        ));
        const frontFanOn = toBool(firstDefined(
            readField(data, 'motors', ['front_fan', 'front_circulation_fan', 'fan_motor']),
            readField(data, 'status', ['front_fan_running'])
        ));
        const rearFanRpm = toNumber(firstDefined(
            readField(data, 'motors', ['rear_fan_speed', 'rear_fan_rpm']),
            readField(data, 'analog', ['rear_fan_speed', 'rear_fan_rpm']),
            rearFanOn ? 960 : 0
        ));
        const frontFanRpm = toNumber(firstDefined(
            readField(data, 'motors', ['front_fan_speed', 'front_fan_rpm']),
            readField(data, 'analog', ['front_fan_speed', 'front_fan_rpm']),
            frontFanOn ? 720 : 0
        ));
        this.setFanState('rear', rearFanOn, rearFanRpm);
        this.setFanState('front', frontFanOn, frontFanRpm);

        for (let i = 0; i < this.oilAgitators.length; i++) {
            const index = i + 1;
            const aliases = [`oil_stir_${index}`, `oil_agitator_${index}`, `stir_${index}`];
            const speedAliases = aliases.flatMap(name => [`${name}_speed`, `${name}_rpm`]);
            const running = toBool(firstDefined(
                readField(data, 'motors', aliases),
                readField(data, 'status', aliases),
                readField(data, 'motors', ['stir_motor'])
            ));
            const rpm = toNumber(firstDefined(
                readField(data, 'motors', speedAliases),
                readField(data, 'analog', speedAliases),
                running ? 520 : 0
            ));
            this.setAgitatorState(i, running, rpm);
        }
    }

    setFanState(key, running, rpm) {
        const fan = this.fans[key];
        if (!fan) return;
        fan.running = running;
        fan.rpm = rpm;
        this.applyActiveMaterial(fan.motor, running, rpm > 0 ? this.matActive : this.matInactive);
    }

    setAgitatorState(index, running, rpm) {
        const agitator = this.oilAgitators[index];
        if (!agitator) return;
        agitator.running = running;
        agitator.rpm = rpm;
        this.applyActiveMaterial(agitator.motor, running, rpm > 0 ? this.matActive : this.matInactive);
        if (agitator.label?.div) {
            agitator.label.div.textContent = `油搅拌${index + 1}: ${Math.round(rpm)} rpm`;
        }
    }

    applyActiveMaterial(mesh, active, sourceMaterial) {
        if (!mesh?.material) return;
        mesh.material.color.copy(sourceMaterial.color);
        mesh.material.emissive.copy(sourceMaterial.emissive);
        mesh.material.emissiveIntensity = active ? sourceMaterial.emissiveIntensity : 0;
    }

    updateDoors(data) {
        this.animateDoor('frontDoorOpen', this.frontDoor, data.doors?.front_door_open, this._frontDoorClosedY);
        this.animateDoor('middleDoorOpen', this.middleDoor, data.doors?.middle_door_open, this._middleDoorClosedY);
    }

    animateDoor(stateKey, doorGroup, isOpen, closedY) {
        const nextOpen = toBool(isOpen);
        if (this.state[stateKey] === nextOpen) return;
        this.state[stateKey] = nextOpen;

        const targetY = nextOpen ? closedY + 2.55 : closedY;
        gsap.killTweensOf(doorGroup.position);
        gsap.to(doorGroup.position, { y: targetY, duration: 0.75, ease: 'power2.inOut' });
    }

    updateGasValves(data) {
        let activeCount = 0;
        let totalFlow = 0;
        const summaryParts = [];

        this.gasValves.forEach((valve, index) => {
            const names = [valve.key, `gas_${index + 1}`, ...valve.aliases];
            const onNames = names.flatMap(name => [`${name}_on`, `${name}_open`, name]);
            const flowNames = names.flatMap(name => [`${name}_flow`, `${name}_flow_rate`, `${name}_pv`]);
            const flow = toNumber(firstDefined(
                readField(data, 'gas', flowNames),
                readField(data, 'analog', flowNames)
            ), 0);
            const on = toBool(firstDefined(
                readField(data, 'gas', onNames),
                readField(data, 'status', onNames)
            ), flow > 0.05);

            if (valve.on !== on) {
                valve.on = on;
                this.applyValveState(valve, on);
            }
            if (Math.abs(valve.flow - flow) > 0.02) {
                valve.flow = flow;
                this.applyValveFlow(valve, flow);
            }

            if (on) activeCount += 1;
            totalFlow += Math.max(0, flow);
            if (on || flow > 0) summaryParts.push(`${valve.label} ${flow.toFixed(1)}`);
        });

        if (this.gasEl) {
            this.gasEl.innerText = `${activeCount}/${this.gasValves.length} 开`;
        }
        if (this.gasSummaryLabel?.div) {
            const text = summaryParts.length
                ? `气体阀组: ${summaryParts.slice(0, 5).join(' | ')}`
                : '气体阀组: 全部关闭';
            this.gasSummaryLabel.div.textContent = `${text}  总流量 ${totalFlow.toFixed(1)}`;
        }
    }

    applyValveState(valve, on) {
        const color = on ? 0x31d17c : 0x555b61;
        const emissive = on ? 0x31d17c : 0x000000;
        [valve.body, valve.coil].forEach(mesh => {
            mesh.material.color.setHex(color);
            mesh.material.emissive.setHex(emissive);
            mesh.material.emissiveIntensity = on ? 0.65 : 0;
        });
    }

    applyValveFlow(valve, flow) {
        const normalized = Math.max(0.05, Math.min(1.8, flow / 45));
        valve.flowBar.scale.y = normalized;
        valve.flowBar.position.y = normalized * 0.06;
        valve.flowBar.material.opacity = flow > 0.05 ? 0.94 : 0.18;
        valve.flowBar.material.emissiveIntensity = flow > 0.05 ? 0.7 : 0;
    }

    updateChain(data) {
        const nextForward = toBool(data.mechanisms?.push_chain_forward);
        if (this.state.chainForward === nextForward) return;
        this.state.chainForward = nextForward;

        const targetZ = nextForward ? 2.45 : this._chainBaseZ;
        gsap.killTweensOf(this.pushChain.position);
        gsap.to(this.pushChain.position, { z: targetZ, duration: 1.45, ease: 'power1.inOut' });
    }

    updateThermalState(data) {
        const temp = toNumber(firstDefined(data.analog?.actual_temp, data.analog?.rear_temp), NaN);
        if (!Number.isFinite(temp)) return;
        const intensity = Math.max(0.08, Math.min(0.82, (temp - 620) / 420));
        this.rearInnerGlow.material.emissiveIntensity = intensity;
        this.matHot.emissiveIntensity = intensity;
    }

    updateDeviceState(data) {
        const deviceQuality = this.resolveDeviceQuality(data);
        const isAlarm = !!data.status?.alarm;
        if (this.lastDeviceQuality === deviceQuality && this.lastAlarm === isAlarm) return;
        this.lastDeviceQuality = deviceQuality;
        this.lastAlarm = isAlarm;

        let material = this.matActive;
        if (deviceQuality === 'bad') material = this.matAlarm;
        else if (deviceQuality === 'stale') material = this.matStale;
        else if (isAlarm) material = this.matAlarm;
        else if (!data.status?.running) material = this.matInactive;

        this.statusIndicator.material.color.copy(material.color);
        this.statusIndicator.material.emissive.copy(material.emissive);
        this.statusIndicator.material.emissiveIntensity = material.emissiveIntensity;

        const shellEmissive = deviceQuality === 'bad'
            ? 0x551818
            : deviceQuality === 'stale'
                ? 0x554000
                : isAlarm
                    ? 0x551010
                    : 0x000000;
        this.rearChamber.material.emissive.setHex(shellEmissive);
        this.frontChamber.material.emissive.setHex(shellEmissive);
    }

    resolveDeviceQuality(data) {
        const values = Object.values(data.quality || {}).flatMap(group => Object.values(group || {}));
        if (values.includes('bad')) return 'bad';
        if (values.includes('stale')) return 'stale';
        return 'good';
    }

    update(delta) {
        const rearSpeed = Math.max(0, this.fans.rear?.rpm || 0) / 60;
        const frontSpeed = Math.max(0, this.fans.front?.rpm || 0) / 60;
        if (this.fans.rear?.running) this.fans.rear.blades.rotation.y += delta * Math.max(4, rearSpeed * 2.8);
        if (this.fans.front?.running) this.fans.front.blades.rotation.y += delta * Math.max(4, frontSpeed * 2.8);

        this.oilAgitators.forEach((agitator) => {
            if (!this.detailVisible) return;
            if (!agitator.running) return;
            agitator.blades.rotation.y += delta * Math.max(3, (agitator.rpm / 60) * 2.6);
        });
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
