const fs = require('fs');
const crypto = require('crypto');
const { canonicalize } = require('./license');

const RELEASE_FORMAT = 'heat-treatment-digital-twin-release';
const RELEASE_VERSION = 1;
const RELEASE_ALGORITHM = 'ed25519';

function sha256File(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function normalizePayload(payload = {}) {
    return {
        productName: String(payload.productName || '').trim(),
        productVersion: String(payload.productVersion || '').trim(),
        configurationVersion: String(payload.configurationVersion || '').trim(),
        createdAt: String(payload.createdAt || '').trim(),
        artifactName: String(payload.artifactName || '').trim(),
        artifactSha256: String(payload.artifactSha256 || '').trim().toLowerCase(),
        minSupportedVersion: String(payload.minSupportedVersion || '').trim() || null,
        releaseNotes: String(payload.releaseNotes || '').trim()
    };
}

function parseVersion(value) {
    const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return null;
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

function signReleasePayload(payload, privateKey) {
    const normalized = normalizePayload(payload);
    const signature = crypto.sign(null, Buffer.from(canonicalize(normalized)), privateKey);
    return {
        format: RELEASE_FORMAT,
        version: RELEASE_VERSION,
        algorithm: RELEASE_ALGORITHM,
        payload: normalized,
        signature: signature.toString('base64url')
    };
}

function verifyReleaseManifest(manifest, options = {}) {
    const result = {
        valid: false,
        format: RELEASE_FORMAT,
        version: RELEASE_VERSION,
        status: 'invalid',
        reason: '发布清单无效',
        artifactSha256: null,
        targetVersion: null,
        currentVersion: options.currentVersion || null
    };
    if (!manifest || typeof manifest !== 'object') {
        result.reason = '发布清单必须是 JSON 对象';
        return result;
    }
    if (manifest.format !== RELEASE_FORMAT || Number(manifest.version) !== RELEASE_VERSION || manifest.algorithm !== RELEASE_ALGORITHM) {
        result.reason = '发布清单格式或版本不受支持';
        return result;
    }
    const payload = normalizePayload(manifest.payload);
    result.targetVersion = payload.productVersion || null;
    if (!payload.productName || !parseVersion(payload.productVersion) || !payload.createdAt || !payload.artifactName || !/^[a-f0-9]{64}$/.test(payload.artifactSha256)) {
        result.reason = '发布清单缺少必要字段';
        return result;
    }
    const publicKey = options.publicKey;
    if (!publicKey) {
        result.reason = '未配置发布公钥';
        return result;
    }
    let signatureValid = false;
    try {
        signatureValid = crypto.verify(
            null,
            Buffer.from(canonicalize(payload)),
            publicKey,
            Buffer.from(String(manifest.signature || ''), 'base64url')
        );
    } catch (error) {
        signatureValid = false;
    }
    if (!signatureValid) {
        result.reason = '发布清单签名校验失败';
        return result;
    }
    if (options.currentVersion) {
        const comparison = compareVersions(payload.productVersion, options.currentVersion);
        if (comparison === null || comparison <= 0) {
            result.reason = '目标版本不高于当前版本';
            return result;
        }
    }
    if (payload.minSupportedVersion && options.currentVersion) {
        const comparison = compareVersions(options.currentVersion, payload.minSupportedVersion);
        if (comparison === null || comparison < 0) {
            result.reason = `当前版本低于最低升级版本 ${payload.minSupportedVersion}`;
            return result;
        }
    }
    if (options.artifactPath) {
        try {
            const actualHash = sha256File(options.artifactPath);
            result.artifactSha256 = actualHash;
            if (actualHash !== payload.artifactSha256) {
                result.reason = '升级包 SHA-256 与清单不一致';
                return result;
            }
        } catch (error) {
            result.reason = `升级包无法读取：${error.message}`;
            return result;
        }
    }
    result.valid = true;
    result.status = 'valid';
    result.reason = '发布清单和升级包校验通过';
    return result;
}

module.exports = {
    RELEASE_FORMAT,
    RELEASE_VERSION,
    RELEASE_ALGORITHM,
    compareVersions,
    normalizePayload,
    signReleasePayload,
    verifyReleaseManifest
};
