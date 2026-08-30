const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'release-manifest.json');

function loadReleaseManifest() {
    let source = {};
    try {
        source = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } catch (error) {
        source = {};
    }
    return {
        productName: String(source.productName || '热处理数字孪生大屏'),
        productVersion: String(source.productVersion || '0.0.0'),
        configurationVersion: String(source.configurationVersion || '0.0.0'),
        dashboardSchemaVersion: Number(source.dashboardSchemaVersion || 0),
        businessDataContractVersion: Number(source.businessDataContractVersion || 0),
        releaseChannel: String(process.env.RELEASE_CHANNEL || source.releaseChannel || 'source'),
        buildCommit: String(process.env.BUILD_COMMIT || 'unknown'),
        buildTime: String(process.env.BUILD_TIME || '') || null
    };
}

module.exports = { MANIFEST_PATH, loadReleaseManifest };
