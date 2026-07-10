/**
 * 内置 S7 PLC 采集器
 *
 * 运行模型：
 * - 每台设备保存自己的 PLC 连接配置。
 * - 每个点位保存自己的采集周期 sample_interval_ms。
 * - 运行时按 “PLC 端点 + 采集周期” 合并任务，nodes7 会继续对同一 DB 内点位做批量优化读取。
 */

const nodes7 = require('nodes7');
const { getDb } = require('../db/database');

const DATA_GROUPS = ['analog', 'status', 'motors', 'doors', 'mechanisms', 'gas'];
const MIN_SAMPLE_INTERVAL_MS = 100;
const MAX_SAMPLE_INTERVAL_MS = 60000;
const STATUS_BROADCAST_MIN_MS = 2000;

class PlcReader {
    constructor(options = {}) {
        this.options = options;
        this.onData = null;
        this.onStatusChange = null;
        this.tasks = new Map();
        this.deviceStatus = new Map();
        this.deviceTaskIds = new Map();
        this.latestSnapshots = new Map();
        this.currentStatus = { status: 'idle', message: '采集器未启动', devices: [], timestamp: Date.now() };
        this.lastStatusSignature = '';
        this.lastStatusBroadcastAt = 0;
        this.stopped = true;
    }

    async start(onData, onStatusChange) {
        this.onData = onData;
        this.onStatusChange = onStatusChange;
        this.stopped = false;

        await this._loadDataPoints();

        if (this.tasks.size === 0) {
            this._notifyAggregateStatus(true);
            return;
        }

        console.log(`[PlcReader] 已创建 ${this.tasks.size} 个 PLC 采集任务`);
        for (const task of this.tasks.values()) {
            this._connectTask(task);
        }
    }

    stop() {
        this.stopped = true;
        for (const task of this.tasks.values()) {
            this._clearTaskTimers(task);
            this._dropTaskConnection(task);
            task.status = 'stopped';
            task.message = '采集任务已停止';
        }
        this._notifyStatus('stopped', '内置 PLC 采集器已停止');
        console.log('[PlcReader] 已停止');
    }

    async restart(onData, onStatusChange) {
        this.stop();
        this.tasks.clear();
        this.deviceStatus.clear();
        this.deviceTaskIds.clear();
        this.latestSnapshots.clear();
        await this.start(onData || this.onData, onStatusChange || this.onStatusChange);
    }

    getStatus() {
        return this.currentStatus;
    }

    getPointRuntimeValues(deviceId, points = []) {
        const snapshot = this.latestSnapshots.get(deviceId);
        const deviceStatus = this.deviceStatus.get(deviceId) || null;
        const fallbackQuality = deviceStatus?.quality || 'bad';

        return {
            deviceStatus,
            snapshotTimestamp: snapshot?.timestamp || null,
            points: points.map(point => {
                const category = this._resolveCategory(point);
                const fieldName = point.value_role || point.name;
                const value = snapshot?.[category]?.[fieldName] ?? null;
                const quality = snapshot?.quality?.[category]?.[fieldName] || fallbackQuality;
                return {
                    ...point,
                    category_resolved: category,
                    field_name: fieldName,
                    plc_address: this._normalizePointAddress(point) || point.plc_tag || '',
                    sample_interval_ms: this._resolveSampleInterval(point),
                    value,
                    quality,
                    lastReadAt: deviceStatus?.lastReadAt || null
                };
            })
        };
    }

