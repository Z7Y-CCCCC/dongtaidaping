const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const unzipper = require('unzipper');
const {
    createDatabaseBackup,
    importDatabaseBackupFile,
    restoreDatabaseBackup,
    resolveDatabaseBackupPath,
    verifySqliteFile,
    loadDatabaseConfig
} = require('../db/database');

const DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '..', 'data');
const SITE_BACKUP_DIR = path.resolve(process.env.SITE_BACKUP_DIR || path.join(DATA_DIR, 'site-backups'));
const SITE_IMPORT_DIR = path.resolve(process.env.SITE_IMPORT_DIR || path.join(DATA_DIR, 'site-imports'));
const SITE_BACKUP_RETENTION = positiveInteger(process.env.SITE_BACKUP_RETENTION, 5);
const SITE_BACKUP_FORMAT = 'heat-treatment-digital-twin-site-backup';
const SITE_BACKUP_VERSION = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10000;
const MAX_ARCHIVE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_CONTENT_BYTES = 2 * 1024 * 1024 * 1024;
let activeSiteBackupOperation = null;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function timestampToken(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

function sha256File(filename) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filename);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function listFiles(directory) {
    if (!fs.existsSync(directory)) return [];
    const files = [];
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const filename = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) visit(filename);
            if (entry.isFile()) files.push(filename);
        }
    };
    visit(directory);
    return files.sort((a, b) => a.localeCompare(b));
}

function backupDescriptor(filename) {
    const stat = fs.statSync(filename);
    return {
        filename: path.basename(filename),
        size: stat.size,
        createdAt: stat.mtime.toISOString()
    };
}

