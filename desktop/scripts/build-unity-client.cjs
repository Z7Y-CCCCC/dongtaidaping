const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const unityProjectDir = path.join(projectDir, 'unity-client');
const projectVersionFile = path.join(unityProjectDir, 'ProjectSettings', 'ProjectVersion.txt');
const buildDirectory = path.join(unityProjectDir, 'Builds', 'Windows');
const buildExecutable = path.join(buildDirectory, 'HeatTreatmentDigitalTwin.exe');
const logDirectory = path.join(unityProjectDir, 'Logs');
const logFile = path.join(logDirectory, 'desktop-package-build.log');

function readEditorVersion() {
    const text = fs.readFileSync(projectVersionFile, 'utf8');
    const match = text.match(/^m_EditorVersion:\s*(.+)$/m);
    if (!match) throw new Error(`无法从 ${projectVersionFile} 读取 Unity 版本`);
    return match[1].trim();
}

function installedEditorCandidates(version) {
    const candidates = [];
    if (process.env.UNITY_EDITOR_PATH) candidates.push(path.resolve(process.env.UNITY_EDITOR_PATH));
    candidates.push(
        path.join('C:\\Program Files', `Unity ${version}`, 'Editor', 'Unity.exe'),
        path.join('C:\\Program Files', 'Unity Hub', 'Editor', version, 'Editor', 'Unity.exe'),
        path.join('C:\\Program Files', 'Unity', 'Hub', 'Editor', version, 'Editor', 'Unity.exe')
    );

    const programFiles = 'C:\\Program Files';
    if (fs.existsSync(programFiles)) {
        for (const name of fs.readdirSync(programFiles)) {
            if (!name.toLowerCase().startsWith('unity')) continue;
            candidates.push(path.join(programFiles, name, 'Editor', 'Unity.exe'));
        }
    }
    return [...new Set(candidates)];
}

function findEditor(version) {
    const editor = installedEditorCandidates(version).find(candidate => fs.existsSync(candidate));
    if (editor) return editor;
    throw new Error(
        `未找到 Unity ${version}。请安装对应编辑器，或设置 UNITY_EDITOR_PATH 指向 Unity.exe。`
    );
}

const version = readEditorVersion();
const editor = findEditor(version);
fs.mkdirSync(logDirectory, { recursive: true });

console.log(`使用 Unity 编辑器：${editor}`);
const result = spawnSync(editor, [
    '-batchmode',
    '-nographics',
    '-quit',
    '-accept-apiupdate',
    '-projectPath', unityProjectDir,
    '-executeMethod', 'HeatTreatment.DigitalTwin.Editor.ProjectBootstrap.BuildWindowsClient',
    '-logFile', logFile
], {
    cwd: projectDir,
    windowsHide: true,
    stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0) {
    throw new Error(`Unity Windows 构建失败（退出码 ${result.status}），请查看：${logFile}`);
}

for (const required of [
    buildExecutable,
    path.join(buildDirectory, 'UnityPlayer.dll'),
    path.join(buildDirectory, 'HeatTreatmentDigitalTwin_Data')
]) {
    if (!fs.existsSync(required)) throw new Error(`Unity 构建缺少产物：${required}`);
}

console.log(`Unity Windows 客户端已生成：${buildExecutable}`);