    async _loadDataPoints() {
        const db = await getDb();
        const devices = await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC');
        const allPoints = await db.all('SELECT * FROM data_points ORDER BY device_id, id ASC');
        const pointsByDevice = new Map();
        allPoints.forEach(point => {
            if (!pointsByDevice.has(point.device_id)) pointsByDevice.set(point.device_id, []);
            pointsByDevice.get(point.device_id).push(point);
        });

        this.tasks.clear();
        this.deviceStatus.clear();
        this.deviceTaskIds.clear();

        devices.forEach(device => {
            const points = pointsByDevice.get(device.id) || [];
            const plc = this._normalizePlcConfig(device);
            this.deviceStatus.set(device.id, this._createBaseDeviceStatus(device, plc));

            if (!plc.enabled) return;
            if (plc.protocol !== 'S7') {
                this._updateBaseDeviceStatus(device.id, {
                    status: 'unsupported',
                    quality: 'bad',
                    message: `暂不支持 ${plc.protocol} 协议`
                });
                return;
            }
            if (!plc.ip) {
                this._updateBaseDeviceStatus(device.id, {
                    status: 'unconfigured',
                    quality: 'bad',
                    message: 'PLC IP 未配置'
                });
                return;
            }
            if (points.length === 0) {
                this._updateBaseDeviceStatus(device.id, {
                    status: 'no_points',
                    quality: 'stale',
                    message: '未配置点位'
                });
                return;
            }

            let readableCount = 0;
            points.forEach(point => {
                if (String(point.access_type || 'READ').toUpperCase() === 'WRITE') return;
                const address = this._normalizePointAddress(point);
                if (!address) return;

                readableCount += 1;
                const interval = this._resolveSampleInterval(point);
                const endpointKey = this._endpointKey(plc);
                const taskKey = `${endpointKey}|${interval}`;
                const task = this._getOrCreateTask(taskKey, plc, interval);
                const tagName = `${device.id}.${point.name}.${point.id || readableCount}`;
                task.tags[tagName] = address;

                if (!task.devices[device.id]) {
                    task.devices[device.id] = { deviceName: device.name, points: [] };
                }
                task.devices[device.id].points.push({ ...point, tagName, plc_address: address });

                if (!this.deviceTaskIds.has(device.id)) this.deviceTaskIds.set(device.id, new Set());
                this.deviceTaskIds.get(device.id).add(taskKey);
            });

            if (readableCount === 0) {
                this._updateBaseDeviceStatus(device.id, {
                    status: 'no_points',
                    quality: 'stale',
                    message: '未配置可读取点位或点位地址无效'
                });
            }
        });

        const pointCount = Array.from(this.tasks.values())
            .reduce((sum, task) => sum + Object.keys(task.tags).length, 0);
        console.log(`[PlcReader] 已加载 ${pointCount} 个可读取点位，覆盖 ${this.deviceTaskIds.size} 台启用 PLC 的设备`);
        this._refreshDeviceStatuses();
    }

    _getOrCreateTask(taskKey, plc, interval) {
        if (this.tasks.has(taskKey)) return this.tasks.get(taskKey);
        const task = {
            id: taskKey,
            endpointKey: this._endpointKey(plc),
            endpoint: plc,
            interval,
            tags: {},
            devices: {},
            conn: null,
            timer: null,
            retryTimer: null,
            reading: false,
            status: 'idle',
            message: '等待连接',
            retryCount: 0,
            lastConnectedAt: null,
            lastReadAt: null,
            lastError: '',
            nextRetryAt: null
        };
        this.tasks.set(taskKey, task);
        return task;
    }

    _connectTask(task) {
        if (this.stopped) return;
        this._clearTaskTimers(task);
        this._dropTaskConnection(task);
        task.conn = new nodes7();
        this._setTaskStatus(task, 'connecting', `正在连接 ${this._formatEndpoint(task.endpoint)}...`);

        const { ip, port, rack, slot, timeout } = task.endpoint;
        task.conn.initiateConnection({ host: ip, port, rack, slot, timeout }, (err) => {
            if (this.stopped) return;
            if (err) {
                this._handleTaskFailure(task, err, '连接失败');
                return;
            }

            try {
                const tagNames = Object.keys(task.tags);
                task.conn.setTranslationCB(tag => task.tags[tag]);
                task.conn.addItems(tagNames);
                task.lastConnectedAt = Date.now();
                task.retryCount = 0;
                task.lastError = '';
                task.nextRetryAt = null;
                this._setTaskStatus(task, 'connected', `${this._formatEndpoint(task.endpoint)} 已连接，${tagNames.length} 点，${task.interval}ms`);
                this._startTaskPolling(task);
            } catch (e) {
                this._handleTaskFailure(task, e, '点位注册失败');
            }
        });
    }

