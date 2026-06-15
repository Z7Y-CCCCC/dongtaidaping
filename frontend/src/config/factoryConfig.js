import { reactive, ref } from 'vue'

const API_BASE = 'http://localhost:3001/api'

// 全局响应式配置状态
const factoryConfig = reactive({
    settings: {},
    workshops: [],
    lines: [],
    models: [],
    loaded: false
})

const loading = ref(false)
const error = ref(null)

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
        mqtt_broker: 'ws://broker.emqx.io:8083/mqtt',
        mqtt_topic_prefix: 'factory/Line1',
        data_mode: 'simulation'
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
        getSetting: (key, defaultValue = '') => factoryConfig.settings[key] || defaultValue,
        getMqttBroker: () => factoryConfig.settings.mqtt_broker || 'ws://broker.emqx.io:8083/mqtt',
        getMqttTopicPrefix: () => factoryConfig.settings.mqtt_topic_prefix || 'factory/Line1',
        getFactoryName: () => factoryConfig.settings.factory_name || '智能热处理数字孪生控制中心'
    }
}

// Admin API helpers
export const adminApi = {
    // 车间
    async getWorkshops() { return (await fetch(`${API_BASE}/workshops`)).json() },
    async createWorkshop(data) { return (await fetch(`${API_BASE}/workshops`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
    async updateWorkshop(id, data) { return (await fetch(`${API_BASE}/workshops/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
    async deleteWorkshop(id) { return (await fetch(`${API_BASE}/workshops/${id}`, { method: 'DELETE' })).json() },

    // 产线
    async getLines() { return (await fetch(`${API_BASE}/lines`)).json() },
    async createLine(data) { return (await fetch(`${API_BASE}/lines`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
    async updateLine(id, data) { return (await fetch(`${API_BASE}/lines/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
    async deleteLine(id) { return (await fetch(`${API_BASE}/lines/${id}`, { method: 'DELETE' })).json() },

    // 设备
    async getDevices(lineId) { 
        const url = lineId ? `${API_BASE}/devices?line_id=${lineId}` : `${API_BASE}/devices`
        return (await fetch(url)).json() 
    },
    async getDevice(id) { return (await fetch(`${API_BASE}/devices/${id}`)).json() },
    async createDevice(data) { return (await fetch(`${API_BASE}/devices`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
    async updateDevice(id, data) { return (await fetch(`${API_BASE}/devices/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
    async deleteDevice(id) { return (await fetch(`${API_BASE}/devices/${id}`, { method: 'DELETE' })).json() },

    // 点位
    async getDataPoints(deviceId) { return (await fetch(`${API_BASE}/datapoints?device_id=${deviceId}`)).json() },
    async saveDataPointsBatch(deviceId, points) { 
        return (await fetch(`${API_BASE}/datapoints/batch`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ device_id: deviceId, points }) })).json() 
    },
    async deleteDataPoint(id) { return (await fetch(`${API_BASE}/datapoints/${id}`, { method: 'DELETE' })).json() },

    // 设置
    async getSettings() { return (await fetch(`${API_BASE}/settings`)).json() },
    async saveSettings(data) { return (await fetch(`${API_BASE}/settings`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },

    // 模型
    async getModels() { return (await fetch(`${API_BASE}/models`)).json() },
    async uploadModel(formData) { return (await fetch(`${API_BASE}/models/upload`, { method: 'POST', body: formData })).json() },
    async deleteModel(id) { return (await fetch(`${API_BASE}/models/${id}`, { method: 'DELETE' })).json() },
}
