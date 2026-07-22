const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_ARCHIVES = 60;
let archiveSequence = 0;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function timestampToken(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

function archiveFilename(filename) {
    const extension = path.extname(filename);
    const stem = path.basename(filename, extension);
    archiveSequence += 1;
    return path.join(
        path.dirname(filename),
        `${stem}-${timestampToken()}-${process.pid}-${archiveSequence}.log.gz`
    );
}

function archiveOptions(options = {}) {
    return {
        retentionDays: positiveInteger(options.retentionDays ?? process.env.LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
        maxArchives: positiveInteger(options.maxArchives ?? process.env.LOG_MAX_ARCHIVES, DEFAULT_MAX_ARCHIVES)
    };
}

function cleanupLogArchives(directory, options = {}) {
    fs.mkdirSync(directory, { recursive: true });
    const { retentionDays, maxArchives } = archiveOptions(options);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const archives = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.log.gz'))
        .map(entry => {
            const filename = path.join(directory, entry.name);
            return { filename, stat: fs.statSync(filename) };
        });

    for (const archive of archives) {
        if (archive.stat.mtimeMs < cutoff) fs.rmSync(archive.filename, { force: true });
    }

    const retained = archives
        .filter(archive => fs.existsSync(archive.filename))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const archive of retained.slice(maxArchives)) {
        fs.rmSync(archive.filename, { force: true });
    }
}

async function archiveExistingLog(filename) {
    if (!fs.existsSync(filename)) return null;
    if (fs.statSync(filename).size === 0) {
        fs.rmSync(filename, { force: true });
        return null;
    }

    const destination = archiveFilename(filename);
    const temporary = `${destination}.tmp`;
    fs.rmSync(temporary, { force: true });
    try {
        await pipeline(
            fs.createReadStream(filename),
            zlib.createGzip({ level: 6 }),
            fs.createWriteStream(temporary, { flags: 'wx' })
        );
        fs.renameSync(temporary, destination);
        fs.rmSync(filename, { force: true });
        return destination;
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function archiveCurrentLogSync(filename) {
    if (!fs.existsSync(filename) || fs.statSync(filename).size === 0) return null;
    const destination = archiveFilename(filename);
    const temporary = `${destination}.tmp`;
    fs.rmSync(temporary, { force: true });
    try {
        fs.writeFileSync(temporary, zlib.gzipSync(fs.readFileSync(filename), { level: 6 }), { flag: 'wx' });
        fs.renameSync(temporary, destination);
        fs.rmSync(filename, { force: true });
        return destination;
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

class RotatingLogWriter extends Writable {
    constructor(directory, filename, options = {}) {
        super();
        fs.mkdirSync(directory, { recursive: true });
        this.directory = directory;
        this.filename = path.join(directory, filename);
        this.maxBytes = positiveInteger(options.maxBytes ?? process.env.LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
        this.retentionDays = positiveInteger(options.retentionDays ?? process.env.LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
        this.maxArchives = positiveInteger(options.maxArchives ?? process.env.LOG_MAX_ARCHIVES, DEFAULT_MAX_ARCHIVES);
        this.fd = null;
        this.bytes = 0;
        this.open();
    }

    open() {
        this.fd = fs.openSync(this.filename, 'a');
        this.bytes = fs.fstatSync(this.fd).size;
    }

    close() {
        if (this.fd === null) return;
        fs.closeSync(this.fd);
        this.fd = null;
    }

    rotate() {
        this.close();
        archiveCurrentLogSync(this.filename);
        cleanupLogArchives(this.directory, this);
        this.open();
    }

    _write(chunk, encoding, callback) {
        try {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            if (this.bytes > 0 && this.bytes + buffer.length > this.maxBytes) this.rotate();
            fs.writeSync(this.fd, buffer);
            this.bytes += buffer.length;
            callback();
        } catch (error) {
            callback(error);
        }
    }

    _final(callback) {
        try {
            this.close();
            callback();
        } catch (error) {
            callback(error);
        }
    }

    _destroy(error, callback) {
        try { this.close(); } catch (closeError) { error ||= closeError; }
        callback(error);
    }
}

async function createRotatingLogWriter(directory, filename, options = {}) {
    fs.mkdirSync(directory, { recursive: true });
    await archiveExistingLog(path.join(directory, filename));
    cleanupLogArchives(directory, options);
    return new RotatingLogWriter(directory, filename, options);
}

module.exports = {
    DEFAULT_MAX_BYTES,
    DEFAULT_RETENTION_DAYS,
    DEFAULT_MAX_ARCHIVES,
    cleanupLogArchives,
    createRotatingLogWriter
};