    _startTaskPolling(task) {
        this._readTask(task);
        task.timer = setInterval(() => this._readTask(task), task.interval);
    }

    _readTask(task) {
        if (this.stopped || task.reading || task.status !== 'connected' || !task.conn) return;
        task.reading = true;
        task.conn.readAllItems((err, values) => {
            task.reading = false;
            if (this.stopped) return;
            if (err) {
                this._handleTaskFailure(task, err, '读取失败');
                return;
            }

            task.lastReadAt = Date.now();
            task.lastError = '';
            task.nextRetryAt = null;
            if (task.status !== 'connected') {
                this._setTaskStatus(task, 'connected', `${this._formatEndpoint(task.endpoint)} 数据正常`);
            } else {
                this._refreshDeviceStatuses();
                this._notifyAggregateStatus(false);
            }

            const deviceDataArray = [];
            Object.entries(task.devices).forEach(([deviceId, info]) => {
                const patch = this._assembleDeviceData(deviceId, info, values || {});
                const merged = this._mergeDevicePatch(deviceId, patch);
                deviceDataArray.push(merged);
            });

            if (this.onData && deviceDataArray.length > 0) {
                this.onData(deviceDataArray);
            }
        });
    }

    _handleTaskFailure(task, err, prefix) {
        if (this.stopped) return;
        const message = `${prefix}: ${err?.message || err}`;
        console.error(`[PlcReader] ${task.id} ${message}`);
        this._clearTaskTimers(task);
        this._dropTaskConnection(task);
        this._emitBadSnapshotsForTask(task);

        task.retryCount += 1;
        const maxRetries = Number(task.endpoint.maxRetries || 0);
        if (maxRetries > 0 && task.retryCount > maxRetries) {
            this._setTaskStatus(task, 'error', `${message}，重连次数已达上限`);
            return;
        }

        const retryInterval = this._clampInteger(task.endpoint.retryInterval, 1000, 120000, 10000);
        task.lastError = message;
        task.nextRetryAt = Date.now() + retryInterval;
        this._setTaskStatus(task, 'retrying', `${message}，${Math.round(retryInterval / 1000)} 秒后重连`);
        task.retryTimer = setTimeout(() => {
            task.retryTimer = null;
            if (this.stopped) return;
            this._connectTask(task);
        }, retryInterval);
    }

    _assembleDeviceData(deviceId, info, rawValues) {
        const data = this._createEmptyDeviceData(deviceId, info.deviceName);

        info.points.forEach(point => {
            const rawValue = rawValues[point.tagName];
            const convertedValue = this._convertValue(rawValue, point.data_type);
            const scaledValue = this._applyScaleOffset(convertedValue, point);
            const value = this._applyExpression(scaledValue, point);
            const category = this._resolveCategory(point);
            const fieldName = point.value_role || point.name;
            const quality = this._resolveQuality(rawValue, point);

            data[category][fieldName] = value;
            data.quality[category][fieldName] = quality;
            data.pointMeta[`${category}.${fieldName}`] = {
                label: point.label,
                unit: point.unit || '',
                display_format: point.display_format || '',
                sample_interval_ms: this._resolveSampleInterval(point),
                plc_address: point.plc_address || point.plc_tag || ''
            };
        });

        return data;
    }

    _emitBadSnapshotsForTask(task) {
        if (!this.onData) return;
        const deviceDataArray = [];
        Object.entries(task.devices || {}).forEach(([deviceId, info]) => {
            const previous = this.latestSnapshots.get(deviceId) || this._createEmptyDeviceData(deviceId, info.deviceName);
            const patch = this._createEmptyDeviceData(deviceId, info.deviceName);
            info.points.forEach(point => {
                const category = this._resolveCategory(point);
                const fieldName = point.value_role || point.name;
                patch[category][fieldName] = previous[category]?.[fieldName] ?? null;
                patch.quality[category][fieldName] = 'bad';
                patch.pointMeta[`${category}.${fieldName}`] = {
                    label: point.label,
                    unit: point.unit || '',
                    display_format: point.display_format || '',
                    sample_interval_ms: this._resolveSampleInterval(point),
                    plc_address: point.plc_address || point.plc_tag || ''
                };
            });
            deviceDataArray.push(this._mergeDevicePatch(deviceId, patch));
        });
        if (deviceDataArray.length > 0) this.onData(deviceDataArray);
    }

