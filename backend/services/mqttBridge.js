/**
 * mqttBridge.js - MQTT 中继桥接模块（方案A）
 * 
 * 方案A 的数据通路：
 *   PLC ← Node.js plcReader 读取 → MQTT Broker 发布 → 同时后端自己订阅 → WebSocket → 前端
 * 
 * 本模块的职责：
 * 1. 接收 plcReader 读到的数据
 * 2. 将数据发布到 MQTT Broker（模仿原来 C# 上位机的行为）
 * 3. 同时也可以订阅 MQTT Topic（如果将来有其他数据源往 MQTT 发数据）
 * 
 * 这样做的好处是：
 * - 保留了 MQTT 这条数据通路，其他系统可以订阅
 * - 前端不需要关心数据是从 MQTT 来的还是直连来的，统一走 WebSocket
 */

const mqtt = require('mqtt');
const { getDb } = require('../db/database');

class MqttBridge {
    constructor() {
        this.client = null;
        this.connected = false;
        this.settings = {};
        this.onExternalData = null;   // 收到外部 MQTT 数据时的回调
        this.onStatusChange = null;
    }

    /**
     * 启动 MQTT 桥接
     * @param {Function} onExternalData - 收到外部 MQTT 数据时的回调 (data) => {}
     * @param {Function} onStatusChange - 连接状态变化 (statusInfo) => {}
     */
    start(onExternalData, onStatusChange) {
        this.onExternalData = onExternalData;
        this.onStatusChange = onStatusChange;
        this._loadSettings();

        const broker = this.settings.mqtt_broker;
        if (!broker) {
            console.warn('[MqttBridge] MQTT Broker 地址未配置');
            return;
        }

        // 使用 tcp:// 协议连接（后端不用 ws://，直接用 mqtt://）
        // 将 ws:// 开头的地址转换为 mqtt:// （后端是 Node.js，可以直连 MQTT TCP 端口）
        let backendBroker = broker;
        if (broker.startsWith('ws://')) {
            // 如果用户配的是 ws://192.168.1.100:8083/mqtt
            // 后端应该连 mqtt://192.168.1.100:1883
            const url = new URL(broker);
            backendBroker = `mqtt://${url.hostname}:1883`;
            console.log(`[MqttBridge] 检测到 WebSocket 地址，后端改用 TCP 连接: ${backendBroker}`);
        }

        console.log(`[MqttBridge] 正在连接 MQTT Broker: ${backendBroker}`);
        this._notifyStatus('connecting', `正在连接 ${backendBroker}...`);

        this.client = mqtt.connect(backendBroker, {
            reconnectPeriod: 5000,
            connectTimeout: 10000,
            clientId: `digital_twin_backend_${Date.now()}`
        });

        this.client.on('connect', () => {
            console.log('[MqttBridge] MQTT Broker 连接成功');
            this.connected = true;
            this._notifyStatus('connected', `已连接 ${backendBroker}`);

            // 订阅 topic（接收外部数据源）
            const prefix = this.settings.mqtt_topic_prefix || 'factory';
            this.client.subscribe(`${prefix}/realtime`, (err) => {
                if (!err) {
                    console.log(`[MqttBridge] 已订阅 ${prefix}/realtime`);
                }
            });
        });

        this.client.on('message', (topic, payload) => {
            try {
                const data = JSON.parse(payload.toString());
                // 如果收到外部数据，通过回调通知上层
                if (this.onExternalData) {
                    this.onExternalData(data);
                }
            } catch (e) {
                // 忽略非 JSON 消息
            }
        });

        this.client.on('error', (err) => {
            console.error('[MqttBridge] MQTT 错误:', err.message);
            this._notifyStatus('error', err.message);
        });

        this.client.on('close', () => {
            this.connected = false;
            this._notifyStatus('disconnected', 'MQTT 连接已断开');
        });
    }

    /**
     * 将 PLC 读到的数据发布到 MQTT（模仿 C# 上位机的行为）
     */
    publishDeviceData(deviceDataArray) {
        if (!this.client || !this.connected) return;

        const prefix = this.settings.mqtt_topic_prefix || 'factory';
        deviceDataArray.forEach(deviceData => {
            const topic = `${prefix}/realtime`;
            this.client.publish(topic, JSON.stringify(deviceData), { qos: 0 });
        });
    }

    stop() {
        if (this.client) {
            this.client.end(true);
            this.client = null;
            this.connected = false;
        }
        console.log('[MqttBridge] 已停止');
    }

    restart(onExternalData, onStatusChange) {
        this.stop();
        this.start(onExternalData || this.onExternalData, onStatusChange || this.onStatusChange);
    }

    _loadSettings() {
        const db = getDb();
        const rows = db.prepare('SELECT * FROM settings').all();
        this.settings = {};
        rows.forEach(r => { this.settings[r.key] = r.value; });
    }

    _notifyStatus(status, message) {
        if (this.onStatusChange) {
            this.onStatusChange({ status, message, timestamp: Date.now() });
        }
    }
}

module.exports = MqttBridge;