function listSiteBackups() {
    ensureDirectory(SITE_BACKUP_DIR);
    return fs.readdirSync(SITE_BACKUP_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
        .map(entry => path.join(SITE_BACKUP_DIR, entry.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
        .map(backupDescriptor);
}

function pruneSiteBackups() {
    for (const backup of listSiteBackups().slice(SITE_BACKUP_RETENTION)) {
        fs.rmSync(path.join(SITE_BACKUP_DIR, backup.filename), { force: true });
    }
}

function resolveSiteBackupPath(filename) {
    const supplied = String(filename || '');
    const name = path.basename(supplied);
    if (!name || name !== supplied || !name.toLowerCase().endsWith('.zip')) {
        throw new Error('整站备份文件名不合法');
    }
    const resolved = path.join(SITE_BACKUP_DIR, name);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error('整站备份文件不存在');
    }
    return resolved;
}

function getSiteBackupStatus() {
    const supported = String(loadDatabaseConfig().type || '').toLowerCase() === 'sqlite';
    return {
        supported,
        format: SITE_BACKUP_FORMAT,
        version: SITE_BACKUP_VERSION,
        retention: SITE_BACKUP_RETENTION,
        localDirectory: SITE_BACKUP_DIR,
        externalCopyRequired: true,
        busy: activeSiteBackupOperation?.name || null,
        backups: supported ? listSiteBackups() : []
    };
}

async function runSiteBackupOperation(name, callback) {
    if (activeSiteBackupOperation) {
        throw new Error(`整站灾备正在${activeSiteBackupOperation.name}，请稍后再试`);
    }
    const operation = { name };
    activeSiteBackupOperation = operation;
    try {
        return await callback();
    } finally {
        if (activeSiteBackupOperation === operation) activeSiteBackupOperation = null;
    }
}

async function addArchiveFile(manifestFiles, archivePath, filename) {
    const stat = fs.statSync(filename);
    manifestFiles.push({
        path: archivePath,
        size: stat.size,
        sha256: await sha256File(filename)
    });
}

async function createSiteBackup(uploadsRootDir) {
    return runSiteBackupOperation('导出', () => createSiteBackupUnlocked(uploadsRootDir));
}

async function createSiteBackupUnlocked(uploadsRootDir) {
    if (!getSiteBackupStatus().supported) {
        throw new Error('整站灾备导出仅支持安装版 SQLite 数据库');
    }

    ensureDirectory(SITE_BACKUP_DIR);
    const databaseBackup = await createDatabaseBackup('site-export');
    const databaseFilename = resolveDatabaseBackupPath(databaseBackup.filename);
    const uploadsRoot = path.resolve(uploadsRootDir);
    ensureDirectory(SITE_IMPORT_DIR);
    const exportStaging = path.join(SITE_IMPORT_DIR, `export-${timestampToken()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    let temporary = null;

    try {
        const uploadedFiles = listFiles(path.join(uploadsRoot, 'models')).map(source => {
            const relative = path.relative(uploadsRoot, source).split(path.sep).join('/');
            const filename = path.join(exportStaging, ...relative.split('/'));
            ensureDirectory(path.dirname(filename));
            fs.copyFileSync(source, filename);
            return { filename, relative };
        });
        const manifestFiles = [];
        await addArchiveFile(manifestFiles, 'database/factory.db', databaseFilename);

        for (const file of uploadedFiles) {
            await addArchiveFile(manifestFiles, `uploads/${file.relative}`, file.filename);
        }

        const createdAt = new Date();
        const manifest = {
            format: SITE_BACKUP_FORMAT,
            version: SITE_BACKUP_VERSION,
            createdAt: createdAt.toISOString(),
            databaseType: 'sqlite',
            uploadedFileCount: uploadedFiles.length,
            files: manifestFiles
        };
        const filename = `heat-treatment-site-backup-${timestampToken(createdAt)}.zip`;
        const destination = path.join(SITE_BACKUP_DIR, filename);
        temporary = `${destination}.${process.pid}.tmp`;
        fs.rmSync(temporary, { force: true });

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(temporary);
            const archive = archiver('zip', { zlib: { level: 6 } });
            output.once('close', resolve);
            output.once('error', reject);
            archive.once('error', reject);
            archive.on('warning', error => {
                if (error.code !== 'ENOENT') reject(error);
            });
            archive.pipe(output);
            archive.file(databaseFilename, { name: 'database/factory.db' });
            for (const file of uploadedFiles) {
                archive.file(file.filename, { name: `uploads/${file.relative}` });
            }
            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
            archive.finalize().catch(reject);
        });
        fs.renameSync(temporary, destination);
        pruneSiteBackups();
        return {
            ...backupDescriptor(destination),
            sha256: await sha256File(destination),
            uploadedFileCount: uploadedFiles.length,
            manifestCreatedAt: manifest.createdAt
        };
    } finally {
        if (temporary) fs.rmSync(temporary, { force: true });
        fs.rmSync(exportStaging, { recursive: true, force: true });
    }
}

function normalizeArchivePath(value) {
    const supplied = String(value || '');
    if (!supplied || supplied.includes('\\') || path.posix.isAbsolute(supplied)) {
        throw new Error('备份包包含不合法的文件路径');
    }
    const normalized = path.posix.normalize(supplied);
    if (normalized !== supplied || normalized === '..' || normalized.startsWith('../')) {
        throw new Error('备份包包含越界文件路径');
    }
    return normalized;
}

function validateManifest(manifest) {
    if (!manifest || manifest.format !== SITE_BACKUP_FORMAT || manifest.version !== SITE_BACKUP_VERSION) {
        throw new Error('不是受支持的整站备份包');
    }
    if (manifest.databaseType !== 'sqlite' || !Array.isArray(manifest.files)) {
        throw new Error('整站备份清单不完整');
    }
    const declared = new Map();
    let totalSize = 0;
    for (const file of manifest.files) {
        const archivePath = normalizeArchivePath(file?.path);
        const size = Number(file?.size);
        const sha256 = String(file?.sha256 || '').toLowerCase();
        if (declared.has(archivePath)) throw new Error(`整站备份清单存在重复文件: ${archivePath}`);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_FILE_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) {
            throw new Error(`整站备份文件校验信息无效: ${archivePath}`);
        }
        if (archivePath !== 'database/factory.db' && !archivePath.startsWith('uploads/models/')) {
            throw new Error(`整站备份包含不允许恢复的文件: ${archivePath}`);
        }
        totalSize += size;
        if (totalSize > MAX_ARCHIVE_CONTENT_BYTES) throw new Error('整站备份解压后体积超过安全限制');
        declared.set(archivePath, { path: archivePath, size, sha256 });
    }
    if (!declared.has('database/factory.db')) throw new Error('整站备份缺少 SQLite 数据库');
    return declared;
}

async function extractValidatedArchive(archiveFilename, stagingDirectory) {
    const directory = await unzipper.Open.file(archiveFilename);
    const entries = directory.files.filter(entry => entry.type === 'File');
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('整站备份文件数量超过安全限制');
    const entryMap = new Map();
    for (const entry of entries) {
        const archivePath = normalizeArchivePath(entry.path);
        if (entryMap.has(archivePath)) throw new Error(`整站备份包含重复文件: ${archivePath}`);
        entryMap.set(archivePath, entry);
    }

    const manifestEntry = entryMap.get('manifest.json');
    if (!manifestEntry || Number(manifestEntry.uncompressedSize || 0) > MAX_MANIFEST_BYTES) {
        throw new Error('整站备份缺少有效清单');
    }
    const manifest = JSON.parse((await readEntryBuffer(manifestEntry, MAX_MANIFEST_BYTES)).toString('utf8'));
    const declared = validateManifest(manifest);

    for (const archivePath of entryMap.keys()) {
        if (archivePath !== 'manifest.json' && !declared.has(archivePath)) {
            throw new Error(`整站备份包含未登记文件: ${archivePath}`);
        }
    }
    for (const file of declared.values()) {
        const entry = entryMap.get(file.path);
        if (!entry) throw new Error(`整站备份缺少文件: ${file.path}`);
        const declaredEntrySize = Number(entry.uncompressedSize ?? entry.size);
        if (Number.isFinite(declaredEntrySize) && declaredEntrySize !== file.size) {
            throw new Error(`整站备份文件大小校验失败: ${file.path}`);
        }
        const destination = path.join(stagingDirectory, ...file.path.split('/'));
        ensureDirectory(path.dirname(destination));
        await streamEntryToFile(entry, destination, file.size, file.sha256);
    }

    const databaseFilename = path.join(stagingDirectory, 'database', 'factory.db');
    const verification = verifySqliteFile(databaseFilename);
    if (!verification.valid) throw new Error(`整站备份数据库校验失败: ${verification.error}`);
    return { manifest, databaseFilename };
}

async function readEntryBuffer(entry, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of entry.stream()) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('整站备份清单超过安全限制');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

async function streamEntryToFile(entry, destination, expectedSize, expectedSha256) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const verifier = new Transform({
        transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (bytes > expectedSize) {
                callback(new Error(`整站备份文件超过清单大小: ${destination}`));
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        },
        flush(callback) {
            if (bytes !== expectedSize) {
                callback(new Error(`整站备份文件大小校验失败: ${destination}`));
                return;
            }
            callback();
        }
    });
    try {
        await pipeline(entry.stream(), verifier, fs.createWriteStream(destination));
        if (hash.digest('hex') !== expectedSha256) throw new Error(`整站备份文件校验失败: ${destination}`);
    } catch (error) {
        fs.rmSync(destination, { force: true });
        throw error;
    }
}

async function restoreSiteBackup(archiveFilename, uploadsRootDir) {
    return runSiteBackupOperation('恢复', () => restoreSiteBackupUnlocked(archiveFilename, uploadsRootDir));
}

async function restoreSiteBackupUnlocked(archiveFilename, uploadsRootDir) {
    if (!getSiteBackupStatus().supported) {
        throw new Error('整站灾备恢复仅支持安装版 SQLite 数据库');
    }

    ensureDirectory(SITE_IMPORT_DIR);
    const stagingDirectory = path.join(SITE_IMPORT_DIR, `restore-${timestampToken()}-${process.pid}`);
    const uploadsRoot = path.resolve(uploadsRootDir);
    const modelsDirectory = path.join(uploadsRoot, 'models');
    const rollbackModels = path.join(stagingDirectory, 'rollback-models');
    let uploadsMutationStarted = false;
    ensureDirectory(stagingDirectory);

    try {
        const { manifest, databaseFilename } = await extractValidatedArchive(path.resolve(archiveFilename), stagingDirectory);
        if (fs.existsSync(modelsDirectory)) fs.cpSync(modelsDirectory, rollbackModels, { recursive: true });

        uploadsMutationStarted = true;
        fs.rmSync(modelsDirectory, { recursive: true, force: true });
        const restoredModels = path.join(stagingDirectory, 'uploads', 'models');
        if (fs.existsSync(restoredModels)) fs.cpSync(restoredModels, modelsDirectory, { recursive: true });
        ensureDirectory(modelsDirectory);

        const imported = await importDatabaseBackupFile(databaseFilename, 'site-import');
        const databaseRestore = await restoreDatabaseBackup(imported.filename);
        return {
            success: true,
            manifestCreatedAt: manifest.createdAt,
            uploadedFileCount: manifest.uploadedFileCount || 0,
            databaseBackup: imported,
            rollback: databaseRestore.rollback,
            recovery: databaseRestore.recovery
        };
    } catch (error) {
        if (uploadsMutationStarted) {
            fs.rmSync(modelsDirectory, { recursive: true, force: true });
            if (fs.existsSync(rollbackModels)) fs.cpSync(rollbackModels, modelsDirectory, { recursive: true });
            ensureDirectory(modelsDirectory);
        }
        throw error;
    } finally {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
}

module.exports = {
    createSiteBackup,
    restoreSiteBackup,
    getSiteBackupStatus,
    resolveSiteBackupPath,
    SITE_IMPORT_DIR
};
