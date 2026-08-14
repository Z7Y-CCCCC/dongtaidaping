const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { safeObject, normalizeWorkshopLayout } = require('../utils/spatialLayout');
const {
    assertDeletionConfirmation,
    getWorkshopDeletionImpact,
    publicDeletionImpact
} = require('../services/deletionImpact');

function normalizeWorkshopRow(row) {
    const layout = normalizeWorkshopLayout(row?.layout_json || row?.layout);
    return { ...row, layout, layout_json: JSON.stringify(layout) };
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const workshops = await db.all('SELECT * FROM workshops ORDER BY sort_order ASC');
        res.json(workshops.map(normalizeWorkshopRow));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/deletion-impact', async (req, res) => {
    try {
        const impact = await getWorkshopDeletionImpact(await getDb(), req.params.id);
        if (!impact) return res.status(404).json({ error: '车间不存在，可能已经被删除或 ID 未正确编码' });
        res.json(publicDeletionImpact(impact));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const { id, name, sort_order, layout_json, layout } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: '车间ID和名称不能为空' });
    }
    try {
        const db = await getDb();
        const nextLayout = normalizeWorkshopLayout(layout_json || layout);
        await db.run(
            'INSERT INTO workshops (id, name, sort_order, layout_json) VALUES (?, ?, ?, ?)',
            [id, name, sort_order || 0, JSON.stringify(nextLayout)]
        );
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const { name, sort_order, layout_json, layout } = req.body;
    try {
        const db = await getDb();
        const existing = await db.get('SELECT * FROM workshops WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: '车间不存在，可能已经被删除或 ID 未正确编码' });

        const nextLayout = normalizeWorkshopLayout(layout_json ?? layout ?? existing.layout_json);
        await db.run('UPDATE workshops SET name = ?, sort_order = ?, layout_json = ? WHERE id = ?', [
            name ?? existing.name,
            sort_order ?? existing.sort_order ?? 0,
            JSON.stringify(nextLayout),
            req.params.id
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const deletedImpact = await db.transaction(async (tx) => {
            const impact = await getWorkshopDeletionImpact(tx, req.params.id);
            if (!impact) {
                const error = new Error('车间不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            assertDeletionConfirmation(req.body, impact.name);
            if (impact.deviceIds.length) {
                const placeholders = impact.deviceIds.map(() => '?').join(',');
                await tx.run(`DELETE FROM data_points WHERE device_id IN (${placeholders})`, impact.deviceIds);
                await tx.run(`DELETE FROM devices WHERE id IN (${placeholders})`, impact.deviceIds);
            }
            if (impact.lineIds.length) {
                const placeholders = impact.lineIds.map(() => '?').join(',');
                await tx.run(`DELETE FROM \`lines\` WHERE id IN (${placeholders})`, impact.lineIds);
            }
            const environmentRow = await tx.get('SELECT value FROM settings WHERE `key` = ?', ['native_environment_config']);
            const environment = safeObject(environmentRow?.value);
            if (Array.isArray(environment.walls)) {
                environment.walls = environment.walls.filter(wall => (
                    String(wall?.workshopId || wall?.workshop_id || '') !== String(req.params.id)
                ));
                await tx.run('UPDATE settings SET value = ? WHERE `key` = ?', [
                    JSON.stringify(environment),
                    'native_environment_config'
                ]);
            }
            await tx.run('DELETE FROM workshops WHERE id = ?', [req.params.id]);
            return impact;
        });
        res.json({ success: true, impact: publicDeletionImpact(deletedImpact) });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
