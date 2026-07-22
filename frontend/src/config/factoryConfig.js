import { reactive, ref } from 'vue'
import { API_BASE } from '../runtime/backendEndpoint.js'

// 全局响应式配置状态
const factoryConfig = reactive({
    settings: {},
    workshops: [],
    lines: [],
    models: [],
    platform: {},
    loaded: false
})

const loading = ref(false)
const error = ref(null)

async function readApiJson(resp, fallbackMessage = '请求失败') {
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) return { error: data.error || `${fallbackMessage}: ${resp.status}` }
    return data
}

function pathId(id) {
    return encodeURIComponent(String(id))
}

/**
 * 从后端拉取完整工厂配置
 */
async function loadConfig() {
    loading.value = true
    error.value = null
    try {
        const resp = await fetch(`${API_BASE}/config`)
        if (!resp.ok) throw new Error(`配置加载失败: ${resp.status}`)
        const data = await resp.json()
        
        factoryConfig.settings = data.settings || {}
        factoryConfig.workshops = data.workshops || []
        
        // 为了兼容性，我们可以从 workshops 拍平 lines，或者直接取 data.workshops 下挂载的 lines。
        // 由于 config.js 返回的是 workshops -> lines，我们把它拍平赋给 factoryConfig.lines 方便原有逻辑使用
        factoryConfig.lines = factoryConfig.workshops.flatMap(ws => ws.lines)
        factoryConfig.models = data.models || []
        factoryConfig.platform = data.platform || {}
        factoryConfig.loaded = true
        
        console.log(`✅ 工厂配置加载完成: ${factoryConfig.workshops.length} 个车间, ${factoryConfig.lines.length} 条产线`)
    } catch (e) {
        error.value = e.message
        console.error('❌ 加载工厂配置失败:', e)
        // 回退到默认配置
        useFallbackConfig()
    } finally {
        loading.value = false
    }
}

/**
 * 当后端不可用时的回退配置
 */
function useFallbackConfig() {
    factoryConfig.settings = {
        factory_name: '智能热处理数字孪生控制中心',
        data_mode: 'integrated_plc',
        render_profile: 'balanced',
        render_target_fps: '45',
        render_scale: '1',
        render_antialias: 'false',
        render_label_fps: '12'
    }
    
    const lineNames = ['A 产线', 'B 产线', 'C 产线', 'D 产线']
    const fallbackLines = lineNames.map((name, li) => {
        const lineId = `line_${String.fromCharCode(97 + li)}`
        const devices = []
        for (let di = 0; di < 5; di++) {
            const globalIdx = li * 5 + di
            devices.push({
                id: `Furnace_${String(globalIdx + 1).padStart(2, '0')}`,
                name: `${globalIdx + 1}# 多用炉`,
                line_id: lineId,
                model_type: 'builtin_furnace',
                model_file: null,
                pos_x: (di - 2) * 14,
                pos_y: 0,
                pos_z: -li * 16,
                rotation_y: 0,
                scale: 1.0,
                sort_order: di,
                dataPoints: []
            })
        }
        return { id: lineId, name, workshop_id: 'ws_1', sort_order: li, devices }
    })
    
    factoryConfig.workshops = [{ id: 'ws_1', name: '默认车间 1', sort_order: 0, lines: fallbackLines }]
    factoryConfig.lines = fallbackLines
    
    factoryConfig.models = []
    factoryConfig.platform = {
        activeProject: { id: 'project_default', name: '离线演示项目' },
        activeScene: {
            id: 'scene_factory_overview',
            name: '工厂总览',
            camera: { mode: 'auto', staleMs: 6000 },
            theme: { preset: 'industrial_twin' }
        },
        widgets: [
            { id: 'widget_navigation', widget_type: 'navigation', title: '层级导航', visible: 1 },
            { id: 'widget_metrics', widget_type: 'metrics', title: '生产指标', visible: 1, config: { compact: true } },
            { id: 'widget_trend', widget_type: 'trend', title: '历史趋势', visible: 1, config: { metric: 'avg_temp' } },
            { id: 'widget_alarms', widget_type: 'alarm_list', title: '报警履历', visible: 1, config: { limit: 5 } },
            { id: 'widget_marquee', widget_type: 'marquee', title: '实时日志', visible: 1, config: { speed: 30, limit: 20, eventWindowHours: 24 } }
        ]
    }
    factoryConfig.loaded = true
    console.warn('⚠️ 使用回退配置（后端不可用）')
}

/**
 * Vue Composable：在组件中使用配置
 */
export function useFactoryConfig() {
    return {
        config: factoryConfig,
        loading,
        error,
        loadConfig,

        // 便捷方法
        getWorkshops: () => factoryConfig.workshops,
        getLines: () => factoryConfig.lines,
        getDevicesByLine: (lineId) => {
            const line = factoryConfig.lines.find(l => l.id === lineId)
            return line ? line.devices : []
        },
        getAllDevices: () => factoryConfig.lines.flatMap(l => l.devices),
        getPlatform: () => factoryConfig.platform,
        getSetting: (key, defaultValue = '') => factoryConfig.settings[key] || defaultValue,
        getFactoryName: () => factoryConfig.settings.factory_name || '智能热处理数字孪生控制中心'
    }
}

