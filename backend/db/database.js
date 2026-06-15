const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'factory.db');

let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        initTables();
        seedDefaults();
    }
    return db;
}

function initTables() {
    db.exec(`
        -- 车间表
        CREATE TABLE IF NOT EXISTS workshops (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 产线表
        CREATE TABLE IF NOT EXISTS lines (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            workshop_id TEXT REFERENCES workshops(id) ON DELETE CASCADE,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 设备表
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            line_id TEXT REFERENCES lines(id) ON DELETE CASCADE,
            model_type TEXT DEFAULT 'builtin_furnace',
            model_file TEXT,
            template_id TEXT DEFAULT '',
            instance_config TEXT DEFAULT '{}',
            pos_x REAL DEFAULT 0,
            pos_y REAL DEFAULT 0,
            pos_z REAL DEFAULT 0,
            rotation_y REAL DEFAULT 0,
            scale REAL DEFAULT 1.0,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- PLC 点位映射表
        CREATE TABLE IF NOT EXISTS data_points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            label TEXT NOT NULL,
            plc_tag TEXT NOT NULL,
            data_type TEXT DEFAULT 'WORD',
            category TEXT DEFAULT '',
            value_role TEXT DEFAULT '',
            quality TEXT DEFAULT 'good',
            scale REAL DEFAULT 1,
            offset REAL DEFAULT 0,
            expression TEXT DEFAULT '',
            display_format TEXT DEFAULT '',
            unit TEXT DEFAULT '',
            alarm_high REAL,
            alarm_low REAL
        );

        -- 模型库
        CREATE TABLE IF NOT EXISTS models (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            asset_type TEXT DEFAULT 'model',
            tags TEXT DEFAULT '[]',
            thumbnail TEXT,
            default_scale REAL DEFAULT 1.0,
            metadata TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 平台项目
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            is_active INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 场景编排
        CREATE TABLE IF NOT EXISTS scenes (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            scene_type TEXT DEFAULT 'factory_overview',
            layout_json TEXT DEFAULT '{}',
            camera_json TEXT DEFAULT '{}',
            theme_json TEXT DEFAULT '{}',
            is_active INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 设备模板
        CREATE TABLE IF NOT EXISTS device_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            model_type TEXT DEFAULT 'builtin_furnace',
            default_config TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 点位模板
        CREATE TABLE IF NOT EXISTS datapoint_templates (
            id TEXT PRIMARY KEY,
            device_template_id TEXT REFERENCES device_templates(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            label TEXT NOT NULL,
            category TEXT DEFAULT '',
            value_role TEXT DEFAULT '',
            data_type TEXT DEFAULT 'WORD',
            unit TEXT DEFAULT '',
            scale REAL DEFAULT 1,
            offset REAL DEFAULT 0,
            expression TEXT DEFAULT '',
            display_format TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0
        );

        -- 画面组件
        CREATE TABLE IF NOT EXISTS widgets (
            id TEXT PRIMARY KEY,
            scene_id TEXT REFERENCES scenes(id) ON DELETE CASCADE,
            widget_type TEXT NOT NULL,
            title TEXT DEFAULT '',
            config_json TEXT DEFAULT '{}',
            binding_json TEXT DEFAULT '{}',
            x REAL DEFAULT 0,
            y REAL DEFAULT 0,
            w REAL DEFAULT 1,
            h REAL DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            visible INTEGER DEFAULT 1
        );

        -- 数据绑定
        CREATE TABLE IF NOT EXISTS bindings (
            id TEXT PRIMARY KEY,
            widget_id TEXT REFERENCES widgets(id) ON DELETE CASCADE,
            source_type TEXT DEFAULT 'device',
            source_id TEXT DEFAULT '',
            path TEXT DEFAULT '',
            transform TEXT DEFAULT '',
            fallback TEXT DEFAULT ''
        );

        -- 发布版本
        CREATE TABLE IF NOT EXISTS releases (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            version TEXT NOT NULL,
            snapshot_json TEXT DEFAULT '{}',
            is_current INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 事件与报警履历
        CREATE TABLE IF NOT EXISTS event_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT DEFAULT 'alarm',
            level TEXT DEFAULT 'info',
            source_id TEXT DEFAULT '',
            title TEXT NOT NULL,
            message TEXT DEFAULT '',
            value TEXT DEFAULT '',
            quality TEXT DEFAULT 'good',
            occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            acknowledged INTEGER DEFAULT 0
        );

        -- 指标快照，用于大屏不要只靠前端假数据
        CREATE TABLE IF NOT EXISTS metric_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            current_output INTEGER DEFAULT 0,
            daily_target INTEGER DEFAULT 0,
            overall_oee REAL DEFAULT 0,
            energy_consumption REAL DEFAULT 0,
            running_devices INTEGER DEFAULT 0,
            alarm_devices INTEGER DEFAULT 0,
            online_devices INTEGER DEFAULT 0,
            total_devices INTEGER DEFAULT 0
        );

        -- 全局设置
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_lines_workshop ON lines(workshop_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_devices_line ON devices(line_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_data_points_device ON data_points(device_id);
        CREATE INDEX IF NOT EXISTS idx_widgets_scene ON widgets(scene_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_event_logs_time ON event_logs(occurred_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_metric_snapshots_time ON metric_snapshots(snapshot_time DESC, id DESC);
    `);

    ensureColumn('lines', 'workshop_id', 'TEXT REFERENCES workshops(id) ON DELETE CASCADE');
    ensureColumn('data_points', 'category', "TEXT DEFAULT ''");
    ensureColumn('data_points', 'value_role', "TEXT DEFAULT ''");
    ensureColumn('data_points', 'quality', "TEXT DEFAULT 'good'");
    ensureColumn('data_points', 'scale', 'REAL DEFAULT 1');
    ensureColumn('data_points', 'offset', 'REAL DEFAULT 0');
    ensureColumn('data_points', 'expression', "TEXT DEFAULT ''");
    ensureColumn('data_points', 'display_format', "TEXT DEFAULT ''");
    ensureColumn('devices', 'template_id', "TEXT DEFAULT ''");
    ensureColumn('devices', 'instance_config', "TEXT DEFAULT '{}'");
    ensureColumn('models', 'asset_type', "TEXT DEFAULT 'model'");
    ensureColumn('models', 'tags', "TEXT DEFAULT '[]'");
    ensureColumn('models', 'metadata', "TEXT DEFAULT '{}'");
}

