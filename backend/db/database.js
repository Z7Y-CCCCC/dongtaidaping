const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'database-config.json');

const DEFAULT_CONFIG = {
    type: 'mysql',
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'root',
    database: 'dongtai_daping',
    filename: path.join(DATA_DIR, 'factory.db'),
    encrypt: false,
    trustServerCertificate: true
};

let pool;
let sqliteDb;
let activeConfig;
let initPromise;
let lastInitError = null;
let mysqlDriver;
let pgDriver;
let sqlserverDriver;
let sqliteDriver;

function getMysql() {
    if (!mysqlDriver) mysqlDriver = require('mysql2/promise');
    return mysqlDriver;
}

function getPgPool() {
    if (!pgDriver) pgDriver = require('pg').Pool;
    return pgDriver;
}

function getSqlServer() {
    if (!sqlserverDriver) sqlserverDriver = require('mssql');
    return sqlserverDriver;
}

function getSqliteDatabase() {
    if (!sqliteDriver) sqliteDriver = require('better-sqlite3');
    return sqliteDriver;
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStoredConfig() {
    ensureDataDir();
    if (!fs.existsSync(CONFIG_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.warn('[DB] database-config.json 读取失败，使用默认配置:', e.message);
        return {};
    }
}

function loadDatabaseConfig() {
    const stored = readStoredConfig();
    const merged = { ...DEFAULT_CONFIG, ...stored };
    if (process.env.DB_TYPE) merged.type = process.env.DB_TYPE;
    if (process.env.MYSQL_HOST || process.env.DB_HOST) merged.host = process.env.MYSQL_HOST || process.env.DB_HOST;
    if (process.env.MYSQL_PORT || process.env.DB_PORT) merged.port = Number(process.env.MYSQL_PORT || process.env.DB_PORT);
    if (process.env.MYSQL_USER || process.env.DB_USER) merged.user = process.env.MYSQL_USER || process.env.DB_USER;
    if (process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD) merged.password = process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD;
    if (process.env.MYSQL_DATABASE || process.env.DB_NAME) merged.database = process.env.MYSQL_DATABASE || process.env.DB_NAME;
    if (process.env.SQLITE_FILE) merged.filename = process.env.SQLITE_FILE;
    return normalizeConfig(merged);
}

function normalizeConfig(config) {
    const type = String(config.type || 'mysql').toLowerCase();
    const port = Number(config.port || defaultPort(type));
    return {
        ...config,
        type,
        port: Number.isFinite(port) ? port : defaultPort(type),
        database: config.database || DEFAULT_CONFIG.database,
        filename: config.filename || DEFAULT_CONFIG.filename,
        encrypt: !!config.encrypt,
        trustServerCertificate: config.trustServerCertificate !== false
    };
}

function defaultPort(type) {
    if (type === 'postgres' || type === 'postgresql') return 5432;
    if (type === 'sqlserver' || type === 'mssql') return 1433;
    if (type === 'mysql' || type === 'mariadb') return 3307;
    return 0;
}

function publicDatabaseConfig(config = loadDatabaseConfig()) {
    const normalized = normalizeConfig(config);
    return {
        ...normalized,
        password: normalized.password ? '******' : ''
    };
}

function saveDatabaseConfig(input) {
    ensureDataDir();
    const current = loadDatabaseConfig();
    const next = normalizeConfig({
        ...current,
        ...input,
        password: input.password === '******' ? current.password : (input.password ?? current.password)
    });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return publicDatabaseConfig(next);
}

function dialectName(config = activeConfig || loadDatabaseConfig()) {
    const type = String(config.type || 'mysql').toLowerCase();
    if (type === 'postgresql') return 'postgres';
    if (type === 'mssql') return 'sqlserver';
    if (type === 'mariadb') return 'mysql';
    return type;
}

function quoteIdentifier(name, config = activeConfig || loadDatabaseConfig()) {
    const dialect = dialectName(config);
    const value = String(name);
    if (dialect === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
    if (dialect === 'sqlserver') return '[' + value.replace(/]/g, ']]') + ']';
    return `"${value.replace(/"/g, '""')}"`;
}

function tableName(name) {
    return quoteIdentifier(name);
}

function normalizeSql(sql, params = []) {
    const dialect = dialectName();
    let text = sql.replace(/`([^`]+)`/g, (_, name) => quoteIdentifier(name));

    if (dialect === 'postgres') {
        let idx = 0;
        text = text.replace(/\?/g, () => `$${++idx}`);
    } else if (dialect === 'sqlserver') {
        text = normalizeSqlServerLimit(text);
        let idx = 0;
        text = text.replace(/\?/g, () => `@p${++idx}`);
    }

    return { text, params };
}

function normalizeSqlServerLimit(text) {
    const limitMatch = text.match(/\s+LIMIT\s+(\d+)\s*$/i);
    if (!limitMatch) return text;
    const limit = limitMatch[1];
    const withoutLimit = text.replace(/\s+LIMIT\s+\d+\s*$/i, '');
    return withoutLimit.replace(/^SELECT\s+/i, `SELECT TOP ${limit} `);
}

async function createDatabaseIfNeeded(config) {
    const dialect = dialectName(config);
    if (dialect === 'sqlite') return;

    if (dialect === 'mysql') {
        const mysql = getMysql();
        const connection = await mysql.createConnection({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            multipleStatements: false
        });
        try {
            await connection.query(
                `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(config.database, config)}
                 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
        } finally {
            await connection.end();
        }
        return;
    }

    if (dialect === 'postgres') {
        const PgPool = getPgPool();
        const adminPool = new PgPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.adminDatabase || 'postgres'
        });
        try {
            const result = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.database]);
            if (result.rowCount === 0) {
                await adminPool.query(`CREATE DATABASE ${quoteIdentifier(config.database, config)} ENCODING 'UTF8'`);
            }
        } finally {
            await adminPool.end();
        }
        return;
    }

    if (dialect === 'sqlserver') {
        const sqlserver = getSqlServer();
        const connection = await sqlserver.connect(sqlServerConnectionConfig(config, 'master'));
        try {
            await connection.request().query(
                `IF DB_ID(N'${String(config.database).replace(/'/g, "''")}') IS NULL CREATE DATABASE ${quoteIdentifier(config.database, config)}`
            );
        } finally {
            await connection.close();
        }
    }
}