// Admin API helpers
export const adminApi = {
    // 车间
    async getWorkshops() { return (await fetch(`${API_BASE}/workshops`)).json() },
    async createWorkshop(data) { return readApiJson(await fetch(`${API_BASE}/workshops`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建车间失败') },
    async updateWorkshop(id, data) { return readApiJson(await fetch(`${API_BASE}/workshops/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存车间失败') },
    async deleteWorkshop(id) { return readApiJson(await fetch(`${API_BASE}/workshops/${pathId(id)}`, { method: 'DELETE' }), '删除车间失败') },

    // 产线
    async getLines() { return (await fetch(`${API_BASE}/lines`)).json() },
    async createLine(data) { return readApiJson(await fetch(`${API_BASE}/lines`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建产线失败') },
    async updateLine(id, data) { return readApiJson(await fetch(`${API_BASE}/lines/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存产线失败') },
    async deleteLine(id) { return readApiJson(await fetch(`${API_BASE}/lines/${pathId(id)}`, { method: 'DELETE' }), '删除产线失败') },

    // 设备
    async getDevices(lineId) { 
        const url = lineId ? `${API_BASE}/devices?line_id=${encodeURIComponent(lineId)}` : `${API_BASE}/devices`
        return (await fetch(url)).json() 
    },
    async getDevice(id) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`), '读取设备失败') },
    async createDevice(data) { return readApiJson(await fetch(`${API_BASE}/devices`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建设备失败') },
    async updateDevice(id, data) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存设备失败') },
    async deleteDevice(id) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`, { method: 'DELETE' }), '删除设备失败') },

    // 点位
    async getDataPoints(deviceId) {
        const suffix = deviceId && deviceId !== 'all' ? `?device_id=${encodeURIComponent(deviceId)}` : ''
        return (await fetch(`${API_BASE}/datapoints${suffix}`)).json()
    },
    async saveDataPointsBatch(deviceId, points) { 
        return readApiJson(await fetch(`${API_BASE}/datapoints/batch`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ device_id: deviceId, points }) }), '保存点位失败')
    },
    async getRealtimePointValues(deviceId) {
        const suffix = deviceId && deviceId !== 'all' ? `?device_id=${encodeURIComponent(deviceId)}` : ''
        return readApiJson(await fetch(`${API_BASE}/plc/points/realtime${suffix}`), '读取实时点位失败')
    },
    async deleteDataPoint(id) { return readApiJson(await fetch(`${API_BASE}/datapoints/${pathId(id)}`, { method: 'DELETE' }), '删除点位失败') },

    // 设置
    async getSettings() { return (await fetch(`${API_BASE}/settings`)).json() },
    async saveSettings(data) { return readApiJson(await fetch(`${API_BASE}/settings`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存设置失败') },
    async getDatabaseConfig() { return (await fetch(`${API_BASE}/database/config`)).json() },
    async testDatabaseConfig(data) { return readApiJson(await fetch(`${API_BASE}/database/test`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '测试数据库连接失败') },
    async saveDatabaseConfig(data) { return readApiJson(await fetch(`${API_BASE}/database/config`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存数据库配置失败') },
    async getDatabaseBackups() { return readApiJson(await fetch(`${API_BASE}/database/backups`), '读取数据库备份失败') },
    async createDatabaseBackup() { return readApiJson(await fetch(`${API_BASE}/database/backups`, { method: 'POST' }), '创建数据库备份失败') },
    async restoreDatabaseBackup(filename) { return readApiJson(await fetch(`${API_BASE}/database/backups/${pathId(filename)}/restore`, { method: 'POST' }), '恢复数据库备份失败') },
    databaseBackupDownloadUrl(filename) { return `${API_BASE}/database/backups/${pathId(filename)}/download` },

    // 模型
    async getModels() { return (await fetch(`${API_BASE}/models`)).json() },
    async uploadModel(formData) { return readApiJson(await fetch(`${API_BASE}/models/upload`, { method: 'POST', body: formData }), '上传模型失败') },
    async updateModel(id, data) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存模型失败') },
    async deleteModel(id) {
        const resp = await fetch(`${API_BASE}/models/${pathId(id)}`, { method: 'DELETE' })
        const data = await resp.json().catch(() => ({}))
        return resp.ok ? data : { error: data.error || `删除失败: ${resp.status}` }
    },

    // 平台编排
    async getPlatform() { return (await fetch(`${API_BASE}/platform`)).json() },
    async updateScene(id, data) { return readApiJson(await fetch(`${API_BASE}/platform/scenes/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存场景失败') },
    async createWidget(data) { return readApiJson(await fetch(`${API_BASE}/platform/widgets`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建组件失败') },
    async updateWidget(id, data) { return readApiJson(await fetch(`${API_BASE}/platform/widgets/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存组件失败') },
    async deleteWidget(id) { return readApiJson(await fetch(`${API_BASE}/platform/widgets/${pathId(id)}`, { method: 'DELETE' }), '删除组件失败') },
    async getEvents(limit = 50) { return (await fetch(`${API_BASE}/platform/events?limit=${limit}`)).json() },
    async createEvent(data) { return (await fetch(`${API_BASE}/platform/events`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
}
