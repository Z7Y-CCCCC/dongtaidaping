#!/usr/bin/env node

const net = require('net');

const commandType = process.argv[2];
const paramsText = process.argv[3] || '{}';

if (!commandType) {
    console.error('Usage: node tools/blender_mcp_client.cjs <command-type> [params-json]');
    process.exit(2);
}

let params;
try {
    params = JSON.parse(paramsText);
} catch (error) {
    console.error(`Invalid params JSON: ${error.message}`);
    process.exit(2);
}

const host = process.env.BLENDER_MCP_HOST || '127.0.0.1';
const port = Number(process.env.BLENDER_MCP_PORT || 9876);
const timeoutMs = Number(process.env.BLENDER_MCP_TIMEOUT_MS || 60000);
const command = { type: commandType, params };

const client = net.createConnection({ host, port });
let responseText = '';
let settled = false;

function finish(exitCode, message) {
    if (settled) return;
    settled = true;
    if (message) {
        const output = exitCode === 0 ? process.stdout : process.stderr;
        output.write(`${message}\n`);
    }
    client.destroy();
    process.exitCode = exitCode;
}

client.setTimeout(timeoutMs);
client.on('connect', () => client.write(JSON.stringify(command)));
client.on('data', chunk => {
    responseText += chunk.toString('utf8');
    try {
        const response = JSON.parse(responseText);
        finish(response?.status === 'error' ? 1 : 0, JSON.stringify(response, null, 2));
    } catch {
        // The Blender add-on sends an unframed JSON object. Keep collecting until it parses.
    }
});
client.on('timeout', () => finish(1, `Blender MCP timed out after ${timeoutMs} ms`));
client.on('error', error => finish(1, `Blender MCP connection failed: ${error.message}`));
