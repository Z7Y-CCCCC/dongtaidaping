const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '..', 'data');
const LICENSE_FILE = path.resolve(process.env.LICENSE_FILE || path.join(DATA_DIR, 'license.json'));
const LICENSE_FORMAT = 'heat-treatment-digital-twin-license';
const LICENSE_VERSION = 1;
const LICENSE_ALGORITHM = 'ed25519';

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4;
    return Buffer.from(normalized + (padding ? '='.repeat(4 - padding) : ''), 'base64');
}

function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function normalizePayload(payload = {}) {
    const features = Array.isArray(payload.features)
        ? [...new Set(payload.features.map(value => String(value || '').trim()).filter(Boolean))].sort()
        : [];
    return {
        licenseId: String(payload.licenseId || '').trim(),
        customer: String(payload.customer || '').trim(),
        issuedAt: String(payload.issuedAt || '').trim(),
        expiresAt: String(payload.expiresAt || '').trim(),
        features,
        machineId: String(payload.machineId || '').trim() || null,
        deviceLimit: Number.isFinite(Number(payload.deviceLimit)) && Number(payload.deviceLimit) > 0
            ? Math.floor(Number(payload.deviceLimit))
            : null
    };
}

function readPublicKey() {
    const configuredFile = String(process.env.LICENSE_PUBLIC_KEY_FILE || '').trim();
    const configuredValue = String(process.env.LICENSE_PUBLIC_KEY || '').trim();
    if (configuredFile) {
        try { return crypto.createPublicKey(fs.readFileSync(path.resolve(configuredFile))); } catch (error) { return null; }
    }
    if (!configuredValue) return null;
    try {
        const material = configuredValue.includes('BEGIN PUBLIC KEY')
            ? configuredValue.replace(/\\n/g, '\n')
            : Buffer.from(configuredValue, 'base64');
        return crypto.createPublicKey(material);
    } catch (error) {
        return null;
    }
}

function loadRawLicense() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return { __readError: error.message };
    }
}

function evaluateLicense(raw = loadRawLicense(), options = {}) {
    const enforce = options.enforce !== undefined
        ? Boolean(options.enforce)
        : process.env.LICENSE_ENFORCE === 'true';
    const publicKey = options.publicKey || readPublicKey();
    const result = {
        format: LICENSE_FORMAT,
        version: LICENSE_VERSION,
        file: LICENSE_FILE,
        enforce,
        configured: false,
        valid: false,
        status: 'not_configured',
        reason: '未配置离线许可证',
        licenseId: null,
        customer: null,
        issuedAt: null,
        expiresAt: null,
        features: [],
        machineBound: false,
        checkedAt: new Date().toISOString()
    };
    if (!raw) return result;
    if (raw.__readError) {
        result.status = 'invalid';
        result.reason = `许可证文件无法读取：${raw.__readError}`;
        return result;
    }
    result.configured = true;
    if (raw.format !== LICENSE_FORMAT || Number(raw.version) !== LICENSE_VERSION || raw.algorithm !== LICENSE_ALGORITHM) {
        result.status = 'invalid';
        result.reason = '许可证格式或版本不受支持';
        return result;
    }
    const payload = normalizePayload(raw.payload);
    Object.assign(result, {
        licenseId: payload.licenseId || null,
        customer: payload.customer || null,
        issuedAt: payload.issuedAt || null,
        expiresAt: payload.expiresAt || null,
        features: payload.features,
        machineBound: Boolean(payload.machineId)
    });
    if (!payload.licenseId || !payload.customer || !payload.issuedAt || !payload.expiresAt || !raw.signature) {
        result.status = 'invalid';
        result.reason = '许可证缺少必要字段';
        return result;
    }
    if (!publicKey) {
        result.status = 'unverified';
        result.reason = '未配置许可证公钥，无法验证签名';
        return result;
    }
    let signature;
    try { signature = base64UrlDecode(raw.signature); } catch (error) { signature = null; }
    let signatureValid = false;
    try {
        signatureValid = Boolean(signature)
            && crypto.verify(null, Buffer.from(canonicalize(payload)), publicKey, signature);
    } catch (error) {
        signatureValid = false;
    }
    if (!signatureValid) {
        result.status = 'invalid';
        result.reason = '许可证签名校验失败';
        return result;
    }
    const now = Date.now();
    const issued = Date.parse(payload.issuedAt);
    const expires = Date.parse(payload.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
        result.status = 'invalid';
        result.reason = '许可证日期无效';
        return result;
    }
    if (now < issued) {
        result.status = 'not_yet_valid';
        result.reason = '许可证尚未到生效时间';
        return result;
    }
    if (now >= expires) {
        result.status = 'expired';
        result.reason = '许可证已过期';
        return result;
    }
    const expectedMachine = String(process.env.LICENSE_MACHINE_ID || '').trim();
    if (payload.machineId && expectedMachine && payload.machineId !== expectedMachine) {
        result.status = 'machine_mismatch';
        result.reason = '许可证未授权当前安装实例';
        return result;
    }
    result.status = 'valid';
    result.valid = true;
    result.reason = '许可证有效';
    return result;
}

function getLicenseStatus() {
    return evaluateLicense();
}

function isLicenseEnforced() {
    return process.env.LICENSE_ENFORCE === 'true';
}

function assertLicenseForWrite() {
    if (!isLicenseEnforced()) return;
    const status = getLicenseStatus();
    if (!status.valid) {
        const error = new Error(`当前许可证不可用：${status.reason}`);
        error.code = 'LICENSE_REQUIRED';
        throw error;
    }
}

function installLicense(document) {
    const raw = document && typeof document === 'object' ? document : null;
    if (!raw) throw new Error('许可证内容必须是 JSON 对象');
    const status = evaluateLicense(raw);
    if (status.status !== 'valid') throw new Error(`许可证校验失败：${status.reason}`);
    fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
    const temporary = `${LICENSE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, LICENSE_FILE);
    return getLicenseStatus();
}

function signLicensePayload(payload, privateKey) {
    const normalized = normalizePayload(payload);
    const signature = crypto.sign(null, Buffer.from(canonicalize(normalized)), privateKey);
    return {
        format: LICENSE_FORMAT,
        version: LICENSE_VERSION,
        algorithm: LICENSE_ALGORITHM,
        payload: normalized,
        signature: base64UrlEncode(signature)
    };
}

module.exports = {
    LICENSE_FILE,
    LICENSE_FORMAT,
    LICENSE_VERSION,
    LICENSE_ALGORITHM,
    canonicalize,
    evaluateLicense,
    getLicenseStatus,
    installLicense,
    isLicenseEnforced,
    assertLicenseForWrite,
    signLicensePayload,
    normalizePayload
};
