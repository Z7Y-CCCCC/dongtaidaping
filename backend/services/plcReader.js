/**
 * plcReader.js - S7 PLC 连接与数据读取模块
 * 
 * 统一的 PLC 读取层，方案A 和 方案B 都使用此模块连接和读取 PLC。
 * 使用 nodes7 库通过 S7comm (ISO-on-TCP) 协议通信。
 * 
 * 工作流程：
 * 1. 从数据库读取 PLC 连接参数（IP/端口/机架/槽号）
 * 2. 从数据库读取所有设备的点位映射（data_points 表）
 * 3. 建立 S7 连接
 * 4. 按轮询间隔定时读取所有点位
 * 5. 将读到的原始值按设备分组，组装成前端需要的数据结构
 * 6. 通过回调通知上层（dataEngine）
 */

const nodes7 = require('nodes7');
const { getDb } = require('../db/database');

class PlcReader {
    constructor() {
        this.conn = new nodes7();
        this.connected = false;
        this.pollTimer = null;
        this.onData = null;           // 数据回调: (deviceDataArray) => {}
        this.onStatusChange = null;   // 连接状态回调: (status) => {}
        this.devicePointMap = {};     // { deviceId: [{ name, plc_tag, data_type, ... }] }
        this.allTags = {};            // nodes7 需要的 tag 注册表 { tagName: s7Address }
        this.settings = {};
        this.retryTimer = null;
    }

    /**
     * 启动 PLC 读取
     */
    start(onData, onStatusChange) {
        this.onData = onData;
        this.onStatusChange = onStatusChange;

        // 从数据库读取设置
        this._loadSettings();

        if (!this.settings.plc_ip) {
            console.warn('[PlcReader] PLC IP 地址未配置，跳过连接');
            this._notifyStatus('unconfigured', 'PLC IP 地址未配置');
            return;
        }

        // 从数据库读取所有设备点位
        this._loadDataPoints();

        if (Object.keys(this.allTags).length === 0) {
            console.warn('[PlcReader] 没有配置任何点位映射，跳过连接');
            this._notifyStatus('no_points', '没有配置点位映射');
            return;
        }

        // 发起连接
        this._connect();
    }

