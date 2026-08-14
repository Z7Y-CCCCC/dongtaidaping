const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const crypto = require('crypto');
const {
    createCorsMiddleware,
    createOperationRateLimiter,
    protectManagementWrites,
    securityHeaders
} = require('./middleware/security');
const {
    getDb,
    closeDb,
    getDbStatus,
    reconnectDb,
    createDatabaseBackup,
    restoreDatabaseBackup,
    deleteDatabaseBackup,
    getDatabaseBackupStatus,
    saveDatabaseBackupPolicy,
    resolveDatabaseBackupPath,
    startDatabaseMaintenance,
    stopDatabaseMaintenance,
    loadDatabaseConfig,
    publicDatabaseConfig,
    saveDatabaseConfig,
    testDatabaseConfig
} = require('./db/database');
const { mergeBuiltinModels } = require('./services/builtinModels');
const { stringifyModelMetadata } = require('./services/modelAssetMetadata');
const { publicProtocolDefinitions } = require('./services/plcProtocolConfig');
const {
    createSiteBackup,
    restoreSiteBackup,
    getSiteBackupStatus,
    loadSiteBackupConfig,
    saveSiteBackupConfig,
    startSiteBackupMaintenance,
    stopSiteBackupMaintenance,
    resolveSiteBackupPath,
    SITE_IMPORT_DIR
} = require('./services/siteBackup');
const {
    startDataSourceMaintenance,
    stopDataSourceMaintenance
} = require('./services/dataSources');

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';

const uploadsRootDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, 'uploads');
const uploadsDir = path.join(uploadsRootDir, 'models');
const audioUploadsDir = path.join(uploadsRootDir, 'audio');
const assetsDir = path.join(__dirname, 'assets');
const assetModelsDir = path.join(assetsDir, 'models');
const frontendDistDir = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : null;

