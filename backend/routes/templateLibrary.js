const express = require('express');
const { getHeatTreatmentTemplatePacks } = require('../services/heatTreatmentTemplates');

const router = express.Router();

router.get('/', (req, res) => {
    const category = String(req.query.category || '').trim().toLowerCase();
    const packs = getHeatTreatmentTemplatePacks().filter(pack => !category || pack.category === category);
    res.json({
        success: true,
        readOnly: true,
        contractVersion: 1,
        packs,
        count: packs.length
    });
});

module.exports = router;
