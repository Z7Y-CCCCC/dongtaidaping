[CmdletBinding()]
param(
    [string]$DatabaseHost = '127.0.0.1',
    [int]$DatabasePort = 3307,
    [string]$DatabaseUser = 'root',
    [string]$DatabasePassword = 'root',
    [string]$DatabaseName = 'dongtai_daping',
    [switch]$IncludeHistory,
    [switch]$RefreshDependencies
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectDirectory = $PSScriptRoot
$desktopDirectory = Join-Path $projectDirectory 'desktop'
$outputDirectory = Join-Path $projectDirectory '安装包'
$packageFile = Join-Path $desktopDirectory 'package.json'
$unityVersionFile = Join-Path $projectDirectory 'unity-client\ProjectSettings\ProjectVersion.txt'

function Resolve-RequiredCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Names,

        [Parameter(Mandatory = $true)]
        [string]$InstallHint
    )

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    throw $InstallHint
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    Write-Host "`n[$Label]" -ForegroundColor Cyan
    & $Executable @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Label 失败（退出码 $LASTEXITCODE）。"
    }
}

function Ensure-NodeDependencies {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [string]$NpmExecutable
    )

    $nodeModules = Join-Path $Directory 'node_modules'
    if ((Test-Path -LiteralPath $nodeModules) -and -not $RefreshDependencies) {
        Write-Host "[$Label] 已检测到依赖，直接复用。"
        return
    }

    $installCommand = if (Test-Path -LiteralPath (Join-Path $Directory 'package-lock.json')) { 'ci' } else { 'install' }
    Invoke-CheckedCommand -Label "$Label 依赖安装" -Executable $NpmExecutable -ArgumentList @(
        '--prefix',
        $Directory,
        $installCommand
    )
}

function Resolve-UnityEditor {
    if (-not (Test-Path -LiteralPath $unityVersionFile)) {
        throw "缺少 Unity 版本文件：$unityVersionFile"
    }

    $versionLine = Get-Content -LiteralPath $unityVersionFile | Where-Object {
        $_ -match '^m_EditorVersion:\s*'
    } | Select-Object -First 1
    if (-not $versionLine) {
        throw "无法从 $unityVersionFile 读取 Unity 编辑器版本。"
    }

    $version = ($versionLine -replace '^m_EditorVersion:\s*', '').Trim()
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:UNITY_EDITOR_PATH) {
        $candidates.Add([IO.Path]::GetFullPath($env:UNITY_EDITOR_PATH))
    }
    $candidates.Add("C:\Program Files\Unity $version\Editor\Unity.exe")
    $candidates.Add("C:\Program Files\Unity Hub\Editor\$version\Editor\Unity.exe")
    $candidates.Add("C:\Program Files\Unity\Hub\Editor\$version\Editor\Unity.exe")

    if (Test-Path -LiteralPath 'C:\Program Files') {
        Get-ChildItem -LiteralPath 'C:\Program Files' -Directory -Filter 'Unity*' -ErrorAction SilentlyContinue |
            ForEach-Object { $candidates.Add((Join-Path $_.FullName 'Editor\Unity.exe')) }
    }

    $editor = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $editor) {
        throw "未找到 Unity $version。请安装对应编辑器，或先设置 UNITY_EDITOR_PATH 指向 Unity.exe。"
    }
    return $editor
}

