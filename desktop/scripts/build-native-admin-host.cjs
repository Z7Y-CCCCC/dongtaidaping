const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const hostProject = path.join(projectDir, 'native-admin-host', 'HeatTreatmentAdminHost.csproj');
const outputDirectory = path.join(projectDir, 'unity-client', 'Builds', 'Windows', 'AdminHost');
const executable = path.join(outputDirectory, 'HeatTreatmentAdminHost.exe');

if (!fs.existsSync(hostProject)) throw new Error(`内嵌后台宿主项目不存在：${hostProject}`);
fs.mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync('dotnet', [
    'publish', hostProject,
    '--configuration', 'Release',
    '--runtime', 'win-x64',
    '--self-contained', 'true',
    '--output', outputDirectory
], {
    cwd: projectDir,
    windowsHide: true,
    stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0) {
    throw new Error(`内嵌后台宿主构建失败（退出码 ${result.status}）`);
}

for (const required of [
    executable,
    path.join(outputDirectory, 'Microsoft.Web.WebView2.Core.dll'),
    path.join(outputDirectory, 'Microsoft.Web.WebView2.WinForms.dll'),
    path.join(outputDirectory, 'WebView2Loader.dll')
]) {
    if (!fs.existsSync(required)) throw new Error(`内嵌后台宿主缺少产物：${required}`);
}

console.log(`Unity 内嵌后台宿主已生成：${executable}`);
