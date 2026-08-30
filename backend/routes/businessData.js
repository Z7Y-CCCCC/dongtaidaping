const express = require('express');
const {
    readBatchDetail,
    readBusinessManifest,
    readBusinessSnapshot,
    readBatches,
    readCompliance,
    readOee
} = require('../services/businessData');

const router = express.Router();

function connectionId(req) {
    return String(req.query.connection_id || req.query.connectionId || process.env.BUSINESS_DATA_SOURCE_ID || '').trim();
}

function options(req) {
    return {
        deviceId: String(req.query.device_id || req.query.deviceId || '').trim(),
        batchId: String(req.query.batch_id || req.query.batchId || '').trim(),
        limit: req.query.limit
    };
}

function handleError(res, error) {
    const status = /connectionId|数据源|批次ID/.test(String(error?.message || '')) ? 400 : 500;
    res.status(status).json({ success: false, readOnly: true, error: error.message || String(error) });
}

// These endpoints are deliberately GET-only. The digital-twin application
// reads business records from the scheduling system and never writes to it.
router.get('/manifest', async (req, res) => {
    try { res.json({ success: true, ...(await readBusinessManifest(connectionId(req))) }); }
    catch (error) { handleError(res, error); }
});

router.get('/snapshot', async (req, res) => {
    try { res.json({ success: true, ...(await readBusinessSnapshot(connectionId(req), options(req))) }); }
    catch (error) { handleError(res, error); }
});

router.get('/batches', async (req, res) => {
    try {
        res.json({ success: true, readOnly: true, contractVersion: 1, source: { connectionId: connectionId(req) }, ...(await readBatches(connectionId(req), options(req))) });
    } catch (error) { handleError(res, error); }
});

router.get('/batches/:id', async (req, res) => {
    try {
        res.json({ success: true, readOnly: true, contractVersion: 1, source: { connectionId: connectionId(req) }, ...(await readBatchDetail(connectionId(req), req.params.id)) });
    } catch (error) { handleError(res, error); }
});

router.get('/compliance', async (req, res) => {
    try {
        res.json({ success: true, readOnly: true, contractVersion: 1, source: { connectionId: connectionId(req) }, ...(await readCompliance(connectionId(req), options(req))) });
    } catch (error) { handleError(res, error); }
});

router.get('/oee', async (req, res) => {
    try {
        res.json({ success: true, readOnly: true, contractVersion: 1, source: { connectionId: connectionId(req) }, ...(await readOee(connectionId(req), options(req))) });
    } catch (error) { handleError(res, error); }
});

module.exports = router;
