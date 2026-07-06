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

const app = express();
const PORT = Number(process.env.PORT || 3001);

const uploadsDir = path.join(__dirname, 'uploads', 'models');
const assetsDir = path.join(__dirname, 'assets');
const assetModelsDir = path.join(assetsDir, 'models');

for (const dir of [uploadsDir, assetModelsDir]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
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

app.post('/api/models/upload', upload.single('modelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '未收到文件' });
    }

    const { id, name, asset_type, tags, metadata, default_scale } = req.body;
    const filePath = `/uploads/models/${req.file.filename}`;

    try {
        const db = await getDb();
        await db.upsert('models', {
            id: id || req.file.filename.replace(/\.[^.]+$/, ''),
            name: name || req.file.originalname,
            file_path: filePath,
            asset_type: asset_type || 'model',
            tags: tags || '[]',
            thumbnail: null,
            default_scale: Number.isFinite(Number(default_scale)) ? Number(default_scale) : 1.0,
            metadata: metadata || '{}'
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

        await db.run(
            'UPDATE models SET name = ?, tags = ?, default_scale = ?, metadata = ? WHERE id = ?',
            [nextName, nextTags, nextScale, nextMetadata, req.params.id]
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
        if (model && model.file_path) {
            const relativePath = model.file_path.replace(/^[/\\]+/, '');
            const fullPath = path.resolve(__dirname, relativePath);
            const allowedRoot = path.resolve(uploadsDir);
            if (fullPath !== allowedRoot && !fullPath.startsWith(allowedRoot + path.sep)) {
                return res.status(400).json({ error: '模型文件路径不合法' });
            }
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        await db.run('DELETE FROM models WHERE id = ?', [req.params.id]);
        res.json({ success: true });
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

    httpServer.listen(PORT, () => {
        console.log(`\n数字孪生后端服务已启动: http://localhost:${PORT}`);
        const dbConfig = publicDatabaseConfig(loadDatabaseConfig());
        console.log(`   Database:    ${dbConfig.type} ${dbConfig.host || dbConfig.filename}:${dbConfig.port || ''}/${dbConfig.database || ''}`);
        console.log(`   配置 API:    http://localhost:${PORT}/api/config`);
        console.log(`   管理 API:    http://localhost:${PORT}/api/lines | devices | datapoints | settings`);
        console.log(`   引擎状态:    http://localhost:${PORT}/api/engine/status`);
        console.log(`   WebSocket:   ws://localhost:${PORT}/ws\n`);

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
