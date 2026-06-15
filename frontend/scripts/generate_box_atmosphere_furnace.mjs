import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const outputPath = path.resolve('../backend/assets/models/box_atmosphere_furnace.glb');

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
  shell: material('warm_light_gray_shell', 0xd9dde1, { roughness: 0.72, metalness: 0.08 }),
  dark: material('dark_heat_resistant_panel', 0x25282b, { roughness: 0.76, metalness: 0.22 }),
  door: material('black_lift_door', 0x17191c, { roughness: 0.66, metalness: 0.38 }),
  blue: material('industrial_blue_base', 0x07559f, { roughness: 0.56, metalness: 0.18 }),
  yellow: material('safety_yellow_pipe', 0xf0b13e, { roughness: 0.45, metalness: 0.28 }),
  metal: material('brushed_steel', 0x8a9299, { roughness: 0.42, metalness: 0.62 }),
  rail: material('dark_steel_rail', 0x4d5358, { roughness: 0.5, metalness: 0.58 }),
  glass: material('amber_observation_glass', 0xff9d2e, {
    roughness: 0.2,
    metalness: 0,
    emissive: 0x8c3b00,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.72
  }),
  hot: material('hot_chamber_glow', 0xb45b22, {
    roughness: 0.82,
    metalness: 0,
    emissive: 0x7a2500,
    emissiveIntensity: 0.45
  }),
  green: material('green_indicator', 0x39c56b, { emissive: 0x39c56b, emissiveIntensity: 0.75 }),
  red: material('red_indicator', 0xd85151, { emissive: 0xd85151, emissiveIntensity: 0.75 })
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

function addSidePipes(root) {
  const pipeZ = [-2.7, -1.4, -0.1, 1.2];
  pipeZ.forEach((z, index) => {
    root.add(cylinder(`atmosphere_side_pipe_${index + 1}`, 0.045, 0.045, 4.8, [-2.32, 2.35, z], mats.yellow, 8, [Math.PI / 2, 0, 0]));
    root.add(cylinder(`pipe_valve_${index + 1}`, 0.13, 0.13, 0.08, [-2.32, 2.35, z + 1.9], mats.metal, 10, [Math.PI / 2, 0, 0]));
  });
}

function addDoor(root, z, namePrefix) {
  root.add(box(`${namePrefix}_lift_door`, [4.3, 2.45, 0.18], [0, 1.55, z], mats.door));
  root.add(box(`${namePrefix}_door_frame_top`, [4.55, 0.16, 0.26], [0, 2.86, z + 0.03], mats.dark));
  root.add(box(`${namePrefix}_door_frame_bottom`, [4.55, 0.16, 0.26], [0, 0.24, z + 0.03], mats.dark));
  root.add(box(`${namePrefix}_observation_window`, [1.0, 0.42, 0.22], [0, 1.78, z + 0.13], mats.glass));
  root.add(box(`${namePrefix}_handle`, [1.5, 0.08, 0.28], [0, 1.22, z + 0.18], mats.metal));
}

function addControlCabinet(root) {
  root.add(box('right_control_cabinet', [0.72, 1.9, 1.12], [2.48, 1.04, -1.15], mats.dark));
  root.add(box('control_panel_face', [0.04, 1.32, 0.76], [2.86, 1.12, -1.15], mats.shell));
  root.add(box('operator_screen', [0.05, 0.38, 0.46], [2.9, 1.5, -1.15], mats.glass));
  root.add(cylinder('green_status_lamp', 0.055, 0.055, 0.035, [2.92, 0.95, -1.42], mats.green, 10, [0, 0, Math.PI / 2]));
  root.add(cylinder('red_status_lamp', 0.055, 0.055, 0.035, [2.92, 0.95, -0.9], mats.red, 10, [0, 0, Math.PI / 2]));
}

function addFanAndStack(root) {
  root.add(cylinder('top_circulation_fan_motor', 0.38, 0.38, 0.72, [0, 3.45, -1.72], mats.metal, 14));
  root.add(cylinder('fan_base_flange', 0.52, 0.52, 0.14, [0, 3.05, -1.72], mats.dark, 14));
  root.add(cylinder('rear_exhaust_stack', 0.18, 0.18, 1.65, [-1.35, 3.6, -4.35], mats.yellow, 10));
  root.add(cylinder('exhaust_stack_cap', 0.34, 0.24, 0.22, [-1.35, 4.55, -4.35], mats.yellow, 10));
}

function addRailsAndBase(root) {
  root.add(box('left_floor_rail', [0.18, 0.12, 7.6], [-0.62, 0.08, 0.05], mats.rail));
  root.add(box('right_floor_rail', [0.18, 0.12, 7.6], [0.62, 0.08, 0.05], mats.rail));
  root.add(box('load_tray', [2.6, 0.28, 1.45], [0, 0.38, 1.02], mats.metal));

  [-1.85, 1.85].forEach((x) => {
    [-4.2, -1.4, 1.5, 3.6].forEach((z, index) => {
      root.add(box(`support_leg_${x}_${index}`, [0.22, 0.38, 0.22], [x, -0.04, z], mats.dark));
    });
  });
}

function addQuenchTank(root) {
  root.add(box('front_quench_tank', [4.8, 1.55, 1.95], [0, 0.82, 3.25], mats.blue));
  root.add(box('quench_tank_dark_lid', [4.6, 0.12, 1.72], [0, 1.63, 3.25], mats.dark));
  root.add(cylinder('quench_agitator_motor', 0.32, 0.32, 0.62, [1.52, 2.16, 3.25], mats.metal, 12));
  root.add(cylinder('agitator_shaft', 0.045, 0.045, 1.1, [1.52, 1.42, 3.25], mats.rail, 8));
}

function buildModel() {
  const root = new THREE.Group();
  root.name = 'box_atmosphere_multipurpose_furnace_low_poly';

  root.add(box('main_heat_chamber_shell', [4.2, 2.9, 4.9], [0, 1.5, -2.15], mats.shell));
  root.add(box('dark_top_cover', [4.35, 0.28, 5.05], [0, 3.1, -2.15], mats.dark));
  root.add(box('hot_chamber_inner_reveal', [3.55, 2.16, 0.08], [0, 1.55, 0.36], mats.hot));
  root.add(box('front_transfer_chamber', [4.2, 2.42, 2.12], [0, 1.28, 1.05], mats.dark));

  addDoor(root, 0.02, 'middle');
  addDoor(root, 2.16, 'front');
  addQuenchTank(root);
  addControlCabinet(root);
  addSidePipes(root);
  addFanAndStack(root);
  addRailsAndBase(root);

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
      byMaterial.set(materialName, {
        material: child.material,
        geometries: []
      });
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
