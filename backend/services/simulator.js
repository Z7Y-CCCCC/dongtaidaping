/**
 * simulator.js - 模拟数据生成器
 * 
 * 在没有真实 PLC 的情况下，按照和 PLC 读取完全一样的数据格式
 * 生成随机的模拟数据，供离线演示和功能调试使用。
 */

const { getDb } = require('../db/database');

class Simulator {
    constructor() {
        this.pollTimer = null;
        this.onData = null;
        this.onStatusChange = null;
        this.devices = [];
        // 每台设备的持久状态（模拟真实运行时的渐变效果）
        this.deviceStates = {};
    }

    start(onData, onStatusChange) {
        this.onData = onData;
        this.onStatusChange = onStatusChange;

        // 从数据库加载设备列表
        const db = getDb();
        this.devices = db.prepare('SELECT * FROM devices').all();

        // 为每台设备初始化模拟状态
        this.devices.forEach(device => {
            this.deviceStates[device.id] = {
                actual_temp: 820 + Math.random() * 60,       // 820-880°C
                setpoint_temp: 860,
                actual_carbon: 0.75 + Math.random() * 0.2,   // 0.75-0.95%
                setpoint_carbon: 0.85,
                fan_motor: true,
                stir_motor: true,
                oil_pump: Math.random() > 0.5,
                front_door_open: false,
                middle_door_open: false,
                push_chain_forward: false,
                running: true,
                alarm: false,
                // 控制门/链的动画计数器
                doorCycle: Math.floor(Math.random() * 100),
                chainCycle: Math.floor(Math.random() * 100)
            };
        });

        console.log(`[Simulator] 已初始化 ${this.devices.length} 台设备的模拟数据`);
        if (this.onStatusChange) {
            this.onStatusChange({ status: 'simulating', message: `模拟运行中 (${this.devices.length} 台设备)`, timestamp: Date.now() });
        }

        // 读取轮询间隔
        const settingsRows = db.prepare('SELECT * FROM settings').all();
        const settings = {};
        settingsRows.forEach(r => { settings[r.key] = r.value; });
        const interval = parseInt(settings.plc_poll_interval || '2000');

        // 开始模拟
        this._tick();
        this.pollTimer = setInterval(() => this._tick(), interval);
    }

    stop() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        console.log('[Simulator] 已停止');
        if (this.onStatusChange) {
            this.onStatusChange({ status: 'stopped', message: '已停止', timestamp: Date.now() });
        }
    }

    restart(onData, onStatusChange) {
        this.stop();
        this.start(onData || this.onData, onStatusChange || this.onStatusChange);
    }

    _tick() {
        const deviceDataArray = [];

        this.devices.forEach(device => {
            const state = this.deviceStates[device.id];
            if (!state) return;

            // 温度缓慢波动（在设定值附近 ±5°C 范围内做布朗运动）
            state.actual_temp += (Math.random() - 0.5) * 2;
            state.actual_temp = Math.max(state.setpoint_temp - 15, Math.min(state.setpoint_temp + 15, state.actual_temp));

            // 碳势缓慢波动
            state.actual_carbon += (Math.random() - 0.5) * 0.01;
            state.actual_carbon = Math.max(state.setpoint_carbon - 0.1, Math.min(state.setpoint_carbon + 0.1, state.actual_carbon));

            // 门和链的周期性动作（模拟生产节拍）
            state.doorCycle++;
            state.chainCycle++;
            if (state.doorCycle % 30 === 0) {
                state.front_door_open = !state.front_door_open;
            }
            if (state.doorCycle % 45 === 0) {
                state.middle_door_open = !state.middle_door_open;
            }
            if (state.chainCycle % 60 === 0) {
                state.push_chain_forward = !state.push_chain_forward;
            }

            // 偶尔随机报警（每次 tick 有 0.5% 概率触发报警，持续约 10 秒）
            if (Math.random() < 0.005) {
                state.alarm = true;
                setTimeout(() => { state.alarm = false; }, 10000);
            }

            deviceDataArray.push({
                furnace_id: device.id,
                furnace_name: device.name,
                timestamp: Date.now(),
                analog: {
                    actual_temp: parseFloat(state.actual_temp.toFixed(1)),
                    setpoint_temp: state.setpoint_temp,
                    actual_carbon: parseFloat(state.actual_carbon.toFixed(3)),
                    setpoint_carbon: state.setpoint_carbon
                },
                status: {
                    running: state.running,
                    alarm: state.alarm
                },
                motors: {
                    fan_motor: state.fan_motor,
                    stir_motor: state.stir_motor,
                    oil_pump: state.oil_pump
                },
                doors: {
                    front_door_open: state.front_door_open,
                    middle_door_open: state.middle_door_open
                },
                mechanisms: {
                    push_chain_forward: state.push_chain_forward
                },
                quality: {
                    analog: {
                        actual_temp: 'good',
                        setpoint_temp: 'good',
                        actual_carbon: 'good',
                        setpoint_carbon: 'good'
                    },
                    status: {
                        running: 'good',
                        alarm: 'good'
                    },
                    motors: {
                        fan_motor: 'good',
                        stir_motor: 'good',
                        oil_pump: 'good'
                    },
                    doors: {
                        front_door_open: 'good',
                        middle_door_open: 'good'
                    },
                    mechanisms: {
                        push_chain_forward: 'good'
                    }
                },
                pointMeta: {
                    'analog.actual_temp': { label: '实际温度', unit: '°C', display_format: '0.0' },
                    'analog.setpoint_temp': { label: '设定温度', unit: '°C', display_format: '0' },
                    'analog.actual_carbon': { label: '实际碳势', unit: '%', display_format: '0.000' },
                    'analog.setpoint_carbon': { label: '设定碳势', unit: '%', display_format: '0.000' },
                    'status.running': { label: '运行状态', unit: '', display_format: '' },
                    'status.alarm': { label: '报警状态', unit: '', display_format: '' }
                }
            });
        });

        if (this.onData && deviceDataArray.length > 0) {
            this.onData(deviceDataArray);
        }
    }
}

module.exports = Simulator;
