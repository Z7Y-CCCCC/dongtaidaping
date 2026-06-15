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
            scale REAL DEFAULT 1,
            offset REAL DEFAULT 0,
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
            thumbnail TEXT,
            default_scale REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 全局设置
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    ensureColumn('lines', 'workshop_id', 'TEXT REFERENCES workshops(id) ON DELETE CASCADE');
    ensureColumn('data_points', 'category', "TEXT DEFAULT ''");
    ensureColumn('data_points', 'value_role', "TEXT DEFAULT ''");
    ensureColumn('data_points', 'scale', 'REAL DEFAULT 1');
    ensureColumn('data_points', 'offset', 'REAL DEFAULT 0');
    ensureColumn('data_points', 'display_format', "TEXT DEFAULT ''");
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
}

module.exports = { getDb };
