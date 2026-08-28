const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heat-treatment-spatial-test-'));
const databaseFile = path.join(temporaryRoot, 'legacy.db');

function closeEnough(actual, expected, message) {
    assert.ok(Math.abs(Number(actual) - Number(expected)) < 0.0001, `${message}: ${actual} != ${expected}`);
}

function createLegacyDatabase() {
    const sqlite = new Database(databaseFile);
    sqlite.exec(`
        CREATE TABLE workshops (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE lines (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            workshop_id TEXT,
            layout_json TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE devices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            line_id TEXT,
            model_type TEXT DEFAULT 'builtin_furnace',
            model_file TEXT,
            template_id TEXT DEFAULT '',
            instance_config TEXT,
            pos_x REAL DEFAULT 0,
            pos_y REAL DEFAULT 0,
            pos_z REAL DEFAULT 0,
            rotation_y REAL DEFAULT 0,
            scale REAL DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
    sqlite.prepare('INSERT INTO workshops (id, name, sort_order) VALUES (?, ?, ?)')
        .run('ws_1', '迁移测试车间', 0);
    sqlite.prepare('INSERT INTO lines (id, name, workshop_id, layout_json, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run('line_a', 'A 产线', 'ws_1', JSON.stringify({
            version: 1,
            flowDirection: 'right',
            lanes: [
                { id: 'lane_1', name: '设备线 1', offsetZ: -10.5, length: 60, sort_order: 0 },
                { id: 'lane_2', name: '设备线 2', offsetZ: 11.5, length: 60, sort_order: 1 }
            ],
            rails: [{ id: 'rail_1', name: '小车导轨 1', offsetZ: 0.5, length: 60, sort_order: 0 }]
        }), 0);
    const insertDevice = sqlite.prepare(`INSERT INTO devices
        (id, name, line_id, model_type, instance_config, pos_x, pos_y, pos_z, rotation_y, scale, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertDevice.run(
        'furnace_1', '1# 多用炉', 'line_a', 'builtin_furnace',
        JSON.stringify({ laneLineId: 'line_a', laneId: 'lane_1' }),
        19.5, 0, -10.5, 1.5708, 1, 0
    );
    insertDevice.run(
        'cart_1', '料车', null, 'transfer_cart',
        JSON.stringify({ role: 'transfer_cart', workshop_id: 'ws_1', railLineId: 'line_a', railId: 'rail_1' }),
        -22.5, 0, 0.5, 0, 1, 1
    );
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'native_environment_config',
        JSON.stringify({
            version: 2,
            showWalls: true,
            walls: [{
                id: 'wall_1', name: '旧世界坐标墙', enabled: true,
                x: 10, baseY: 0, z: 20, length: 30, height: 6, thickness: 0.3, rotationY: 30
            }]
        })
    );
    sqlite.close();
}

async function run() {
    createLegacyDatabase();
    process.env.APP_DATA_DIR = temporaryRoot;
    process.env.DB_TYPE = 'sqlite';
    process.env.SQLITE_FILE = databaseFile;

    const { getDb, closeDb } = require('../db/database');
    const {
        normalizeWorkshopLayout,
        normalizeLineLayout,
        composeSpatialTransforms,
        localToParentPoint
    } = require('../utils/spatialLayout');
    const db = await getDb();
    const workshop = await db.get('SELECT * FROM workshops WHERE id = ?', ['ws_1']);
    const line = await db.get('SELECT * FROM `lines` WHERE id = ?', ['line_a']);
    const devices = await db.all('SELECT * FROM devices ORDER BY id');
    const environmentRow = await db.get('SELECT value FROM settings WHERE `key` = ?', ['native_environment_config']);

    const workshopLayout = normalizeWorkshopLayout(workshop.layout_json);
    const lineLayout = normalizeLineLayout(line.layout_json);
    const lineWorld = composeSpatialTransforms(workshopLayout.transform, lineLayout.transform);
    const furnace = devices.find(device => device.id === 'furnace_1');
    const cart = devices.find(device => device.id === 'cart_1');
    const furnaceWorld = localToParentPoint({ x: furnace.pos_x, y: furnace.pos_y, z: furnace.pos_z }, lineWorld);
    const cartWorld = localToParentPoint({ x: cart.pos_x, y: cart.pos_y, z: cart.pos_z }, lineWorld);

    assert.equal(workshopLayout.version, 2);
    assert.equal(lineLayout.version, 2);
    assert.equal(lineLayout.placementPending, false);
    assert.equal(normalizeLineLayout({ ...lineLayout, placementPending: true }).placementPending, true);
    assert.equal(furnace.coordinate_space, 'line_local');
    assert.equal(cart.coordinate_space, 'line_local');
    assert.equal(cart.line_id, 'line_a');
    closeEnough(furnaceWorld.x, 19.5, '炉子世界 X 应保持');
    closeEnough(furnaceWorld.z, -10.5, '炉子世界 Z 应保持');
    closeEnough(cartWorld.x, -22.5, '料车世界 X 应保持');
    closeEnough(cartWorld.z, 0.5, '料车世界 Z 应保持');

    const environment = JSON.parse(environmentRow.value);
    const wall = environment.walls[0];
    assert.equal(environment.version, 3);
    assert.equal(wall.workshopId, 'ws_1');
    assert.equal(wall.coordinateSpace, 'workshop_local');
    const wallWorld = localToParentPoint({ x: wall.x, y: wall.baseY, z: wall.z }, workshopLayout.transform);
    closeEnough(wallWorld.x, 10, '围墙世界 X 应保持');
    closeEnough(wallWorld.z, 20, '围墙世界 Z 应保持');

    await closeDb();
    console.log(JSON.stringify({
        success: true,
        workshopTransform: workshopLayout.transform,
        lineTransform: lineLayout.transform,
        furnaceWorld,
        cartWorld,
        wallWorld
    }, null, 2));
}

run()
    .finally(() => {
        const resolved = path.resolve(temporaryRoot);
        const temporaryBase = path.resolve(os.tmpdir());
        if (resolved.startsWith(`${temporaryBase}${path.sep}`) && path.basename(resolved).startsWith('heat-treatment-spatial-test-')) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
