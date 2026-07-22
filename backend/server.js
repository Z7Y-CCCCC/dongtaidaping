const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const {
    getDb,
    getDbStatus,
    reconnectDb,
    loadDatabaseConfig,
    publicDatabaseConfig,
    saveDatabaseConfig,
    testDatabaseConfig
} = require('./db/database');
const { mergeBuiltinModels } = require('./services/builtinModels');
const { stringifyModelMetadata } = require('./services/modelAssetMetadata');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';

const uploadsRootDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, 'uploads');
const uploadsDir = path.join(uploadsRootDir, 'models');
const assetsDir = path.join(__dirname, 'assets');
const assetModelsDir = path.join(assetsDir, 'models');
const frontendDistDir = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : null;

for (const dir of [uploadsDir, assetModelsDir]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

if (process.env.ENABLE_CORS !== 'false') app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(uploadsRootDir));
app.use('/assets', express.static(assetsDir));

app.use('/api/config', require('./routes/config'));
app.use('/api/workshops', require('./routes/workshops'));
app.use('/api/lines', require('./routes/lines'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/datapoints', require('./routes/datapoints'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/platform', require('./routes/platform'));

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + file.originalname;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.glb', '.gltf'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('仅支持 .glb 和 .gltf 格式的 3D 模型文件'));
        }
    },
    limits: { fileSize: 100 * 1024 * 1024 }
});

function resolveModelFileDeletePlan(modelFilePath) {
    if (!modelFilePath) return null;

    const relativePath = modelFilePath.replace(/^[/\\]+/, '');
    const fullPath = relativePath.startsWith('uploads/')
        ? path.resolve(uploadsRootDir, relativePath.slice('uploads/'.length))
        : path.resolve(__dirname, relativePath);
    const uploadRoot = path.resolve(uploadsDir);
    const assetRoot = path.resolve(assetModelsDir);

    if (fullPath.startsWith(uploadRoot + path.sep)) {
        return { fullPath, deleteFile: true };
    }
    if (fullPath.startsWith(assetRoot + path.sep)) {
        return { fullPath, deleteFile: false };
    }

    throw new Error('模型文件路径不合法');
}

