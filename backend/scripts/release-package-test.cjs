const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    RELEASE_FORMAT,
    signReleasePayload,
    verifyReleaseManifest
} = require('../services/releasePackage');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-twin-release-'));
const artifactPath = path.join(tempDir, 'heat-treatment-digital-twin-2.4.0.nsis.7z');
fs.writeFileSync(artifactPath, Buffer.from('signed release artifact fixture\n'), 'utf8');
const artifactSha256 = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

try {
    const manifest = signReleasePayload({
        productName: '热处理数字孪生大屏',
        productVersion: '2.4.0',
        configurationVersion: '1.0.6',
        createdAt: new Date().toISOString(),
        artifactName: path.basename(artifactPath),
        artifactSha256,
        minSupportedVersion: '2.3.0',
        releaseNotes: '升级契约测试'
    }, privateKey);
    const valid = verifyReleaseManifest(manifest, { publicKey, artifactPath, currentVersion: '2.3.0' });
    assert.equal(valid.valid, true);
    assert.equal(valid.status, 'valid');
    assert.equal(valid.artifactSha256, artifactSha256);

    const tampered = { ...manifest, payload: { ...manifest.payload, productVersion: '2.4.1' } };
    assert.equal(verifyReleaseManifest(tampered, { publicKey, artifactPath, currentVersion: '2.3.0' }).valid, false);

    const wrongArtifact = path.join(tempDir, 'wrong.7z');
    fs.writeFileSync(wrongArtifact, 'tampered\n', 'utf8');
    const hashMismatch = verifyReleaseManifest(manifest, { publicKey, artifactPath: wrongArtifact, currentVersion: '2.3.0' });
    assert.equal(hashMismatch.reason, '升级包 SHA-256 与清单不一致');

    assert.equal(verifyReleaseManifest(manifest, { publicKey, artifactPath, currentVersion: '2.4.0' }).valid, false);
    assert.equal(verifyReleaseManifest(manifest, { currentVersion: '2.3.0' }).reason, '未配置发布公钥');

    console.log(JSON.stringify({
        success: true,
        format: RELEASE_FORMAT,
        targetVersion: valid.targetVersion,
        signatureVerified: true,
        artifactHashVerified: true,
        tamperRejected: true,
        downgradeRejected: true
    }, null, 2));
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
