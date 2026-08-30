const express = require('express');
const { getDb, getDbStatus, getDatabaseBackupStatus } = require('../db/database');
const { getHeatTreatmentTemplatePacks } = require('../services/heatTreatmentTemplates');
const { loadReleaseManifest } = require('../services/releaseManifest');
const { getLicenseStatus } = require('../services/license');

const router = express.Router();

async function countRows(db, table) {
    try {
        const row = await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
        return Number(row?.count || 0);
    } catch (error) {
        return null;
    }
}

router.get('/', async (req, res) => {
    const dbStatus = getDbStatus();
    const backupStatus = getDatabaseBackupStatus();
    const engineStatus = global.dataEngine?.getStatus?.() || null;
    const wsServer = global.wsServer;
    const unityClients = wsServer?.countClients?.('unity') || 0;
    const collector = engineStatus?.collectorStatus || {};
    const collectorAgeMs = collector.lastFrameAt ? Math.max(0, Date.now() - Number(collector.lastFrameAt)) : null;
    const collectorFresh = collectorAgeMs !== null && collectorAgeMs <= 15000;
    const templatePacks = getHeatTreatmentTemplatePacks();
    const license = getLicenseStatus();
    let releaseCount = null;
    let deviceCount = null;
    try {
        const db = await getDb();
        [releaseCount, deviceCount] = await Promise.all([
            countRows(db, 'releases'),
            countRows(db, 'devices')
        ]);
    } catch (error) {
        // Database status below contains the actionable failure detail.
    }
    const checks = {
        database: {
            passed: dbStatus.connected === true,
            status: dbStatus.connected ? 'connected' : 'error',
            detail: dbStatus.error || null
        },
        collector: {
            passed: !!engineStatus?.mode && ['connected', 'simulating'].includes(String(collector.status || '').toLowerCase()) && collectorFresh,
            mode: engineStatus?.mode || null,
            status: collector.status || 'not_started',
            fresh: collectorFresh,
            ageMs: collectorAgeMs
        },
        dashboardRelease: {
            passed: Number(releaseCount) > 0,
            currentReleaseCount: releaseCount,
            configurationVersion: loadReleaseManifest().configurationVersion
        },
        deviceConfiguration: {
            passed: Number(deviceCount) > 0,
            configuredDevices: deviceCount
        },
        templateLibrary: {
            passed: templatePacks.length > 0,
            packCount: templatePacks.length
        },
        backup: {
            passed: backupStatus.supported === true,
            supported: backupStatus.supported === true,
            type: backupStatus.type || null
        },
        license: {
            passed: !license.enforce || license.valid,
            enforce: license.enforce,
            configured: license.configured,
            valid: license.valid,
            status: license.status,
            expiresAt: license.expiresAt,
            reason: license.reason
        },
        unity: {
            passed: unityClients > 0,
            status: unityClients > 0 ? 'connected' : 'offline',
            clients: unityClients
        }
    };
    const configurationChecks = ['database', 'collector', 'dashboardRelease', 'deviceConfiguration', 'templateLibrary', 'backup'];
    if (license.enforce) configurationChecks.push('license');
    const configurationReady = configurationChecks.every(key => checks[key].passed);
    const displayReady = configurationReady && checks.unity.passed;
    res.json({
        success: true,
        readOnly: true,
        generatedAt: new Date().toISOString(),
        version: loadReleaseManifest(),
        configurationReady,
        displayReady,
        blockingFailures: Object.entries(checks).filter(([, check]) => !check.passed).map(([key]) => key),
        checks
    });
});

module.exports = router;