app.post('/api/models/upload', upload.single('modelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '未收到文件' });
    }

    const { id, name, asset_type, tags, metadata, default_scale } = req.body;
    const filePath = `/uploads/models/${req.file.filename}`;
    const modelName = name || req.file.originalname;

    try {
        const db = await getDb();
        const normalizedMetadata = stringifyModelMetadata(metadata || '{}', { name: modelName });
        await db.upsert('models', {
            id: id || req.file.filename.replace(/\.[^.]+$/, ''),
            name: modelName,
            file_path: filePath,
            asset_type: asset_type || 'model',
            tags: tags || '[]',
            thumbnail: null,
            default_scale: Number.isFinite(Number(default_scale)) ? Number(default_scale) : 1.0,
            metadata: normalizedMetadata
        }, 'id');
        res.json({ success: true, filePath });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const db = await getDb();
        const models = await db.all('SELECT * FROM models');
        res.json(mergeBuiltinModels(models));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/models/:id', async (req, res) => {
    try {
        const db = await getDb();
        const existing = await db.get('SELECT * FROM models WHERE id = ?', [req.params.id]);
        if (!existing) {
            return res.status(404).json({ error: '模型不存在或为不可编辑的内置模型' });
        }

        const nextName = req.body.name ?? existing.name;
        const nextTags = req.body.tags ?? existing.tags ?? '[]';
        const nextMetadata = req.body.metadata ?? existing.metadata ?? '{}';
        const nextScale = Number.isFinite(Number(req.body.default_scale))
            ? Number(req.body.default_scale)
            : Number(existing.default_scale || 1);
        const normalizedMetadata = stringifyModelMetadata(nextMetadata, { name: nextName });

        await db.run(
            'UPDATE models SET name = ?, tags = ?, default_scale = ?, metadata = ? WHERE id = ?',
            [nextName, nextTags, nextScale, normalizedMetadata, req.params.id]
        );

        const updated = await db.get('SELECT * FROM models WHERE id = ?', [req.params.id]);
        res.json({ success: true, model: updated });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/models/:id', async (req, res) => {
    try {
        const db = await getDb();
        const model = await db.get('SELECT * FROM models WHERE id = ?', [req.params.id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        const usedByDevices = await db.get('SELECT COUNT(*) AS cnt FROM devices WHERE model_type = ?', [req.params.id]);
        if (Number(usedByDevices?.cnt || 0) > 0) {
            return res.status(409).json({ error: `该模型正在被 ${usedByDevices.cnt} 台设备使用，先修改这些设备的模型后再删除` });
        }

        let fileDeleted = false;
        if (model.file_path) {
            const deletePlan = resolveModelFileDeletePlan(model.file_path);
            if (deletePlan?.deleteFile && fs.existsSync(deletePlan.fullPath)) {
                const stat = fs.statSync(deletePlan.fullPath);
                if (!stat.isFile()) {
                    return res.status(400).json({ error: '模型文件路径不是文件，已拒绝删除' });
                }
                fs.unlinkSync(deletePlan.fullPath);
                fileDeleted = true;
            }
        }

        await db.run('DELETE FROM models WHERE id = ?', [req.params.id]);
        if (req.params.id === 'box_atmosphere_furnace') {
            await db.upsert('settings', { key: 'deleted_seed_model_box_atmosphere_furnace', value: '1' }, 'key');
        }
        res.json({ success: true, fileDeleted });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/engine/status', (req, res) => {
    if (global.dataEngine) {
        res.json(global.dataEngine.getStatus());
    } else {
        res.json({ mode: null, plcStatus: { status: 'not_started', message: '引擎未启动' } });
    }
});

app.get('/api/plc/points/realtime', async (req, res) => {
    try {
        const deviceId = String(req.query.device_id || '').trim();

        const db = await getDb();
        const devices = deviceId
            ? [await db.get('SELECT * FROM devices WHERE id = ?', [deviceId])]
            : await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC');

        if (deviceId && !devices[0]) {
            return res.status(404).json({ error: '设备不存在' });
        }

        const allPoints = deviceId
            ? await db.all('SELECT * FROM data_points WHERE device_id = ? ORDER BY id ASC', [deviceId])
            : await db.all('SELECT * FROM data_points ORDER BY device_id, id ASC');
        const pointsByDevice = new Map();
        allPoints.forEach(point => {
            if (!pointsByDevice.has(point.device_id)) pointsByDevice.set(point.device_id, []);
            pointsByDevice.get(point.device_id).push(point);
        });

        const runtimeDevices = devices.filter(Boolean).map(device => {
            const points = pointsByDevice.get(device.id) || [];
            const runtime = global.dataEngine?.getPointRuntimeValues
                ? global.dataEngine.getPointRuntimeValues(device.id, points)
                : {
                    deviceStatus: null,
                    snapshotTimestamp: null,
                    points: points.map(point => ({ ...point, value: null, quality: 'bad' }))
                };
            return {
                device,
                deviceStatus: runtime.deviceStatus,
                snapshotTimestamp: runtime.snapshotTimestamp,
                points: runtime.points.map(point => ({
                    ...point,
                    device_id: device.id,
                    device_name: device.name,
                    device_status: runtime.deviceStatus?.status || null
                }))
            };
        });

        const latestSnapshot = runtimeDevices
            .map(item => Number(item.snapshotTimestamp || 0))
            .filter(Number.isFinite)
            .reduce((max, value) => Math.max(max, value), 0) || null;

        res.json({
            success: true,
            device: deviceId ? runtimeDevices[0]?.device : null,
            devices: runtimeDevices.map(item => item.device),
            deviceStatus: deviceId ? runtimeDevices[0]?.deviceStatus : null,
            deviceStatuses: runtimeDevices.map(item => item.deviceStatus).filter(Boolean),
            snapshotTimestamp: latestSnapshot,
            points: runtimeDevices.flatMap(item => item.points),
            timestamp: Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/engine/restart', async (req, res) => {
    if (!global.dataEngine) {
        return res.status(500).json({ error: '数据引擎未初始化' });
    }
    await global.dataEngine.restart();
    res.json({ success: true, message: '数据引擎正在重启...' });
});

app.get('/api/health', (req, res) => {
    const engineStatus = global.dataEngine ? global.dataEngine.getStatus() : null;
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        db: getDbStatus(),
        engine: engineStatus
    });
});

if (frontendDistDir && fs.existsSync(path.join(frontendDistDir, 'index.html'))) {
    app.use(express.static(frontendDistDir));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/assets/') || req.path.startsWith('/uploads/') || req.path === '/ws') {
            return next();
        }
        return res.sendFile(path.join(frontendDistDir, 'index.html'));
    });
}

app.get('/api/database/config', (req, res) => {
    res.json(publicDatabaseConfig(loadDatabaseConfig()));
});

app.post('/api/database/test', async (req, res) => {
    try {
        await testDatabaseConfig(req.body || {});
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.put('/api/database/config', async (req, res) => {
    try {
        const config = saveDatabaseConfig(req.body || {});
        await reconnectDb();
        if (global.dataEngine) {
            await global.dataEngine.restart();
        }
        res.json({ success: true, config });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

async function startServer() {
    const httpServer = http.createServer(app);
    httpServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`\n后端端口 ${PORT} 已被占用。`);
            console.error(`请先关闭旧的后端进程，或用 PowerShell 临时换端口启动：$env:PORT=3002; npm start`);
            process.exit(1);
        }
        throw error;
    });

    const WsServer = require('./services/wsServer');
    const wsServer = new WsServer();
    wsServer.attach(httpServer);

    const DataEngine = require('./services/dataEngine');
    const dataEngine = new DataEngine(wsServer);
    global.dataEngine = dataEngine;

    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try { dataEngine.stop(); } catch (e) { /* ignore */ }
        try { wsServer.close(); } catch (e) { /* ignore */ }
        httpServer.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2500).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    httpServer.listen(PORT, HOST, () => {
        console.log(`\n数字孪生后端服务已启动: http://${HOST}:${PORT}`);
        const dbConfig = publicDatabaseConfig(loadDatabaseConfig());
        console.log(`   Database:    ${dbConfig.type} ${dbConfig.host || dbConfig.filename}:${dbConfig.port || ''}/${dbConfig.database || ''}`);
        console.log(`   配置 API:    http://${HOST}:${PORT}/api/config`);
        console.log(`   管理 API:    http://${HOST}:${PORT}/api/lines | devices | datapoints | settings`);
        console.log(`   引擎状态:    http://${HOST}:${PORT}/api/engine/status`);
        console.log(`   WebSocket:   ws://${HOST}:${PORT}/ws\n`);

        setTimeout(() => {
            getDb()
                .then(() => dataEngine.start())
                .catch((error) => {
                    console.error('[DataEngine] 启动失败:', error.message);
                    console.error('[DataEngine] 可在后台“数据库连接”中修改并测试数据库配置。');
                });
        }, 1000);
    });
}

startServer().catch((error) => {
    console.error('\n后端启动失败:', error.message);
    process.exit(1);
});