function Assert-ApplicationIsClosed {
    $running = Get-Process -Name 'HeatTreatmentDigitalTwin', 'HeatTreatmentAdminHost' -ErrorAction SilentlyContinue
    if ($running) {
        $processList = ($running | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join '、'
        throw "打包前请先关闭正在运行的调试程序：$processList"
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw '此脚本仅支持在 Windows 开发电脑上生成安装包。'
}
if (-not (Test-Path -LiteralPath $packageFile)) {
    throw "脚本必须放在项目根目录运行，当前找不到：$packageFile"
}

$node = Resolve-RequiredCommand -Names @('node.exe', 'node') -InstallHint '未找到 Node.js，请先安装 Node.js 18 或更高版本。'
$npm = Resolve-RequiredCommand -Names @('npm.cmd', 'npm') -InstallHint '未找到 npm，请重新安装包含 npm 的 Node.js。'
$null = Resolve-RequiredCommand -Names @('dotnet.exe', 'dotnet') -InstallHint '未找到 .NET SDK，请先安装支持 .NET 8 的 SDK。'
$unityEditor = Resolve-UnityEditor
$desktopPackage = Get-Content -Raw -LiteralPath $packageFile | ConvertFrom-Json
$version = [string]$desktopPackage.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "无法从 $packageFile 读取安装包版本。"
}

Assert-ApplicationIsClosed
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

Write-Host '热处理数字孪生大屏：安装包构建' -ForegroundColor Green
Write-Host "项目目录：$projectDirectory"
Write-Host "软件版本：$version"
Write-Host "Unity：$unityEditor"
Write-Host "配置数据库：$DatabaseHost`:$DatabasePort/$DatabaseName"
Write-Host "运行历史：$(if ($IncludeHistory) { '包含' } else { '不包含，仅交付现场配置' })"

Ensure-NodeDependencies -Directory (Join-Path $projectDirectory 'backend') -Label '后端' -NpmExecutable $npm
Ensure-NodeDependencies -Directory (Join-Path $projectDirectory 'frontend') -Label '前端' -NpmExecutable $npm
Ensure-NodeDependencies -Directory $desktopDirectory -Label '桌面端' -NpmExecutable $npm

$environmentNames = @(
    'UNITY_EDITOR_PATH',
    'DESKTOP_MYSQL_HOST',
    'DESKTOP_MYSQL_PORT',
    'DESKTOP_MYSQL_USER',
    'DESKTOP_MYSQL_PASSWORD',
    'DESKTOP_MYSQL_DATABASE',
    'DESKTOP_TEMPLATE_INCLUDE_HISTORY'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    $env:UNITY_EDITOR_PATH = $unityEditor
    $env:DESKTOP_MYSQL_HOST = $DatabaseHost
    $env:DESKTOP_MYSQL_PORT = [string]$DatabasePort
    $env:DESKTOP_MYSQL_USER = $DatabaseUser
    $env:DESKTOP_MYSQL_PASSWORD = $DatabasePassword
    $env:DESKTOP_MYSQL_DATABASE = $DatabaseName
    $env:DESKTOP_TEMPLATE_INCLUDE_HISTORY = if ($IncludeHistory) { 'true' } else { 'false' }

    Invoke-CheckedCommand -Label '生成 Windows x64 客户安装包' -Executable $npm -ArgumentList @(
        '--prefix',
        $desktopDirectory,
        'run',
        'dist'
    )
} finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}

$installerName = "热处理数字孪生大屏-安装包-$version-x64.exe"
$installerPath = Join-Path $outputDirectory $installerName
if (-not (Test-Path -LiteralPath $installerPath)) {
    throw "构建命令已结束，但没有找到预期安装包：$installerPath"
}

$installer = Get-Item -LiteralPath $installerPath
if ($installer.Length -le 0) {
    throw "安装包文件为空：$installerPath"
}

$hash = Get-FileHash -LiteralPath $installerPath -Algorithm SHA256
$checksumPath = "$installerPath.sha256.txt"
Set-Content -LiteralPath $checksumPath -Encoding UTF8 -Value "$($hash.Hash.ToLowerInvariant())  $installerName"

Write-Host "`n安装包生成完成。" -ForegroundColor Green
Write-Host "安装包：$installerPath"
Write-Host "文件大小：$([Math]::Round($installer.Length / 1MB, 1)) MB"
Write-Host "SHA-256：$($hash.Hash)"
Write-Host "校验文件：$checksumPath"
