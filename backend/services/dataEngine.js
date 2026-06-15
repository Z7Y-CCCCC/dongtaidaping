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
        this.alarmState = new Map();
        this.lastMetricSnapshotAt = 0;
        this.metricSnapshotIntervalMs = 5000;
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

    _publishRealtimeData(deviceDataArray) {
        if (!Array.isArray(deviceDataArray) || deviceDataArray.length === 0) return;
        this._recordMetrics(deviceDataArray);
        this._recordAlarmEvents(deviceDataArray);
        this.wsServer.broadcastDeviceData(deviceDataArray);
    }

    _recordMetrics(deviceDataArray) {
        try {
            const now = Date.now();
            if (now - this.lastMetricSnapshotAt < this.metricSnapshotIntervalMs) return;
            this.lastMetricSnapshotAt = now;

            const db = getDb();
            const totalDevices = deviceDataArray.length;
            const runningDevices = deviceDataArray.filter(d => !!d.status?.running).length;
            const alarmDevices = deviceDataArray.filter(d => !!d.status?.alarm).length;
            const onlineDevices = deviceDataArray.filter(d => this._deviceQuality(d) !== 'bad').length;
            const avgTemp = this._avg(deviceDataArray.map(d => Number(d.analog?.actual_temp)).filter(Number.isFinite));
            const currentOutput = Math.round(runningDevices * 180 + Math.max(0, avgTemp - 760));
            const dailyTarget = Math.max(totalDevices * 250, 1);
            const overallOee = totalDevices ? Math.max(0, Math.min(99.9, (runningDevices / totalDevices) * 92 - alarmDevices * 4)) : 0;
            const energyConsumption = Math.round((avgTemp || 0) * Math.max(runningDevices, 1) * 0.72);

            db.prepare(`INSERT INTO metric_snapshots (
                current_output, daily_target, overall_oee, energy_consumption,
                running_devices, alarm_devices, online_devices, total_devices
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
                currentOutput,
                dailyTarget,
                parseFloat(overallOee.toFixed(1)),
                energyConsumption,
                runningDevices,
                alarmDevices,
                onlineDevices,
                totalDevices
            );
        } catch (e) {
            console.warn('[DataEngine] 指标快照写入失败:', e.message);
        }
    }

    _recordAlarmEvents(deviceDataArray) {
        try {
            const db = getDb();
            const insertEvent = db.prepare(`INSERT INTO event_logs (
                event_type, level, source_id, title, message, value, quality
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`);

            deviceDataArray.forEach(deviceData => {
                const id = deviceData.furnace_id;
                const alarm = !!deviceData.status?.alarm;
                const previous = this.alarmState.get(id) || false;

                if (alarm !== previous) {
                    insertEvent.run(
                        'alarm',
                        alarm ? 'critical' : 'info',
                        id,
                        alarm ? `${deviceData.furnace_name || id} 报警触发` : `${deviceData.furnace_name || id} 报警恢复`,
                        alarm ? '设备实时数据出现报警状态' : '报警状态已恢复',
                        String(alarm),
                        this._deviceQuality(deviceData)
                    );
                    this.alarmState.set(id, alarm);
                }
            });
        } catch (e) {
            console.warn('[DataEngine] 事件履历写入失败:', e.message);
        }
    }

    _deviceQuality(deviceData) {
        const groups = deviceData.quality || {};
        const values = Object.values(groups).flatMap(group => Object.values(group || {}));
        if (values.includes('bad')) return 'bad';
        if (values.includes('stale')) return 'stale';
        return 'good';
    }

    _avg(values) {
        if (!values.length) return 0;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
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
                this._publishRealtimeData([externalData]);
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
                this._publishRealtimeData(deviceDataArray);
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
                this._publishRealtimeData(deviceDataArray);
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
                this._publishRealtimeData(deviceDataArray);
            },
            (statusInfo) => {
                this.plcStatus = statusInfo;
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }
}

module.exports = DataEngine;
