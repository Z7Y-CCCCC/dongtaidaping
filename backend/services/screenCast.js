/**
 * 屏幕捕获 → H.264/MPEG-TS 直播流 → DLNA 电视。
 *
 * DLNA 电视只会“播一个媒体地址”，不会打开网页，所以真正的一键投屏必须由本机
 * 把大屏画面实时编码成视频流，再把流地址交给电视。本服务负责：
 *   1. 找到可用的 ffmpeg；
 *   2. 起一个只在局域网内可访问的 HTTP 流服务（/cast/<token>/live.ts）；
 *   3. 电视来拉流时，为它单独拉起一路 ffmpeg（gdigrab 只抓 Unity 窗口），断开即回收；
 *   4. 通过 AVTransport 让电视开始/停止播放。
 *
 * 正式安装包内置固定版本的 LGPL FFmpeg；开发环境未准备资源时会明确提示。
 */

const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dlna = require('./dlnaClient');
const { ipv4ToLong, isPrivateIpv4, listLanIpv4Interfaces } = require('../utils/lanNetwork');

const DEFAULT_STREAM_PORT = 8788;
const STREAM_TITLE = '热处理数字孪生大屏';
const DEFAULT_WINDOW_TITLE = 'Heat Treatment Digital Twin';

function candidateFfmpegPaths() {
    const root = path.resolve(__dirname, '..', '..');
    return [
        process.env.FFMPEG_PATH,
        path.join(root, 'desktop', 'resources', 'ffmpeg', 'ffmpeg.exe'),
        path.join(root, 'backend', 'vendor', 'ffmpeg', 'ffmpeg.exe'),
        path.join(process.resourcesPath || root, 'ffmpeg', 'ffmpeg.exe'),
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    ].filter(Boolean);
}

function runFfmpegCommand(command, args, timeout = 5000) {
    return new Promise(resolve => {
        execFile(command, args, {
            timeout,
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024
        }, (error, stdout = '', stderr = '') => resolve({ error, stdout, stderr }));
    });
}

async function probeFfmpeg(command) {
    const version = await runFfmpegCommand(command, ['-version']);
    if (version.error) {
        return { available: false, executable: false, reason: version.error.message };
    }
    const encoders = await runFfmpegCommand(command, ['-hide_banner', '-encoders']);
    if (encoders.error) {
        return { available: false, executable: true, reason: encoders.error.message };
    }
    const hasMediaFoundationH264 = /\bh264_mf\b/.test(`${encoders.stdout}\n${encoders.stderr}`);
    return {
        available: hasMediaFoundationH264,
        executable: true,
        reason: hasMediaFoundationH264 ? '' : '该 FFmpeg 不包含 Windows Media Foundation h264_mf 编码器',
        version: String(version.stdout || version.stderr).split(/\r?\n/)[0].trim()
    };
}

