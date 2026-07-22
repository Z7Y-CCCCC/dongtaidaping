const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const unzipper = require('unzipper');
const {
    BACKEND_DIR,
    copySqliteDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SOURCE_DB = path.resolve(process.env.SITE_BACKUP_TEST_SOURCE_DB || path.join(BACKEND_DIR, 'data', 'factory.db'));
const SHUTDOWN_TOKEN = `site-backup-test-${process.pid}-${Date.now()}`;
const SETTING_KEY = 'site_backup_test_marker';
const ORIGINAL_SETTING = 'value-before-export';
const MUTATED_SETTING = 'value-after-export';
const MODEL_FILENAME = 'site-backup-test.glb';
const ORIGINAL_MODEL = Buffer.from('site-backup-original-model-content');
const MUTATED_MODEL = Buffer.from('site-backup-mutated-model-content');

let backend = null;
let backendOrigin = null;
let runDirectory = null;

function inspectDatabase(filename) {
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
        return {
            quickCheck: db.pragma('quick_check', { simple: true }),
            setting: db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY)?.value ?? null
        };
    } finally {
        db.close();
    }
}

async function putSetting(value) {
    return requestJson(`${backendOrigin}/api/settings`, {
        method: 'PUT',
        body: JSON.stringify({ [SETTING_KEY]: value })
    });
}

async function readSetting() {
    const settings = await requestJson(`${backendOrigin}/api/settings`);
    return settings[SETTING_KEY] ?? null;
}

async function importArchive(filename, uploadName = path.basename(filename)) {
    const form = new FormData();
    form.append('backup', new Blob([fs.readFileSync(filename)], { type: 'application/zip' }), uploadName);
    const response = await fetch(`${backendOrigin}/api/site-backups/import`, { method: 'POST', body: form });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (error) { body = text; }
    return { ok: response.ok, status: response.status, body };
}

async function gracefulStop() {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    await requestJson(`${backendOrigin}/api/internal/shutdown`, {
        method: 'POST',
        headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
    });
    await waitForExit(backend, 15000);
    backend = null;
}

async function main() {
    runDirectory = createRunDirectory('site-backup');
    const resultFile = path.join(runDirectory, 'result.json');
    const dataDir = path.join(runDirectory, 'data');
    const uploadsDir = path.join(runDirectory, 'uploads');
    const modelsDir = path.join(uploadsDir, 'models');
    const databaseFile = path.join(dataDir, 'factory.db');
    const startedAt = Date.now();
    let result;

    try {
        if (!fs.existsSync(SOURCE_DB)) throw new Error(`Source SQLite database not found: ${SOURCE_DB}`);
        fs.mkdirSync(modelsDir, { recursive: true });
        await copySqliteDatabase(SOURCE_DB, databaseFile);
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2));
        fs.writeFileSync(path.join(modelsDir, MODEL_FILENAME), ORIGINAL_MODEL);

        const port = await findFreePort(3301);
        backendOrigin = `http://127.0.0.1:${port}`;
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(port),
                APP_DATA_DIR: dataDir,
                UPLOADS_DIR: uploadsDir,
                SITE_BACKUP_RETENTION: '3',
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
                DB_BACKUP_RETENTION: '10',
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${backendOrigin}/api/health`, 30000);

        await putSetting(ORIGINAL_SETTING);
        const exported = await requestJson(`${backendOrigin}/api/site-backups/export`, { method: 'POST' });
        if (!exported.success || !exported.backup?.filename) throw new Error('Export API did not return a backup filename');

        const downloadResponse = await fetch(`${backendOrigin}/api/site-backups/${encodeURIComponent(exported.backup.filename)}/download`);
        if (!downloadResponse.ok) throw new Error(`Backup download failed: HTTP ${downloadResponse.status}`);
        const downloadedArchive = path.join(runDirectory, exported.backup.filename);
        fs.writeFileSync(downloadedArchive, Buffer.from(await downloadResponse.arrayBuffer()));

        const archive = await unzipper.Open.file(downloadedArchive);
        const manifestEntry = archive.files.find(entry => entry.path === 'manifest.json');
        if (!manifestEntry) throw new Error('Exported archive does not contain manifest.json');
        const manifest = JSON.parse((await manifestEntry.buffer()).toString('utf8'));
        const archivePaths = new Set(archive.files.filter(entry => entry.type === 'File').map(entry => entry.path));

        await putSetting(MUTATED_SETTING);
        fs.writeFileSync(path.join(modelsDir, MODEL_FILENAME), MUTATED_MODEL);
        const imported = await importArchive(downloadedArchive);
        if (!imported.ok || !imported.body?.success) {
            throw new Error(`Valid import failed: HTTP ${imported.status} ${JSON.stringify(imported.body)}`);
        }

        const settingAfterRestore = await readSetting();
        const modelAfterRestore = fs.readFileSync(path.join(modelsDir, MODEL_FILENAME));
        const databaseAfterRestore = inspectDatabase(databaseFile);

        const corruptedArchive = path.join(runDirectory, 'corrupted-site-backup.zip');
        const corrupted = fs.readFileSync(downloadedArchive);
        const offset = Math.max(0, Math.floor(corrupted.length / 2));
        corrupted[offset] ^= 0xff;
        fs.writeFileSync(corruptedArchive, corrupted);
        const corruptedImport = await importArchive(corruptedArchive);

        const checks = {
            manifestFormatValid: manifest.format === 'heat-treatment-digital-twin-site-backup' && manifest.version === 1,
            databaseIncluded: archivePaths.has('database/factory.db'),
            uploadedModelIncluded: archivePaths.has(`uploads/models/${MODEL_FILENAME}`),
            databaseSettingRestored: settingAfterRestore === ORIGINAL_SETTING && databaseAfterRestore.setting === ORIGINAL_SETTING,
            uploadedModelRestored: modelAfterRestore.equals(ORIGINAL_MODEL),
            databaseIntegrityValid: databaseAfterRestore.quickCheck === 'ok',
            corruptedArchiveRejected: !corruptedImport.ok && corruptedImport.status === 400,
            rollbackBackupCreated: imported.body?.rollback?.filename?.includes('-before-restore.db') === true,
            archiveHashMatches: crypto.createHash('sha256').update(fs.readFileSync(downloadedArchive)).digest('hex') === exported.backup.sha256
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        if (failed.length) throw new Error(`Site backup checks failed: ${failed.join(', ')}`);

        result = {
            success: true,
            durationMs: Date.now() - startedAt,
            checks,
            artifacts: {
                archive: downloadedArchive,
                result: resultFile,
                log: path.join(runDirectory, 'backend.log')
            }
        };
        await gracefulStop();
    } catch (error) {
        result = {
            success: false,
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
        await forceStop(backend);
        process.exitCode = 1;
    } finally {
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    }
}

main();