function ensureColumn(tableName, columnName, definition) {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = columns.some(c => c.name === columnName);
    if (!exists) {
        db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
    }
}

function seedDefaults() {
    const settingsCount = db.prepare('SELECT COUNT(*) as cnt FROM settings').get();
    if (settingsCount.cnt === 0) {
        const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        const seedSettings = db.transaction(() => {
            insertSetting.run('factory_name', '智能热处理数字孪生控制中心');
            insertSetting.run('data_mode', 'mqtt');  // mqtt | node_s7 | simulation
            // MQTT 通道参数
            insertSetting.run('mqtt_broker', 'ws://broker.emqx.io:8083/mqtt');
            insertSetting.run('mqtt_topic_prefix', 'factory/Line1');
            // C# 上位机参数
            insertSetting.run('csharp_host_ip', '');
            insertSetting.run('csharp_host_port', '8080');
            // PLC 连接参数
            insertSetting.run('plc_ip', '');
            insertSetting.run('plc_port', '102');
            insertSetting.run('plc_rack', '0');
            insertSetting.run('plc_slot', '1');
            insertSetting.run('plc_poll_interval', '2000');
            insertSetting.run('plc_timeout', '5000');
            insertSetting.run('plc_retry_interval', '10000');
            insertSetting.run('realtime_stale_ms', '6000');
            insertSetting.run('display_mode', 'industrial_twin');
        });
        seedSettings();
    }

    // 初始化默认车间
    const workshopsCount = db.prepare('SELECT COUNT(*) as cnt FROM workshops').get();
    if (workshopsCount.cnt === 0) {
        db.prepare('INSERT INTO workshops (id, name, sort_order) VALUES (?, ?, ?)').run('ws_1', '默认车间 1', 0);
        // 将可能存在的旧产线关联到默认车间
        db.prepare("UPDATE lines SET workshop_id = 'ws_1' WHERE workshop_id IS NULL").run();
    }

    // 如果没有产线数据，预置默认的 4 条产线和 20 台设备
    const linesCount = db.prepare('SELECT COUNT(*) as cnt FROM lines').get();
    if (linesCount.cnt === 0) {
        const insertLine = db.prepare('INSERT INTO lines (id, name, workshop_id, sort_order) VALUES (?, ?, ?, ?)');
        const insertDevice = db.prepare('INSERT INTO devices (id, name, line_id, model_type, pos_x, pos_y, pos_z, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

        const seedData = db.transaction(() => {
            const lineNames = ['A 产线', 'B 产线', 'C 产线', 'D 产线'];
            for (let li = 0; li < lineNames.length; li++) {
                const lineId = `line_${String.fromCharCode(97 + li)}`;
                insertLine.run(lineId, lineNames[li], 'ws_1', li);

                for (let di = 0; di < 5; di++) {
                    const globalIdx = li * 5 + di;
                    const deviceId = `Furnace_${String(globalIdx + 1).padStart(2, '0')}`;
                    const deviceName = `${globalIdx + 1}# 多用炉`;
                    const posX = (di - 2) * 14;
                    const posZ = -li * 16;
                    insertDevice.run(deviceId, deviceName, lineId, 'builtin_furnace', posX, 0, posZ, di);
                }
            }
        });
        seedData();
    }

    seedPlatformDefaults();
}

function seedPlatformDefaults() {
    const projectCount = db.prepare('SELECT COUNT(*) as cnt FROM projects').get();
    if (projectCount.cnt === 0) {
        db.prepare('INSERT INTO projects (id, name, description, is_active) VALUES (?, ?, ?, ?)')
            .run('project_default', '热处理车间大屏项目', '默认项目，可在现场编排器中继续扩展。', 1);
    }

    const sceneCount = db.prepare('SELECT COUNT(*) as cnt FROM scenes').get();
    if (sceneCount.cnt === 0) {
        db.prepare(`INSERT INTO scenes (
            id, project_id, name, scene_type, layout_json, camera_json, theme_json, is_active, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            'scene_factory_overview',
            'project_default',
            '工厂总览',
            'factory_overview',
            JSON.stringify({ grid: { columns: 24, rows: 12 }, panels: ['navigation', 'metrics', 'trend', 'alarms', 'marquee'] }),
            JSON.stringify({ mode: 'auto', staleMs: 6000 }),
            JSON.stringify({ preset: 'industrial_twin' }),
            1,
            0
        );
    }

    const templateCount = db.prepare('SELECT COUNT(*) as cnt FROM device_templates').get();
    if (templateCount.cnt === 0) {
        db.prepare('INSERT INTO device_templates (id, name, model_type, default_config) VALUES (?, ?, ?, ?)')
            .run('tpl_multipurpose_furnace', '多用炉模板', 'builtin_furnace', JSON.stringify({ category: 'furnace', realtimeProfile: 'heat_treatment' }));
    }

    const widgetCount = db.prepare('SELECT COUNT(*) as cnt FROM widgets').get();
    if (widgetCount.cnt === 0) {
        const insertWidget = db.prepare(`INSERT INTO widgets (
            id, scene_id, widget_type, title, config_json, binding_json, x, y, w, h, sort_order, visible
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const seedWidgets = db.transaction(() => {
            insertWidget.run('widget_navigation', 'scene_factory_overview', 'navigation', '层级导航', '{}', '{}', 0, 0, 5, 5, 0, 1);
            insertWidget.run('widget_metrics', 'scene_factory_overview', 'metrics', '生产指标', JSON.stringify({ compact: true }), '{}', 0, 5, 5, 5, 1, 1);
            insertWidget.run('widget_trend', 'scene_factory_overview', 'trend', '历史趋势', JSON.stringify({ metric: 'avg_temp' }), '{}', 19, 0, 5, 5, 2, 1);
            insertWidget.run('widget_alarms', 'scene_factory_overview', 'alarm_list', '报警履历', JSON.stringify({ limit: 5 }), '{}', 19, 5, 5, 5, 3, 1);
            insertWidget.run('widget_marquee', 'scene_factory_overview', 'marquee', '实时日志', JSON.stringify({ speed: 30 }), '{}', 3, 11, 18, 1, 4, 1);
        });
        seedWidgets();
    }

    const releaseCount = db.prepare('SELECT COUNT(*) as cnt FROM releases').get();
    if (releaseCount.cnt === 0) {
        db.prepare('INSERT INTO releases (id, project_id, version, snapshot_json, is_current) VALUES (?, ?, ?, ?, ?)')
            .run('release_default_v1', 'project_default', '1.0.0', JSON.stringify({ scene_id: 'scene_factory_overview' }), 1);
    }
}

module.exports = { getDb };
