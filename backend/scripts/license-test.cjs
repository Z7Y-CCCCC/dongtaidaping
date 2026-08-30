const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-twin-license-'));
process.env.APP_DATA_DIR = dataDir;
process.env.LICENSE_ENFORCE = 'true';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
process.env.LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });

const {
    LICENSE_FILE,
    evaluateLicense,
    getLicenseStatus,
    installLicense,
    signLicensePayload,
    assertLicenseForWrite
} = require('../services/license');

function payload(overrides = {}) {
    const issuedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return {
        licenseId: 'LIC-TEST-001',
        customer: '测试客户',
        issuedAt,
        expiresAt,
        features: ['dashboard', 'business-readonly'],
        ...overrides
    };
}

try {
    const signed = signLicensePayload(payload(), privateKey);
    const valid = evaluateLicense(signed);
    assert.equal(valid.status, 'valid');
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.features, ['business-readonly', 'dashboard']);

    const tampered = { ...signed, payload: { ...signed.payload, customer: '篡改客户' } };
    assert.equal(evaluateLicense(tampered).status, 'invalid');

    const expired = signLicensePayload(payload({
        issuedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    }), privateKey);
    assert.equal(evaluateLicense(expired).status, 'expired');

    const installed = installLicense(signed);
    assert.equal(installed.status, 'valid');
    assert(fs.existsSync(LICENSE_FILE));
    assert.doesNotThrow(() => assertLicenseForWrite());

    process.env.LICENSE_PUBLIC_KEY = '';
    assert.equal(getLicenseStatus().status, 'unverified');
    let blocked = false;
    try { assertLicenseForWrite(); } catch (error) { blocked = error.code === 'LICENSE_REQUIRED'; }
    assert.equal(blocked, true);

    console.log(JSON.stringify({
        success: true,
        format: signed.format,
        algorithm: signed.algorithm,
        installed: installed.licenseId,
        tamperRejected: true,
        expiryRejected: true,
        strictModeBlocksUnverified: true
    }, null, 2));
} finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
}
