const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const projects = [
    { label: 'frontend', directory: path.join(projectDir, 'frontend') },
    { label: 'backend', directory: path.join(projectDir, 'backend') }
];
const packages = new Map();

function normalizeLicense(value) {
    if (Array.isArray(value)) return value.map(normalizeLicense).filter(Boolean).join(' OR ');
    if (value && typeof value === 'object') return normalizeLicense(value.type);
    return typeof value === 'string' ? value.trim() : '';
}

function repositoryUrl(value) {
    if (typeof value === 'string') return value;
    return value?.url || '';
}

function readLicenseFile(packageDirectory, declaredLicense) {
    const filenames = fs.readdirSync(packageDirectory);
    const declaredMatch = declaredLicense.match(/^SEE LICEN[CS]E IN (.+)$/i);
    const candidates = [
        ...(declaredMatch ? [path.basename(declaredMatch[1].trim())] : []),
        ...filenames.filter(filename => /^LICEN[CS]E(?:\..+)?$/i.test(filename))
    ];
    const filename = candidates.find(candidate => fs.existsSync(path.join(packageDirectory, candidate)));
    if (!filename) return { filename: '', text: '' };
    return {
        filename,
        text: fs.readFileSync(path.join(packageDirectory, filename), 'utf8').trim().replace(/[ \t]+$/gm, '')
    };
}

function readPackageMetadata(name, info) {
    if (!info.version || !info.path) return null;
    const packageDirectory = path.resolve(info.path);
    const manifestPath = path.join(packageDirectory, 'package.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let license = normalizeLicense(manifest.license || info.license);
    const licenseFile = readLicenseFile(packageDirectory, license);
    if (!license && /Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(licenseFile.text)) {
        license = 'MIT';
    }

    return {
        name: manifest.name || name,
        version: manifest.version || info.version,
        license: license || (licenseFile.text ? 'See included license text' : 'UNKNOWN'),
        repository: repositoryUrl(manifest.repository || info.repository),
        licenseFilename: licenseFile.filename,
        licenseText: licenseFile.text
    };
}

function collectDependencies(dependencies = {}) {
    Object.entries(dependencies).forEach(([name, info]) => {
        const metadata = readPackageMetadata(name, info);
        if (metadata) {
            const key = `${metadata.name}@${metadata.version}`;
            if (!packages.has(key)) packages.set(key, metadata);
        }
        collectDependencies(info.dependencies);
    });
}

projects.forEach(({ directory }) => {
    const npmCli = process.env.npm_execpath
        || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const output = execFileSync(process.execPath, [npmCli, 'ls', '--omit=dev', '--all', '--json', '--long'], {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    collectDependencies(JSON.parse(output).dependencies);
});

const lines = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '============================',
    '',
    'This product includes the following installed production packages. License',
    'metadata and upstream license files are captured from the build environment.',
    'Electron and Chromium notices are distributed in their own license files.',
    '',
    ...Array.from(packages.values())
        .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
        .flatMap(item => [
            `${item.name}@${item.version}`,
            `License: ${item.license}`,
            ...(item.repository ? [`Repository: ${item.repository}`] : []),
            ...(item.licenseText ? [
                `License file: ${item.licenseFilename}`,
                '----- BEGIN UPSTREAM LICENSE TEXT -----',
                item.licenseText,
                '----- END UPSTREAM LICENSE TEXT -----'
            ] : []),
            ''
        ])
];

const unknownPackages = Array.from(packages.values()).filter(item => item.license === 'UNKNOWN');
if (unknownPackages.length > 0) {
    throw new Error(`无法确定以下依赖的许可证：${unknownPackages.map(item => `${item.name}@${item.version}`).join(', ')}`);
}

const outputPath = path.join(desktopDir, 'THIRD_PARTY_NOTICES.txt');
fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log(`已生成第三方依赖清单：${outputPath} (${packages.size} packages)`);
