const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const {
    cleanupLogArchives,
    createRotatingLogWriter
} = require('../logManager.cjs');

async function main() {
    const root = path.resolve(__dirname, '..', '..', 'output', `log-manager-${Date.now()}-${process.pid}`);
    fs.mkdirSync(root, { recursive: true });
    const current = path.join(root, 'backend.log');
    fs.writeFileSync(current, 'previous-session\n');

    const writer = await createRotatingLogWriter(root, 'backend.log', {
        maxBytes: 32,
        retentionDays: 30,
        maxArchives: 10
    });
    writer.write('12345678901234567890\n');
    writer.write('abcdefghijklmnopqrst\n');
    writer.end();
    await once(writer, 'finish');

    const initialArchives = fs.readdirSync(root).filter(name => name.endsWith('.log.gz'));
    const archivedText = initialArchives
        .map(name => zlib.gunzipSync(fs.readFileSync(path.join(root, name))).toString('utf8'))
        .join('\n');
    const currentText = fs.readFileSync(current, 'utf8');

    const agedArchive = path.join(root, 'backend-aged.log.gz');
    fs.writeFileSync(agedArchive, zlib.gzipSync('aged'));
    const agedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(agedArchive, agedAt, agedAt);
    cleanupLogArchives(root, { retentionDays: 30, maxArchives: 10 });

    for (let index = 0; index < 5; index += 1) {
        const filename = path.join(root, `backend-extra-${index}.log.gz`);
        fs.writeFileSync(filename, zlib.gzipSync(`extra-${index}`));
        const modified = new Date(Date.now() + index * 1000);
        fs.utimesSync(filename, modified, modified);
    }
    cleanupLogArchives(root, { retentionDays: 30, maxArchives: 2 });
    const finalArchives = fs.readdirSync(root).filter(name => name.endsWith('.log.gz'));

    const checks = {
        previousSessionCompressed: archivedText.includes('previous-session'),
        sizeRotationCompressed: archivedText.includes('12345678901234567890'),
        activeLogContinuesAfterRotation: currentText.includes('abcdefghijklmnopqrst'),
        expiredArchiveDeleted: !fs.existsSync(agedArchive),
        archiveCountCapped: finalArchives.length === 2
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const result = { success: failed.length === 0, checks, directory: root };
    console.log(JSON.stringify(result, null, 2));
    if (failed.length) throw new Error(`Log manager checks failed: ${failed.join(', ')}`);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
