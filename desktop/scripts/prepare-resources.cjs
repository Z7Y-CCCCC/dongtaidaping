const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const resourcesDir = path.join(desktopDir, 'resources');
const runtimeDir = path.join(resourcesDir, 'runtime');
const templatesDir = path.join(resourcesDir, 'templates');
const backendDependenciesDir = path.join(resourcesDir, 'backend-dependencies');
const nativeClientSourceDir = path.join(projectDir, 'unity-client', 'Builds', 'Windows');
const nativeClientOutputDir = path.join(resourcesDir, 'native-client');
const sourceDb = path.resolve(
    process.env.DESKTOP_TEMPLATE_SOURCE_DB || path.join(projectDir, 'backend', 'data', 'factory.db')
);
const outputDb = path.join(templatesDir, 'factory-template.db');
const nodeBinary = process.execPath;

async function prepareDatabaseTemplate() {
    let templateSource = sourceDb;
    let generatedDataDir = null;

    if (!fs.existsSync(templateSource)) {
        generatedDataDir = path.join(resourcesDir, '.template-build');
        const generatedDb = path.join(generatedDataDir, 'factory.db');
        fs.mkdirSync(generatedDataDir, { recursive: true });
        fs.writeFileSync(path.join(generatedDataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: generatedDb
        }, null, 2));
        process.env.APP_DATA_DIR = generatedDataDir;
        process.env.DB_TYPE = 'sqlite';
        process.env.SQLITE_FILE = generatedDb;

        const databaseModule = require(path.join(projectDir, 'backend', 'db', 'database.js'));
        await databaseModule.getDb();
        await databaseModule.closeDb();
        templateSource = generatedDb;
    }

    const Database = require(path.join(projectDir, 'backend', 'node_modules', 'better-sqlite3'));
    const db = new Database(templateSource);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const integrity = db.pragma('quick_check', { simple: true });
    db.close();
    if (integrity !== 'ok') throw new Error(`数据库模板完整性检查失败：${integrity}`);

    fs.copyFileSync(templateSource, outputDb);
    if (generatedDataDir) fs.rmSync(generatedDataDir, { recursive: true, force: true });
    return generatedDataDir ? '全新默认数据库' : sourceDb;
}

async function main() {
    fs.rmSync(resourcesDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });

    for (const required of ['HeatTreatmentDigitalTwin.exe', 'UnityPlayer.dll', 'HeatTreatmentDigitalTwin_Data']) {
        if (!fs.existsSync(path.join(nativeClientSourceDir, required))) {
            throw new Error(`找不到 Unity 原生客户端产物：${path.join(nativeClientSourceDir, required)}`);
        }
    }

    const databaseSource = await prepareDatabaseTemplate();
    fs.copyFileSync(nodeBinary, path.join(runtimeDir, 'node.exe'));
    fs.cpSync(path.join(projectDir, 'backend', 'node_modules'), backendDependenciesDir, { recursive: true });
    fs.cpSync(nativeClientSourceDir, nativeClientOutputDir, {
        recursive: true,
        filter: source => !path.basename(source).includes('BurstDebugInformation_DoNotShip')
    });

    console.log(`已准备数据库模板：${outputDb}（来源：${databaseSource}）`);
    console.log(`已准备 Node.js 运行时：${nodeBinary}`);
    console.log(`已准备后端运行依赖：${backendDependenciesDir}`);
    console.log(`已准备 Unity 原生客户端：${nativeClientOutputDir}`);
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
