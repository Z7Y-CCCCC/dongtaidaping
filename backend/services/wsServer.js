/**
 * wsServer.js - WebSocket 服务器
 * 
 * 提供前端连接的 WebSocket 通道。
 * 数据引擎（dataEngine）通过此模块把设备实时数据推送给所有已连接的前端客户端。
 * 
 * 消息协议：
 * - 服务端 → 客户端: { type: "device_data", payload: { furnace_id, ... } }
 * - 服务端 → 客户端: { type: "plc_status", payload: { status, message } }
 * - 客户端 → 服务端: { type: "ping" }  →  回复 { type: "pong" }
 */

const { WebSocketServer } = require('ws');

class WsServer {
    constructor() {
        this.wss = null;
        this.clients = new Set();
    }

    /**
     * 将 WebSocket 绑定到已有的 HTTP Server 上
     * @param {http.Server} httpServer
     */
    attach(httpServer) {
        this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

        this.wss.on('connection', (ws, req) => {
            const clientIp = req.socket.remoteAddress;
            console.log(`[WebSocket] 客户端已连接: ${clientIp} (当前 ${this.wss.clients.size} 个连接)`);
            this.clients.add(ws);

            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (data.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    }
                } catch (e) { /* 忽略非 JSON 消息 */ }
            });

            ws.on('close', () => {
                this.clients.delete(ws);
                console.log(`[WebSocket] 客户端断开: ${clientIp} (剩余 ${this.wss.clients.size} 个连接)`);
            });

            ws.on('error', (err) => {
                console.error(`[WebSocket] 客户端错误:`, err.message);
                this.clients.delete(ws);
            });

            // 连接成功后立即发送一条欢迎消息
            ws.send(JSON.stringify({
                type: 'welcome',
                payload: { message: '数字孪生 WebSocket 通道已建立', timestamp: Date.now() }
            }));
        });

        console.log('[WebSocket] 服务已启动，等待客户端连接 (路径: /ws)');
    }

    /**
     * 向所有客户端广播设备数据
     * @param {Array} deviceDataArray - 所有设备的实时数据数组
     */
    broadcastDeviceData(deviceDataArray) {
        if (!this.wss || this.wss.clients.size === 0) return;

        // 逐台设备分别推送（前端按 furnace_id 匹配设备）
        deviceDataArray.forEach(deviceData => {
            const message = JSON.stringify({
                type: 'device_data',
                payload: deviceData
            });
            this.wss.clients.forEach(client => {
                if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(message);
                }
            });
        });
    }

    /**
     * 广播 PLC/数据源连接状态
     */
    broadcastStatus(statusInfo) {
        if (!this.wss || this.wss.clients.size === 0) return;

        const message = JSON.stringify({
            type: 'plc_status',
            payload: statusInfo
        });
        this.wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(message);
            }
        });
    }

    /**
     * 关闭 WebSocket 服务
     */
    close() {
        if (this.wss) {
            this.wss.close();
            console.log('[WebSocket] 服务已关闭');
        }
    }
}

module.exports = WsServer;