function sqlServerConnectionConfig(config, database = config.database) {
    return {
        server: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database,
        options: {
            encrypt: !!config.encrypt,
            trustServerCertificate: config.trustServerCertificate !== false
        }
    };
}

async function initDb() {
    activeConfig = loadDatabaseConfig();
    await createDatabaseIfNeeded(activeConfig);

    const dialect = dialectName(activeConfig);
    if (dialect === 'mysql') {
        const mysql = getMysql();
        pool = mysql.createPool({
            host: activeConfig.host,
            port: activeConfig.port,
            user: activeConfig.user,
            password: activeConfig.password,
            database: activeConfig.database,
            waitForConnections: true,
            connectionLimit: Number(activeConfig.connectionLimit || 10),
            queueLimit: 0,
            charset: 'utf8mb4'
        });
        await pool.query('SET time_zone = "+08:00"');
    } else if (dialect === 'postgres') {
        const PgPool = getPgPool();
        pool = new PgPool({
            host: activeConfig.host,
            port: activeConfig.port,
            user: activeConfig.user,
            password: activeConfig.password,
            database: activeConfig.database,
            max: Number(activeConfig.connectionLimit || 10)
        });
    } else if (dialect === 'sqlserver') {
        const sqlserver = getSqlServer();
        pool = await sqlserver.connect(sqlServerConnectionConfig(activeConfig));
    } else if (dialect === 'sqlite') {
        const Database = getSqliteDatabase();
        ensureDataDir();
        sqliteDb = new Database(activeConfig.filename || DEFAULT_CONFIG.filename);
        sqliteDb.pragma('journal_mode = WAL');
        sqliteDb.pragma('foreign_keys = ON');
    } else {
        throw new Error(`不支持的数据库类型: ${activeConfig.type}`);
    }

    await initTables();
    await seedDefaults();
    lastInitError = null;
}

async function getDb() {
    if (!initPromise) {
        initPromise = initDb().catch((error) => {
            lastInitError = error;
            initPromise = null;
            console.error('[DB] 初始化失败:', error.message);
            throw error;
        });
    }
    await initPromise;
    return makeDbClient();
}

function getDbStatus() {
    return {
        type: dialectName(activeConfig || loadDatabaseConfig()),
        config: publicDatabaseConfig(activeConfig || loadDatabaseConfig()),
        connected: !!(pool || sqliteDb) && !lastInitError,
        error: lastInitError ? lastInitError.message : null
    };
}

async function closeDb() {
    if (pool) {
        const dialect = dialectName();
        if (dialect === 'mysql') await pool.end();
        if (dialect === 'postgres') await pool.end();
        if (dialect === 'sqlserver') await pool.close();
        pool = null;
    }
    if (sqliteDb) {
        sqliteDb.close();
        sqliteDb = null;
    }
    initPromise = null;
}

