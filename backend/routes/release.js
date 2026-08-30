const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { loadReleaseManifest } = require('../services/releaseManifest');
const { RELEASE_FORMAT, RELEASE_VERSION, RELEASE_ALGORITHM, verifyReleaseManifest } = require('../services/releasePackage');

const router = express.Router();

function loadPublicKey() {
    const filename = String(process.env.RELEASE_PUBLIC_KEY_FILE || '').trim();
    const value = String(process.env.RELEASE_PUBLIC_KEY || '').trim();
    try {
        if (filename) return crypto.createPublicKey(fs.readFileSync(filename));
        if (value) return crypto.createPublicKey(value.replace(/\\n/g, '\n'));
    } catch (error) {
        return null;
    }
    return null;
}

router.get('/', (req, res) => {
    const current = loadReleaseManifest();
    res.json({
        success: true,
        readOnly: true,
        mode: 'offline_signed_package',
        automaticDownload: false,
        current,
        contract: {
            format: RELEASE_FORMAT,
            version: RELEASE_VERSION,
            algorithm: RELEASE_ALGORITHM,
            signatureRequired: true,
            sha256Required: true,
            downgradeRejected: true,
            rollback: '先恢复整站灾备，再安装上一版签名包'
        }
    });
});

router.post('/verify', (req, res) => {
    const manifest = req.body?.manifest || req.body;
    const result = verifyReleaseManifest(manifest, {
        publicKey: loadPublicKey(),
        currentVersion: req.body?.currentVersion || loadReleaseManifest().productVersion
    });
    res.status(result.valid ? 200 : 400).json({ success: result.valid, readOnly: true, ...result });
});

module.exports = router;
