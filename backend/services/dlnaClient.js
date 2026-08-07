/**
 * DLNA AVTransport 控制端。
 *
 * 电视被发现之后，投屏其实就是三条 SOAP 调用：
 *   SetAVTransportURI → 告诉电视去哪儿拉流
 *   Play              → 开始播放
 *   Stop              → 结束投屏
 *
 * 注意 DLNA 只能播媒体，不能让电视去打开一个网页——这也是为什么大屏必须
 * 先被编码成视频流（见 screenCast.js），而不是把后台地址丢给电视。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SOAP_TIMEOUT_MS = 8000;

function escapeXml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * DLNA.ORG_FLAGS 的高位标记这是一路“实时流”：不可 seek、长度未知。
 * 少了这段元数据，不少电视会拒播或者一直转圈。
 */
function buildLiveVideoMetadata({ url, title, mimeType = 'video/mp2t' }) {
    const protocolInfo = `http-get:*:${mimeType}:`
        + 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;'
        + 'DLNA.ORG_FLAGS=8D500000000000000000000000000000';
    return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"'
        + ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
        + ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"'
        + ' xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">'
        + '<item id="live-dashboard" parentID="0" restricted="1">'
        + `<dc:title>${escapeXml(title)}</dc:title>`
        + '<upnp:class>object.item.videoItem</upnp:class>'
        + `<res protocolInfo="${protocolInfo}">${escapeXml(url)}</res>`
        + '</item>'
        + '</DIDL-Lite>';
}

function soapRequest({ controlUrl, serviceType, action, args }) {
    const body = '<?xml version="1.0" encoding="utf-8"?>'
        + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
        + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        + '<s:Body>'
        + `<u:${action} xmlns:u="${serviceType}">`
        + Object.entries(args).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join('')
        + `</u:${action}>`
        + '</s:Body>'
        + '</s:Envelope>';

    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(controlUrl);
        } catch (error) {
            reject(new Error(`电视控制地址无效：${controlUrl}`));
            return;
        }
        const client = target.protocol === 'https:' ? https : http;
        const payload = Buffer.from(body, 'utf8');
        const request = client.request(
            target,
            {
                method: 'POST',
                timeout: SOAP_TIMEOUT_MS,
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    'Content-Length': payload.length,
                    SOAPACTION: `"${serviceType}#${action}"`,
                    Connection: 'close'
                }
            },
            response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (response.statusCode === 200) {
                        resolve(text);
                        return;
                    }
                    const description = /<errorDescription>([\s\S]*?)<\/errorDescription>/i.exec(text)?.[1];
                    const code = /<errorCode>([\s\S]*?)<\/errorCode>/i.exec(text)?.[1];
                    const error = new Error(
                        description
                            ? `电视拒绝了 ${action}：${description}${code ? `（错误码 ${code}）` : ''}`
                            : `电视返回 HTTP ${response.statusCode}（${action}）`
                    );
                    error.action = action;
                    error.statusCode = response.statusCode;
                    error.upnpCode = code || '';
                    error.responseBody = text.slice(0, 4000);
                    reject(error);
                });
                response.on('error', reject);
            }
        );
        request.on('timeout', () => request.destroy(new Error(`电视响应超时（${action}）`)));
        request.on('error', requestError => {
            const error = new Error(`无法连接电视：${requestError.message}`);
            error.action = action;
            error.cause = requestError;
            reject(error);
        });
        request.end(payload);
    });
}

function avTransport(device, action, args) {
    return soapRequest({
        controlUrl: device.avTransportUrl,
        serviceType: device.avTransportType || 'urn:schemas-upnp-org:service:AVTransport:1',
        action,
        args: { InstanceID: '0', ...args }
    });
}

function serviceAction(device, { urlKey, typeKey, fallbackType, action, args }) {
    return soapRequest({
        controlUrl: device[urlKey],
        serviceType: device[typeKey] || fallbackType,
        action,
        args
    });
}

function decodeXmlText(value) {
    return String(value || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

async function getSinkProtocolInfo(device) {
    if (!device?.connectionManagerUrl) return [];
    const xml = await serviceAction(device, {
        urlKey: 'connectionManagerUrl',
        typeKey: 'connectionManagerType',
        fallbackType: 'urn:schemas-upnp-org:service:ConnectionManager:1',
        action: 'GetProtocolInfo',
        args: {}
    });
    const sink = /<(?:\w+:)?Sink>([\s\S]*?)<\/(?:\w+:)?Sink>/i.exec(xml)?.[1] || '';
    return decodeXmlText(sink).split(',').map(value => value.trim()).filter(Boolean);
}

function chooseVideoMimeType(protocols = []) {
    const joined = protocols.join('\n').toLowerCase();
    if (joined.includes(':video/mp2t:')) return 'video/mp2t';
    // 标准 MPEG-TS 也常被电视笼统声明为 video/mpeg；实际封装仍保持 MPEG-TS。
    if (joined.includes(':video/mpeg:')) return 'video/mpeg';
    return 'video/mp2t';
}

async function startPlayback(device, { url, title, mimeType = 'video/mp2t' }) {
    // 先 Stop 一次：电视上可能还停在上一次投屏的会话里，直接 SetAVTransportURI
    // 有些机型会报 “Transition not available”。这一步失败不影响后续。
    try {
        await avTransport(device, 'Stop', {});
    } catch (error) {
        // 电视本来就是停止状态，忽略。
    }
    let metadataMode = 'full';
    try {
        await avTransport(device, 'SetAVTransportURI', {
            CurrentURI: url,
            CurrentURIMetaData: buildLiveVideoMetadata({ url, title, mimeType })
        });
    } catch (metadataError) {
        // 一部分老电视支持直播地址，却会因为 DIDL-Lite 或 DLNA flags 过严而返回 500。
        // 空元数据是 UPnP AVTransport 允许的兼容写法，自动重试能覆盖这类机型。
        try {
            await avTransport(device, 'SetAVTransportURI', {
                CurrentURI: url,
                CurrentURIMetaData: ''
            });
            metadataMode = 'empty';
        } catch (fallbackError) {
            fallbackError.message += `；兼容模式也失败（首次错误：${metadataError.message}）`;
            throw fallbackError;
        }
    }
    await avTransport(device, 'Play', { Speed: '1' });
    return { metadataMode, mimeType };
}

async function stopPlayback(device) {
    await avTransport(device, 'Stop', {});
}

async function getTransportInfo(device) {
    const xml = await avTransport(device, 'GetTransportInfo', {});
    return {
        state: /<CurrentTransportState>([\s\S]*?)<\/CurrentTransportState>/i.exec(xml)?.[1]?.trim() || '',
        status: /<CurrentTransportStatus>([\s\S]*?)<\/CurrentTransportStatus>/i.exec(xml)?.[1]?.trim() || ''
    };
}

module.exports = {
    startPlayback,
    stopPlayback,
    getTransportInfo,
    getSinkProtocolInfo,
    chooseVideoMimeType,
    buildLiveVideoMetadata
};