    _mergeDevicePatch(deviceId, patch) {
        const previous = this.latestSnapshots.get(deviceId) || this._createEmptyDeviceData(deviceId, patch.furnace_name);
        const merged = this._createEmptyDeviceData(deviceId, patch.furnace_name || previous.furnace_name);
        merged.timestamp = patch.timestamp;

        DATA_GROUPS.forEach(groupName => {
            merged[groupName] = {
                ...(previous[groupName] || {}),
                ...(patch[groupName] || {})
            };
            merged.quality[groupName] = {
                ...(previous.quality?.[groupName] || {}),
                ...(patch.quality?.[groupName] || {})
            };
        });

        merged.pointMeta = {
            ...(previous.pointMeta || {}),
            ...(patch.pointMeta || {})
        };

        this.latestSnapshots.set(deviceId, merged);
        return merged;
    }

    _createEmptyDeviceData(deviceId, deviceName) {
        return {
            furnace_id: deviceId,
            furnace_name: deviceName,
            timestamp: Date.now(),
            analog: {},
            status: {},
            motors: {},
            doors: {},
            mechanisms: {},
            gas: {},
            quality: {
                analog: {},
                status: {},
                motors: {},
                doors: {},
                mechanisms: {},
                gas: {}
            },
            pointMeta: {}
        };
    }

    _setTaskStatus(task, status, message) {
        const changed = task.status !== status || task.message !== message;
        task.status = status;
        task.message = message;
        this._refreshDeviceStatuses();
        this._notifyAggregateStatus(changed);
    }

    _refreshDeviceStatuses() {
        for (const [deviceId, status] of this.deviceStatus.entries()) {
            const taskIds = Array.from(this.deviceTaskIds.get(deviceId) || []);
            if (taskIds.length === 0) continue;

            const tasks = taskIds.map(id => this.tasks.get(id)).filter(Boolean);
            const connected = tasks.filter(task => task.status === 'connected');
            const connecting = tasks.filter(task => task.status === 'connecting');
            const retrying = tasks.filter(task => task.status === 'retrying');
            const errors = tasks.filter(task => task.status === 'error');
            const lastConnectedAt = this._maxNumber(tasks.map(task => task.lastConnectedAt));
            const lastReadAt = this._maxNumber(tasks.map(task => task.lastReadAt));
            const nextRetryAt = this._minNumber(tasks.map(task => task.nextRetryAt));
            const lastError = tasks.find(task => task.lastError)?.lastError || '';
            const retryCount = Math.max(...tasks.map(task => Number(task.retryCount || 0)), 0);
            const intervals = [...new Set(tasks.map(task => task.interval))].sort((a, b) => a - b);

            let next = {
                status: 'idle',
                quality: 'stale',
                message: '等待采集',
                lastConnectedAt,
                lastReadAt,
                lastError,
                retryCount,
                nextRetryAt,
                intervals
            };

            if (connected.length === tasks.length) {
                next = { ...next, status: 'connected', quality: 'good', message: '数据采集正常' };
            } else if (connected.length > 0) {
                next = { ...next, status: 'retrying', quality: 'stale', message: '部分采集任务异常，正在重连' };
            } else if (connecting.length > 0) {
                next = { ...next, status: 'connecting', quality: 'stale', message: '正在连接 PLC' };
            } else if (retrying.length > 0) {
                next = { ...next, status: 'retrying', quality: 'stale', message: retrying[0].message || '正在重连 PLC' };
            } else if (errors.length > 0) {
                next = { ...next, status: 'error', quality: 'bad', message: errors[0].message || 'PLC 连接失败' };
            }

            this.deviceStatus.set(deviceId, { ...status, ...next });
        }
    }

