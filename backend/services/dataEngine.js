const { getDb } = require('../db/database');
const PlcReader = require('./plcReader');
const Simulator = require('./simulator');

class DataEngine {
    constructor(wsServer) {
        this.wsServer = wsServer;
        this.plcReader = null;
        this.simulator = null;
        this.currentMode = null;
        this.plcStatus = { status: 'idle', message: '未启动' };
        this.collectorStatus = {
            status: 'idle',
            message: '内置低延迟采集器未启动',
            lastFrameAt: null,
            frames: 0,
            devices: 0
        };
        this.alarmState = new Map();
        this.lastMetricSnapshotAt = 0;
        this.metricSnapshotIntervalMs = 5000;
    }

    async start() {
        const db = await getDb();
        const rows = await db.all('SELECT * FROM settings');
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });

        const mode = this._normalizeMode(settings.data_mode);
        this.currentMode = mode;
        console.log(`\n[DataEngine] 启动，模式: ${mode}`);

        switch (mode) {
            case 'integrated_plc':
                await this._startIntegratedPlcMode();
                break;
            case 'simulation':
            default:
                await this._startSimulationMode();
                break;
        }
    }

    stop() {
        if (this.plcReader) { this.plcReader.stop(); this.plcReader = null; }
        if (this.simulator) { this.simulator.stop(); this.simulator = null; }
        this.currentMode = null;
        console.log('[DataEngine] 所有数据源已停止');
    }

    async restart() {
        console.log('[DataEngine] 正在重启数据引擎...');
        this.stop();
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.start();
    }

    getStatus() {
        return {
            mode: this.currentMode,
            plcStatus: this.plcStatus,
            collectorStatus: this.collectorStatus
        };
    }

    _normalizeMode(mode) {
        const value = String(mode || '').trim();
        return value === 'simulation' ? 'simulation' : 'integrated_plc';
    }

    _publishRealtimeData(deviceDataArray) {
        if (!Array.isArray(deviceDataArray) || deviceDataArray.length === 0) return;

        this.collectorStatus = {
            ...this.collectorStatus,
            status: 'connected',
            message: `内置采集器数据正常 (${deviceDataArray.length} 台设备)`,
            lastFrameAt: Date.now(),
            frames: this.collectorStatus.frames + 1,
            devices: deviceDataArray.length
        };

        this._recordMetrics(deviceDataArray).catch(e => {
            console.warn('[DataEngine] 指标快照写入失败:', e.message);
        });
        this._recordAlarmEvents(deviceDataArray).catch(e => {
            console.warn('[DataEngine] 事件履历写入失败:', e.message);
        });
        this.wsServer.broadcastDeviceData(deviceDataArray);
    }

    async _recordMetrics(deviceDataArray) {
        const now = Date.now();
        if (now - this.lastMetricSnapshotAt < this.metricSnapshotIntervalMs) return;
        this.lastMetricSnapshotAt = now;

        const db = await getDb();
        const totalDevices = deviceDataArray.length;
        const runningDevices = deviceDataArray.filter(d => !!d.status?.running).length;
        const alarmDevices = deviceDataArray.filter(d => !!d.status?.alarm).length;
        const onlineDevices = deviceDataArray.filter(d => this._deviceQuality(d) !== 'bad').length;
        const avgTemp = this._avg(deviceDataArray.map(d => Number(d.analog?.actual_temp)).filter(Number.isFinite));
        const currentOutput = Math.round(runningDevices * 180 + Math.max(0, avgTemp - 760));
        const dailyTarget = Math.max(totalDevices * 250, 1);
        const overallOee = totalDevices ? Math.max(0, Math.min(99.9, (runningDevices / totalDevices) * 92 - alarmDevices * 4)) : 0;
        const energyConsumption = Math.round((avgTemp || 0) * Math.max(runningDevices, 1) * 0.72);

        await db.run(`INSERT INTO metric_snapshots (
            current_output, daily_target, overall_oee, energy_consumption,
            running_devices, alarm_devices, online_devices, total_devices
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            currentOutput,
            dailyTarget,
            parseFloat(overallOee.toFixed(1)),
            energyConsumption,
            runningDevices,
            alarmDevices,
            onlineDevices,
            totalDevices
        ]);
    }

    async _recordAlarmEvents(deviceDataArray) {
        const db = await getDb();
        for (const deviceData of deviceDataArray) {
            const id = deviceData.furnace_id;
            const alarm = !!deviceData.status?.alarm;
            const previous = this.alarmState.get(id) || false;

            if (alarm !== previous) {
                await db.run(`INSERT INTO event_logs (
                    event_type, level, source_id, title, message, value, quality
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                    'alarm',
                    alarm ? 'critical' : 'info',
                    id,
                    alarm ? `${deviceData.furnace_name || id} 报警触发` : `${deviceData.furnace_name || id} 报警恢复`,
                    alarm ? '设备实时数据出现报警状态' : '报警状态已恢复',
                    String(alarm),
                    this._deviceQuality(deviceData)
                ]);
                this.alarmState.set(id, alarm);
            }
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

    async _startIntegratedPlcMode() {
        console.log('[DataEngine] 内置低延迟采集模式: PLC -> 后端采集器 -> WebSocket');

        this.collectorStatus = {
            status: 'starting',
            message: '内置低延迟采集器正在启动',
            lastFrameAt: null,
            frames: 0,
            devices: 0
        };

        this.plcReader = new PlcReader({ profile: 'low_latency' });
        await this.plcReader.start(
            (deviceDataArray) => {
                this._publishRealtimeData(deviceDataArray);
            },
            (statusInfo) => {
                this.plcStatus = statusInfo;
                this.collectorStatus = {
                    ...this.collectorStatus,
                    status: statusInfo.status,
                    message: statusInfo.message,
                    lastStatusAt: statusInfo.timestamp || Date.now()
                };
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }

    async _startSimulationMode() {
        console.log('[DataEngine] 模拟模式: 生成模拟数据 -> WebSocket');

        this.simulator = new Simulator();
        await this.simulator.start(
            (deviceDataArray) => {
                this._publishRealtimeData(deviceDataArray);
            },
            (statusInfo) => {
                this.plcStatus = statusInfo;
                this.collectorStatus = {
                    status: statusInfo.status,
                    message: statusInfo.message,
                    lastFrameAt: Date.now(),
                    frames: this.collectorStatus.frames,
                    devices: this.collectorStatus.devices
                };
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }
}

module.exports = DataEngine;
