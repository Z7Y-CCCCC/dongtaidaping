const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
const PORT = 3001;

// 确保数据目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
const uploadsDir = path.join(__dirname, 'uploads', 'models');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
const assetsDir = path.join(__dirname, 'assets');
const assetModelsDir = path.join(assetsDir, 'models');
if (!fs.existsSync(assetModelsDir)) {
    fs.mkdirSync(assetModelsDir, { recursive: true });
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/assets', express.static(assetsDir));

// API 路由
app.use('/api/config', require('./routes/config'));
app.use('/api/workshops', require('./routes/workshops'));
app.use('/api/lines', require('./routes/lines'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/datapoints', require('./routes/datapoints'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/platform', require('./routes/platform'));

// 模型文件上传 (使用 multer)
const multer = require('multer');
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
            cb(new Error('仅支持 .glb 和 .gltf 格式的3D模型文件'));
        }
    },
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// POST /api/models/upload - 上传模型文件
app.post('/api/models/upload', upload.single('modelFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '未收到文件' });
    }
    const { getDb } = require('./db/database');
    const db = getDb();
    const { id, name, asset_type, tags, metadata, default_scale } = req.body;
    const filePath = `/uploads/models/${req.file.filename}`;

    try {
        db.prepare(`INSERT OR REPLACE INTO models (
            id, name, file_path, asset_type, tags, default_scale, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            id || req.file.filename.replace(/\.[^.]+$/, ''),
            name || req.file.originalname,
            filePath,
            asset_type || 'model',
            tags || '[]',
            Number.isFinite(Number(default_scale)) ? Number(default_scale) : 1.0,
            metadata || '{}'
        );
        res.json({ success: true, filePath });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// GET /api/models - 获取模型列表
app.get('/api/models', (req, res) => {
    const { getDb } = require('./db/database');
    const db = getDb();
    const models = db.prepare('SELECT * FROM models').all();
    // 始终包含内置模型
    const builtinModel = {
        id: 'builtin_furnace',
        name: '内置多用炉模型（程序化几何体）',
        file_path: null,
        default_scale: 1.0,
        is_builtin: true
    };
    res.json([builtinModel, ...models]);
});

// DELETE /api/models/:id
app.delete('/api/models/:id', (req, res) => {
    const { getDb } = require('./db/database');
    const db = getDb();
    const model = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
    if (model && model.file_path) {
        const relativePath = model.file_path.replace(/^[/\\]+/, '');
        const fullPath = path.resolve(__dirname, relativePath);
        const allowedRoot = path.resolve(uploadsDir);
        if (fullPath !== allowedRoot && !fullPath.startsWith(allowedRoot + path.sep)) {
            return res.status(400).json({ error: '模型文件路径不合法' });
        }
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// ============ 数据引擎 API ============

// GET /api/engine/status - 获取数据引擎当前状态
app.get('/api/engine/status', (req, res) => {
    if (global.dataEngine) {
        res.json(global.dataEngine.getStatus());
    } else {
        res.json({ mode: null, plcStatus: { status: 'not_started', message: '引擎未启动' } });
    }
});

// POST /api/engine/restart - 重启数据引擎（用户修改连接设置后调用）
app.post('/api/engine/restart', (req, res) => {
    if (global.dataEngine) {
        global.dataEngine.restart();
        res.json({ success: true, message: '数据引擎正在重启...' });
    } else {
        res.status(500).json({ error: '数据引擎未初始化' });
    }
});

// 健康检查
app.get('/api/health', (req, res) => {
    const engineStatus = global.dataEngine ? global.dataEngine.getStatus() : null;
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        engine: engineStatus
    });
});

// ============ 启动服务器 + WebSocket + 数据引擎 ============

const httpServer = http.createServer(app);

// 初始化 WebSocket
const WsServer = require('./services/wsServer');
const wsServer = new WsServer();
wsServer.attach(httpServer);

// 初始化数据引擎
const DataEngine = require('./services/dataEngine');
const dataEngine = new DataEngine(wsServer);
global.dataEngine = dataEngine;

httpServer.listen(PORT, () => {
    console.log(`\n✅ 数字孪生后端服务已启动: http://localhost:${PORT}`);
    console.log(`   配置 API:    http://localhost:${PORT}/api/config`);
    console.log(`   管理 API:    http://localhost:${PORT}/api/lines | devices | datapoints | settings`);
    console.log(`   引擎状态:    http://localhost:${PORT}/api/engine/status`);
    console.log(`   WebSocket:   ws://localhost:${PORT}/ws`);
    console.log('');

    // 延迟启动数据引擎（确保数据库初始化完成）
    setTimeout(() => {
        dataEngine.start();
    }, 1000);
});
