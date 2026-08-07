const crypto = require('crypto');
const cors = require('cors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isLoopbackAddress(address) {
    const value = String(address || '').trim().toLowerCase();
    return value === '::1'
        || /^(::ffff:)?127(?:\.\d{1,3}){3}$/.test(value)
        || value === 'localhost';
}

function splitList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function isLoopbackOrigin(origin) {
    try {
        const parsed = new URL(origin);
        return ['http:', 'https:'].includes(parsed.protocol)
            && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase());
    } catch (error) {
        return false;
    }
}

function createCorsMiddleware() {
    const configured = new Set(splitList(process.env.CORS_ALLOWED_ORIGINS));
    return cors({
        origin(origin, callback) {
            if (!origin || isLoopbackOrigin(origin) || configured.has(origin)) {
                callback(null, true);
                return;
            }
            callback(null, false);
        },
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Shutdown-Token'],
        maxAge: 600,
        credentials: false
    });
}

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:"
    ].join('; '));
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
    }
    next();
}

function safeTokenEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length > 0
        && leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function suppliedAdminToken(req) {
    const direct = String(req.get('x-admin-token') || '');
    if (direct) return direct;
    const authorization = String(req.get('authorization') || '');
    return authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : '';
}

function protectManagementWrites(req, res, next) {
    if (!req.path.startsWith('/api/') || SAFE_METHODS.has(req.method)) {
        next();
        return;
    }

    if (isLoopbackAddress(req.socket.remoteAddress)) {
        next();
        return;
    }

    const configuredToken = String(process.env.ADMIN_API_TOKEN || '');
    if (configuredToken && safeTokenEqual(suppliedAdminToken(req), configuredToken)) {
        next();
        return;
    }

    res.status(403).json({
        success: false,
        error: '管理修改仅允许在现场电脑本机执行；远程管理需配置 ADMIN_API_TOKEN'
    });
}

function createOperationRateLimiter(options = {}) {
    const windowMs = Math.max(1000, Number(options.windowMs || 10 * 60 * 1000));
    const limit = Math.max(1, Number(options.limit || 20));
    const entries = new Map();

    return (req, res, next) => {
        const now = Date.now();
        const key = `${req.socket.remoteAddress || 'unknown'}:${options.name || req.path}`;
        const current = entries.get(key);
        if (!current || now >= current.resetAt) {
            entries.set(key, { count: 1, resetAt: now + windowMs });
            next();
            return;
        }
        current.count += 1;
        if (current.count <= limit) {
            next();
            return;
        }
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
        res.status(429).json({ success: false, error: '操作过于频繁，请稍后再试' });
    };
}

module.exports = {
    createCorsMiddleware,
    createOperationRateLimiter,
    isLoopbackAddress,
    protectManagementWrites,
    securityHeaders
};
