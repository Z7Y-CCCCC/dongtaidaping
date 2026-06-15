const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/config - 输出完整的工厂配置（大屏前端启动时拉取）
router.get('/', (req, res) => {
    const db = getDb();

    // 1. 全局设置
    const settingsRows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });

    // 2. 车间、产线和设备
    const workshops = db.prepare('SELECT * FROM workshops ORDER BY sort_order ASC').all();
    const lines = db.prepare('SELECT * FROM lines ORDER BY sort_order ASC').all();
    const allDevices = db.prepare('SELECT * FROM devices ORDER BY line_id, sort_order ASC').all();
    const allPoints = db.prepare('SELECT * FROM data_points ORDER BY device_id').all();

    // 按设备 ID 分组点位
    const pointsByDevice = {};
    allPoints.forEach(p => {
        if (!pointsByDevice[p.device_id]) pointsByDevice[p.device_id] = [];
        pointsByDevice[p.device_id].push(p);
    });

    // 按产线 ID 分组设备
    const linesWithDevices = lines.map(line => {
        const devices = allDevices
            .filter(d => d.line_id === line.id)
            .map(d => ({
                ...d,
                dataPoints: pointsByDevice[d.id] || []
            }));
        return { ...line, devices };
    });

    // 按车间 ID 分组产线
    const workshopsWithLines = workshops.map(ws => {
        const wsLines = linesWithDevices.filter(l => l.workshop_id === ws.id);
        return { ...ws, lines: wsLines };
    });

    // 3. 模型库
    const models = db.prepare('SELECT * FROM models').all();

    res.json({
        settings,
        workshops: workshopsWithLines,
        models
    });
});

module.exports = router;