async function reconnectDb() {
    await closeDb();
    return getDb();
}

async function testDatabaseConfig(input) {
    const config = normalizeConfig({
        ...loadDatabaseConfig(),
        ...input,
        password: input.password === '******' ? loadDatabaseConfig().password : (input.password ?? loadDatabaseConfig().password)
    });
    await createDatabaseIfNeeded(config);
    const dialect = dialectName(config);

    if (dialect === 'mysql') {
        const mysql = getMysql();
        const connection = await mysql.createConnection({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database
        });
        await connection.query('SELECT 1');
        await connection.end();
        return true;
    }
    if (dialect === 'postgres') {
        const PgPool = getPgPool();
        const testPool = new PgPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database
        });
        await testPool.query('SELECT 1');
        await testPool.end();
        return true;
    }
    if (dialect === 'sqlserver') {
        const sqlserver = getSqlServer();
        const connection = await sqlserver.connect(sqlServerConnectionConfig(config));
        await connection.request().query('SELECT 1 AS ok');
        await connection.close();
        return true;
    }
    if (dialect === 'sqlite') {
        const Database = getSqliteDatabase();
        ensureDataDir();
        const db = new Database(config.filename || DEFAULT_CONFIG.filename);
        db.prepare('SELECT 1').get();
        db.close();
        return true;
    }
    throw new Error(`不支持的数据库类型: ${config.type}`);
}

function makeDbClient() {
    return {
        all: executeAll,
        get: executeGet,
        run: executeRun,
        transaction,
        insertIgnore: (table, data, key) => insertIgnoreWithClient(makeDbClient(), table, data, key),
        upsert: (table, data, key) => upsertWithClient(makeDbClient(), table, data, key),
        q: quoteIdentifier
    };
}

async function executeAll(sql, params = []) {
    const dialect = dialectName();
    const normalized = normalizeSql(sql, params);
    if (dialect === 'mysql') {
        const [rows] = await pool.execute(normalized.text, normalized.params);
        return rows;
    }
    if (dialect === 'postgres') {
        const result = await pool.query(normalized.text, normalized.params);
        return result.rows;
    }
    if (dialect === 'sqlserver') {
        const request = pool.request();
        normalized.params.forEach((value, index) => request.input(`p${index + 1}`, value));
        const result = await request.query(normalized.text);
        return result.recordset || [];
    }
    return sqliteDb.prepare(normalized.text).all(normalized.params);
}

async function executeGet(sql, params = []) {
    const rows = await executeAll(sql, params);
    return rows[0] || null;
}

async function executeRun(sql, params = []) {
    const dialect = dialectName();
    const normalized = normalizeSql(sql, params);
    if (dialect === 'mysql') {
        const [result] = await pool.execute(normalized.text, normalized.params);
        return normalizeRunResult(result);
    }
    if (dialect === 'postgres') {
        const result = await pool.query(normalized.text, normalized.params);
        return { lastInsertRowid: null, insertId: null, changes: result.rowCount, affectedRows: result.rowCount };
    }
    if (dialect === 'sqlserver') {
        const request = pool.request();
        normalized.params.forEach((value, index) => request.input(`p${index + 1}`, value));
        const result = await request.query(normalized.text);
        const rowsAffected = result.rowsAffected?.[0] || 0;
        return { lastInsertRowid: null, insertId: null, changes: rowsAffected, affectedRows: rowsAffected };
    }
    const result = sqliteDb.prepare(normalized.text).run(normalized.params);
    return { lastInsertRowid: result.lastInsertRowid, insertId: result.lastInsertRowid, changes: result.changes, affectedRows: result.changes };
}

function normalizeRunResult(result) {
    return {
        lastInsertRowid: result.insertId,
        insertId: result.insertId,
        changes: result.affectedRows,
        affectedRows: result.affectedRows
    };
}

