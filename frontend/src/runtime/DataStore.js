import { reactive, ref } from 'vue';

const API_BASE = 'http://localhost:3001/api';

function getDeviceQuality(data) {
    const groups = data?.quality || {};
    const values = Object.values(groups).flatMap(group => Object.values(group || {}));
    if (values.includes('bad')) return 'bad';
    if (values.includes('stale')) return 'stale';
    return 'good';
}

function formatEvent(row) {
    const date = row?.occurred_at ? new Date(row.occurred_at) : new Date();
    return {
        id: row?.id ?? `${Date.now()}-${Math.random()}`,
        time: date.toLocaleTimeString(),
        msg: row?.title || row?.message || '系统事件',
        level: row?.level || 'info'
    };
}

export function createDashboardDataStore(options = {}) {
    const staleMs = ref(options.staleMs || 6000);
    const metricsRefreshIntervalMs = options.metricsRefreshIntervalMs || 5000;
    const eventsRefreshIntervalMs = options.eventsRefreshIntervalMs || 5000;
    const wsConnected = ref(false);
    const plcStatusText = ref('等待连接...');
    const selectedDeviceId = ref(null);
    const selectedDeviceData = reactive({});
    const deviceStatusMap = reactive({});
    const metrics = reactive({
        current_output: 0,
        daily_target: 1,
        overall_oee: 0,
        energy_consumption: 0,
        running_devices: 0,
        alarm_devices: 0,
        online_devices: 0,
        total_devices: 0
    });
    const events = ref([{ id: 'boot', time: new Date().toLocaleTimeString(), msg: '等待实时事件接入', level: 'info' }]);
    const trendPoints = ref([
        { time: '08:00', value: 840 },
        { time: '10:00', value: 852 },
        { time: '12:00', value: 850 },
        { time: '14:00', value: 855 },
        { time: '16:00', value: 848 },
        { time: '18:00', value: 850 }
    ]);

    const latestDeviceDataMap = new Map();
    const lastSeenMap = new Map();
    let wsClient = null;
    let reconnectTimer = null;
    let staleTimer = null;
    let disposed = false;
    let onDeviceData = null;
    let lastMetricsRefreshAt = 0;
    let lastEventsRefreshAt = 0;
    let metricsInFlight = false;
    let eventsInFlight = false;

    function setStaleMs(value) {
        const next = Number(value);
        if (Number.isFinite(next) && next > 0) staleMs.value = next;
    }

    function setDeviceDataHandler(handler) {
        onDeviceData = handler;
    }

    function registerDevice(deviceCfg) {
        if (!deviceCfg?.id) return;
        deviceStatusMap[deviceCfg.id] = {
            name: deviceCfg.name,
            temp: '--',
            carbon: '--',
            running: false,
            alarm: false,
            online: false,
            quality: 'bad',
            lastSeen: null
        };
    }

    function selectDevice(deviceId) {
        selectedDeviceId.value = deviceId;
        const cachedData = latestDeviceDataMap.get(deviceId);
        Object.keys(selectedDeviceData).forEach(key => delete selectedDeviceData[key]);
        if (cachedData) Object.assign(selectedDeviceData, cachedData);
    }

    function applyDeviceRealtimeData(data) {
        if (!data?.furnace_id) return;

        latestDeviceDataMap.set(data.furnace_id, data);
        lastSeenMap.set(data.furnace_id, Date.now());

        const quality = getDeviceQuality(data);
        deviceStatusMap[data.furnace_id] = {
            name: data.furnace_name,
            temp: data.analog?.actual_temp ?? '--',
            carbon: data.analog?.actual_carbon ?? '--',
            running: !!data.status?.running,
            alarm: !!data.status?.alarm,
            online: quality !== 'bad',
            quality,
            lastSeen: Date.now()
        };

        if (selectedDeviceId.value === data.furnace_id) {
            Object.assign(selectedDeviceData, data);
        }

        if (onDeviceData) onDeviceData(data);
    }

    function cloneDataWithQuality(data, quality) {
        const next = {
            ...data,
            quality: {}
        };
        Object.entries(data?.quality || {}).forEach(([groupName, group]) => {
            next.quality[groupName] = {};
            Object.keys(group || {}).forEach(fieldName => {
                next.quality[groupName][fieldName] = quality;
            });
        });
        if (!next.quality.status) next.quality.status = {};
        next.quality.status._connection = quality;
        return next;
    }

    function applyFrame(payload) {
        const devices = payload?.devices || [];
        devices.forEach(applyDeviceRealtimeData);
        updateRollingTrend(devices);
        refreshMetrics();
        refreshEvents();
    }

    function updateRollingTrend(devices) {
        const temps = devices.map(d => Number(d.analog?.actual_temp)).filter(Number.isFinite);
        if (!temps.length) return;
        const avgTemp = temps.reduce((sum, value) => sum + value, 0) / temps.length;
        const now = new Date().toLocaleTimeString().slice(0, 5);
        const points = [...trendPoints.value, { time: now, value: Number(avgTemp.toFixed(1)) }];
        trendPoints.value = points.slice(-8);
    }

    function checkStaleDevices() {
        const now = Date.now();
        Object.entries(deviceStatusMap).forEach(([deviceId, status]) => {
            const lastSeen = lastSeenMap.get(deviceId);
            if (!lastSeen) return;
            const age = now - lastSeen;
            if (age > staleMs.value) {
                const nextQuality = age > staleMs.value * 2 ? 'bad' : 'stale';
                if (status.quality !== nextQuality) {
                    status.quality = nextQuality;
                    status.online = status.quality !== 'bad';
                    const cachedData = latestDeviceDataMap.get(deviceId);
                    if (cachedData) {
                        const staleData = cloneDataWithQuality(cachedData, nextQuality);
                        latestDeviceDataMap.set(deviceId, staleData);
                        if (selectedDeviceId.value === deviceId) {
                            Object.keys(selectedDeviceData).forEach(key => delete selectedDeviceData[key]);
                            Object.assign(selectedDeviceData, staleData);
                        }
                        if (onDeviceData) onDeviceData(staleData);
                    }
                }
            }
        });
    }

    async function refreshEvents(force = false) {
        const now = Date.now();
        if (!force && (eventsInFlight || now - lastEventsRefreshAt < eventsRefreshIntervalMs)) return;
        eventsInFlight = true;
        try {
            const resp = await fetch(`${API_BASE}/platform/events?limit=20`);
            if (!resp.ok) return;
            const rows = await resp.json();
            events.value = rows.length ? rows.map(formatEvent) : [{ id: 'empty', time: new Date().toLocaleTimeString(), msg: '暂无报警履历', level: 'info' }];
        } catch (e) {
            // 离线时保留当前列表。
        } finally {
            lastEventsRefreshAt = Date.now();
            eventsInFlight = false;
        }
    }

    async function refreshMetrics(force = false) {
        const now = Date.now();
        if (!force && (metricsInFlight || now - lastMetricsRefreshAt < metricsRefreshIntervalMs)) return;
        metricsInFlight = true;
        try {
            const resp = await fetch(`${API_BASE}/platform/metrics/latest`);
            if (!resp.ok) return;
            const data = await resp.json();
            Object.assign(metrics, data);
        } catch (e) {
            // 离线时用实时帧聚合兜底。
            const statuses = Object.values(deviceStatusMap);
            metrics.total_devices = statuses.length;
            metrics.online_devices = statuses.filter(s => s.online).length;
            metrics.running_devices = statuses.filter(s => s.running).length;
            metrics.alarm_devices = statuses.filter(s => s.alarm).length;
        } finally {
            lastMetricsRefreshAt = Date.now();
            metricsInFlight = false;
        }
    }

    function connect() {
        if (disposed) return;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost = window.location.hostname || 'localhost';
        const wsUrl = `${wsProtocol}//${wsHost}:3001/ws`;
        wsClient = new WebSocket(wsUrl);

        wsClient.onopen = () => {
            wsConnected.value = true;
            plcStatusText.value = '通信正常';
        };

        wsClient.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'realtime_frame') {
                    applyFrame(msg.payload);
                } else if (msg.type === 'device_data') {
                    applyDeviceRealtimeData(msg.payload);
                } else if (msg.type === 'plc_status') {
                    plcStatusText.value = msg.payload?.message || msg.payload?.status || '状态未知';
                }
            } catch (e) {
                // 忽略非 JSON 消息。
            }
        };

        wsClient.onclose = () => {
            if (disposed) return;
            wsConnected.value = false;
            plcStatusText.value = '连接断开，重连中...';
            reconnectTimer = setTimeout(() => connect(), 5000);
        };

        wsClient.onerror = () => {
            wsConnected.value = false;
        };

        if (!staleTimer) {
            staleTimer = setInterval(checkStaleDevices, 1000);
        }
    }

    function dispose() {
        disposed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (staleTimer) clearInterval(staleTimer);
        if (wsClient) {
            wsClient.onclose = null;
            wsClient.close();
        }
        reconnectTimer = null;
        staleTimer = null;
        wsClient = null;
    }

    return {
        staleMs,
        wsConnected,
        plcStatusText,
        selectedDeviceId,
        selectedDeviceData,
        deviceStatusMap,
        metrics,
        events,
        trendPoints,
        latestDeviceDataMap,
        setStaleMs,
        setDeviceDataHandler,
        registerDevice,
        selectDevice,
        connect,
        dispose,
        refreshEvents,
        refreshMetrics
    };
}
