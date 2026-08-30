const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heat-treatment-business-data-'));
    const database = path.join(root, 'schedule.db');
    const Database = require('better-sqlite3');
    const seed = new Database(database);
    seed.exec(`
        CREATE TABLE produce_batch (
            id INTEGER PRIMARY KEY, batch_no TEXT, batch_name TEXT, product_name TEXT,
            operator TEXT, workpiece_count INTEGER, workpiece_weight REAL, template_id INTEGER,
            status TEXT, current_step INTEGER, progress INTEGER, plan_start_time TEXT,
            actual_start_time TEXT, actual_finish_time TEXT, update_time TEXT, create_time TEXT
        );
        CREATE TABLE produce_batch_step (
            id INTEGER PRIMARY KEY, batch_id INTEGER, step_index INTEGER, step_name TEXT,
            furnace_id TEXT, furnace_type_id INTEGER, technology_id INTEGER,
            actual_begin_time TEXT, actual_end_time TEXT, status TEXT, create_time TEXT
        );
        CREATE TABLE rc_furnace_attr_history (
            id INTEGER PRIMARY KEY, device_id TEXT, signal_id INTEGER, signal_name TEXT,
            actual_value TEXT, batch_id INTEGER, record_time TEXT, create_time TEXT
        );
        CREATE TABLE device_statistics_daily (
            id INTEGER PRIMARY KEY, furnace_id TEXT, stat_date TEXT, total_runtime INTEGER,
            idle_time INTEGER, alarm_time INTEGER, offline_time INTEGER, batch_count INTEGER,
            alarm_count INTEGER, utilization_rate REAL
        );
        CREATE TABLE template (id INTEGER PRIMARY KEY, code TEXT, name TEXT, description TEXT, steps TEXT);
    `);
    seed.prepare(`INSERT INTO produce_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        101, 'B-20260830-001', '齿轮渗碳批次', '齿轮', '张工', 120, 860.5, 7,
        'RUNNING', 2, 48, '2026-08-30 08:00:00', '2026-08-30 08:12:00', null,
        '2026-08-30 10:00:00', '2026-08-30 07:50:00'
    );
    seed.prepare(`INSERT INTO produce_batch_step VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        1, 101, 1, '渗碳', 'FURNACE-01', 1, 7, '2026-08-30 08:12:00', null, 'RUNNING', '2026-08-30 08:00:00'
    );
    seed.prepare(`INSERT INTO rc_furnace_attr_history VALUES (?,?,?,?,?,?,?,?)`).run(
        1, 'FURNACE-01', 13, '实际温度', '920.5', 101, '2026-08-30 10:00:00', '2026-08-30 10:00:00'
    );
    seed.prepare(`INSERT INTO rc_furnace_attr_history VALUES (?,?,?,?,?,?,?,?)`).run(
        2, 'FURNACE-01', 14, '碳势值', '1.12', 101, '2026-08-30 10:00:00', '2026-08-30 10:00:00'
    );
    seed.prepare(`INSERT INTO device_statistics_daily VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        1, 'FURNACE-01', '2026-08-30', 480, 60, 5, 0, 3, 1, 88.5
    );
    seed.close();

    process.env.APP_DATA_DIR = root;
    const dataSources = require('../services/dataSources');
    const businessData = require('../services/businessData');
    const connection = dataSources.saveDataSource({
        id: 'schedule_readonly', name: '排产系统只读库', type: 'sqlite', filename: database, enabled: true
    });
    const snapshot = await businessData.readBusinessSnapshot(connection.id, {
        deviceId: 'FURNACE-01', limit: 20
    });
    if (snapshot.readOnly !== true) throw new Error('业务快照没有声明只读');
    if (!snapshot.sections.batches.available || snapshot.sections.batches.rows[0].batchNo !== 'B-20260830-001') {
        throw new Error(`批次读取失败：${JSON.stringify(snapshot.sections.batches)}`);
    }
    if (!snapshot.sections.compliance.available || snapshot.sections.compliance.rows.length !== 2) {
        throw new Error(`温度/碳势读取失败：${JSON.stringify(snapshot.sections.compliance)}`);
    }
    if (!snapshot.sections.oee.available || snapshot.sections.oee.rows[0].utilizationRate !== 88.5) {
        throw new Error(`设备统计读取失败：${JSON.stringify(snapshot.sections.oee)}`);
    }
    if (snapshot.sections.energy.available || snapshot.sections.maintenance.available) {
        throw new Error('缺失的可选业务表不应被伪造为可用');
    }
    let writeRejected = false;
    try { await dataSources.executeReadOnlyQuery(connection.id, 'UPDATE produce_batch SET status = ? WHERE id = ?', ['DONE', 101]); }
    catch (error) { writeRejected = /只允许|禁止/.test(error.message); }
    if (!writeRejected) throw new Error('只读查询边界未拒绝 UPDATE');

    console.log(JSON.stringify({
        success: true,
        contractVersion: snapshot.contractVersion,
        batch: snapshot.sections.batches.rows[0].batchNo,
        complianceRows: snapshot.sections.compliance.rows.length,
        utilizationRate: snapshot.sections.oee.rows[0].utilizationRate,
        optionalSectionsExplicitlyUnavailable: true,
        writesRejected: true
    }, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
}

main().catch(error => {
    console.error(JSON.stringify({ success: false, error: error.stack || error.message }, null, 2));
    process.exitCode = 1;
});
