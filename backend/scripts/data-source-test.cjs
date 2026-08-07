const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
    const source = path.resolve(__dirname, '..', 'data', 'factory.db');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heat-treatment-data-source-'));
    const database = path.join(root, 'external.db');
    fs.copyFileSync(source, database);
    process.env.APP_DATA_DIR = root;

    const service = require('../services/dataSources');
    const connection = service.saveDataSource({
        id: 'test_external',
        name: '测试外部数据库',
        type: 'sqlite',
        filename: database,
        enabled: true
    });
    await service.testDataSource(connection);
    const tables = await service.listTables(connection.id);
    const settingsTable = tables.find(item => item.name === 'settings') || tables[0];
    if (!settingsTable) throw new Error('没有读取到任何数据表');
    const columns = await service.listColumns(connection.id, settingsTable.schema, settingsTable.name);
    const field = columns.find(item => item.name === 'value') || columns[0];
    if (!field) throw new Error('没有读取到任何字段');
    const preview = await service.previewBinding({
        connectionId: connection.id,
        schema: settingsTable.schema,
        table: settingsTable.name,
        field: field.name,
        valueMode: 'latest',
        rowLimit: 5
    });
    const runtime = await service.readRuntimeBindings([{ id: 'widget_test', data: {
        mode: 'database', connectionId: connection.id, schema: settingsTable.schema,
        table: settingsTable.name, field: field.name, valueMode: 'latest'
    } }]);
    service.saveBackupConfig({ autoEnabled: false, selectedConnectionIds: [connection.id], intervalHours: 6, retention: 2 });
    const backup = await service.createConnectionBackup(connection.id, 'test');
    const backupPath = path.join(root, 'data-source-backups', connection.id, backup.filename);
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size < 32) throw new Error('外部数据库压缩备份未生成');
    await service.stopDataSourceMaintenance();

    console.log(JSON.stringify({
        success: true,
        connection: connection.id,
        tables: tables.length,
        columns: columns.length,
        preview: preview.value,
        runtimeQuality: runtime.widget_test?.quality,
        backup: backup.filename
    }, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
}

main().catch(error => {
    console.error(JSON.stringify({ success: false, error: error.stack || error.message }, null, 2));
    process.exitCode = 1;
});
