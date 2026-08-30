const assert = require('assert');

const BASE = process.env.MCP_TEST_URL || 'http://127.0.0.1:3001/api/mcp';

async function rpc(id, method, params = {}) {
    const response = await fetch(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
    return response.json();
}

(async () => {
    const init = await rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-interface-test', version: '1.0.0' }
    });
    assert.equal(init.result.serverInfo.name, 'digital-twin-control-mcp');

    const list = await rpc(2, 'tools/list');
    const toolNames = list.result.tools.map(tool => tool.name);
    for (const name of ['get_project_state', 'configure_demo_site', 'run_acceptance_checks', 'get_license_status', 'get_release_status']) {
        assert(toolNames.includes(name), `工具缺失：${name}`);
    }

    const state = await rpc(3, 'tools/call', { name: 'get_project_state', arguments: {} });
    assert.equal(state.result.isError, false);
    assert(state.result.structuredContent.designer.document.scene.views.some(view => view.id === 'device_part'));

    const checks = await rpc(4, 'tools/call', { name: 'run_acceptance_checks', arguments: {} });
    assert.equal(checks.result.structuredContent.success, true);
    assert(checks.result.structuredContent.checks.every(check => check.passed), '存在未通过的 MCP 验收项');

    const license = await rpc(5, 'tools/call', { name: 'get_license_status', arguments: {} });
    assert.equal(license.result.structuredContent.readOnly, true);

    const release = await rpc(6, 'tools/call', { name: 'get_release_status', arguments: {} });
    assert.equal(release.result.structuredContent.mode, 'offline_signed_package');

    console.log(JSON.stringify({ success: true, protocolVersion: init.result.protocolVersion, tools: toolNames.length, checks: checks.result.structuredContent.checks.length }, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