    /**
     * 停止 PLC 读取并断开连接
     */
    stop() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.connected) {
            try {
                this.conn.dropConnection();
            } catch (e) { /* 忽略断开异常 */ }
            this.connected = false;
        }
        this._notifyStatus('stopped', '已停止');
        console.log('[PlcReader] 已停止');
    }

    /**
     * 重新加载配置并重连
     */
    restart(onData, onStatusChange) {
        this.stop();
        // 创建新的 nodes7 实例（旧实例状态不可靠）
        this.conn = new nodes7();
        this.allTags = {};
        this.devicePointMap = {};
        this.start(onData || this.onData, onStatusChange || this.onStatusChange);
    }

    // ==================== 内部方法 ====================

    _loadSettings() {
        const db = getDb();
        const rows = db.prepare('SELECT * FROM settings').all();
        this.settings = {};
        rows.forEach(r => { this.settings[r.key] = r.value; });
    }

    _loadDataPoints() {
        const db = getDb();
        // 获取所有设备及其点位
        const devices = db.prepare('SELECT * FROM devices').all();
        const allPoints = db.prepare('SELECT * FROM data_points').all();

        this.devicePointMap = {};
        this.allTags = {};

        devices.forEach(device => {
            const points = allPoints.filter(p => p.device_id === device.id);
            if (points.length > 0) {
                this.devicePointMap[device.id] = {
                    deviceName: device.name,
                    points: points
                };

                // 注册 nodes7 tags
                // tag 名使用 "设备ID.点位名" 格式确保唯一
                points.forEach(point => {
                    if (point.plc_tag && point.plc_tag.trim() !== '') {
                        const tagName = `${device.id}.${point.name}`;
                        this.allTags[tagName] = point.plc_tag;
                    }
                });
            }
        });

        console.log(`[PlcReader] 已加载 ${Object.keys(this.allTags).length} 个点位映射，覆盖 ${Object.keys(this.devicePointMap).length} 台设备`);
    }

    _connect() {
        const ip = this.settings.plc_ip;
        const port = parseInt(this.settings.plc_port || '102');
        const rack = parseInt(this.settings.plc_rack || '0');
        const slot = parseInt(this.settings.plc_slot || '1');
        const timeout = parseInt(this.settings.plc_timeout || '5000');

        console.log(`[PlcReader] 正在连接 PLC: ${ip}:${port} (Rack=${rack}, Slot=${slot})`);
        this._notifyStatus('connecting', `正在连接 ${ip}:${port}...`);

        this.conn.initiateConnection({
            host: ip,
            port: port,
            rack: rack,
            slot: slot,
            timeout: timeout
        }, (err) => {
            if (err) {
                console.error(`[PlcReader] PLC 连接失败: ${err}`);
                this.connected = false;
                this._notifyStatus('error', `连接失败: ${err}`);
                this._scheduleRetry();
                return;
            }

            console.log('[PlcReader] PLC 连接成功！');
            this.connected = true;
            this._notifyStatus('connected', `已连接 ${ip}:${port}`);

            // 注册所有 tags
            this.conn.setTranslationCB((tag) => tag);
            this.conn.addItems(Object.keys(this.allTags).map(name => this.allTags[name]));

            // 开始轮询
            this._startPolling();
        });
    }

    _startPolling() {
        const interval = parseInt(this.settings.plc_poll_interval || '2000');
        console.log(`[PlcReader] 开始轮询，间隔 ${interval}ms`);

        // 立即读一次
        this._readAll();

        this.pollTimer = setInterval(() => {
            if (this.connected) {
                this._readAll();
            }
        }, interval);
    }

    _readAll() {
        const addresses = Object.values(this.allTags);
        if (addresses.length === 0) return;

        this.conn.readAllItems((err, values) => {
            if (err) {
                console.error('[PlcReader] 读取失败:', err);
                this.connected = false;
                this._notifyStatus('error', `读取失败: ${err}`);
                if (this.pollTimer) {
                    clearInterval(this.pollTimer);
                    this.pollTimer = null;
                }
                this._scheduleRetry();
                return;
            }

            // values 的 key 是 S7 地址，需要反向映射回 tagName
            const addressToTag = {};
            Object.entries(this.allTags).forEach(([tagName, addr]) => {
                addressToTag[addr] = tagName;
            });

            // 按设备分组组装数据
            const deviceDataArray = [];
            Object.entries(this.devicePointMap).forEach(([deviceId, info]) => {
                const deviceData = this._assembleDeviceData(deviceId, info, values, addressToTag);
                deviceDataArray.push(deviceData);
            });

            // 回调通知上层
            if (this.onData) {
                this.onData(deviceDataArray);
            }
        });
    }

    /**
     * 将原始 PLC 值组装成前端需要的设备数据结构
     */
    _assembleDeviceData(deviceId, info, rawValues, addressToTag) {
        const data = {
            furnace_id: deviceId,
            furnace_name: info.deviceName,
            timestamp: Date.now(),
            analog: {},
            status: {},
            motors: {},
            doors: {},
            mechanisms: {}
        };

        info.points.forEach(point => {
            const addr = point.plc_tag;
            const rawValue = rawValues[addr];
            const convertedValue = this._convertValue(rawValue, point.data_type);
            const value = this._applyScaleOffset(convertedValue, point);
            const category = this._resolveCategory(point);
            const fieldName = point.value_role || point.name;

            data[category][fieldName] = value;
        });

        return data;
    }

    _resolveCategory(point) {
        const configured = String(point.category || '').trim().toLowerCase();
        if (['analog', 'status', 'motors', 'doors', 'mechanisms'].includes(configured)) {
            return configured;
        }

        // 兼容旧点位：没有配置分类时，仍按名称做兜底推断。
        const name = String(point.name || '').toLowerCase();
        if (name.includes('temp') || name.includes('carbon') || name.includes('setpoint') ||
            name.includes('current') || name.includes('pressure') || name.includes('flow')) {
            return 'analog';
        }
        if (name.includes('motor') || name.includes('fan') || name.includes('stir') ||
            name.includes('pump') || name.includes('oil_pump')) {
            return 'motors';
        }
        if (name.includes('door')) return 'doors';
        if (name.includes('chain') || name.includes('push') || name.includes('pull') ||
            name.includes('mechanism')) {
            return 'mechanisms';
        }
        if (name.includes('running') || name.includes('alarm') || name.includes('status') ||
            name.includes('fault') || name.includes('ready')) {
            return 'status';
        }
        return 'analog';
    }

    _applyScaleOffset(value, point) {
        if (typeof value !== 'number' || Number.isNaN(value)) return value;

        const scale = Number(point.scale ?? 1);
        const offset = Number(point.offset ?? 0);
        const safeScale = Number.isFinite(scale) ? scale : 1;
        const safeOffset = Number.isFinite(offset) ? offset : 0;
        return parseFloat((value * safeScale + safeOffset).toFixed(3));
    }

    _convertValue(rawValue, dataType) {
        if (rawValue === undefined || rawValue === null) return null;
        const type = (dataType || '').toUpperCase();
        switch (type) {
            case 'BOOL':
                return !!rawValue;
            case 'REAL':
            case 'FLOAT':
                return parseFloat(Number(rawValue).toFixed(2));
            case 'INT':
            case 'WORD':
            case 'DINT':
            case 'DWORD':
                return parseInt(rawValue);
            default:
                return rawValue;
        }
    }

    _scheduleRetry() {
        const retryInterval = parseInt(this.settings.plc_retry_interval || '10000');
        console.log(`[PlcReader] 将在 ${retryInterval}ms 后重试连接...`);
        this._notifyStatus('retrying', `${retryInterval / 1000}秒后重连...`);

        this.retryTimer = setTimeout(() => {
            this.conn = new nodes7();
            this._connect();
        }, retryInterval);
    }

    _notifyStatus(status, message) {
        if (this.onStatusChange) {
            this.onStatusChange({ status, message, timestamp: Date.now() });
        }
    }
}

module.exports = PlcReader;
