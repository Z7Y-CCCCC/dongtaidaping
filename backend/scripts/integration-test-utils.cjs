const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(BACKEND_DIR, '..');
const OUTPUT_DIR = path.join(REPO_DIR, 'output');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function runToken() {
    return new Date().toISOString().replace(/[-:.]/g, '');
}

function createRunDirectory(prefix) {
    const directory = path.join(OUTPUT_DIR, `${prefix}-${runToken()}-${process.pid}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

async function copySqliteDatabase(source, destination) {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
        await db.backup(destination);
    } finally {
        db.close();
    }
}

function findFreePort(preferred) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(preferred, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function startLoggedProcess(command, args, options) {
    const log = fs.createWriteStream(options.logFile, { flags: 'a' });
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('exit', () => log.end());
    return child;
}

function waitForExit(child, timeoutMs = 15000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child?.exitCode);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Process ${child.pid} did not exit in ${timeoutMs}ms`));
        }, timeoutMs);
        const onExit = code => {
            cleanup();
            resolve(code);
        };
        const cleanup = () => {
            clearTimeout(timer);
            child.off('exit', onExit);
        };
        child.once('exit', onExit);
    });
}

async function forceStop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGKILL'); } catch (error) { /* process may already be gone */ }
    try { await waitForExit(child, 5000); } catch (error) { /* best-effort cleanup */ }
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    let body = null;
    if (text) {
        try { body = JSON.parse(text); } catch (error) { body = text; }
    }
    if (!response.ok) {
        throw new Error(`${options.method || 'GET'} ${url} failed: HTTP ${response.status} ${text}`);
    }
    return body;
}

async function waitForHttp(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await requestJson(url);
        } catch (error) {
            lastError = error;
            await sleep(200);
        }
    }
    throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'no response'}`);
}

async function waitUntil(predicate, timeoutMs, label, intervalMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function percentile(values, percent) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
}

function round(value, digits = 1) {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

module.exports = {
    BACKEND_DIR,
    REPO_DIR,
    copySqliteDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    percentile,
    requestJson,
    round,
    sleep,
    startLoggedProcess,
    waitForExit,
    waitForHttp,
    waitUntil
};
