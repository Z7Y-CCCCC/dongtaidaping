import * as THREE from 'three';

const BADGE_COLORS = {
    bad: { text: '离线', bg: '#3f4547', edge: '#8c9497', textColor: '#f1f4f5' },
    stale: { text: '数据过期', bg: '#6c4c18', edge: '#d8a33f', textColor: '#fff4d8' }
};

const textureCache = new Map();
const tempBox = new THREE.Box3();
const tempChildBox = new THREE.Box3();
const tempMatrix = new THREE.Matrix4();
const tempSize = new THREE.Vector3();
const tempCenter = new THREE.Vector3();

function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function createBadgeTexture(quality) {
    const spec = BADGE_COLORS[quality] || BADGE_COLORS.bad;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;
    roundRect(ctx, 28, 34, 456, 124, 18);
    ctx.fillStyle = spec.bg;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.lineWidth = 6;
    ctx.strokeStyle = spec.edge;
    ctx.stroke();

    ctx.fillStyle = spec.textColor;
    ctx.font = '700 58px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.text, 256, 98);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 2;
    texture.needsUpdate = true;
    return texture;
}

function getBadgeTexture(quality) {
    const key = quality === 'stale' ? 'stale' : 'bad';
    if (!textureCache.has(key)) textureCache.set(key, createBadgeTexture(key));
    return textureCache.get(key);
}

export function computeLocalBox(root) {
    root.updateMatrixWorld(true);
    const inverseRoot = tempMatrix.copy(root.matrixWorld).invert();
    const box = new THREE.Box3();

    root.traverse?.((child) => {
        if (!child.isMesh || !child.geometry) return;
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        tempChildBox.copy(child.geometry.boundingBox);
        tempChildBox.applyMatrix4(child.matrixWorld);
        tempChildBox.applyMatrix4(inverseRoot);
        box.union(tempChildBox);
    });

    if (!box.isEmpty()) return box;
    return tempBox.setFromCenterAndSize(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(2.4, 2.4, 1.2)).clone();
}

function createBadgeMesh(quality, box) {
    const size = box.getSize(tempSize);
    const center = box.getCenter(tempCenter);
    const width = Math.max(1.25, Math.min(3.2, size.x * 0.42 || 1.8));
    const height = width * 0.36;

    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({
        map: getBadgeTexture(quality),
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'runtime_connection_badge_3d';
    mesh.renderOrder = 20;
    mesh.position.set(center.x, box.min.y + size.y * 0.68, box.max.z + Math.max(0.04, size.z * 0.012));
    return mesh;
}

export function ensureConnectionBadge3D(root, options = {}) {
    if (root.userData?.connectionBadge3D) return root.userData.connectionBadge3D;
    const box = options.box?.clone?.() || computeLocalBox(root);
    const mesh = createBadgeMesh('bad', box);
    if (root.userData?.mirrorX) mesh.scale.x = -1;
    root.add(mesh);
    const badge = { mesh, quality: 'bad' };
    root.userData.connectionBadge3D = badge;
    return badge;
}

export function setConnectionBadge3D(root, quality, options = {}) {
    if (!root) return;
    const nextQuality = quality === 'stale' ? 'stale' : quality === 'bad' ? 'bad' : 'good';
    const badge = ensureConnectionBadge3D(root, options);
    badge.mesh.scale.x = root.userData?.mirrorX ? -1 : 1;
    const visible = nextQuality === 'bad' || nextQuality === 'stale';
    badge.mesh.visible = visible;
    if (badge.quality !== nextQuality && badge.mesh.material) {
        badge.mesh.material.map = getBadgeTexture(nextQuality);
        badge.mesh.material.needsUpdate = true;
        badge.quality = nextQuality;
    }
}