async function transaction(callback) {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const tx = makeConnectionClient(connection);
            const result = await callback(tx);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
    if (dialect === 'postgres') {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const tx = makeConnectionClient(client);
            const result = await callback(tx);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    if (dialect === 'sqlite') {
        sqliteDb.prepare('BEGIN').run();
        try {
            const result = await callback(makeDbClient());
            sqliteDb.prepare('COMMIT').run();
            return result;
        } catch (error) {
            sqliteDb.prepare('ROLLBACK').run();
            throw error;
        }
    }
    const sqlserver = getSqlServer();
    const tx = new sqlserver.Transaction(pool);
    await tx.begin();
    try {
        const result = await callback(makeSqlServerTransactionClient(tx));
        await tx.commit();
        return result;
    } catch (error) {
        await tx.rollback();
        throw error;
    }
}

function makeConnectionClient(connection) {
    const client = {
        async all(sql, params = []) {
            const dialect = dialectName();
            const normalized = normalizeSql(sql, params);
            if (dialect === 'mysql') {
                const [rows] = await connection.execute(normalized.text, normalized.params);
                return rows;
            }
            const result = await connection.query(normalized.text, normalized.params);
            return result.rows;
        },
        async get(sql, params = []) {
            const rows = await this.all(sql, params);
            return rows[0] || null;
        },
        async run(sql, params = []) {
            const dialect = dialectName();
            const normalized = normalizeSql(sql, params);
            if (dialect === 'mysql') {
                const [result] = await connection.execute(normalized.text, normalized.params);
                return normalizeRunResult(result);
            }
            const result = await connection.query(normalized.text, normalized.params);
            return { lastInsertRowid: null, insertId: null, changes: result.rowCount, affectedRows: result.rowCount };
        },
        q: quoteIdentifier
    };
    client.insertIgnore = (table, data, key) => insertIgnoreWithClient(client, table, data, key);
    client.upsert = (table, data, key) => upsertWithClient(client, table, data, key);
    return client;
}

function makeSqlServerTransactionClient(tx) {
    const client = {
        all: (sql, params = []) => executeSqlServerInTransaction(tx, sql, params, true),
        get: async (sql, params = []) => (await executeSqlServerInTransaction(tx, sql, params, true))[0] || null,
        run: (sql, params = []) => executeSqlServerInTransaction(tx, sql, params, false),
        q: quoteIdentifier
    };
    client.insertIgnore = (table, data, key) => insertIgnoreWithClient(client, table, data, key);
    client.upsert = (table, data, key) => upsertWithClient(client, table, data, key);
    return client;
}

async function executeSqlServerInTransaction(tx, sql, params, returnRows) {
    const normalized = normalizeSql(sql, params);
    const sqlserver = getSqlServer();
    const request = new sqlserver.Request(tx);
    normalized.params.forEach((value, index) => request.input(`p${index + 1}`, value));
    const result = await request.query(normalized.text);
    if (returnRows) return result.recordset || [];
    const rowsAffected = result.rowsAffected?.[0] || 0;
    return { lastInsertRowid: null, insertId: null, changes: rowsAffected, affectedRows: rowsAffected };
}

async function insertIgnore(table, data, key) {
    return insertIgnoreWithClient(makeDbClient(), table, data, key);
}

async function insertIgnoreWithClient(client, table, data, key) {
    const existing = await client.get(`SELECT * FROM ${tableName(table)} WHERE ${quoteIdentifier(key)} = ?`, [data[key]]);
    if (existing) return { changes: 0, affectedRows: 0 };
    return insertRowWithClient(client, table, data);
}

async function upsert(table, data, key) {
    return upsertWithClient(makeDbClient(), table, data, key);
}

async function upsertWithClient(client, table, data, key) {
    const existing = await client.get(`SELECT * FROM ${tableName(table)} WHERE ${quoteIdentifier(key)} = ?`, [data[key]]);
    if (!existing) return insertRowWithClient(client, table, data);
    const columns = Object.keys(data).filter(column => column !== key);
    const assignments = columns.map(column => `${quoteIdentifier(column)} = ?`).join(', ');
    return client.run(
        `UPDATE ${tableName(table)} SET ${assignments} WHERE ${quoteIdentifier(key)} = ?`,
        [...columns.map(column => data[column]), data[key]]
    );
}

async function insertRow(table, data) {
    return insertRowWithClient(makeDbClient(), table, data);
}

async function insertRowWithClient(client, table, data) {
    const columns = Object.keys(data);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${tableName(table)} (${columns.map(column => quoteIdentifier(column)).join(', ')}) VALUES (${placeholders})`;
    return client.run(sql, columns.map(column => data[column]));
}

function schemaTypes() {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        return {
            text: 'TEXT',
            string: n => `VARCHAR(${n})`,
            int: 'INT',
            bool: 'TINYINT',
            double: 'DOUBLE',
            datetime: 'DATETIME',
            json: 'JSON',
            autoId: 'INT AUTO_INCREMENT PRIMARY KEY',
            options: 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        };
    }
    if (dialect === 'postgres') {
        return {
            text: 'TEXT',
            string: n => `VARCHAR(${n})`,
            int: 'INTEGER',
            bool: 'SMALLINT',
            double: 'DOUBLE PRECISION',
            datetime: 'TIMESTAMP',
            json: 'JSONB',
            autoId: 'SERIAL PRIMARY KEY',
            options: ''
        };
    }
    if (dialect === 'sqlserver') {
        return {
            text: 'NVARCHAR(MAX)',
            string: n => `NVARCHAR(${n})`,
            int: 'INT',
            bool: 'TINYINT',
            double: 'FLOAT',
            datetime: 'DATETIME',
            json: 'NVARCHAR(MAX)',
            autoId: 'INT IDENTITY(1,1) PRIMARY KEY',
            options: ''
        };
    }
    return {
        text: 'TEXT',
        string: n => `TEXT`,
        int: 'INTEGER',
        bool: 'INTEGER',
        double: 'REAL',
        datetime: 'DATETIME',
        json: 'TEXT',
        autoId: 'INTEGER PRIMARY KEY AUTOINCREMENT',
        options: ''
    };
}

async function createTable(name, bodySql) {
    const dialect = dialectName();
    const suffix = schemaTypes().options;
    if (dialect === 'sqlserver') {
        await rawQuery(`IF OBJECT_ID(N'${name}', N'U') IS NULL BEGIN CREATE TABLE ${tableName(name)} (${bodySql}) END`);
        return;
    }
    await rawQuery(`CREATE TABLE IF NOT EXISTS ${tableName(name)} (${bodySql}) ${suffix}`);
}

async function columnExists(table, column) {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
            [activeConfig.database, table, column]
        );
        return rows[0].cnt > 0;
    }
    if (dialect === 'postgres') {
        const result = await pool.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
            [table, column]
        );
        return result.rowCount > 0;
    }
    if (dialect === 'sqlserver') {
        const result = await pool.request().query(
            `SELECT 1 FROM sys.columns
             WHERE object_id = OBJECT_ID(N'${table}') AND name = N'${column}'`
        );
        return result.recordset.length > 0;
    }
    const rows = sqliteDb.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    return rows.some(row => row.name === column);
}

async function ensureColumn(table, column, definitionSql) {
    if (await columnExists(table, column)) return;
    await rawQuery(`ALTER TABLE ${tableName(table)} ADD ${quoteIdentifier(column)} ${definitionSql}`);
}

async function ensureSchemaColumns() {
    const t = schemaTypes();

    await ensureColumn('devices', 'plc_enabled', `${t.bool} DEFAULT 0`);
    await ensureColumn('devices', 'plc_protocol', `${t.string(32)} DEFAULT 'S7'`);
    await ensureColumn('devices', 'plc_ip', `${t.string(128)} DEFAULT ''`);
    await ensureColumn('devices', 'plc_port', `${t.int} DEFAULT 102`);
    await ensureColumn('devices', 'plc_rack', `${t.int} DEFAULT 0`);
    await ensureColumn('devices', 'plc_slot', `${t.int} DEFAULT 1`);
    await ensureColumn('devices', 'plc_timeout', `${t.int} DEFAULT 5000`);
    await ensureColumn('devices', 'plc_retry_interval', `${t.int} DEFAULT 10000`);
    await ensureColumn('devices', 'plc_max_retries', `${t.int} DEFAULT 0`);

    await ensureColumn('data_points', 'sample_interval_ms', `${t.int} DEFAULT 1000`);
    await ensureColumn('data_points', 'access_type', `${t.string(32)} DEFAULT 'READ'`);
    await ensureColumn('data_points', 'db_number', `${t.int} NULL`);
    await ensureColumn('data_points', 'db_byte_offset', `${t.int} NULL`);
    await ensureColumn('data_points', 'bit_offset', `${t.int} NULL`);
}

async function rawQuery(sql) {
    const dialect = dialectName();
    if (dialect === 'mysql') return pool.query(sql);
    if (dialect === 'postgres') return pool.query(sql);
    if (dialect === 'sqlserver') return pool.request().query(sql);
    return sqliteDb.exec(sql);
}

async function initTables() {
    const t = schemaTypes();
    await createTable('workshops', `
        id ${t.string(64)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        sort_order ${t.int} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('lines', `
        id ${t.string(64)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        workshop_id ${t.string(64)},
        sort_order ${t.int} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('devices', `
        id ${t.string(64)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        line_id ${t.string(64)},
        model_type ${t.string(128)} DEFAULT 'builtin_furnace',
        model_file ${t.text},
        template_id ${t.string(128)} DEFAULT '',
        instance_config ${t.json},
        pos_x ${t.double} DEFAULT 0,
        pos_y ${t.double} DEFAULT 0,
        pos_z ${t.double} DEFAULT 0,
        rotation_y ${t.double} DEFAULT 0,
        scale ${t.double} DEFAULT 1,
        sort_order ${t.int} DEFAULT 0,
        plc_enabled ${t.bool} DEFAULT 0,
        plc_protocol ${t.string(32)} DEFAULT 'S7',
        plc_ip ${t.string(128)} DEFAULT '',
        plc_port ${t.int} DEFAULT 102,
        plc_rack ${t.int} DEFAULT 0,
        plc_slot ${t.int} DEFAULT 1,
        plc_timeout ${t.int} DEFAULT 5000,
        plc_retry_interval ${t.int} DEFAULT 10000,
        plc_max_retries ${t.int} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('data_points', `
        id ${t.autoId},
        device_id ${t.string(64)},
        name ${t.string(128)} NOT NULL,
        label ${t.string(255)} NOT NULL,
        plc_tag ${t.string(255)} NOT NULL,
        data_type ${t.string(32)} DEFAULT 'WORD',
        category ${t.string(64)} DEFAULT '',
        value_role ${t.string(128)} DEFAULT '',
        quality ${t.string(32)} DEFAULT 'good',
        scale ${t.double} DEFAULT 1,
        offset ${t.double} DEFAULT 0,
        expression ${t.text},
        display_format ${t.string(64)} DEFAULT '',
        unit ${t.string(32)} DEFAULT '',
        sample_interval_ms ${t.int} DEFAULT 1000,
        access_type ${t.string(32)} DEFAULT 'READ',
        db_number ${t.int} NULL,
        db_byte_offset ${t.int} NULL,
        bit_offset ${t.int} NULL,
        alarm_high ${t.double} NULL,
        alarm_low ${t.double} NULL
    `);
    await createTable('models', `
        id ${t.string(128)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        file_path ${t.text} NOT NULL,
        asset_type ${t.string(64)} DEFAULT 'model',
        tags ${t.json},
        thumbnail ${t.text},
        default_scale ${t.double} DEFAULT 1,
        metadata ${t.json},
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('projects', `
        id ${t.string(128)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        description ${t.text},
        is_active ${t.bool} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        updated_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('scenes', `
        id ${t.string(128)} PRIMARY KEY,
        project_id ${t.string(128)},
        name ${t.string(255)} NOT NULL,
        scene_type ${t.string(64)} DEFAULT 'factory_overview',
        layout_json ${t.json},
        camera_json ${t.json},
        theme_json ${t.json},
        is_active ${t.bool} DEFAULT 0,
        sort_order ${t.int} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        updated_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('device_templates', `
        id ${t.string(128)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        model_type ${t.string(128)} DEFAULT 'builtin_furnace',
        default_config ${t.json},
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('datapoint_templates', `
        id ${t.string(128)} PRIMARY KEY,
        device_template_id ${t.string(128)},
        name ${t.string(128)} NOT NULL,
        label ${t.string(255)} NOT NULL,
        category ${t.string(64)} DEFAULT '',
        value_role ${t.string(128)} DEFAULT '',
        data_type ${t.string(32)} DEFAULT 'WORD',
        unit ${t.string(32)} DEFAULT '',
        scale ${t.double} DEFAULT 1,
        offset ${t.double} DEFAULT 0,
        expression ${t.text},
        display_format ${t.string(64)} DEFAULT '',
        sort_order ${t.int} DEFAULT 0
    `);
    await createTable('widgets', `
        id ${t.string(128)} PRIMARY KEY,
        scene_id ${t.string(128)},
        widget_type ${t.string(64)} NOT NULL,
        title ${t.string(255)} DEFAULT '',
        config_json ${t.json},
        binding_json ${t.json},
        x ${t.double} DEFAULT 0,
        y ${t.double} DEFAULT 0,
        w ${t.double} DEFAULT 1,
        h ${t.double} DEFAULT 1,
        sort_order ${t.int} DEFAULT 0,
        visible ${t.bool} DEFAULT 1
    `);
    await createTable('bindings', `
        id ${t.string(128)} PRIMARY KEY,
        widget_id ${t.string(128)},
        source_type ${t.string(64)} DEFAULT 'device',
        source_id ${t.string(128)} DEFAULT '',
        path ${t.string(255)} DEFAULT '',
        transform ${t.text},
        fallback ${t.text}
    `);
    await createTable('releases', `
        id ${t.string(128)} PRIMARY KEY,
        project_id ${t.string(128)},
        version ${t.string(64)} NOT NULL,
        snapshot_json ${t.json},
        is_current ${t.bool} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('event_logs', `
        id ${t.autoId},
        event_type ${t.string(64)} DEFAULT 'alarm',
        level ${t.string(32)} DEFAULT 'info',
        source_id ${t.string(128)} DEFAULT '',
        title ${t.string(255)} NOT NULL,
        message ${t.text},
        value ${t.text},
        quality ${t.string(32)} DEFAULT 'good',
        occurred_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        acknowledged ${t.bool} DEFAULT 0
    `);
    await createTable('metric_snapshots', `
        id ${t.autoId},
        snapshot_time ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        current_output ${t.int} DEFAULT 0,
        daily_target ${t.int} DEFAULT 0,
        overall_oee ${t.double} DEFAULT 0,
        energy_consumption ${t.double} DEFAULT 0,
        running_devices ${t.int} DEFAULT 0,
        alarm_devices ${t.int} DEFAULT 0,
        online_devices ${t.int} DEFAULT 0,
        total_devices ${t.int} DEFAULT 0
    `);
    await createTable('settings', `
        ${quoteIdentifier('key')} ${t.string(128)} PRIMARY KEY,
        value ${t.text} NOT NULL
    `);

    await ensureSchemaColumns();

    await createIndex('idx_lines_workshop', 'lines', `${quoteIdentifier('workshop_id')}, ${quoteIdentifier('sort_order')}`);
    await createIndex('idx_devices_line', 'devices', `${quoteIdentifier('line_id')}, ${quoteIdentifier('sort_order')}`);
    await createIndex('idx_data_points_device', 'data_points', quoteIdentifier('device_id'));
    await createIndex('idx_widgets_scene', 'widgets', `${quoteIdentifier('scene_id')}, ${quoteIdentifier('sort_order')}`);
    await createIndex('idx_event_logs_time', 'event_logs', `${quoteIdentifier('occurred_at')} DESC, ${quoteIdentifier('id')} DESC`);
    await createIndex('idx_metric_snapshots_time', 'metric_snapshots', `${quoteIdentifier('snapshot_time')} DESC, ${quoteIdentifier('id')} DESC`);
}

async function createIndex(indexName, table, columnsSql) {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?`,
            [activeConfig.database, table, indexName]
        );
        if (rows[0].cnt > 0) return;
    } else if (dialect === 'postgres') {
        const result = await pool.query('SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1', [indexName]);
        if (result.rowCount > 0) return;
    } else if (dialect === 'sqlserver') {
        const result = await pool.request().query(
            `SELECT 1 FROM sys.indexes WHERE name = N'${indexName}' AND object_id = OBJECT_ID(N'${table}')`
        );
        if (result.recordset.length > 0) return;
    } else {
        const row = sqliteDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName);
        if (row) return;
    }
    await rawQuery(`CREATE INDEX ${quoteIdentifier(indexName)} ON ${tableName(table)} (${columnsSql})`);
}

async function seedDefaults() {
    const db = makeDbClient();
    const rows = [
        ['factory_name', '智能热处理数字孪生控制中心'],
        ['data_mode', 'integrated_plc'],
        ['simulation_interval_ms', '2000'],
        ['realtime_stale_ms', '6000'],
        ['display_mode', 'industrial_twin']
    ];
    for (const [key, value] of rows) {
        await db.insertIgnore('settings', { key, value }, 'key');
    }

    await seedModelAssets(db);
    await seedFactoryDefaults(db);
    await seedPlatformDefaults(db);
}

async function seedFactoryDefaults(db) {
    const workshopsCount = await db.get('SELECT COUNT(*) AS cnt FROM workshops');
    if (workshopsCount.cnt === 0) {
        await db.insertIgnore('workshops', { id: 'ws_1', name: '默认车间 1', sort_order: 0 }, 'id');
    }

    const linesCount = await db.get('SELECT COUNT(*) AS cnt FROM `lines`');
    if (linesCount.cnt > 0) return;

    const lineNames = ['A 产线', 'B 产线', 'C 产线', 'D 产线'];
    for (let li = 0; li < lineNames.length; li++) {
        const lineId = `line_${String.fromCharCode(97 + li)}`;
        await db.insertIgnore('lines', { id: lineId, name: lineNames[li], workshop_id: 'ws_1', sort_order: li }, 'id');

        for (let di = 0; di < 5; di++) {
            const globalIdx = li * 5 + di;
            await db.insertIgnore('devices', {
                id: `Furnace_${String(globalIdx + 1).padStart(2, '0')}`,
                name: `${globalIdx + 1}# 多用炉`,
                line_id: lineId,
                model_type: 'box_atmosphere_furnace',
                model_file: null,
                template_id: '',
                instance_config: '{}',
                pos_x: (di - 2) * 14,
                pos_y: 0,
                pos_z: -li * 16,
                rotation_y: 0,
                scale: 1,
                sort_order: di
            }, 'id');
        }
    }
}

async function seedModelAssets(db) {
    await db.insertIgnore('models', {
        id: 'box_atmosphere_furnace',
        name: '箱式气氛多用炉低模',
        file_path: '/assets/models/box_atmosphere_furnace.glb',
        asset_type: 'model',
        tags: JSON.stringify(['heat_treatment', 'atmosphere_furnace', 'low_poly']),
        thumbnail: null,
        default_scale: 1,
        metadata: JSON.stringify({
            source: 'generated',
            polygonProfile: 'low_poly',
            intendedUse: 'realtime_dashboard',
            batchable: true
        })
    }, 'id');
}

async function seedPlatformDefaults(db) {
    const projectCount = await db.get('SELECT COUNT(*) AS cnt FROM projects');
    if (projectCount.cnt === 0) {
        await db.insertIgnore('projects', {
            id: 'project_default',
            name: '热处理车间大屏项目',
            description: '默认项目，可在现场编排器中继续扩展。',
            is_active: 1
        }, 'id');
    }

    const sceneCount = await db.get('SELECT COUNT(*) AS cnt FROM scenes');
    if (sceneCount.cnt === 0) {
        await db.insertIgnore('scenes', {
            id: 'scene_factory_overview',
            project_id: 'project_default',
            name: '工厂总览',
            scene_type: 'factory_overview',
            layout_json: JSON.stringify({ grid: { columns: 24, rows: 12 }, panels: ['navigation', 'metrics', 'trend', 'alarms', 'marquee'] }),
            camera_json: JSON.stringify({ mode: 'auto', staleMs: 6000 }),
            theme_json: JSON.stringify({ preset: 'industrial_twin' }),
            is_active: 1,
            sort_order: 0
        }, 'id');
    }

    const templateCount = await db.get('SELECT COUNT(*) AS cnt FROM device_templates');
    if (templateCount.cnt === 0) {
        await db.insertIgnore('device_templates', {
            id: 'tpl_multipurpose_furnace',
            name: '多用炉模板',
            model_type: 'box_atmosphere_furnace',
            default_config: JSON.stringify({ category: 'furnace', realtimeProfile: 'heat_treatment' })
        }, 'id');
    }

    const widgetCount = await db.get('SELECT COUNT(*) AS cnt FROM widgets');
    if (widgetCount.cnt === 0) {
        const widgets = [
            ['widget_navigation', 'navigation', '层级导航', '{}', '{}', 0, 0, 5, 5, 0],
            ['widget_metrics', 'metrics', '生产指标', JSON.stringify({ compact: true }), '{}', 0, 5, 5, 5, 1],
            ['widget_trend', 'trend', '历史趋势', JSON.stringify({ metric: 'avg_temp' }), '{}', 19, 0, 5, 5, 2],
            ['widget_alarms', 'alarm_list', '报警履历', JSON.stringify({ limit: 5 }), '{}', 19, 5, 5, 5, 3],
            ['widget_marquee', 'marquee', '实时日志', JSON.stringify({ speed: 30 }), '{}', 3, 11, 18, 1, 4]
        ];
        for (const [id, widget_type, title, config_json, binding_json, x, y, w, h, sort_order] of widgets) {
            await db.insertIgnore('widgets', {
                id,
                scene_id: 'scene_factory_overview',
                widget_type,
                title,
                config_json,
                binding_json,
                x,
                y,
                w,
                h,
                sort_order,
                visible: 1
            }, 'id');
        }
    }

    const releaseCount = await db.get('SELECT COUNT(*) AS cnt FROM releases');
    if (releaseCount.cnt === 0) {
        await db.insertIgnore('releases', {
            id: 'release_default_v1',
            project_id: 'project_default',
            version: '1.0.0',
            snapshot_json: JSON.stringify({ scene_id: 'scene_factory_overview' }),
            is_current: 1
        }, 'id');
    }
}

module.exports = {
    getDb,
    closeDb,
    reconnectDb,
    getDbStatus,
    loadDatabaseConfig,
    saveDatabaseConfig,
    publicDatabaseConfig,
    testDatabaseConfig
};