function buildEncoderArgs(options, windowTitle) {
    const { frameRate, width, height, bitrateKbps } = options;
    return [
        '-hide_banner', '-loglevel', 'error',
        '-thread_queue_size', '512',
        '-f', 'gdigrab', '-framerate', String(frameRate), '-draw_mouse', '0',
        '-rtbufsize', '256M', '-i', `title=${windowTitle}`,
        // 电视对纯视频的 TS 容错参差不齐，补一路静音音轨兼容性最好。
        '-thread_queue_size', '512',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
            + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=nv12`,
        // h264_mf 使用 Windows 自带 Media Foundation，无独显也可用；不依赖 GPL libx264。
        '-c:v', 'h264_mf', '-rate_control', 'cbr', '-scenario', 'display_remoting',
        // Media Foundation 只接受数字枚举：77 = Main Profile，41 = Level 4.1。
        // 相比默认可能选择的 High Profile，老款电视的硬解兼容性更好。
        '-profile:v', '77', '-level:v', '41',
        '-b:v', `${bitrateKbps}k`, '-maxrate', `${bitrateKbps}k`, '-bufsize', `${Math.round(bitrateKbps / 2)}k`,
        // 每秒一个关键帧，电视中途接入也能尽快出画面；关闭 B 帧降低延迟。
        '-g', String(frameRate), '-bf', '0', '-flags', '+low_delay',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        '-f', 'mpegts', '-mpegts_flags', '+resend_headers',
        '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1',
        'pipe:1'
    ];
}

/** 找出能直连目标电视的那张网卡的地址；多网卡（有线 + WiFi + 虚拟网卡）时很关键。 */
function pickLocalAddressFor(targetIp) {
    const interfaces = listLanIpv4Interfaces();
    if (!interfaces.length) return '';

    if (targetIp) {
        const target = ipv4ToLong(targetIp);
        const sameSubnet = interfaces.find(entry => {
            if (target == null || !entry.netmask) return false;
            const mask = ipv4ToLong(entry.netmask);
            const local = ipv4ToLong(entry.address);
            return mask != null && local != null && (local & mask) === (target & mask);
        });
        if (sameSubnet) return sameSubnet.address;
    }
    const priv = interfaces.find(entry => isPrivateIpv4(entry.address));
    return (priv || interfaces[0]).address;
}

class ScreenCastService {
    constructor({ port = DEFAULT_STREAM_PORT, windowTitle = process.env.CAST_WINDOW_TITLE } = {}) {
        const requested = Number(port);
        // 0 表示交给系统随机分配端口（自测用），不能被当成“没填”而回落到默认值。
        this.port = Number.isInteger(requested) && requested >= 0 && requested <= 65535
            ? requested
            : DEFAULT_STREAM_PORT;
        this.server = null;
        this.ffmpegPath = '';
        this.ffmpegVersion = '';
        this.ffmpegProbeError = '';
        this.ffmpegChecked = false;
        this.ffmpegCheckedAt = 0;
        this.ffmpegProbePromise = null;
        this.windowTitle = String(windowTitle || DEFAULT_WINDOW_TITLE).trim() || DEFAULT_WINDOW_TITLE;
        this.streamToken = '';
        this.session = null;
        this.encoders = new Set();
        this.error = '';
        this.options = {
            frameRate: 20,
            width: 1920,
            height: 1080,
            bitrateKbps: 8000
        };
    }

    async resolveFfmpeg({ force = false } = {}) {
        if (this.ffmpegPath && !force) return this.ffmpegPath;
        // 开发时把 FFmpeg 放进目录后无需重启后端；失败结果只缓存几秒。
        const missingRetryDue = !this.ffmpegPath && Date.now() - this.ffmpegCheckedAt >= 5000;
        if (this.ffmpegChecked && !force && !missingRetryDue) return this.ffmpegPath;
        if (this.ffmpegProbePromise) return this.ffmpegProbePromise;

        this.ffmpegProbePromise = (async () => {
            this.ffmpegPath = '';
            this.ffmpegVersion = '';
            this.ffmpegProbeError = '';
            for (const candidate of new Set(candidateFfmpegPaths())) {
                const isBarePath = path.dirname(candidate) === '.';
                if (!isBarePath && !fs.existsSync(candidate)) continue;
                const probe = await probeFfmpeg(candidate);
                if (probe.available) {
                    this.ffmpegPath = candidate;
                    this.ffmpegVersion = probe.version || '';
                    this.ffmpegProbeError = '';
                    break;
                }
                if (probe.executable && probe.reason) this.ffmpegProbeError = probe.reason;
            }
            if (!this.ffmpegPath && !this.ffmpegProbeError) {
                this.ffmpegProbeError = '没有在程序资源目录或系统 PATH 中找到 ffmpeg';
            }
            this.ffmpegChecked = true;
            this.ffmpegCheckedAt = Date.now();
            return this.ffmpegPath;
        })().finally(() => { this.ffmpegProbePromise = null; });
        return this.ffmpegProbePromise;
    }

    async assertCaptureTarget() {
        if (process.platform !== 'win32') {
            throw new Error('Unity 原生大屏投屏目前只支持 Windows');
        }
        const result = await runFfmpegCommand(this.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'gdigrab', '-framerate', '1', '-draw_mouse', '0',
            '-i', `title=${this.windowTitle}`,
            '-frames:v', '1', '-f', 'null', 'NUL'
        ], 8000);
        if (!result.error) return;

        const detail = String(result.stderr || result.error.message || '').trim().replace(/\s+/g, ' ');
        if (/find window|window.*not found|can't find|could not find/i.test(detail)) {
            throw new Error(`没有找到 Unity 大屏窗口“${this.windowTitle}”。请先启动原生大屏，再点击投屏`);
        }
        throw new Error(`无法读取 Unity 大屏窗口“${this.windowTitle}”：${detail || result.error.message}`);
    }

    async ensureStreamServer() {
        if (this.server) return;
        if (!this.streamToken) this.streamToken = crypto.randomBytes(12).toString('hex');
        const server = http.createServer((req, res) => this.handleStreamRequest(req, res));
        await new Promise((resolve, reject) => {
            const onError = error => { server.off('listening', onListening); reject(error); };
            const onListening = () => { server.off('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(this.port, '0.0.0.0');
        });
        // 电视一路直播会挂很久，别让 Node 的默认超时把它掐了。
        server.timeout = 0;
        server.headersTimeout = 0;
        server.requestTimeout = 0;
        this.server = server;
        // 端口传 0 时以系统实际分配的为准，否则给电视的地址会指向错误端口。
        this.port = server.address().port;
    }

    streamPath() {
        return `/cast/${this.streamToken}/live.ts`;
    }

    streamUrl(deviceAddress) {
        const host = pickLocalAddressFor(deviceAddress);
        if (!host) throw new Error('本机没有可用的局域网 IPv4 地址，无法向电视提供画面');
        return `http://${host}:${this.port}${this.streamPath()}`;
    }

    handleStreamRequest(req, res) {
        const pathname = (req.url || '/').split('?')[0];
        if (pathname !== this.streamPath()) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.statusCode = 405;
            res.setHeader('Allow', 'GET, HEAD');
            res.end('method not allowed');
            return;
        }
        const session = this.session;
        if (!session) {
            res.statusCode = 410;
            res.end('cast session ended');
            return;
        }

        res.setHeader('Content-Type', session.mimeType || 'video/mp2t');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'close');
        // 直播长度未知，明确告诉电视不要试图 seek。
        res.setHeader('transferMode.dlna.org', 'Streaming');
        res.setHeader(
            'contentFeatures.dlna.org',
            'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8D500000000000000000000000000000'
        );
        res.setHeader('Accept-Ranges', 'none');
        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        const encoder = this.spawnEncoder();
        if (!encoder) {
            res.statusCode = 503;
            res.end('encoder unavailable');
            return;
        }

        this.encoders.add(encoder);
        session.viewers += 1;
        session.streamRequests += 1;
        session.state = 'casting';
        session.firstViewerAt ||= Date.now();
        session.lastViewerAt = Date.now();
        session.retryCount = 0;
        session.lastReconnectError = '';
        this.clearPlaybackRetry(session);
        this.error = '';

        const cleanup = () => {
            if (!this.encoders.delete(encoder)) return;
            session.viewers = Math.max(0, session.viewers - 1);
            session.lastViewerAt = Date.now();
            encoder.castExpectedStop = true;
            try { encoder.kill('SIGKILL'); } catch (error) { /* 已退出 */ }
            if (this.session === session && session.viewers === 0) {
                session.state = 'waiting_for_tv';
                this.schedulePlaybackRetry(session, 5000);
            }
        };

        res.flushHeaders?.();
        encoder.stdout.pipe(res);
        encoder.stdout.on('error', cleanup);
        encoder.on('exit', () => { try { res.end(); } catch (error) { /* 已关闭 */ } cleanup(); });
        res.on('close', cleanup);
        res.on('error', cleanup);
    }

    spawnEncoder() {
        if (!this.ffmpegPath) return null;
        const args = buildEncoderArgs(this.options, this.windowTitle);
        const child = spawn(this.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.castExpectedStop = false;
        let latestError = '';
        child.stderr.on('data', chunk => {
            const text = chunk.toString('utf8').trim();
            if (text) {
                latestError = `${latestError}\n${text}`.trim().slice(-4000);
                console.warn(`[投屏编码] ${text}`);
            }
        });
        child.on('error', error => {
            this.error = `屏幕编码进程启动失败：${error.message}`;
            console.error(`[投屏编码] ${this.error}`);
        });
        child.on('exit', code => {
            if (!child.castExpectedStop && code !== 0) {
                const detail = latestError.replace(/\s+/g, ' ').trim();
                this.error = `Unity 大屏画面编码中断${detail ? `：${detail}` : `（代码 ${code}）`}`;
                console.error(`[投屏编码] ${this.error}`);
            }
        });
        return child;
    }

    stopEncoders() {
        for (const encoder of this.encoders) {
            encoder.castExpectedStop = true;
            try { encoder.kill('SIGKILL'); } catch (error) { /* 已退出 */ }
        }
        this.encoders.clear();
    }

    clearPlaybackRetry(session) {
        if (!session?.retryTimer) return;
        clearTimeout(session.retryTimer);
        session.retryTimer = null;
    }

    schedulePlaybackRetry(session, delayMs = 12000) {
        if (!session || this.session !== session || session.viewers > 0 || session.retryTimer) return;
        session.retryTimer = setTimeout(() => {
            session.retryTimer = null;
            this.retryPlayback(session).catch(error => {
                console.warn(`[投屏] 自动重连异常：${error.message}`);
            });
        }, delayMs);
        session.retryTimer.unref?.();
    }

    async retryPlayback(session) {
        if (this.session !== session || session.viewers > 0) return;
        if (session.retryCount >= 2) {
            session.state = 'waiting_for_tv';
            if (!session.firstViewerAt) {
                this.error = '电视已收到投屏控制命令，但没有连接视频流。请检查电视是否允许外部媒体播放，以及 Windows 防火墙是否允许本程序访问局域网。';
            }
            return;
        }

        session.retryCount += 1;
        session.state = 'reconnecting';
        try {
            const playback = await dlna.startPlayback(session.device, {
                url: session.url,
                title: STREAM_TITLE,
                mimeType: session.mimeType
            });
            if (this.session !== session) return;
            session.metadataMode = playback.metadataMode;
            session.lastReconnectError = '';
            session.state = session.viewers > 0 ? 'casting' : 'waiting_for_tv';
            if (session.viewers === 0) this.schedulePlaybackRetry(session, 15000);
        } catch (error) {
            if (this.session !== session) return;
            session.lastReconnectError = error.message;
            session.state = 'reconnect_failed';
            this.error = `电视连接中断，自动重连失败：${error.message}`;
            this.schedulePlaybackRetry(session, 15000);
        }
    }

    async start(device) {
        if (!device?.avTransportUrl) throw new Error('该设备没有提供 AVTransport 控制地址，无法投屏');
        const ffmpeg = await this.resolveFfmpeg();
        if (!ffmpeg) {
            throw new Error(
                '内置 FFmpeg 投屏编码器未就绪，无法把 Unity 大屏转换成电视能播放的视频流。'
                + (this.ffmpegProbeError ? ` ${this.ffmpegProbeError}。` : '')
                + '开发环境请在 desktop 目录运行 npm run prepare:ffmpeg 后重启后端。'
            );
        }
        await this.assertCaptureTarget();

        if (this.session) await this.stop().catch(() => {});
        await this.ensureStreamServer();
        this.streamToken = crypto.randomBytes(12).toString('hex');

        const url = this.streamUrl(device.address);
        let sinkProtocols = [];
        try {
            sinkProtocols = await dlna.getSinkProtocolInfo(device);
        } catch (error) {
            // ConnectionManager 并非所有电视都完整实现；读取失败时使用通用类型继续。
        }
        const mimeType = dlna.chooseVideoMimeType(sinkProtocols);
        this.error = '';
        const session = {
            device,
            deviceId: device.id,
            deviceName: device.name,
            deviceAddress: device.address,
            url,
            mimeType,
            sinkProtocols,
            metadataMode: 'full',
            state: 'starting',
            startedAt: Date.now(),
            viewers: 0,
            streamRequests: 0,
            retryCount: 0,
            retryTimer: null,
            firstViewerAt: 0,
            lastViewerAt: 0,
            lastReconnectError: ''
        };
        // Play 调用返回前电视就可能开始 GET，先登记临时会话，避免把合法请求当成过期流。
        this.session = session;
        try {
            const playback = await dlna.startPlayback(device, { url, title: STREAM_TITLE, mimeType });
            session.metadataMode = playback.metadataMode;
        } catch (error) {
            if (this.session === session) this.session = null;
            this.stopEncoders();
            this.error = error.message;
            throw error;
        }
        session.state = session.viewers > 0 ? 'casting' : 'waiting_for_tv';
        this.schedulePlaybackRetry(session);
        console.log(`[投屏] 已推送到电视「${device.name}」(${device.address})：${url}`);
        return this.status();
    }

    async stop() {
        const session = this.session;
        this.session = null;
        this.clearPlaybackRetry(session);
        this.stopEncoders();
        if (session?.device) {
            // 电视可能已经关机或换了输入源，停不下来不算失败。
            try { await dlna.stopPlayback(session.device); } catch (error) { /* 忽略 */ }
            console.log(`[投屏] 已停止推送到「${session.deviceName}」`);
        }
        this.error = '';
        return this.status();
    }

    async close() {
        await this.stop();
        const server = this.server;
        this.server = null;
        this.streamToken = '';
        if (!server) return;
        await new Promise(resolve => {
            try { server.close(() => resolve()); } catch (error) { resolve(); }
        });
    }

    status() {
        return {
            ffmpegChecked: this.ffmpegChecked,
            ffmpegChecking: Boolean(this.ffmpegProbePromise),
            ffmpegAvailable: Boolean(this.ffmpegPath),
            ffmpegPath: this.ffmpegPath,
            ffmpegVersion: this.ffmpegVersion,
            ffmpegError: this.ffmpegProbeError,
            encoder: 'h264_mf',
            captureWindowTitle: this.windowTitle,
            streamPort: this.port,
            casting: Boolean(this.session),
            session: this.session
                ? {
                    deviceId: this.session.deviceId,
                    deviceName: this.session.deviceName,
                    deviceAddress: this.session.deviceAddress,
                    url: this.session.url,
                    mimeType: this.session.mimeType,
                    metadataMode: this.session.metadataMode,
                    state: this.session.state,
                    startedAt: new Date(this.session.startedAt).toISOString(),
                    viewers: this.session.viewers,
                    streamRequests: this.session.streamRequests,
                    retryCount: this.session.retryCount,
                    firstViewerAt: this.session.firstViewerAt ? new Date(this.session.firstViewerAt).toISOString() : '',
                    lastViewerAt: this.session.lastViewerAt ? new Date(this.session.lastViewerAt).toISOString() : '',
                    lastReconnectError: this.session.lastReconnectError
                }
                : null,
            error: this.error
        };
    }
}

module.exports = ScreenCastService;
module.exports.pickLocalAddressFor = pickLocalAddressFor;
module.exports.buildEncoderArgs = buildEncoderArgs;
module.exports.DEFAULT_WINDOW_TITLE = DEFAULT_WINDOW_TITLE;
