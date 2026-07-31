const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');

const router = express.Router();
const uploadsRootDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, '..', 'uploads');
const audioDir = path.join(uploadsRootDir, 'audio');
const generatorScript = path.join(__dirname, '..', 'scripts', 'generate-voice.ps1');
const allowedAudioExtensions = new Set(['.wav', '.mp3', '.ogg', '.m4a']);

fs.mkdirSync(audioDir, { recursive: true });

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function generatedFilename(extension = '.wav') {
    const token = crypto.randomBytes(6).toString('hex');
    return `voice-${Date.now()}-${token}${extension}`;
}

function audioPublicUrl(filename) {
    return `/uploads/audio/${encodeURIComponent(filename)}`;
}

function powershellExecutable() {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const bundled = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fs.existsSync(bundled) ? bundled : 'powershell.exe';
}

function runPowerShell(args, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const child = spawn(powershellExecutable(), [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            generatorScript,
            ...args
        ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = [];
        const stderr = [];
        let settled = false;

        const finish = (error, output = '') => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(output);
        };

        child.stdout.on('data', chunk => {
            if (Buffer.concat(stdout).length < 1024 * 1024) stdout.push(chunk);
        });
        child.stderr.on('data', chunk => {
            if (Buffer.concat(stderr).length < 1024 * 1024) stderr.push(chunk);
        });
        child.once('error', error => finish(error));
        child.once('close', code => {
            const output = Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim();
            const errorText = Buffer.concat(stderr).toString('utf8').replace(/^\uFEFF/, '').trim();
            if (code !== 0) {
                finish(new Error(errorText || output || `Windows 语音生成进程退出码 ${code}`));
                return;
            }
            finish(null, output);
        });

        const timer = setTimeout(() => {
            try { child.kill(); } catch (error) { /* ignore */ }
            finish(new Error('Windows 语音生成超时'));
        }, timeoutMs);
        timer.unref?.();
    });
}

const upload = multer({
    storage: multer.diskStorage({
        destination: audioDir,
        filename: (req, file, callback) => {
            const extension = path.extname(file.originalname || '').toLowerCase();
            callback(null, generatedFilename(extension));
        }
    }),
    fileFilter: (req, file, callback) => {
        const extension = path.extname(file.originalname || '').toLowerCase();
        if (!allowedAudioExtensions.has(extension)) {
            callback(new Error('仅支持 WAV、MP3、OGG、M4A 语音文件'));
            return;
        }
        callback(null, true);
    },
    limits: { fileSize: 20 * 1024 * 1024, files: 1 }
});

function receiveAudio(req, res, next) {
    upload.single('audioFile')(req, res, error => {
        if (!error) {
            next();
            return;
        }
        if (req.file?.path) fs.rmSync(req.file.path, { force: true });
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? '语音文件不能超过 20 MB'
            : error.message;
        res.status(400).json({ success: false, error: message });
    });
}

let voiceListCache = null;
let voiceListCacheAt = 0;

router.get('/voices', async (req, res) => {
    if (process.platform !== 'win32') {
        res.json({ success: true, supported: false, voices: [] });
        return;
    }
    try {
        if (voiceListCache && Date.now() - voiceListCacheAt < 10 * 60 * 1000) {
            res.json({ success: true, supported: true, voices: voiceListCache });
            return;
        }
        const output = await runPowerShell(['-ListVoices']);
        const parsed = output ? JSON.parse(output) : [];
        voiceListCache = Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
        voiceListCacheAt = Date.now();
        res.json({ success: true, supported: true, voices: voiceListCache });
    } catch (error) {
        res.status(500).json({ success: false, supported: false, voices: [], error: error.message });
    }
});

router.post('/generate', async (req, res) => {
    if (process.platform !== 'win32') {
        res.status(400).json({ success: false, error: '语音文件自动生成目前仅支持 Windows' });
        return;
    }

    const text = String(req.body?.text || '').trim();
    if (!text) {
        res.status(400).json({ success: false, error: '请输入需要播报的文字' });
        return;
    }
    if (text.length > 500) {
        res.status(400).json({ success: false, error: '单条播报文字不能超过 500 个字符' });
        return;
    }

    const voiceName = String(req.body?.voice_name || '').trim().slice(0, 200);
    const browserRate = clampNumber(req.body?.rate, 0.5, 2, 1);
    const sapiRate = Math.round((browserRate - 1) * 6);
    const volume = Math.round(clampNumber(req.body?.volume, 0, 1, 1) * 100);
    const filename = generatedFilename('.wav');
    const destination = path.join(audioDir, filename);

    try {
        const args = [
            '-TextBase64', Buffer.from(text, 'utf8').toString('base64'),
            '-OutputPath', destination,
            '-Rate', String(sapiRate),
            '-Volume', String(volume)
        ];
        if (voiceName) args.push('-VoiceName', voiceName);
        await runPowerShell(args);
        const stat = fs.statSync(destination);
        if (!stat.isFile() || stat.size <= 44) throw new Error('生成的 WAV 文件无有效音频内容');
        res.json({
            success: true,
            filename,
            url: audioPublicUrl(filename),
            size: stat.size,
            voice_name: voiceName,
            text
        });
    } catch (error) {
        fs.rmSync(destination, { force: true });
        res.status(500).json({ success: false, error: `语音文件生成失败：${error.message}` });
    }
});

router.post('/upload', receiveAudio, (req, res) => {
    if (!req.file) {
        res.status(400).json({ success: false, error: '请选择语音文件' });
        return;
    }
    res.json({
        success: true,
        filename: req.file.filename,
        original_name: req.file.originalname,
        url: audioPublicUrl(req.file.filename),
        size: req.file.size
    });
});

module.exports = router;
