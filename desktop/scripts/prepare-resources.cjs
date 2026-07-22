const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const resourcesDir = path.join(desktopDir, 'resources');
const runtimeDir = path.join(resourcesDir, 'runtime');
const templatesDir = path.join(resourcesDir, 'templates');
const backendDependenciesDir = path.join(resourcesDir, 'backend-dependencies');
const sourceDb = path.join(projectDir, 'backend', 'data', 'factory.db');
const outputDb = path.join(templatesDir, 'factory-template.db');
const nodeBinary = process.execPath;

fs.rmSync(resourcesDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(templatesDir, { recursive: true });

if (!fs.existsSync(sourceDb)) throw new Error(`找不到数据库模板：${sourceDb}`);

const Database = require(path.join(projectDir, 'backend', 'node_modules', 'better-sqlite3'));
const db = new Database(sourceDb);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

fs.copyFileSync(sourceDb, outputDb);
fs.copyFileSync(nodeBinary, path.join(runtimeDir, 'node.exe'));
fs.cpSync(path.join(projectDir, 'backend', 'node_modules'), backendDependenciesDir, { recursive: true });

console.log(`已准备数据库模板：${outputDb}`);
console.log(`已准备 Node.js 运行时：${nodeBinary}`);
console.log(`已准备后端运行依赖：${backendDependenciesDir}`);
