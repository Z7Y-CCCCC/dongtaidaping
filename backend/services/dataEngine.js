/**
 * dataEngine.js - 数据引擎总控
 * 
 * 这是整个数据通路的指挥中心。
 * 根据数据库中 data_mode 设置，自动启动对应的数据源：
 * 
 * - mode = "mqtt"       → 启动 plcReader + mqttBridge（PLC读取→MQTT发布→WebSocket推送）
 * - mode = "node_s7"    → 启动 plcReader（PLC读取→直接 WebSocket推送，不走MQTT）
 * - mode = "simulation" → 启动 simulator（模拟数据→WebSocket推送）
 * 
 * 所有模式最终都通过 wsServer 把数据推给前端。
 */

const { getDb } = require('../db/database');
const PlcReader = require('./plcReader');
const MqttBridge = require('./mqttBridge');
const Simulator = require('./simulator');

class DataEngine {
    constructor(wsServer) {
        this.wsServer = wsServer;
        this.plcReader = null;
        this.mqttBridge = null;
        this.simulator = null;
        this.currentMode = null;
        this.plcStatus = { status: 'idle', message: '未启动' };
    }

    /**
     * 读取配置并启动对应的数据引擎
     */
    start() {
        const db = getDb();
        const rows = db.prepare('SELECT * FROM settings').all();
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });

        const mode = settings.data_mode || 'simulation';
        this.currentMode = mode;

        console.log(`\n╔══════════════════════════════════════════╗`);
        console.log(`║  数据引擎启动 - 模式: ${mode.padEnd(18)}  ║`);
        console.log(`╚══════════════════════════════════════════╝\n`);

        switch (mode) {
            case 'mqtt':
                this._startMqttMode();
                break;
            case 'node_s7':
                this._startDirectMode();
                break;
            case 'simulation':
            default:
                this._startSimulationMode();
                break;
        }
    }

    /**
     * 停止所有数据源
     */
    stop() {
        if (this.plcReader) { this.plcReader.stop(); this.plcReader = null; }
        if (this.mqttBridge) { this.mqttBridge.stop(); this.mqttBridge = null; }
        if (this.simulator) { this.simulator.stop(); this.simulator = null; }
        this.currentMode = null;
        console.log('[DataEngine] 所有数据源已停止');
    }

    /**
     * 重新加载配置并重启引擎
     * 当用户在管理后台修改了连接设置后调用
     */
    restart() {
        console.log('[DataEngine] 正在重启数据引擎...');
        this.stop();
        // 小延迟确保旧连接完全释放
        setTimeout(() => this.start(), 500);
    }

    /**
     * 获取当前引擎状态
     */
    getStatus() {
        return {
            mode: this.currentMode,
            plcStatus: this.plcStatus
        };
    }

    // ==================== 内部启动方法 ====================

    /**
     * 方案A: PLC 读取 → MQTT 发布 + WebSocket 推送
     */
    _startMqttMode() {
        console.log('[DataEngine] 方案A: PLC → MQTT → WebSocket');

        // 1. 启动 MQTT 桥接
        this.mqttBridge = new MqttBridge();
        this.mqttBridge.start(
            // 收到外部 MQTT 数据时也推给 WebSocket（兼容外部数据源）
            (externalData) => {
                this.wsServer.broadcastDeviceData([externalData]);
            },
            (statusInfo) => {
                console.log(`[MqttBridge] ${statusInfo.status}: ${statusInfo.message}`);
            }
        );

        // 2. 启动 PLC 读取
        this.plcReader = new PlcReader();
        this.plcReader.start(
            (deviceDataArray) => {
                // 读到数据后做两件事：
                // a. 发布到 MQTT
                if (this.mqttBridge) {
                    this.mqttBridge.publishDeviceData(deviceDataArray);
                }
                // b. 同时直接 WebSocket 推送（不依赖 MQTT 回环）
                this.wsServer.broadcastDeviceData(deviceDataArray);
            },
            (statusInfo) => {
                this.plcStatus = statusInfo;
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }

    /**
     * 方案B: PLC 读取 → 直接 WebSocket 推送
     */
    _startDirectMode() {
        console.log('[DataEngine] 方案B: PLC → WebSocket (直连)');

        this.plcReader = new PlcReader();
        this.plcReader.start(
            (deviceDataArray) => {
                this.wsServer.broadcastDeviceData(deviceDataArray);
            },
            (statusInfo) => {
                this.plcStatus = statusInfo;
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }

    /**
     * 模拟模式: 生成假数据 → WebSocket 推送
     */
    _startSimulationMode() {
        console.log('[DataEngine] 模拟模式: 生成模拟数据 → WebSocket');

        this.simulator = new Simulator();
        this.simulator.start(
            (deviceDataArray) => {
                this.wsServer.broadcastDeviceData(deviceDataArray);
            },
            (statusInfo) => {
                this.plcStatus = statusInfo;
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }
}

module.exports = DataEngine;
