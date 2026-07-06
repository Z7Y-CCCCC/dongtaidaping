import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.resolve(__dirname, '../../backend/assets/models/box_atmosphere_furnace.glb');

globalThis.FileReader = class NodeFileReader {
  constructor() {
    this.result = null;
    this.onloadend = null;
    this.onerror = null;
  }

  readAsArrayBuffer(blob) {
    blob.arrayBuffer()
      .then((buffer) => {
        this.result = buffer;
        this.onloadend?.({ target: this });
      })
      .catch((error) => this.onerror?.(error));
  }

  readAsDataURL(blob) {
    blob.arrayBuffer()
      .then((buffer) => {
        const bytes = Buffer.from(buffer);
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${bytes.toString('base64')}`;
        this.onloadend?.({ target: this });
      })
      .catch((error) => this.onerror?.(error));
  }
};

function material(name, color, options = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.62,
    metalness: options.metalness ?? 0.18,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1
  });
  mat.name = name;
  return mat;
}

const mats = {
  shell: material('warm_light_gray_shell', 0xdde1e5, { roughness: 0.72, metalness: 0.08 }),
  dark: material('dark_heat_resistant_panel', 0x22282e, { roughness: 0.76, metalness: 0.25 }),
  door: material('black_lift_door', 0x171a1e, { roughness: 0.58, metalness: 0.48 }),
  blue: material('industrial_blue_quench_tank', 0x075aa6, { roughness: 0.55, metalness: 0.18 }),
  oil: material('dark_quench_oil', 0x2a1b11, { roughness: 0.24, metalness: 0.05, transparent: true, opacity: 0.86 }),
  hot: material('hot_rear_chamber_glow', 0xb45b22, { roughness: 0.82, metalness: 0, emissive: 0x7a2500, emissiveIntensity: 0.45 }),
  pipe: material('safety_yellow_gas_pipe', 0xf0b13e, { roughness: 0.45, metalness: 0.32 }),
  metal: material('brushed_steel_motor', 0x8f99a1, { roughness: 0.42, metalness: 0.64 }),
  rail: material('dark_steel_rail', 0x4d545b, { roughness: 0.5, metalness: 0.58 }),
  active: material('active_green_components', 0x2fd27f, { emissive: 0x2fd27f, emissiveIntensity: 0.55 }),
  glass: material('amber_observation_glass', 0xff9d2e, {
    roughness: 0.2,
    metalness: 0,
    emissive: 0x8c3b00,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.72
  })
};

function box(name, size, position, mat) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.name = name;
  mesh.position.set(...position);
  return mesh;
}

function cylinder(name, radiusTop, radiusBottom, height, position, mat, radialSegments = 12, rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments), mat);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  return mesh;
}

function addDoor(root, z, prefix, width = 4.25, height = 2.4) {
  root.add(box(`${prefix}_lift_door_panel`, [width, height, 0.16], [0, 1.42, z], mats.door));
  root.add(box(`${prefix}_door_top_frame`, [width + 0.34, 0.16, 0.24], [0, 2.72, z + 0.02], mats.dark));
  root.add(box(`${prefix}_door_bottom_frame`, [width + 0.34, 0.16, 0.24], [0, 0.12, z + 0.02], mats.dark));
  root.add(box(`${prefix}_door_window`, [1.0, 0.38, 0.22], [0, 1.74, z + 0.12], mats.glass));
  root.add(box(`${prefix}_door_handle`, [1.35, 0.08, 0.28], [0, 1.13, z + 0.16], mats.metal));
}

function addTopFan(root, name, position, scale = 1) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...position);
  group.scale.setScalar(scale);
  group.add(cylinder(`${name}_motor`, 0.38, 0.38, 0.66, [0, 0, 0], mats.metal, 14));
  group.add(cylinder(`${name}_flange`, 0.52, 0.52, 0.12, [0, -0.38, 0], mats.dark, 14));
  for (let i = 0; i < 4; i++) {
    const blade = box(`${name}_blade_${i + 1}`, [0.86, 0.045, 0.16], [0.3, -0.72, 0], mats.rail);
    blade.rotation.y = i * Math.PI / 2;
    group.add(blade);
  }
  root.add(group);
}

function addQuenchTank(root) {
  root.add(box('oil_quench_tank_under_front_chamber', [4.8, 1.55, 2.05], [0, 0.68, 3.24], mats.blue));
  root.add(box('quench_oil_surface', [4.46, 0.06, 1.72], [0, 1.45, 3.24], mats.oil));
  root.add(box('quench_tank_dark_lip', [4.9, 0.16, 2.16], [0, 1.55, 3.24], mats.dark));

  [-1.55, -0.52, 0.52, 1.55].forEach((x, index) => {
    const group = new THREE.Group();
    group.name = `oil_agitator_${index + 1}`;
    group.position.set(x, 2.03, 3.24);
    group.add(cylinder(`oil_agitator_${index + 1}_motor`, 0.28, 0.28, 0.52, [0, 0, 0], mats.metal, 14));
    group.add(cylinder(`oil_agitator_${index + 1}_shaft`, 0.045, 0.045, 1.35, [0, -0.72, 0], mats.rail, 8));
    for (let i = 0; i < 3; i++) {
      const blade = box(`oil_agitator_${index + 1}_blade_${i + 1}`, [0.58, 0.04, 0.12], [0.22, -1.38, 0], mats.rail);
      blade.rotation.y = i * Math.PI * 2 / 3;
      group.add(blade);
    }
    root.add(group);
  });
}

function addGasManifold(root) {
  const manifold = new THREE.Group();
  manifold.name = 'gas_valve_manifold_10_valves';
  manifold.position.set(-2.72, 2.28, -0.75);
  manifold.add(cylinder('main_gas_manifold_pipe', 0.055, 0.055, 7.15, [0, 0, 0], mats.pipe, 8, [Math.PI / 2, 0, 0]));

  for (let i = 0; i < 10; i++) {
    const z = -3.22 + i * 0.72;
    manifold.add(cylinder(`gas_valve_${i + 1}_branch_pipe`, 0.034, 0.034, 0.92, [0.42, 0, z], mats.pipe, 8, [0, 0, Math.PI / 2]));
    manifold.add(cylinder(`gas_valve_${i + 1}_solenoid`, 0.13, 0.13, 0.26, [0.92, 0, z], i % 3 === 0 ? mats.active : mats.metal, 12, [0, 0, Math.PI / 2]));
    manifold.add(box(`gas_valve_${i + 1}_coil`, [0.2, 0.28, 0.28], [1.05, 0.22, z], i % 3 === 0 ? mats.active : mats.metal));
    manifold.add(box(`gas_valve_${i + 1}_flow_bar`, [0.09, 0.24 + (i % 5) * 0.05, 0.12], [1.28, 0.02, z], mats.active));
  }
  root.add(manifold);
}

function addRailsAndBase(root) {
  root.add(box('left_floor_rail', [0.18, 0.12, 7.75], [-0.64, 0.14, 0.14], mats.rail));
  root.add(box('right_floor_rail', [0.18, 0.12, 7.75], [0.64, 0.14, 0.14], mats.rail));
  root.add(box('load_tray_on_chain', [2.68, 0.28, 1.52], [0, 0.42, 1.19], mats.metal));
  for (let z = -3; z <= 3.4; z += 0.62) {
    root.add(box(`chain_tooth_${z.toFixed(1)}`, [1.46, 0.052, 0.1], [0, 0.26, z], mats.metal));
  }

  [-1.9, 1.9].forEach((x) => {
    [-4.2, -1.4, 1.4, 3.7].forEach((z, index) => {
      root.add(box(`support_leg_${x}_${index}`, [0.22, 0.38, 0.22], [x, -0.04, z], mats.dark));
    });
  });
}

function addControlCabinet(root) {
  root.add(box('right_control_cabinet', [0.74, 1.9, 1.12], [2.56, 1.02, -1.18], mats.dark));
  root.add(box('control_panel_face', [0.05, 1.32, 0.76], [2.95, 1.12, -1.18], mats.shell));
  root.add(box('operator_screen', [0.06, 0.38, 0.46], [2.99, 1.5, -1.18], mats.glass));
  root.add(cylinder('cabinet_status_indicator', 0.07, 0.07, 0.04, [3.02, 0.94, -1.5], mats.active, 12, [0, 0, Math.PI / 2]));
}

function buildModel() {
  const root = new THREE.Group();
  root.name = 'complex_box_atmosphere_multipurpose_furnace_low_poly';

  root.add(box('rear_heat_chamber_shell', [4.35, 3.0, 4.9], [0, 1.55, -2.25], mats.shell));
  root.add(box('rear_chamber_top_black_cover', [4.55, 0.26, 5.08], [0, 3.16, -2.25], mats.dark));
  root.add(box('rear_hot_chamber_reveal', [3.55, 2.12, 0.08], [0, 1.56, 0.18], mats.hot));

  root.add(box('front_transfer_chamber_shell', [4.25, 2.45, 2.25], [0, 1.28, 1.26], mats.dark));
  root.add(box('front_chamber_service_panel', [4.0, 0.08, 1.72], [0, 2.58, 1.26], mats.shell));
  root.add(box('front_chamber_window_band', [3.25, 0.42, 0.08], [0, 1.76, 2.42], mats.glass));

  root.add(box('optional_slow_cooling_chamber_above_front', [3.58, 1.08, 1.72], [0, 3.18, 1.28], mats.shell));
  root.add(box('slow_cooling_chamber_dark_top', [3.72, 0.16, 1.86], [0, 3.8, 1.28], mats.dark));
  root.add(cylinder('slow_cooling_exhaust_pipe', 0.13, 0.13, 1.02, [-1.22, 4.33, 1.73], mats.pipe, 10));

  addDoor(root, -0.04, 'middle_door_between_front_and_rear', 4.15, 2.55);
  addDoor(root, 2.48, 'front_lift_door', 4.3, 2.36);
  addQuenchTank(root);
  addTopFan(root, 'rear_chamber_top_fan', [0, 3.78, -2.25], 1);
  addTopFan(root, 'front_chamber_top_fan', [0.92, 3.03, 1.28], 0.78);
  addGasManifold(root);
  addRailsAndBase(root);
  addControlCabinet(root);

  root.add(cylinder('rear_exhaust_stack', 0.18, 0.18, 1.72, [-1.38, 3.86, -4.48], mats.pipe, 10));
  root.add(cylinder('rear_exhaust_cap', 0.34, 0.24, 0.22, [-1.38, 4.84, -4.48], mats.pipe, 10));
  root.add(box('maintenance_platform', [4.86, 0.08, 0.42], [0, 3.34, -4.72], mats.rail));

  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });

  return root;
}

function mergeStaticMeshesByMaterial(root) {
  root.updateMatrixWorld(true);
  const byMaterial = new Map();

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry || Array.isArray(child.material)) return;
    const materialName = child.material.name || child.material.uuid;
    if (!byMaterial.has(materialName)) {
      byMaterial.set(materialName, { material: child.material, geometries: [] });
    }
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    byMaterial.get(materialName).geometries.push(geometry);
  });

  const mergedRoot = new THREE.Group();
  mergedRoot.name = `${root.name}_merged_by_material`;

  for (const [materialName, group] of byMaterial.entries()) {
    const mergedGeometry = mergeGeometries(group.geometries, false);
    mergedGeometry.computeBoundingBox();
    mergedGeometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(mergedGeometry, group.material);
    mesh.name = `merged_${materialName}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mergedRoot.add(mesh);
  }

  return mergedRoot;
}

async function exportGlb(root) {
  const exporter = new GLTFExporter();
  const arrayBuffer = await new Promise((resolve, reject) => {
    exporter.parse(root, resolve, reject, {
      binary: true,
      trs: false,
      onlyVisible: true,
      truncateDrawRange: true
    });
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
  const bytes = fs.statSync(outputPath).size;
  console.log(`Wrote ${outputPath}`);
  console.log(`Size ${(bytes / 1024).toFixed(1)} KiB`);
}

exportGlb(mergeStaticMeshesByMaterial(buildModel())).catch((error) => {
  console.error(error);
  process.exit(1);
});
