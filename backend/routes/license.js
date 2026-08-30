const express = require('express');
const {
    getLicenseStatus,
    installLicense,
    LICENSE_FORMAT,
    LICENSE_VERSION,
    LICENSE_ALGORITHM
} = require('../services/license');

const router = express.Router();

router.get('/', (req, res) => {
    res.json({ success: true, readOnly: true, ...getLicenseStatus() });
});

router.put('/', (req, res) => {
    try {
        const status = installLicense(req.body?.license || req.body);
        res.json({ success: true, ...status });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

router.get('/contract', (req, res) => {
    res.json({
        success: true,
        readOnly: true,
        format: LICENSE_FORMAT,
        version: LICENSE_VERSION,
        algorithm: LICENSE_ALGORITHM,
        fields: ['licenseId', 'customer', 'issuedAt', 'expiresAt', 'features', 'machineId', 'deviceLimit'],
        note: '许可证离线签名校验；系统不会向许可证文件写入密码或私钥。'
    });
});

module.exports = router;