    _notifyAggregateStatus(force = false) {
        const devices = Array.from(this.deviceStatus.values())
            .sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));
        const active = devices.filter(device => device.status !== 'disabled');
        const connectedCount = active.filter(device => device.status === 'connected').length;

        let status = 'unconfigured';
        let message = '未启用任何 PLC 设备';

        if (devices.length === 0) {
            status = 'no_devices';
            message = '未配置设备';
        } else if (active.length === 0) {
            status = 'unconfigured';
            message = '未启用任何 PLC 设备';
        } else if (connectedCount === active.length) {
            status = 'connected';
            message = `PLC 数据正常：${connectedCount}/${active.length} 台设备在线`;
        } else if (connectedCount > 0) {
            status = 'retrying';
            message = `PLC 部分异常：${connectedCount}/${active.length} 台设备在线`;
        } else if (active.some(device => device.status === 'connecting')) {
            status = 'connecting';
            message = '正在连接 PLC...';
        } else if (active.some(device => device.status === 'retrying')) {
            status = 'retrying';
            message = 'PLC 连接异常，正在重连';
        } else if (active.every(device => ['no_points', 'unconfigured', 'unsupported'].includes(device.status))) {
            status = 'unconfigured';
            message = 'PLC 设备或点位未配置完整';
        } else {
            status = 'error';
            message = 'PLC 采集异常';
        }

        const payload = { status, message, devices, timestamp: Date.now() };
        const signature = JSON.stringify({
            status,
            message,
            devices: devices.map(device => ({
                id: device.deviceId,
                status: device.status,
                lastConnectedAt: device.lastConnectedAt,
                lastReadAt: device.lastReadAt,
                lastError: device.lastError,
                retryCount: device.retryCount,
                nextRetryAt: device.nextRetryAt
            }))
        });

        const now = Date.now();
        if (!force && signature === this.lastStatusSignature && now - this.lastStatusBroadcastAt < STATUS_BROADCAST_MIN_MS) {
            this.currentStatus = payload;
            return;
        }

        this.currentStatus = payload;
        this.lastStatusSignature = signature;
        this.lastStatusBroadcastAt = now;
        if (this.onStatusChange) this.onStatusChange(payload);
    }

    _notifyStatus(status, message) {
        const payload = { status, message, devices: Array.from(this.deviceStatus.values()), timestamp: Date.now() };
        this.currentStatus = payload;
        if (this.onStatusChange) this.onStatusChange(payload);
    }

    _createBaseDeviceStatus(device, plc) {
        const status = plc.enabled ? 'idle' : 'disabled';
        return {
            deviceId: device.id,
            deviceName: device.name,
            status,
            quality: plc.enabled ? 'stale' : 'bad',
            message: plc.enabled ? '等待采集' : '未启用 PLC 采集',
            protocol: plc.protocol,
            endpoint: plc.ip ? this._formatEndpoint(plc) : '',
            plc_ip: plc.ip || '',
            plc_port: plc.port || 102,
            plc_rack: plc.rack || 0,
            plc_slot: plc.slot || 1,
            lastConnectedAt: null,
            lastReadAt: null,
            lastError: '',
            retryCount: 0,
            nextRetryAt: null,
            intervals: []
        };
    }

    _updateBaseDeviceStatus(deviceId, patch) {
        const previous = this.deviceStatus.get(deviceId);
        if (!previous) return;
        this.deviceStatus.set(deviceId, { ...previous, ...patch });
    }

    _normalizePlcConfig(device) {
        const enabled = this._isTruthy(device.plc_enabled);
        return {
            enabled,
            protocol: String(device.plc_protocol || 'S7').trim().toUpperCase(),
            ip: String(device.plc_ip || '').trim(),
            port: this._clampInteger(device.plc_port, 1, 65535, 102),
            rack: this._clampInteger(device.plc_rack, 0, 10, 0),
            slot: this._clampInteger(device.plc_slot, 0, 31, 1),
            timeout: this._clampInteger(device.plc_timeout, 1000, 30000, 5000),
            retryInterval: this._clampInteger(device.plc_retry_interval, 1000, 120000, 10000),
            maxRetries: this._clampInteger(device.plc_max_retries, 0, 999, 0)
        };
    }

    _endpointKey(plc) {
        return `${plc.protocol}:${plc.ip}:${plc.port}:${plc.rack}:${plc.slot}`;
    }

    _formatEndpoint(plc) {
        return `${plc.protocol || 'S7'} ${plc.ip}:${plc.port} (Rack=${plc.rack}, Slot=${plc.slot})`;
    }

    _resolveSampleInterval(point) {
        return this._clampInteger(point.sample_interval_ms, MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_INTERVAL_MS, 1000);
    }

    _normalizePointAddress(point) {
        const raw = String(point.plc_tag || '').trim();
        if (raw) return this._normalizeS7Address(raw, point.data_type);

        const dbNumber = Number(point.db_number);
        const byteOffset = Number(point.db_byte_offset);
        if (!Number.isInteger(dbNumber) || !Number.isInteger(byteOffset)) return null;

        const bitOffset = this._clampInteger(point.bit_offset, 0, 7, 0);
        return this._composeDbAddress(dbNumber, byteOffset, bitOffset, point.data_type);
    }

    _normalizeS7Address(address, dataType) {
        const compact = String(address || '').replace(/\s+/g, '').toUpperCase();
        if (!compact) return null;
        if (compact.includes(',')) return compact;

        const dbMatch = compact.match(/^DB(\d+)\.DB([A-Z]+)(\d+)(?:\.(\d+))?$/);
        if (dbMatch) {
            const [, db, token, byteOffset, bitOffset] = dbMatch;
            return this._composeDbAddress(
                Number(db),
                Number(byteOffset),
                bitOffset === undefined ? 0 : Number(bitOffset),
                this._typeFromDbToken(token, dataType)
            );
        }

        return compact;
    }

    _composeDbAddress(dbNumber, byteOffset, bitOffset, dataType) {
        if (!Number.isInteger(dbNumber) || dbNumber < 0 || !Number.isInteger(byteOffset) || byteOffset < 0) return null;
        const type = this._canonicalDataType(dataType);
        if (type === 'STRING' || type === 'CHAR') return null;
        if (type === 'BOOL') {
            const bit = this._clampInteger(bitOffset, 0, 7, 0);
            return `DB${dbNumber},X${byteOffset}.${bit}`;
        }
        return `DB${dbNumber},${type}${byteOffset}`;
    }

    _typeFromDbToken(token, dataType) {
        const normalized = String(token || '').toUpperCase();
        const pointType = this._canonicalDataType(dataType);
        if (normalized === 'X') return 'BOOL';
        if (normalized === 'B' || normalized === 'BYTE') return 'BYTE';
        if (normalized === 'W' || normalized === 'WORD') return pointType === 'INT' ? 'INT' : 'WORD';
        if (normalized === 'I' || normalized === 'INT') return 'INT';
        if (normalized === 'DI' || normalized === 'DINT') return 'DINT';
        if (normalized === 'DW' || normalized === 'DWORD') return pointType === 'REAL' ? 'REAL' : 'DWORD';
        if (normalized === 'D') return ['REAL', 'DINT', 'DWORD'].includes(pointType) ? pointType : 'DWORD';
        if (normalized === 'R' || normalized === 'REAL') return 'REAL';
        if (normalized === 'LR' || normalized === 'LREAL') return 'LREAL';
        if (normalized === 'S' || normalized === 'STRING') return 'STRING';
        if (normalized === 'C' || normalized === 'CHAR') return 'CHAR';
        if (['DT', 'DTZ', 'DTL', 'DTLZ'].includes(normalized)) return normalized;
        return pointType;
    }

    _canonicalDataType(dataType) {
        const type = String(dataType || 'WORD').trim().toUpperCase();
        if (type === 'BOOL' || type === 'BIT' || type === 'X') return 'BOOL';
        if (type === 'FLOAT' || type === 'REAL' || type === 'R') return 'REAL';
        if (type === 'LREAL' || type === 'LR') return 'LREAL';
        if (type === 'DINT' || type === 'DI') return 'DINT';
        if (type === 'DWORD' || type === 'DW') return 'DWORD';
        if (type === 'INT' || type === 'I') return 'INT';
        if (type === 'BYTE' || type === 'B') return 'BYTE';
        if (type === 'STRING' || type === 'S') return 'STRING';
        if (type === 'CHAR' || type === 'C') return 'CHAR';
        if (['DT', 'DTZ', 'DTL', 'DTLZ'].includes(type)) return type;
        return 'WORD';
    }

    _resolveQuality(rawValue, point) {
        if (rawValue === undefined || rawValue === null) return 'bad';
        const configured = String(point.quality || '').trim().toLowerCase();
        if (['good', 'stale', 'bad'].includes(configured)) return configured;
        return 'good';
    }

    _resolveCategory(point) {
        const configured = String(point.category || '').trim().toLowerCase();
        if (DATA_GROUPS.includes(configured)) return configured;

        const name = String(point.name || '').toLowerCase();
        if (name.includes('gas') || name.includes('valve') || name.includes('n2') ||
            name.includes('nitrogen') || name.includes('methanol') || name.includes('propane') ||
            name.includes('ammonia') || name.includes('rx') || name.includes('purge') ||
            name.includes('enrich')) {
            return 'gas';
        }
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

    _applyExpression(value, point) {
        const expression = String(point.expression || '').trim();
        if (!expression || typeof value !== 'number' || Number.isNaN(value)) return value;
        if (!/^[xX0-9+\-*/().\s]+$/.test(expression)) return value;

        try {
            const fn = new Function('x', `"use strict"; return (${expression});`);
            const result = Number(fn(value));
            return Number.isFinite(result) ? parseFloat(result.toFixed(3)) : value;
        } catch (e) {
            return value;
        }
    }

    _convertValue(rawValue, dataType) {
        if (rawValue === undefined || rawValue === null) return null;
        const type = this._canonicalDataType(dataType);
        switch (type) {
            case 'BOOL':
                return !!rawValue;
            case 'REAL':
            case 'LREAL':
                return parseFloat(Number(rawValue).toFixed(2));
            case 'INT':
            case 'WORD':
            case 'DINT':
            case 'DWORD':
            case 'BYTE':
                return parseInt(rawValue, 10);
            case 'STRING':
            case 'CHAR':
            case 'DT':
            case 'DTZ':
            case 'DTL':
            case 'DTLZ':
                return rawValue instanceof Date ? rawValue.toISOString() : String(rawValue);
            default:
                return rawValue;
        }
    }

    _clearTaskTimers(task) {
        if (task.timer) {
            clearInterval(task.timer);
            task.timer = null;
        }
        if (task.retryTimer) {
            clearTimeout(task.retryTimer);
            task.retryTimer = null;
        }
        task.reading = false;
    }

    _dropTaskConnection(task) {
        if (!task.conn) return;
        try {
            task.conn.dropConnection();
        } catch (e) {
            // nodes7 断开异常无需阻断重连。
        }
        task.conn = null;
    }

    _isTruthy(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        const text = String(value || '').trim().toLowerCase();
        return ['1', 'true', 'yes', 'on', 'enabled'].includes(text);
    }

    _clampInteger(value, min, max, fallback) {
        const next = Number(value);
        if (!Number.isFinite(next)) return fallback;
        return Math.max(min, Math.min(max, Math.round(next)));
    }

    _maxNumber(values) {
        const valid = values.filter(value => Number.isFinite(Number(value))).map(Number);
        return valid.length ? Math.max(...valid) : null;
    }

    _minNumber(values) {
        const valid = values.filter(value => Number.isFinite(Number(value))).map(Number);
        return valid.length ? Math.min(...valid) : null;
    }
}

module.exports = PlcReader;
