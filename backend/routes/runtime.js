const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db/database');

const DEFAULT_LAN_DISPLAY_PORT = 8787;

function isLoopbackRequest(req) {
    const address = String(req.socket?.remoteAddress || '');
    return address === '::1' || /^(::ffff:)?127\.0\.0\.1$/.test(address);
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('投屏端口必须是 1024-65535 之间的整数');
    }
    return port;
}

function generatePin() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function normalizePin(value) {
    const pin = String(value || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(pin)) throw new Error('投屏码必须是 6 位数字');
    return pin;
}

function defaultAutoStartEnabled() {
    return String(process.env.DESKTOP_PACKAGED || '').toLowerCase() === 'true';
}

function autoStartSupported() {
    return String(process.env.DESKTOP_AUTO_START_SUPPORTED || '').toLowerCase() === 'true';
}

function packaged() {
    return String(process.env.DESKTOP_PACKAGED || '').toLowerCase() === 'true';
}

function runtimeStatus(controller, values) {
    const lanDisplay = controller.lanDisplay;
    const displayStatus = lanDisplay?.status?.() || {
        enabled: values.lan_display_enabled,
        running: false,
        port: values.lan_display_port,
        pin: values.lan_display_pin,
        urls: [],
        pairingUrls: [],
        clients: 0,
        clientList: [],
        clientDevices: [],
        error: '',
        note: '电视和现场电脑需处于同一局域网；电视端需要支持现代浏览器和 WebGL。'
    };
    return {
        success: true,
        auto_start_enabled: values.auto_start_enabled,
        auto_start_supported: autoStartSupported(),
        packaged: packaged(),
        lan_display_enabled: values.lan_display_enabled,
        lan_display_port: values.lan_display_port,
        lan_display_pin: values.lan_display_pin,
        lan_display: displayStatus
    };
}

module.exports = function createRuntimeRouter(controller = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!isLoopbackRequest(req)) {
            res.status(403).json({ success: false, error: '运行控制接口仅允许本机访问' });
            return;
        }
        next();
    });

    async function readValues({ persistDefaults = true } = {}) {
        const db = await getDb();
        const rows = await db.all(
            "SELECT `key`, `value` FROM `settings` WHERE `key` IN ('desktop_auto_start_enabled', 'lan_display_enabled', 'lan_display_port', 'lan_display_pin')"
        );
        const source = {};
        rows.forEach(row => { source[row.key] = row.value; });

        const values = {
            auto_start_enabled: parseBoolean(source.desktop_auto_start_enabled, defaultAutoStartEnabled()),
            lan_display_enabled: parseBoolean(source.lan_display_enabled, false),
            lan_display_port: Number(source.lan_display_port || DEFAULT_LAN_DISPLAY_PORT),
            lan_display_pin: /^\d{6}$/.test(String(source.lan_display_pin || ''))
                ? String(source.lan_display_pin)
                : generatePin()
        };
        if (!Number.isInteger(values.lan_display_port) || values.lan_display_port < 1024 || values.lan_display_port > 65535) {
            values.lan_display_port = DEFAULT_LAN_DISPLAY_PORT;
        }

        if (persistDefaults) {
            const defaults = {
                desktop_auto_start_enabled: String(values.auto_start_enabled),
                lan_display_enabled: String(values.lan_display_enabled),
                lan_display_port: String(values.lan_display_port),
                lan_display_pin: values.lan_display_pin
            };
            for (const [key, value] of Object.entries(defaults)) {
                if (source[key] === undefined) await db.upsert('settings', { key, value }, 'key');
            }
        }
        return values;
    }

    async function responsePayload() {
        return runtimeStatus(controller, await readValues());
    }

    router.get('/', async (req, res) => {
        try {
            res.json(await responsePayload());
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.put('/', async (req, res) => {
        try {
            const current = await readValues();
            const body = req.body || {};
            const next = {
                auto_start_enabled: body.auto_start_enabled === undefined
                    ? current.auto_start_enabled
                    : parseBoolean(body.auto_start_enabled, current.auto_start_enabled),
                lan_display_enabled: body.lan_display_enabled === undefined
                    ? current.lan_display_enabled
                    : parseBoolean(body.lan_display_enabled, current.lan_display_enabled),
                lan_display_port: body.lan_display_port === undefined
                    ? current.lan_display_port
                    : normalizePort(body.lan_display_port),
                lan_display_pin: body.lan_display_pin === undefined
                    ? current.lan_display_pin
                    : normalizePin(body.lan_display_pin)
            };
            const db = await getDb();
            const entries = {
                desktop_auto_start_enabled: String(next.auto_start_enabled),
                lan_display_enabled: String(next.lan_display_enabled),
                lan_display_port: String(next.lan_display_port),
                lan_display_pin: next.lan_display_pin
            };
            for (const [key, value] of Object.entries(entries)) {
                await db.upsert('settings', { key, value }, 'key');
            }

            if (controller.lanDisplay) {
                const displayStatus = await controller.lanDisplay.apply({
                    enabled: next.lan_display_enabled,
                    port: next.lan_display_port,
                    pin: next.lan_display_pin
                });
                if (next.lan_display_enabled && !displayStatus.running) {
                    res.status(400).json({
                        ...runtimeStatus(controller, next),
                        success: false,
                        error: displayStatus.error || '投屏服务未能启动，请检查端口是否被占用'
                    });
                    return;
                }
            }
            res.json(await responsePayload());
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    router.post('/rotate-pin', async (req, res) => {
        try {
            const current = await readValues();
            const nextPin = generatePin();
            const db = await getDb();
            await db.upsert('settings', { key: 'lan_display_pin', value: nextPin }, 'key');
            if (controller.lanDisplay) {
                const displayStatus = await controller.lanDisplay.apply({
                    enabled: current.lan_display_enabled,
                    port: current.lan_display_port,
                    pin: nextPin
                });
                if (current.lan_display_enabled && !displayStatus.running) {
                    res.status(400).json({
                        ...runtimeStatus(controller, { ...current, lan_display_pin: nextPin }),
                        success: false,
                        error: displayStatus.error || '投屏服务未能重启，请检查端口是否被占用'
                    });
                    return;
                }
            }
            res.json(await responsePayload());
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    return router;
};