for (const dir of [uploadsDir, audioUploadsDir, assetModelsDir]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

app.use(securityHeaders);
if (process.env.ENABLE_CORS !== 'false') app.use(createCorsMiddleware());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb', strict: true }));
app.use(protectManagementWrites);
app.use('/uploads', express.static(uploadsRootDir, { dotfiles: 'deny', index: false }));
app.use('/assets', express.static(assetsDir, { dotfiles: 'deny', index: false }));

app.use('/api/config', require('./routes/config'));
app.use('/api/workshops', require('./routes/workshops'));
app.use('/api/lines', require('./routes/lines'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/datapoints', require('./routes/datapoints'));
app.use('/api/voice', require('./routes/voice'));
const settingsController = { wsServer: null };
app.use('/api/settings', require('./routes/settings')(settingsController));
const nativePreviewController = { wsServer: null };
app.use('/api/native-preview', require('./routes/nativePreview')(nativePreviewController));
app.use('/api/platform', require('./routes/platform'));
app.use('/api/data-sources', require('./routes/dataSources'));

// 仅供 Electron 本机管理“登录后自启”和局域网投屏，路由内部会拒绝非回环请求。
const runtimeController = { lanDisplay: null };
app.use('/api/system/runtime', require('./routes/runtime')(runtimeController));

// 局域网电视发现（SSDP）与 DLNA 一键投屏，同样只对本机开放。
const castController = { discovery: null, screenCast: null };
app.use('/api/system/cast', require('./routes/cast')(castController));

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname || '').toLowerCase();
        const uniqueName = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`;
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

fs.mkdirSync(SITE_IMPORT_DIR, { recursive: true });
const backupOperationLimiter = createOperationRateLimiter({ name: 'backup-operation', limit: 20 });
const siteBackupUpload = multer({
    dest: SITE_IMPORT_DIR,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(ext === '.zip' ? null : new Error('仅支持系统导出的 .zip 整站备份包'), ext === '.zip');
    },
    limits: { fileSize: 1024 * 1024 * 1024, files: 1 }
});

function receiveSiteBackup(req, res, next) {
    siteBackupUpload.single('backup')(req, res, error => {
        if (!error) {
            next();
            return;
        }
        if (req.file?.path) fs.rmSync(req.file.path, { force: true });
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? '整站备份包不能超过 1 GB'
            : error.message;
        res.status(400).json({ success: false, error: message });
    });
}

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

function validateUploadedModelFile(file) {
    const extension = path.extname(file?.filename || '').toLowerCase();
    if (extension === '.glb') {
        const handle = fs.openSync(file.path, 'r');
        try {
            const header = Buffer.alloc(12);
            if (fs.readSync(handle, header, 0, header.length, 0) !== header.length
                || header.toString('ascii', 0, 4) !== 'glTF'
                || header.readUInt32LE(4) !== 2
                || header.readUInt32LE(8) !== file.size) {
                throw new Error('GLB 文件头或长度校验失败');
            }
        } finally {
            fs.closeSync(handle);
        }
        return;
    }
    if (extension === '.gltf') {
        let document;
        try { document = JSON.parse(fs.readFileSync(file.path, 'utf8')); } catch (error) { throw new Error('GLTF 文件不是有效 JSON'); }
        if (!document || typeof document !== 'object' || !String(document.asset?.version || '').startsWith('2')) {
            throw new Error('仅支持 glTF 2.x 模型');
        }
        return;
    }
    throw new Error('模型文件扩展名不合法');
}

app.post('/api/models/upload', upload.single('modelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '未收到文件' });
    }

    const { id, name, asset_type, tags, metadata, default_scale } = req.body;
    const filePath = `/uploads/models/${req.file.filename}`;
    const modelName = name || req.file.originalname;

    try {
        validateUploadedModelFile(req.file);
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
        if (req.file?.path) fs.rmSync(req.file.path, { force: true });
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

app.get('/api/plc/protocols', (req, res) => {
    res.json({ protocols: publicProtocolDefinitions() });
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

app.post('/api/database/test', backupOperationLimiter, async (req, res) => {
    try {
        await testDatabaseConfig(req.body || {});
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.put('/api/database/config', backupOperationLimiter, async (req, res) => {
    try {
        await stopDatabaseMaintenance({ backup: true, reason: 'before-config-change' });
        const config = saveDatabaseConfig(req.body || {});
        await reconnectDb();
        await startDatabaseMaintenance();
        if (global.dataEngine) {
            await global.dataEngine.restart();
        }
        res.json({ success: true, config });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.get('/api/database/backups', (req, res) => {
    try {
        res.json(getDatabaseBackupStatus());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/database/backups/config', backupOperationLimiter, async (req, res) => {
    try {
        const result = await saveDatabaseBackupPolicy(req.body || {});
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/api/database/backups', backupOperationLimiter, async (req, res) => {
    try {
        const backup = await createDatabaseBackup('manual');
        res.json({ success: true, backup, status: getDatabaseBackupStatus() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.get('/api/database/backups/:filename/download', (req, res) => {
    try {
        const filename = resolveDatabaseBackupPath(req.params.filename);
        res.download(filename, path.basename(filename));
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

app.post('/api/database/backups/:filename/restore', backupOperationLimiter, async (req, res) => {
    const dataEngine = global.dataEngine;
    try {
        dataEngine?.stop();
        const result = await restoreDatabaseBackup(req.params.filename);
        if (dataEngine) await dataEngine.start();
        res.json({ ...result, status: getDatabaseBackupStatus() });
    } catch (e) {
        if (dataEngine) {
            try { await dataEngine.start(); } catch (restartError) { /* report original restore error */ }
        }
        res.status(400).json({ success: false, error: e.message });
    }
});

app.delete('/api/database/backups/:filename', backupOperationLimiter, async (req, res) => {
    try {
        res.json(await deleteDatabaseBackup(req.params.filename));
    } catch (e) {
        res.status(e.message === '备份文件不存在' ? 404 : 400).json({ success: false, error: e.message });
    }
});

app.get('/api/site-backups', (req, res) => {
    try {
        res.json(getSiteBackupStatus());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/site-backups/config', (req, res) => {
    try {
        res.json(loadSiteBackupConfig());
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/site-backups/config', backupOperationLimiter, async (req, res) => {
    try {
        const config = saveSiteBackupConfig(req.body || {});
        await startSiteBackupMaintenance(uploadsRootDir);
        res.json({ success: true, config, status: getSiteBackupStatus() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/api/site-backups/export', backupOperationLimiter, async (req, res) => {
    try {
        const backup = await createSiteBackup(uploadsRootDir);
        res.json({ success: true, backup, status: getSiteBackupStatus() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.get('/api/site-backups/:filename/download', (req, res) => {
    try {
        const filename = resolveSiteBackupPath(req.params.filename);
        res.download(filename, path.basename(filename));
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

app.post('/api/site-backups/import', backupOperationLimiter, receiveSiteBackup, async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '未收到整站备份文件' });

    const dataEngine = global.dataEngine;
    let result = null;
    let restoreError = null;
    try {
        dataEngine?.stop();
        await stopDatabaseMaintenance({ backup: true, reason: 'before-site-import' });
        result = await restoreSiteBackup(req.file.path, uploadsRootDir);
    } catch (error) {
        restoreError = error;
    }

    try {
        await startDatabaseMaintenance();
    } catch (error) {
        restoreError ||= error;
    }
    if (dataEngine) {
        try { await dataEngine.start(); } catch (error) { restoreError ||= error; }
    }
    fs.rmSync(req.file.path, { force: true });

    if (restoreError) {
        res.status(400).json({ success: false, error: restoreError.message });
        return;
    }
    res.json({ ...result, status: getSiteBackupStatus(), databaseStatus: getDatabaseBackupStatus() });
});

async function startServer() {
    const httpServer = http.createServer(app);
    httpServer.headersTimeout = Math.max(5000, Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 15000));
    httpServer.requestTimeout = Math.max(30000, Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 10 * 60 * 1000));
    httpServer.keepAliveTimeout = Math.max(1000, Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 5000));
    httpServer.maxHeadersCount = Math.max(32, Number(process.env.HTTP_MAX_HEADERS || 100));
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
    global.wsServer = wsServer;
    settingsController.wsServer = wsServer;
    nativePreviewController.wsServer = wsServer;

    const LanDisplayService = require('./services/lanDisplay');
    const lanDisplay = new LanDisplayService({ app, wsServer, primaryPort: PORT });
    runtimeController.lanDisplay = lanDisplay;

    const CastDiscoveryService = require('./services/castDiscovery');
    const ScreenCastService = require('./services/screenCast');
    const castDiscovery = new CastDiscoveryService();
    const screenCast = new ScreenCastService({ port: Number(process.env.CAST_STREAM_PORT) || 8788 });
    castController.discovery = castDiscovery;
    castController.screenCast = screenCast;

    const DataEngine = require('./services/dataEngine');
    const dataEngine = new DataEngine(wsServer);
    global.dataEngine = dataEngine;

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        const forceExit = setTimeout(() => process.exit(1), 12000);
        forceExit.unref?.();
        try { dataEngine.stop(); } catch (e) { /* ignore */ }
        try { await screenCast.close(); } catch (e) { /* ignore */ }
        try { await lanDisplay.stop(); } catch (e) { /* ignore */ }
        try { stopSiteBackupMaintenance(); } catch (e) { /* ignore */ }
        try { await stopDataSourceMaintenance(); } catch (e) { /* ignore */ }
        try { wsServer.close(); } catch (e) { /* ignore */ }
        if (global.wsServer === wsServer) global.wsServer = null;
        httpServer.close();
        try {
            await stopDatabaseMaintenance({ backup: true, reason: 'shutdown' });
            await closeDb();
            clearTimeout(forceExit);
            process.exit(0);
        } catch (error) {
            console.error('[Shutdown] 安全退出失败:', error.message);
            process.exit(1);
        }
    };

    const desktopShutdownToken = String(process.env.DESKTOP_SHUTDOWN_TOKEN || '');
    if (desktopShutdownToken) {
        app.post('/api/internal/shutdown', (req, res) => {
            const remoteAddress = String(req.socket.remoteAddress || '');
            const isLoopback = remoteAddress === '::1' || /^(::ffff:)?127\.0\.0\.1$/.test(remoteAddress);
            const suppliedToken = String(req.get('x-shutdown-token') || '');
            if (!isLoopback || suppliedToken !== desktopShutdownToken) {
                res.status(403).json({ success: false, error: '拒绝访问' });
                return;
            }

            res.status(202).json({ success: true, message: '正在安全退出' });
            res.once('finish', () => setImmediate(shutdown));
        });
    }
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    // 这些兜底处理必须在动态注册的本机安全退出路由之后，避免误吞掉该路由。
    app.use((req, res) => {
        if (req.path.startsWith('/api/')) {
            res.status(404).json({ success: false, error: '接口不存在' });
            return;
        }
        res.status(404).send('Not Found');
    });
    app.use((error, req, res, next) => {
        if (res.headersSent) {
            next(error);
            return;
        }
        const status = error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE'
            ? 413
            : (Number.isInteger(error?.statusCode) ? error.statusCode : 400);
        const message = status === 413
            ? '请求或上传文件超过大小限制'
            : (error?.message || '请求处理失败');
        // 只记录服务端日志，不把堆栈、绝对路径和数据库连接细节返回给客户端。
        console.error(`[HTTP ${status}] ${req.method} ${req.originalUrl}: ${message}`);
        res.status(status).json({ success: false, error: message });
    });

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
                .then(() => startDatabaseMaintenance())
                .then(() => startDataSourceMaintenance())
                .then(() => lanDisplay.loadFromSettings())
                .then(() => startSiteBackupMaintenance(uploadsRootDir))
                .then(() => dataEngine.start())
                .catch((error) => {
                    console.error('[DataEngine] 启动失败:', error.message);
                    console.error('[DataEngine] 可在后台“数据库连接”中修改并测试数据库配置。');
                });
            // 提前探测 ffmpeg 和局域网电视，后台页面一打开就能看到真实状态。
            screenCast.resolveFfmpeg()
                .then(found => {
                    if (found) console.log(`[投屏] 已找到屏幕编码器: ${found}`);
                    else console.log('[投屏] 未找到 ffmpeg，DLNA 一键投屏不可用；二维码网页投屏不受影响。');
                })
                .catch(() => {});
            castDiscovery.scan({ timeoutMs: 3500 }).catch(() => {});
        }, 1000);
    });
}

startServer().catch((error) => {
    console.error('\n后端启动失败:', error.message);
    process.exit(1);
});
