<script setup>
import { ref, reactive, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { adminApi } from '../config/factoryConfig.js'
import { SceneRuntime } from '../runtime/SceneRuntime.js'
import { createDeviceModel, resolveBackendAssetUrl } from '../three/ModelFactory.js'

// 当前选中的 Tab
const activeTab = ref('composer')
const isAdminNavCollapsed = ref(false)
const isFactoryMenuOpen = ref(true)
const navIconPaths = {
    composer: ['M4 5h16v14H4z', 'M8 9h8', 'M8 13h5', 'M16 13h1', 'M8 17h8'],
    factory: ['M4 20V9l4-3 4 3 4-3 4 3v11', 'M8 20v-6h3v6', 'M16 20v-6h3v6', 'M12 20V9'],
    workshops: ['M4 20V8l8-4 8 4v12', 'M8 20v-8h8v8', 'M10 8h4'],
    lines: ['M4 7h5', 'M15 7h5', 'M9 7c2 0 4 10 6 10', 'M4 17h5', 'M15 17h5'],
    devices: ['M6 8h12v8H6z', 'M9 8V5h6v3', 'M9 19h6', 'M12 16v3'],
    models: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
    platform: ['M5 5h6v6H5z', 'M13 5h6v6h-6z', 'M5 13h6v6H5z', 'M13 13h6v6h-6z'],
    points: ['M5 12h4', 'M15 12h4', 'M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0', 'M12 5V3', 'M12 21v-2'],
    settings: ['M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z', 'M12 2v3', 'M12 19v3', 'M4.93 4.93l2.12 2.12', 'M16.95 16.95l2.12 2.12', 'M2 12h3', 'M19 12h3', 'M4.93 19.07l2.12-2.12', 'M16.95 7.05l2.12-2.12']
}

// ============ 车间管理 ============
const workshops = ref([])
const newWorkshop = reactive({ id: '', name: '' })

async function loadWorkshops() {
    workshops.value = await adminApi.getWorkshops()
}

async function createWorkshop() {
    if (!newWorkshop.id || !newWorkshop.name) return alert('请填写车间ID和名称')
    await adminApi.createWorkshop({ id: newWorkshop.id, name: newWorkshop.name, sort_order: workshops.value.length })
    newWorkshop.id = ''
    newWorkshop.name = ''
    await loadWorkshops()
}

async function deleteWorkshop(id) {
    if (!confirm(`确定删除车间 ${id}？该车间下的所有产线及设备也会被删除！`)) return
    await adminApi.deleteWorkshop(id)
    await loadWorkshops()
    await loadLines()
    await loadDevices()
}

// ============ 产线管理 ============
const lines = ref([])
const newLine = reactive({ id: '', name: '', workshop_id: '' })

async function loadLines() {
    lines.value = await adminApi.getLines()
    if (lines.value.length === 0 && workshops.value.length > 0) {
        newLine.workshop_id = workshops.value[0].id
    }
}

async function createLine() {
    if (!newLine.id || !newLine.name || !newLine.workshop_id) return alert('请填写产线ID、名称和所属车间')
    await adminApi.createLine({ id: newLine.id, name: newLine.name, workshop_id: newLine.workshop_id, sort_order: lines.value.length })
    newLine.id = ''
    newLine.name = ''
    await loadLines()
}

async function deleteLine(id) {
    if (!confirm(`确定删除产线 ${id}？该产线下的所有设备也会被删除！`)) return
    await adminApi.deleteLine(id)
    await loadLines()
    await loadDevices()
}

// ============ 设备管理 ============
const devices = ref([])
const showDeviceForm = ref(false)
const editingDeviceWorkshopId = ref('')
function defaultPlcConnectionConfig() {
    return {
        plc_enabled: 0,
        plc_protocol: 'S7',
        plc_ip: '',
        plc_port: 102,
        plc_rack: 0,
        plc_slot: 1,
        plc_timeout: 5000,
        plc_retry_interval: 10000,
        plc_max_retries: 0
    }
}
const editingDevice = reactive({
    id: '', name: '', line_id: '', model_type: 'builtin_furnace', model_file: '', template_id: '', instance_config: '{}',
    pos_x: 0, pos_y: 0, pos_z: 0, rotation_y: 0, scale: 1.0, sort_order: 0,
    ...defaultPlcConnectionConfig()
})
const isEditMode = ref(false)

async function loadDevices() {
    devices.value = await adminApi.getDevices()
}

function openCreateDevice() {
    isEditMode.value = false
    editingDeviceWorkshopId.value = workshops.value[0]?.id || ''
    Object.assign(editingDevice, { 
        id: '', name: '', line_id: lines.value[0]?.id || '', 
        model_type: 'builtin_furnace', model_file: '', template_id: '', instance_config: '{}',
        pos_x: 0, pos_y: 0, pos_z: 0, rotation_y: 0, scale: 1.0, sort_order: devices.value.length,
        ...defaultPlcConnectionConfig()
    })
    showDeviceForm.value = true
}

function openEditDevice(d) {
    isEditMode.value = true
    const normalized = normalizeDeviceConfig(d)
    Object.assign(editingDevice, { ...defaultPlcConnectionConfig(), ...normalized, line_id: normalized.line_id || '' })
    editingDeviceWorkshopId.value = getDeviceWorkshopId(editingDevice) || workshops.value[0]?.id || ''
    showDeviceForm.value = true
}

async function saveDevice() {
    if (!editingDevice.id || !editingDevice.name) {
        return alert('请填写设备ID和名称')
    }
    const isAuxiliary = isAuxiliaryDeviceConfig(editingDevice)
    if (!isAuxiliary && !editingDevice.line_id) {
        return alert('普通设备必须选择所属产线')
    }
    if (isAuxiliary && !editingDeviceWorkshopId.value) {
        return alert('辅助设备必须选择所在车间')
    }

    let parsedInstanceConfig = {}
    try {
        parsedInstanceConfig = parseEditableInstanceConfig(editingDevice.instance_config)
    } catch (e) {
        return alert('实例配置 JSON 格式不正确')
    }
    const payload = buildDevicePayloadForSave({ ...editingDevice, instance_config: parsedInstanceConfig }, editingDeviceWorkshopId.value)
    if (isEditMode.value) {
        await adminApi.updateDevice(editingDevice.id, payload)
    } else {
        await adminApi.createDevice(payload)
    }
    showDeviceForm.value = false
    await loadDevices()
}

async function deleteDevice(id) {
    if (!confirm(`确定删除设备 ${id}？`)) return
    await adminApi.deleteDevice(id)
    await loadDevices()
}

// ============ 点位映射 ============
const selectedDeviceForPoints = ref('')
const dataPoints = ref([])
const isPointsDirty = ref(false)
const showPointAdvancedFields = ref(false)
const pointCategories = [
    { value: '', label: '自动' },
    { value: 'analog', label: '模拟量' },
    { value: 'status', label: '状态' },
    { value: 'motors', label: '电机' },
    { value: 'doors', label: '炉门' },
    { value: 'mechanisms', label: '机构' },
    { value: 'gas', label: '气体' }
]
async function loadDataPoints() {
    if (!selectedDeviceForPoints.value) { dataPoints.value = []; return }
    const points = await adminApi.getDataPoints(selectedDeviceForPoints.value)
    dataPoints.value = points.map(p => ({
        ...p,
        category: p.category || '',
        value_role: p.value_role || '',
        quality: p.quality || 'good',
        scale: p.scale ?? 1,
        offset: p.offset ?? 0,
        expression: p.expression || '',
        display_format: p.display_format || '',
        sample_interval_ms: p.sample_interval_ms ?? 1000,
        access_type: p.access_type || 'READ',
        db_number: p.db_number ?? null,
        db_byte_offset: p.db_byte_offset ?? null,
        bit_offset: p.bit_offset ?? null
    }))
    isPointsDirty.value = false
}

function addDataPoint() {
    dataPoints.value.push({
        name: '',
        label: '',
        plc_tag: '',
        data_type: 'WORD',
        category: '',
        value_role: '',
        quality: 'good',
        scale: 1,
        offset: 0,
        expression: '',
        display_format: '',
        unit: '',
        sample_interval_ms: 1000,
        access_type: 'READ',
        db_number: null,
        db_byte_offset: null,
        bit_offset: null
    })
    isPointsDirty.value = true
}

function removeDataPoint(idx) {
    dataPoints.value.splice(idx, 1)
    isPointsDirty.value = true
}

function markPointsDirty() {
    isPointsDirty.value = true
}

function buildDataPointPayload(point) {
    const { id, device_id, alarm_high, alarm_low, ...payload } = point
    return {
        ...payload,
        quality: 'good',
        scale: payload.scale ?? 1,
        offset: payload.offset ?? 0,
        expression: payload.expression || '',
        display_format: payload.display_format || ''
    }
}

async function saveAllPoints() {
    if (!selectedDeviceForPoints.value) return alert('请先选择设备')
    const validPoints = dataPoints.value
        .filter(p => p.name && p.label && (p.plc_tag || (p.db_number !== null && p.db_number !== '' && p.db_byte_offset !== null && p.db_byte_offset !== '')))
        .map(buildDataPointPayload)
    const result = await adminApi.saveDataPointsBatch(selectedDeviceForPoints.value, validPoints)
    if (result?.error) return alert(result.error)
    alert('保存成功！')
    isPointsDirty.value = false
    await loadDataPoints()
}

// 扩展功能：从其他设备复制
async function copyPointsFrom(sourceDeviceId) {
    if (!sourceDeviceId || sourceDeviceId === selectedDeviceForPoints.value) return
    if (isPointsDirty.value && !confirm('当前有未保存的修改，复制将覆盖这些修改，确定继续？')) return
    
    const sourcePoints = await adminApi.getDataPoints(sourceDeviceId)
    if (sourcePoints.length === 0) {
        return alert('源设备没有点位配置')
    }
    
    // 复制时去掉 id 相关的字段（如果后端有的话），保持干净的映射
    dataPoints.value = sourcePoints.map(p => ({ ...p, id: undefined }))
    isPointsDirty.value = true
    alert(`已成功复制 ${sourcePoints.length} 个点位配置，请检查后点击保存。`)
}

// 扩展功能：同步到同产线其他设备
async function syncToLine() {
    if (isPointsDirty.value) {
        return alert('请先保存当前设备的点位配置，再执行同步操作！')
    }
    const currentDevice = devices.value.find(d => d.id === selectedDeviceForPoints.value)
    if (!currentDevice) return
    
    const targetDevices = devices.value.filter(d => d.line_id === currentDevice.line_id && d.id !== currentDevice.id)
    if (targetDevices.length === 0) return alert('该产线下没有其他设备。')
    
    if (!confirm(`确定将当前点位配置同步到同产线的 ${targetDevices.length} 台设备吗？\n（目标设备的原有配置将被覆盖）`)) return
    
    const validPoints = dataPoints.value.filter(p => p.name && p.label && p.plc_tag)
    
    try {
        for (const d of targetDevices) {
            await adminApi.saveDataPointsBatch(d.id, validPoints)
        }
        alert('批量同步成功！现在同产线的所有设备都使用了相同的点位结构。')
    } catch (e) {
        alert('同步过程中发生错误')
    }
}

// ============ 连接设置 ============
const settings = reactive({
    factory_name: '',
    data_mode: 'integrated_plc',
    realtime_stale_ms: '6000',
    display_mode: 'industrial_twin',
    // 视角模式
    camera_mode: 'auto'
})

async function loadSettings() {
    const s = await adminApi.getSettings()
    if (s.data_mode !== 'simulation') s.data_mode = 'integrated_plc'
    Object.assign(settings, s)
    await loadDatabaseConfig()
    // 同时获取引擎状态
    loadEngineStatus()
}

const engineStatus = reactive({
    mode: null,
    plcStatus: { status: 'unknown', message: '未知' },
    collectorStatus: { status: 'unknown', message: '未知' }
})
const plcStatusLabels = {
    connected: '已连接',
    connecting: '连接中',
    retrying: '重连中',
    error: '异常',
    disabled: '未启用',
    no_points: '无点位',
    unconfigured: '未配置',
    unsupported: '暂不支持',
    stopped: '已停止',
    idle: '等待'
}
const plcStatusByDevice = computed(() => {
    const map = {}
    const statuses = engineStatus.plcStatus?.devices || []
    statuses.forEach(status => {
        map[status.deviceId] = status
    })
    return map
})

function formatPlcDeviceStatus(device) {
    if (!Number(device.plc_enabled || 0)) return '未启用'
    const status = plcStatusByDevice.value[device.id]
    if (!status) return device.plc_ip ? '等待采集' : '未配置'
    return plcStatusLabels[status.status] || status.status || '未知'
}

function formatPlcEndpoint(device) {
    if (!Number(device.plc_enabled || 0)) return '未启用'
    const status = plcStatusByDevice.value[device.id]
    if (status?.endpoint) return status.endpoint
    if (!device.plc_ip) return '未填写 IP'
    return `${device.plc_protocol || 'S7'} ${device.plc_ip}:${device.plc_port || 102} (Rack=${device.plc_rack ?? 0}, Slot=${device.plc_slot ?? 1})`
}

function formatPlcIntervals(status) {
    const intervals = status?.intervals || []
    return intervals.length ? intervals.map(ms => `${ms}ms`).join(' / ') : '-'
}
const databaseConfig = reactive({
    type: 'mysql',
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: '******',
    database: 'dongtai_daping',
    filename: '',
    encrypt: false,
    trustServerCertificate: true
})
const databaseTestStatus = ref('')
const databaseSaving = ref(false)
const databaseDefaultPorts = {
    mysql: 3307,
    postgres: 5432,
    sqlserver: 1433
}

async function loadDatabaseConfig() {
    try {
        const config = await adminApi.getDatabaseConfig()
        Object.assign(databaseConfig, config)
    } catch (e) {
        databaseTestStatus.value = '数据库配置读取失败'
    }
}

async function testDatabaseConnection() {
    databaseTestStatus.value = '正在测试连接...'
    try {
        const result = await adminApi.testDatabaseConfig({ ...databaseConfig })
        databaseTestStatus.value = result.success ? '连接成功' : `连接失败：${result.error || '未知错误'}`
    } catch (e) {
        databaseTestStatus.value = `连接失败：${e.message || '后端服务不可用'}`
    }
}

async function saveDatabaseConnection() {
    if (!confirm('保存数据库连接后，后端会重新初始化数据库并重启数据引擎，确定继续吗？')) return
    databaseSaving.value = true
    databaseTestStatus.value = '正在保存并重新连接...'
    try {
        const result = await adminApi.saveDatabaseConfig({ ...databaseConfig })
        if (!result.success) {
            databaseTestStatus.value = `保存失败：${result.error || '未知错误'}`
            return
        }
        Object.assign(databaseConfig, result.config || databaseConfig)
        databaseTestStatus.value = '保存成功，数据库已重新连接'
        await Promise.all([loadSettings(), loadWorkshops(), loadLines(), loadDevices(), loadModels(), loadPlatform()])
    } catch (e) {
        databaseTestStatus.value = `保存失败：${e.message || e}`
    } finally {
        databaseSaving.value = false
    }
}

watch(() => databaseConfig.type, (type, oldType) => {
    if (type === oldType) return
    if (type === 'sqlite') {
        databaseConfig.filename ||= 'backend/data/factory.db'
        return
    }
    if (!databaseConfig.port || databaseConfig.port === databaseDefaultPorts[oldType]) {
        databaseConfig.port = databaseDefaultPorts[type] || databaseConfig.port
    }
    databaseConfig.database ||= 'dongtai_daping'
})

async function loadEngineStatus() {
    try {
        const res = await fetch('http://localhost:3001/api/engine/status')
        const data = await res.json()
        Object.assign(engineStatus, data)
    } catch (e) {
        engineStatus.mode = null
        engineStatus.plcStatus = { status: 'error', message: '无法连接后端' }
    }
}

function formatEngineMode(mode) {
    const labels = {
        integrated_plc: '内置低延迟采集模式',
        simulation: '模拟模式'
    }
    return labels[mode] || '未启动'
}

async function saveSettings() {
    await adminApi.saveSettings({
        factory_name: settings.factory_name,
        data_mode: settings.data_mode,
        realtime_stale_ms: settings.realtime_stale_ms,
        display_mode: settings.display_mode,
        camera_mode: settings.camera_mode
    })
    // 保存后自动重启数据引擎
    try {
        await fetch('http://localhost:3001/api/engine/restart', { method: 'POST' })
        alert('设置已保存，数据引擎正在重启以应用新配置...')
    } catch (e) {
        alert('设置已保存，但数据引擎重启失败，请手动重启后端服务')
    }
    // 刷新引擎状态
    setTimeout(() => loadEngineStatus(), 2000)
}

// ============ 模型管理 ============
const models = ref([])
const modelPreviewRef = ref(null)
const modelFileInputRef = ref(null)
const selectedModelFile = ref(null)
const selectedPreviewModelId = ref('')
const modelPreviewMode = ref('asset')
const modelPreviewStatus = ref('选择模型文件后在这里预览')
const modelUploading = ref(false)
const isModelPreviewActive = ref(false)
const modelImportForm = reactive({
    id: '',
    name: '',
    default_scale: 1,
    metadata: '{\n  "batchable": true,\n  "partBindings": []\n}'
})
const fallbackModelOptions = [
    { id: 'builtin_furnace', name: '内置炉子' },
    { id: 'box_atmosphere_furnace', name: '箱式气氛多用炉' },
    { id: 'transfer_cart', name: '轨道料车 / 取料小车' }
]
const availableModelOptions = computed(() => {
    const merged = new Map(fallbackModelOptions.map(model => [model.id, model]))
    models.value.forEach(model => merged.set(model.id, { ...model }))
    return Array.from(merged.values())
})

const selectedModelFileSizeText = computed(() => {
    if (!selectedModelFile.value) return ''
    const mb = selectedModelFile.value.size / 1024 / 1024
    return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`
})

let modelPreviewRuntime = null
let modelPreviewSource = null
let modelPreviewModel = null
let selectedModelObjectUrl = ''
let modelPreviewNodeMap = new Map()
let modelPreviewSelectionBox = null

const modelPreviewNodes = ref([])
const modelPartBindings = ref([])
const selectedModelNodePath = ref('')
const selectedModelBindingIndex = ref(-1)
const modelBindingSaving = ref(false)
const modelBindingStatus = ref('')
const modelBindingForm = reactive({
    id: '',
    name: '',
    node_path: '',
    source_group: 'analog',
    source_key: '',
    action: 'rotate_speed',
    axis: 'y',
    input_min: 0,
    input_max: 100,
    output_min: 0,
    output_max: 90,
    speed_factor: 0.10472,
    on_color: '#00ff88',
    off_color: '#666666',
    invert: false
})
const modelSourceGroups = [
    { value: 'analog', label: '模拟量' },
    { value: 'motors', label: '电机' },
    { value: 'doors', label: '炉门' },
    { value: 'gas', label: '气体' },
    { value: 'mechanisms', label: '机构' },
    { value: 'status', label: '状态' }
]
const modelBindingActions = [
    { value: 'rotate_speed', label: '按转速连续旋转' },
    { value: 'rotate_angle', label: '按数值转角' },
    { value: 'translate', label: '按数值平移' },
    { value: 'visibility', label: '按布尔显示' },
    { value: 'color', label: '按布尔变色' }
]
const modelBindingAxes = [
    { value: 'x', label: 'X' },
    { value: 'y', label: 'Y' },
    { value: 'z', label: 'Z' }
]
const modelNodeNameTranslations = {
    complex_box_atmosphere_multipurpose_furnace_low_poly_merged_by_material: '箱式气氛多用炉低模（按材质合并）',
    merged_warm_light_gray_shell: '浅灰炉体外壳',
    merged_dark_heat_resistant_panel: '深色耐热面板',
    merged_hot_rear_chamber_glow: '后室高温发光区',
    merged_amber_observation_glass: '琥珀色观察窗',
    merged_safety_yellow_gas_pipe: '安全黄色气体管路',
    merged_black_lift_door: '黑色升降炉门',
    merged_brushed_steel_motor: '拉丝钢电机',
    merged_industrial_blue_quench_tank: '工业蓝淬火油槽',
    merged_dark_quench_oil: '深色淬火油',
    merged_dark_steel_rail: '深色钢轨',
    merged_active_green_components: '绿色运行部件'
}
const modelNodeTokenTranslations = {
    complex: '复杂',
    box: '箱式',
    atmosphere: '气氛',
    multipurpose: '多用',
    furnace: '炉',
    low: '低',
    poly: '多边形',
    merged: '合并',
    by: '按',
    material: '材质',
    warm: '暖色',
    light: '浅',
    gray: '灰',
    shell: '外壳',
    dark: '深色',
    heat: '热',
    resistant: '耐',
    panel: '面板',
    hot: '高温',
    rear: '后室',
    chamber: '炉室',
    glow: '发光区',
    amber: '琥珀色',
    observation: '观察',
    glass: '玻璃',
    safety: '安全',
    yellow: '黄色',
    gas: '气体',
    pipe: '管路',
    black: '黑色',
    lift: '升降',
    door: '门',
    brushed: '拉丝',
    steel: '钢',
    motor: '电机',
    industrial: '工业',
    blue: '蓝色',
    quench: '淬火',
    tank: '油槽',
    oil: '油',
    rail: '轨道',
    active: '运行',
    green: '绿色',
    components: '部件'
}
const modelNodeTypeTranslations = {
    Object3D: '对象组',
    Group: '分组',
    Mesh: '网格',
    SkinnedMesh: '蒙皮网格',
    Bone: '骨骼',
    Scene: '场景',
    PerspectiveCamera: '透视相机',
    OrthographicCamera: '正交相机'
}
const activePreviewModel = computed(() => getActivePreviewModel())
const canEditModelBindings = computed(() => !!activePreviewModel.value?.file_path && !activePreviewModel.value?.is_builtin)

async function loadModels() {
    models.value = await adminApi.getModels()
}

function makeModelIdFromFileName(fileName) {
    return fileName.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')
}

function stripModelNodeIndex(name) {
    return String(name || '').replace(/#\d+$/, '')
}

function translateModelNodeName(rawName) {
    const cleanName = stripModelNodeIndex(rawName)
    if (!cleanName) return '未命名节点'
    if (modelNodeNameTranslations[cleanName]) return modelNodeNameTranslations[cleanName]

    const words = cleanName
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .split(/[_\-\s]+/)
        .filter(Boolean)
    const translated = words.map(word => modelNodeTokenTranslations[word.toLowerCase()] || word)
    return translated.join('')
}

function formatModelNodeType(type) {
    return modelNodeTypeTranslations[type] || type || '节点'
}

function formatMeshCount(count) {
    const nextCount = Number(count) || 0
    return nextCount > 0 ? `${nextCount} 个网格` : '无网格'
}

function formatModelNodeOption(node) {
    return `${node.displayName || translateModelNodeName(node.name)} · ${formatModelNodeType(node.type)} · ${formatMeshCount(node.meshCount)}`
}

function formatModelBindingAction(actionValue) {
    return modelBindingActions.find(action => action.value === actionValue)?.label || actionValue || '未设置'
}

function formatModelSourceGroup(groupValue) {
    return modelSourceGroups.find(group => group.value === groupValue)?.label || groupValue || '未设置'
}

function formatModelAxis(axisValue) {
    return modelBindingAxes.find(axis => axis.value === axisValue)?.label || axisValue || '-'
}

function formatModelBindingPartName(binding) {
    if (binding?.name) return binding.name
    const node = modelPreviewNodes.value.find(item => item.path === binding?.node_path)
    if (node) return node.displayName || node.name
    const lastPathSegment = String(binding?.node_path || '').split('/').pop()
    return translateModelNodeName(lastPathSegment)
}

function disposeThreeObject(object) {
    if (!object) return
    object.traverse?.((child) => {
        if (child.element?.parentNode) child.element.parentNode.removeChild(child.element)
        if (child.geometry) child.geometry.dispose()
        const material = child.material
        if (Array.isArray(material)) {
            material.forEach(mat => mat.dispose?.())
        } else if (material) {
            material.dispose?.()
        }
    })
}

function disposeModelPreview(options = {}) {
    if (modelPreviewRuntime) {
        cancelAnimationFrame(modelPreviewRuntime.frameId)
        modelPreviewRuntime.resizeObserver?.disconnect?.()
        modelPreviewRuntime.controls?.dispose?.()
        disposeThreeObject(modelPreviewRuntime.scene)
        modelPreviewRuntime.renderer?.dispose?.()
        const canvas = modelPreviewRuntime.renderer?.domElement
        if (canvas?.parentNode) canvas.parentNode.removeChild(canvas)
        modelPreviewRuntime = null
    }
    isModelPreviewActive.value = false
    modelPreviewNodes.value = []
    if (options.revokeObjectUrl && selectedModelObjectUrl) {
        URL.revokeObjectURL(selectedModelObjectUrl)
        selectedModelObjectUrl = ''
    }
    modelPreviewNodeMap = new Map()
    modelPreviewSelectionBox = null
}

function fitPreviewCamera(camera, controls, object) {
    const box = new THREE.Box3().setFromObject(object)
    if (box.isEmpty()) {
        camera.position.set(4, 3, 6)
        controls.target.set(0, 0, 0)
        controls.update()
        return
    }

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 1)
    const distance = maxDim * 1.75
    camera.near = Math.max(0.01, maxDim / 100)
    camera.far = Math.max(1000, maxDim * 20)
    camera.position.set(center.x + distance * 0.72, center.y + distance * 0.58, center.z + distance)
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
}

function modelNodeSegment(object, index) {
    const rawName = object.name || object.type || 'Object3D'
    return `${String(rawName).replace(/\//g, '_')}#${index}`
}

function collectModelPreviewNodes(root) {
    const nodes = []
    const map = new Map()
    const walk = (object, parentPath) => {
        object.children.forEach((child, index) => {
            const path = parentPath ? `${parentPath}/${modelNodeSegment(child, index)}` : modelNodeSegment(child, index)
            const meshCount = countMeshes(child)
            const rawName = child.name || child.type || `Node ${nodes.length + 1}`
            nodes.push({
                path,
                name: rawName,
                displayName: translateModelNodeName(rawName),
                type: child.type || 'Object3D',
                meshCount
            })
            map.set(path, child)
            walk(child, path)
        })
    }
    walk(root, '')
    return { nodes, map }
}

function countMeshes(object) {
    let count = 0
    object.traverse?.((child) => {
        if (child.isMesh) count += 1
    })
    return count
}

function clearModelPreviewSelectionBox() {
    if (!modelPreviewSelectionBox || !modelPreviewRuntime?.scene) return
    modelPreviewRuntime.scene.remove(modelPreviewSelectionBox)
    modelPreviewSelectionBox.geometry?.dispose?.()
    modelPreviewSelectionBox.material?.dispose?.()
    modelPreviewSelectionBox = null
}

function highlightPreviewNode(path) {
    selectedModelNodePath.value = path || ''
    clearModelPreviewSelectionBox()
    if (!path || !modelPreviewRuntime?.scene) return
    const target = modelPreviewNodeMap.get(path)
    if (!target) return
    modelPreviewSelectionBox = new THREE.BoxHelper(target, 0xffb000)
    modelPreviewSelectionBox.name = 'model_preview_selected_part'
    modelPreviewRuntime.scene.add(modelPreviewSelectionBox)
}

function createModelPreviewRuntime(container) {
    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width || 420))
    const height = Math.max(1, Math.round(rect.height || 320))
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf3f4f5)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000)
    camera.position.set(4, 3, 6)

    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance'
    })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.className = 'model-preview-canvas'
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.7

    scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8582, 1.45))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1)
    keyLight.position.set(6, 9, 7)
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xfff0d6, 0.75)
    fillLight.position.set(-7, 4, -5)
    scene.add(fillLight)

    const grid = new THREE.GridHelper(10, 10, 0xb6bec1, 0xd5dadc)
    grid.position.y = -0.01
    scene.add(grid)

    const runtime = {
        scene,
        camera,
        renderer,
        controls,
        frameId: 0,
        resizeObserver: null,
        updatables: [],
        lastFrameTime: performance.now()
    }
    const render = (now = performance.now()) => {
        const delta = Math.min((now - runtime.lastFrameTime) / 1000, 0.1)
        runtime.lastFrameTime = now
        runtime.updatables.forEach((object) => {
            if (object.visible !== false && object.update) object.update(delta)
        })
        controls.update()
        renderer.render(scene, camera)
        runtime.frameId = requestAnimationFrame(render)
    }
    runtime.frameId = requestAnimationFrame(render)

    if (typeof ResizeObserver !== 'undefined') {
        runtime.resizeObserver = new ResizeObserver(() => {
            const nextRect = container.getBoundingClientRect()
            const nextWidth = Math.max(1, Math.round(nextRect.width || width))
            const nextHeight = Math.max(1, Math.round(nextRect.height || height))
            camera.aspect = nextWidth / nextHeight
            camera.updateProjectionMatrix()
            renderer.setSize(nextWidth, nextHeight)
        })
        runtime.resizeObserver.observe(container)
    }

    return runtime
}

async function renderModelPreview(source) {
    modelPreviewSource = source
    await nextTick()
    const container = modelPreviewRef.value
    if (!container || !source?.url) return

    disposeModelPreview()
    const runtime = createModelPreviewRuntime(container)
    modelPreviewRuntime = runtime
    isModelPreviewActive.value = true
    modelPreviewStatus.value = `正在加载：${source.label}`

    try {
        const loader = new GLTFLoader()
        const gltf = await loader.loadAsync(source.url)
        if (modelPreviewSource !== source || modelPreviewRuntime !== runtime) {
            disposeThreeObject(gltf.scene)
            return
        }

        const root = gltf.scene || gltf.scenes?.[0]
        if (!root) throw new Error('模型文件中没有可显示的场景')
        root.traverse((child) => {
            if (!child.isMesh) return
            child.castShadow = false
            child.receiveShadow = false
        })
        runtime.scene.add(root)
        const { nodes, map } = collectModelPreviewNodes(root)
        modelPreviewNodes.value = nodes
        modelPreviewNodeMap = map
        if (modelBindingForm.node_path) highlightPreviewNode(modelBindingForm.node_path)
        fitPreviewCamera(runtime.camera, runtime.controls, root)
        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        modelPreviewStatus.value = `预览：${source.label} | 尺寸 ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`
    } catch (e) {
        modelPreviewStatus.value = `预览失败：${e.message || e}`
    }
}

async function renderBuiltinModelPreview(model) {
    const source = { builtinId: model.id, label: model.name || model.id }
    modelPreviewSource = source
    await nextTick()
    const container = modelPreviewRef.value
    if (!container) return

    disposeModelPreview()
    const runtime = createModelPreviewRuntime(container)
    modelPreviewRuntime = runtime
    isModelPreviewActive.value = true
    modelPreviewStatus.value = `正在生成：${source.label}`

    try {
        const previewDevice = {
            id: `preview_${model.id}`,
            name: model.name || model.id,
            model_type: model.id,
            model_file: null,
            instance_config: '{}',
            pos_x: 0,
            pos_y: 0,
            pos_z: 0,
            rotation_y: 0,
            scale: Number(model.default_scale || 1)
        }
        const deviceModel = await createDeviceModel(previewDevice, [model])
        if (modelPreviewSource !== source || modelPreviewRuntime !== runtime) {
            disposeThreeObject(deviceModel)
            return
        }

        deviceModel.name = `${model.id}_preview_root`
        deviceModel.position.set(0, 0, 0)
        deviceModel.rotation.set(0, 0, 0)
        deviceModel.scale.setScalar(Number(model.default_scale || 1))
        deviceModel.setLabelVisible?.(false)
        runtime.scene.add(deviceModel)
        runtime.updatables.push(deviceModel)

        const { nodes, map } = collectModelPreviewNodes(deviceModel)
        modelPreviewNodes.value = nodes
        modelPreviewNodeMap = map
        fitPreviewCamera(runtime.camera, runtime.controls, deviceModel)
        const box = new THREE.Box3().setFromObject(deviceModel)
        const size = box.getSize(new THREE.Vector3())
        modelPreviewStatus.value = `预览：${source.label} | 尺寸 ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} | 内置程序化模型`
    } catch (e) {
        modelPreviewStatus.value = `内置模型预览失败：${e.message || e}`
    }
}

function getActivePreviewModel() {
    if (!selectedPreviewModelId.value) return null
    return models.value.find(model => model.id === selectedPreviewModelId.value)
        || fallbackModelOptions.find(model => model.id === selectedPreviewModelId.value)
        || modelPreviewModel
}

async function renderSelectedModelPreview() {
    if (activeTab.value !== 'models') return

    if (selectedModelFile.value && selectedModelObjectUrl) {
        await renderModelPreview({ url: selectedModelObjectUrl, label: selectedModelFile.value.name })
        return
    }

    const model = getActivePreviewModel()
    if (!model) {
        disposeModelPreview()
        modelPreviewSource = null
        modelPreviewStatus.value = '选择模型文件后在这里预览'
        return
    }

    if (!model.file_path) {
        await renderBuiltinModelPreview(model)
        return
    }

    await renderModelPreview({
        url: resolveBackendAssetUrl(model.file_path),
        label: model.name || model.id
    })
}

async function setModelPreviewMode(mode) {
    if (modelPreviewMode.value === mode) return
    modelPreviewMode.value = mode
    await renderSelectedModelPreview()
}

function parseModelMetadata(model) {
    if (!model?.metadata) return {}
    if (typeof model.metadata === 'object') return { ...model.metadata }
    try {
        return JSON.parse(model.metadata)
    } catch (e) {
        return {}
    }
}

function normalizeModelBinding(binding = {}) {
    return {
        id: binding.id || `binding_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: binding.name || '',
        node_path: binding.node_path || '',
        node_name: binding.node_name || '',
        source_group: binding.source_group || binding.category || 'analog',
        source_key: binding.source_key || binding.value_role || binding.key || '',
        action: binding.action || 'rotate_speed',
        axis: binding.axis || 'y',
        input_min: Number(binding.input_min ?? 0),
        input_max: Number(binding.input_max ?? 100),
        output_min: Number(binding.output_min ?? 0),
        output_max: Number(binding.output_max ?? 90),
        speed_factor: Number(binding.speed_factor ?? 0.10472),
        on_color: binding.on_color || '#00ff88',
        off_color: binding.off_color || '#666666',
        invert: !!binding.invert
    }
}

function resetModelBindingForm() {
    Object.assign(modelBindingForm, normalizeModelBinding({
        id: '',
        name: '',
        node_path: selectedModelNodePath.value || '',
        source_group: 'analog',
        source_key: '',
        action: 'rotate_speed',
        axis: 'y'
    }))
    selectedModelBindingIndex.value = -1
}

function loadModelBindingState(model) {
    const metadata = parseModelMetadata(model)
    modelPartBindings.value = Array.isArray(metadata.partBindings)
        ? metadata.partBindings.map(normalizeModelBinding)
        : []
    selectedModelNodePath.value = ''
    modelBindingStatus.value = model?.file_path
        ? `已读取 ${modelPartBindings.value.length} 条部位绑定`
        : '内置程序化模型不可编辑部位绑定'
    resetModelBindingForm()
}

function selectPreviewNode(path) {
    selectedModelNodePath.value = path || ''
    modelBindingForm.node_path = path || ''
    const node = modelPreviewNodes.value.find(item => item.path === path)
    if (node && !modelBindingForm.name) modelBindingForm.name = node.displayName || node.name
    highlightPreviewNode(path)
}

function editModelBinding(index) {
    const binding = modelPartBindings.value[index]
    if (!binding) return
    Object.assign(modelBindingForm, normalizeModelBinding(binding))
    selectedModelBindingIndex.value = index
    selectPreviewNode(modelBindingForm.node_path)
}

function removeModelBinding(index) {
    modelPartBindings.value.splice(index, 1)
    modelBindingStatus.value = '绑定已删除，保存后生效'
    if (selectedModelBindingIndex.value === index) resetModelBindingForm()
}

function saveModelBindingDraft() {
    if (!modelBindingForm.node_path) return alert('请先选择模型部位节点')
    if (!modelBindingForm.source_key) return alert('请填写点位字段，例如 rear_fan_rpm / front_door_open / valve_1_flow')

    const binding = normalizeModelBinding({
        ...modelBindingForm,
        id: modelBindingForm.id || `binding_${Date.now()}`
    })
    if (selectedModelBindingIndex.value >= 0) {
        modelPartBindings.value.splice(selectedModelBindingIndex.value, 1, binding)
        modelBindingStatus.value = '绑定已更新，保存后生效'
    } else {
        modelPartBindings.value.push(binding)
        modelBindingStatus.value = '绑定已加入，保存后生效'
    }
    resetModelBindingForm()
}

async function saveModelPartBindings() {
    const model = activePreviewModel.value
    if (!model?.id || !canEditModelBindings.value) return

    const metadata = parseModelMetadata(model)
    metadata.partBindings = modelPartBindings.value.map(binding => normalizeModelBinding(binding))
    metadata.runtime = {
        ...(metadata.runtime || {}),
        enableGenericBindings: metadata.partBindings.length > 0
    }

    modelBindingSaving.value = true
    modelBindingStatus.value = '正在保存部位绑定...'
    try {
        const result = await adminApi.updateModel(model.id, {
            name: model.name,
            tags: model.tags,
            default_scale: model.default_scale,
            metadata: JSON.stringify(metadata)
        })
        if (result.error) throw new Error(result.error)
        await loadModels()
        const updated = models.value.find(item => item.id === model.id) || result.model || model
        modelPreviewModel = updated
        selectedPreviewModelId.value = updated.id
        loadModelBindingState(updated)
        modelBindingStatus.value = `已保存 ${modelPartBindings.value.length} 条部位绑定`
    } catch (e) {
        modelBindingStatus.value = `保存失败：${e.message || e}`
    } finally {
        modelBindingSaving.value = false
    }
}

function resetModelImportForm(file) {
    const modelId = makeModelIdFromFileName(file.name)
    modelImportForm.id = modelId
    modelImportForm.name = file.name.replace(/\.[^.]+$/, '')
    modelImportForm.default_scale = 1
    modelImportForm.metadata = '{\n  "batchable": true,\n  "partBindings": []\n}'
}

async function selectModelFile(event) {
    const file = event.target.files[0]
    if (!file) return
    selectedPreviewModelId.value = ''
    modelPreviewModel = null
    modelPreviewMode.value = 'asset'
    modelPartBindings.value = []
    modelBindingStatus.value = '待上传模型可先预览节点，上传入库后再保存部位绑定'
    resetModelBindingForm()
    selectedModelFile.value = file
    resetModelImportForm(file)
    if (selectedModelObjectUrl) URL.revokeObjectURL(selectedModelObjectUrl)
    selectedModelObjectUrl = URL.createObjectURL(file)
    await renderSelectedModelPreview()
}

function clearSelectedModelFile() {
    selectedModelFile.value = null
    selectedPreviewModelId.value = ''
    modelPreviewModel = null
    modelPartBindings.value = []
    modelBindingStatus.value = ''
    resetModelBindingForm()
    modelImportForm.id = ''
    modelImportForm.name = ''
    modelImportForm.default_scale = 1
    modelImportForm.metadata = '{\n  "batchable": true,\n  "partBindings": []\n}'
    if (modelFileInputRef.value) modelFileInputRef.value.value = ''
    disposeModelPreview({ revokeObjectUrl: true })
    modelPreviewStatus.value = '选择模型文件后在这里预览'
    modelPreviewSource = null
}

async function uploadModel() {
    const file = selectedModelFile.value
    if (!file) return alert('请先选择模型文件')
    if (!modelImportForm.id || !modelImportForm.name) return alert('请填写模型 ID 和名称')
    try {
        JSON.parse(modelImportForm.metadata || '{}')
    } catch (e) {
        return alert('元数据 JSON 格式不正确')
    }

    const fd = new FormData()
    fd.append('modelFile', file)
    fd.append('id', modelImportForm.id)
    fd.append('name', modelImportForm.name)
    fd.append('default_scale', Number(modelImportForm.default_scale) || 1)
    fd.append('metadata', modelImportForm.metadata || '{}')

    modelUploading.value = true
    try {
        await adminApi.uploadModel(fd)
        await loadModels()
        const uploadedName = modelImportForm.name
        clearSelectedModelFile()
        modelPreviewStatus.value = `已上传：${uploadedName}`
    } finally {
        modelUploading.value = false
    }
}

async function previewExistingModel(model) {
    selectedModelFile.value = null
    modelPreviewModel = model
    if (modelFileInputRef.value) modelFileInputRef.value.value = ''
    if (selectedModelObjectUrl) {
        URL.revokeObjectURL(selectedModelObjectUrl)
        selectedModelObjectUrl = ''
    }
    selectedPreviewModelId.value = model.id
    loadModelBindingState(model)
    modelPreviewSource = model.file_path
        ? { url: resolveBackendAssetUrl(model.file_path), label: model.name || model.id }
        : null
    await renderSelectedModelPreview()
}

async function deleteModel(id) {
    if (!confirm(`确定删除模型 ${id}？`)) return
    await adminApi.deleteModel(id)
    await loadModels()
}

// ============ 现场编排器 ============
const platform = ref({ scenes: [], widgets: [], activeScene: null, activeProject: null })
const widgetTypeOptions = [
    { value: 'navigation', label: '导航' },
    { value: 'metrics', label: '指标' },
    { value: 'trend', label: '趋势' },
    { value: 'alarm_list', label: '报警列表' },
    { value: 'marquee', label: '跑马灯' },
    { value: 'text', label: '文本' }
]
const newWidget = reactive({
    id: '',
    widget_type: 'text',
    title: '自定义文本',
    x: 8,
    y: 1,
    w: 6,
    h: 2,
    sort_order: 10,
    visible: true,
    configText: '{\n  "text": "现场提示 {value}",\n  "tone": "normal"\n}',
    bindingText: '{\n  "path": "metrics.current_output"\n}'
})

function formatJsonForEditor(value) {
    return JSON.stringify(value || {}, null, 2)
}

function parseJsonText(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    return JSON.parse(value)
}

function isEmptyJson(value) {
    try {
        const parsed = parseJsonText(value)
        return !parsed || (typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0)
    } catch (e) {
        return false
    }
}

function getWidgetDefaultConfig(type) {
    const presets = {
        navigation: { mode: 'hierarchy' },
        metrics: {
            chart: 'oee',
            chartLabel: 'OEE',
            chartPath: 'metrics.overall_oee',
            items: [
                { label: '今日产出', path: 'metrics.current_output' },
                { label: '完成进度', path: 'metrics.progress_percent', unit: '%' },
                { label: '能耗估算', path: 'metrics.energy_consumption' },
                { label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' }
            ]
        },
        trend: { seriesName: '平均温度', timeField: 'time', valueField: 'value', lineColor: '#f0b35a' },
        alarm_list: { limit: 5 },
        marquee: { speed: 30 },
        text: { text: '现场提示 {value}', tone: 'normal' }
    }
    return presets[type] || {}
}

function getWidgetDefaultBinding(type) {
    const presets = {
        navigation: { source: 'workshops' },
        metrics: { source: 'metrics' },
        trend: { source: 'trendPoints' },
        alarm_list: { source: 'events' },
        marquee: { source: 'events' },
        text: { path: 'metrics.current_output' }
    }
    return presets[type] || {}
}

function normalizeWidgetEditor(widget) {
    const config = {
        ...getWidgetDefaultConfig(widget.widget_type),
        ...(parseJsonText(widget.config || {}) || {})
    }
    const binding = {
        ...getWidgetDefaultBinding(widget.widget_type),
        ...(isEmptyJson(widget.binding) ? {} : (parseJsonText(widget.binding || {}) || {}))
    }
    return {
        ...widget,
        visible: !!widget.visible,
        configText: formatJsonForEditor(config),
        bindingText: formatJsonForEditor(binding)
    }
}

function applyWidgetDefaults(widget) {
    widget.configText = formatJsonForEditor(getWidgetDefaultConfig(widget.widget_type))
    widget.bindingText = formatJsonForEditor(getWidgetDefaultBinding(widget.widget_type))
}

function applyNewWidgetDefaults() {
    newWidget.configText = formatJsonForEditor(getWidgetDefaultConfig(newWidget.widget_type))
    newWidget.bindingText = formatJsonForEditor(getWidgetDefaultBinding(newWidget.widget_type))
}

async function loadPlatform() {
    const data = await adminApi.getPlatform()
    platform.value = {
        ...data,
        widgets: (data.widgets || []).map(normalizeWidgetEditor)
    }
}

async function saveActiveScene() {
    const scene = platform.value.activeScene
    if (!scene) return
    await adminApi.updateScene(scene.id, {
        name: scene.name,
        scene_type: scene.scene_type,
        layout: scene.layout,
        camera: scene.camera,
        theme: scene.theme,
        is_active: true,
        sort_order: scene.sort_order
    })
    alert('场景配置已保存')
    await loadPlatform()
}

async function saveWidget(widget) {
    let parsedConfig = {}
    let parsedBinding = {}
    try {
        parsedConfig = parseJsonText(widget.configText || '{}')
        parsedBinding = parseJsonText(widget.bindingText || '{}')
    } catch (e) {
        return alert('组件配置或绑定 JSON 格式不正确')
    }
    const result = await adminApi.updateWidget(widget.id, {
        widget_type: widget.widget_type,
        title: widget.title,
        config: parsedConfig,
        binding: parsedBinding,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        sort_order: widget.sort_order,
        visible: !!widget.visible
    })
    if (result?.error) return alert(result.error)
    if (!result?.success) return alert('组件保存失败，请检查后端服务状态')
    alert('组件布局已保存')
    await loadPlatform()
}

async function createWidget() {
    if (!platform.value.activeScene) return alert('当前没有可用场景')
    if (!newWidget.id || !newWidget.widget_type) return alert('请填写组件 ID 和类型')
    let parsedConfig = {}
    let parsedBinding = {}
    try {
        parsedConfig = parseJsonText(newWidget.configText || '{}')
        parsedBinding = parseJsonText(newWidget.bindingText || '{}')
    } catch (e) {
        return alert('组件配置或绑定 JSON 格式不正确')
    }
    const result = await adminApi.createWidget({
        id: newWidget.id,
        scene_id: platform.value.activeScene.id,
        widget_type: newWidget.widget_type,
        title: newWidget.title,
        config: parsedConfig,
        binding: parsedBinding,
        x: newWidget.x,
        y: newWidget.y,
        w: newWidget.w,
        h: newWidget.h,
        sort_order: newWidget.sort_order,
        visible: !!newWidget.visible
    })
    if (result.error) return alert(result.error)
    newWidget.id = `widget_text_${Date.now()}`
    await loadPlatform()
}

async function deleteWidget(id) {
    if (!confirm(`确定删除组件 ${id}？`)) return
    await adminApi.deleteWidget(id)
    await loadPlatform()
}

// ============ 左编辑 / 右预览现场编排器 ============
const composerPreviewRef = ref(null)
const selectedComposerLineId = ref('')
const selectedComposerDeviceId = ref('')
const composerPreviewMode = ref('line')
const composerPreviewStatus = ref('等待加载预览')
const composerSaving = ref(false)
const composerBulkSaving = ref(false)
const isComposerPreviewWide = ref(false)
const composerDraft = reactive({
    id: '',
    name: '',
    line_id: '',
    model_type: 'builtin_furnace',
    model_file: '',
    template_id: '',
    instance_config: '{}',
    pos_x: 0,
    pos_y: 0,
    pos_z: 0,
    rotation_y: 0,
    scale: 1,
    sort_order: 0
})

let composerRuntime = null
let composerPreviewTimer = null
let composerPreviewSeq = 0
let composerResizeObserver = null
let composerDragActive = false

function sortByOrder(list) {
    return [...list].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
}

function numberOrDefault(value, fallback = 0) {
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
}

function parseInstanceConfig(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    try {
        return JSON.parse(value)
    } catch (e) {
        return {}
    }
}

function getDeviceDefaultInstanceConfig(device = {}) {
    const config = parseInstanceConfig(device.instance_config)
    const modelType = device.model_type || 'builtin_furnace'
    const caption = device.name || device.id || ''

    if (modelType === 'transfer_cart' || config.role === 'transfer_cart') {
        return {
            role: 'transfer_cart',
            workshop_id: getDeviceWorkshopId(device) || workshops.value[0]?.id || '',
            caption: caption || '料车',
            animationProfile: 'transfer_cart',
            scaleMultiplier: 1
        }
    }

    if (modelType === 'builtin_furnace' || modelType === 'box_atmosphere_furnace' || modelType.includes('furnace')) {
        return {
            caption: caption || '多用炉',
            animationProfile: 'furnace',
            dataProfile: 'heat_treatment',
            scaleMultiplier: 1,
            labelY: 3.3,
            statusLightY: 2.8
        }
    }

    return {
        caption,
        animationProfile: 'static',
        scaleMultiplier: 1
    }
}

function stringifyInstanceConfigForEdit(value, defaultConfig = {}) {
    if (!value) return JSON.stringify(defaultConfig, null, 2)
    if (typeof value === 'string') {
        try {
            return JSON.stringify({ ...defaultConfig, ...JSON.parse(value) }, null, 2)
        } catch (e) {
            return value
        }
    }
    try {
        return JSON.stringify({ ...defaultConfig, ...value }, null, 2)
    } catch (e) {
        return JSON.stringify(defaultConfig, null, 2)
    }
}

function parseEditableInstanceConfig(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    return JSON.parse(value)
}

function isAuxiliaryDeviceConfig(device) {
    const config = parseInstanceConfig(device?.instance_config)
    return device?.model_type === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true
}

function getDeviceWorkshopId(device) {
    const config = parseInstanceConfig(device?.instance_config)
    return config.workshop_id
        || config.workshopId
        || lines.value.find(line => line.id === device?.line_id)?.workshop_id
        || ''
}

function buildDevicePayloadForSave(device, workshopId) {
    const payload = { ...device }
    const isAuxiliary = isAuxiliaryDeviceConfig(payload)
    const config = parseInstanceConfig(payload.instance_config)

    if (isAuxiliary) {
        config.role = payload.model_type === 'transfer_cart' ? 'transfer_cart' : (config.role || 'auxiliary')
        config.workshop_id = workshopId || getDeviceWorkshopId(payload) || workshops.value[0]?.id || ''
        payload.line_id = payload.line_id || null
    } else {
        delete config.workshop_id
        delete config.workshopId
        if (config.role === 'auxiliary' || config.role === 'transfer_cart') delete config.role
    }

    payload.instance_config = JSON.stringify(config, null, 2)
    return payload
}

function normalizeDeviceConfig(device) {
    const defaultInstanceConfig = getDeviceDefaultInstanceConfig(device)
    return {
        ...device,
        pos_x: numberOrDefault(device.pos_x, 0),
        pos_y: numberOrDefault(device.pos_y, 0),
        pos_z: numberOrDefault(device.pos_z, 0),
        rotation_y: numberOrDefault(device.rotation_y, 0),
        scale: numberOrDefault(device.scale, 1),
        sort_order: numberOrDefault(device.sort_order, 0),
        instance_config: stringifyInstanceConfigForEdit(device.instance_config, defaultInstanceConfig)
    }
}

const selectedComposerLine = computed(() => lines.value.find(line => line.id === selectedComposerLineId.value))
const selectedComposerDevice = computed(() => devices.value.find(device => device.id === selectedComposerDeviceId.value))
const composerPreviewDevices = computed(() => devices.value.map(device => {
    const source = device.id === composerDraft.id ? { ...device, ...composerDraft } : device
    return normalizeDeviceConfig(source)
}))
const selectedComposerWorkshop = computed(() => workshops.value.find(ws => ws.id === selectedComposerLine.value?.workshop_id))
const selectedComposerDevices = computed(() => sortByOrder(composerPreviewDevices.value.filter(device => {
    return device.line_id === selectedComposerLineId.value && !isAuxiliaryDeviceConfig(device)
})))
const selectedComposerAuxDevices = computed(() => sortByOrder(composerPreviewDevices.value.filter(device => {
    return isAuxiliaryDeviceConfig(device) && getDeviceWorkshopId(device) === selectedComposerWorkshop.value?.id
})))
const composerStats = computed(() => ({
    workshops: workshops.value.length,
    lines: lines.value.length,
    devices: devices.value.length,
    selectedLineDevices: selectedComposerDevices.value.length
}))

const composerWorkshops = computed(() => sortByOrder(workshops.value).map(workshop => ({
    ...workshop,
    devices: sortByOrder(composerPreviewDevices.value.filter(device => {
        return isAuxiliaryDeviceConfig(device) && getDeviceWorkshopId(device) === workshop.id
    })),
    lines: sortByOrder(lines.value.filter(line => line.workshop_id === workshop.id)).map(line => ({
        ...line,
        devices: sortByOrder(composerPreviewDevices.value.filter(device => {
            return device.line_id === line.id && !isAuxiliaryDeviceConfig(device)
        }))
    }))
})))

function getComposerLineIndex(lineId) {
    let index = 0
    for (const ws of composerWorkshops.value) {
        for (const line of ws.lines || []) {
            if (line.id === lineId) return index
            index += 1
        }
    }
    return -1
}

function getComposerWorkshopIndex(workshopId) {
    return composerWorkshops.value.findIndex(ws => ws.id === workshopId)
}

function ensureComposerSelection() {
    if (!lines.value.length) {
        selectedComposerLineId.value = ''
        selectedComposerDeviceId.value = ''
        return
    }
    if (!selectedComposerLineId.value || !lines.value.some(line => line.id === selectedComposerLineId.value)) {
        selectedComposerLineId.value = sortByOrder(lines.value)[0]?.id || ''
    }
    const selectableDevices = [...selectedComposerDevices.value, ...selectedComposerAuxDevices.value]
    if (!selectableDevices.some(device => device.id === selectedComposerDeviceId.value)) {
        selectedComposerDeviceId.value = selectedComposerDevices.value[0]?.id || selectedComposerAuxDevices.value[0]?.id || ''
    }
}

function syncComposerDraftFromSelection() {
    const device = selectedComposerDevice.value
    if (!device) {
        Object.assign(composerDraft, {
            id: '',
            name: '',
            line_id: selectedComposerLineId.value || '',
            model_type: 'builtin_furnace',
            model_file: '',
            template_id: '',
            instance_config: '{}',
            pos_x: 0,
            pos_y: 0,
            pos_z: 0,
            rotation_y: 0,
            scale: 1,
            sort_order: 0
        })
        return
    }
    Object.assign(composerDraft, normalizeDeviceConfig(device))
}

function selectComposerLine(lineId) {
    selectedComposerLineId.value = lineId
    const firstDevice = sortByOrder(devices.value.filter(device => device.line_id === lineId && !isAuxiliaryDeviceConfig(device)))[0]
    selectedComposerDeviceId.value = firstDevice?.id || ''
    composerPreviewMode.value = 'line'
}

function selectComposerDevice(deviceId) {
    selectedComposerDeviceId.value = deviceId
    composerPreviewMode.value = 'device'
}

function nudgeComposerDevice(dx, dz) {
    composerDraft.pos_x = numberOrDefault(composerDraft.pos_x, 0) + dx
    composerDraft.pos_z = numberOrDefault(composerDraft.pos_z, 0) + dz
}

function isComposerTransferCart(deviceId) {
    const device = composerPreviewDevices.value.find(item => item.id === deviceId)
    return device?.model_type === 'transfer_cart'
}

function updateComposerDraftPositionFromDrag(deviceId, position) {
    const device = composerPreviewDevices.value.find(item => item.id === deviceId)
        || devices.value.find(item => item.id === deviceId)
    if (!device) return

    if (selectedComposerDeviceId.value !== deviceId) {
        selectedComposerDeviceId.value = deviceId
    }
    if (composerDraft.id !== deviceId) {
        Object.assign(composerDraft, normalizeDeviceConfig(device))
    }

    composerDraft.pos_x = roundComposerNumber(position.x, 2)
    composerDraft.pos_y = roundComposerNumber(position.y ?? composerDraft.pos_y, 2)
    composerDraft.pos_z = roundComposerNumber(position.z, 2)
}

function handleComposerDeviceDragStart(deviceId) {
    if (!isComposerTransferCart(deviceId)) return
    composerDragActive = true
    if (selectedComposerDeviceId.value !== deviceId) {
        selectedComposerDeviceId.value = deviceId
    }
    composerPreviewStatus.value = '正在拖动料车，松手后点击保存生效'
}

function handleComposerDeviceDrag(deviceId, position) {
    if (!isComposerTransferCart(deviceId)) return
    composerDragActive = true
    updateComposerDraftPositionFromDrag(deviceId, position)
}

function handleComposerDeviceDragEnd(deviceId, position, _device, meta = {}) {
    if (!isComposerTransferCart(deviceId)) {
        composerDragActive = false
        return
    }
    if (!meta.moved) {
        composerDragActive = false
        return
    }
    updateComposerDraftPositionFromDrag(deviceId, position)
    composerPreviewStatus.value = '料车位置已调整，点击保存设备布局后写入数据库'
    setTimeout(() => {
        composerDragActive = false
    }, 0)
}

function roundComposerNumber(value, digits = 3) {
    const next = Number(value)
    if (!Number.isFinite(next)) return 0
    return Number(next.toFixed(digits))
}

function normalizeComposerAngle(value) {
    const fullTurn = Math.PI * 2
    const angle = ((numberOrDefault(value, 0) % fullTurn) + fullTurn) % fullTurn
    return roundComposerNumber(angle > Math.PI ? angle - fullTurn : angle, 4)
}

async function flipSelectedComposerLine() {
    const lineDevices = selectedComposerDevices.value
    if (!lineDevices.length) return alert('当前产线没有设备可调转')
    const lineName = selectedComposerLine.value?.name || selectedComposerLineId.value
    if (!confirm(`确定调转 ${lineName} 的整体朝向吗？这会镜像位置、旋转设备并反转排序。`)) return

    const xValues = lineDevices.map(device => numberOrDefault(device.pos_x, 0))
    const zValues = lineDevices.map(device => numberOrDefault(device.pos_z, 0))
    const spreadX = Math.max(...xValues) - Math.min(...xValues)
    const spreadZ = Math.max(...zValues) - Math.min(...zValues)
    const mirrorAxis = spreadX >= spreadZ ? 'pos_x' : 'pos_z'
    const mirrorCenter = mirrorAxis === 'pos_x'
        ? (Math.min(...xValues) + Math.max(...xValues)) / 2
        : (Math.min(...zValues) + Math.max(...zValues)) / 2
    const sortedDevices = sortByOrder(lineDevices)
    const sortOrders = sortedDevices
        .map(device => numberOrDefault(device.sort_order, 0))
        .sort((a, b) => a - b)

    composerBulkSaving.value = true
    try {
        await Promise.all(sortedDevices.map((device, index) => {
            const nextDevice = normalizeDeviceConfig(device)
            nextDevice[mirrorAxis] = roundComposerNumber((mirrorCenter * 2) - numberOrDefault(nextDevice[mirrorAxis], 0))
            nextDevice.rotation_y = normalizeComposerAngle(numberOrDefault(nextDevice.rotation_y, 0) + Math.PI)
            nextDevice.sort_order = sortOrders[sortOrders.length - 1 - index] ?? nextDevice.sort_order
            return adminApi.updateDevice(nextDevice.id, nextDevice)
        }))
        await loadDevices()
        composerPreviewMode.value = 'line'
        composerPreviewStatus.value = `${lineName} 已完成整体反向`
    } finally {
        composerBulkSaving.value = false
    }
}

function resizeComposerPreview(delay = 0) {
    if (delay > 0) {
        setTimeout(() => resizeComposerPreview(), delay)
        return
    }
    nextTick(() => {
        composerRuntime?.sceneManager?.onWindowResize?.()
    })
}

function resizeComposerPreviewAfterLayout() {
    resizeComposerPreview()
    resizeComposerPreview(160)
    resizeComposerPreview(320)
}

function toggleAdminNavCollapsed() {
    isAdminNavCollapsed.value = !isAdminNavCollapsed.value
    resizeComposerPreviewAfterLayout()
}

function selectAdminTab(tabKey) {
    activeTab.value = tabKey
    resizeComposerPreviewAfterLayout()
}

function toggleComposerPreviewWide() {
    isComposerPreviewWide.value = !isComposerPreviewWide.value
    resizeComposerPreviewAfterLayout()
    setTimeout(() => focusComposerPreview(), 180)
}

function controlComposerCamera(action) {
    composerRuntime?.controlCamera(action)
}

function fitComposerPreview() {
    resizeComposerPreviewAfterLayout()
    focusComposerPreview()
}

function disconnectComposerResizeObserver() {
    if (!composerResizeObserver) return
    composerResizeObserver.disconnect()
    composerResizeObserver = null
}

function connectComposerResizeObserver(container) {
    disconnectComposerResizeObserver()
    if (!container || typeof ResizeObserver === 'undefined') return
    composerResizeObserver = new ResizeObserver(() => resizeComposerPreview())
    composerResizeObserver.observe(container)
}

function disposeComposerPreview() {
    disconnectComposerResizeObserver()
    if (composerPreviewTimer) {
        clearTimeout(composerPreviewTimer)
        composerPreviewTimer = null
    }
    if (composerRuntime) {
        composerRuntime.dispose()
        composerRuntime = null
    }
}

function scheduleComposerPreview() {
    if (activeTab.value !== 'composer') return
    if (composerDragActive) return
    if (composerPreviewTimer) clearTimeout(composerPreviewTimer)
    composerPreviewTimer = setTimeout(() => renderComposerPreview(), 220)
}

function focusComposerPreview() {
    if (!composerRuntime) return
    if (composerPreviewMode.value === 'factory') {
        composerRuntime.flyToFactory()
        return
    }
    if (composerPreviewMode.value === 'workshop') {
        const workshopIndex = getComposerWorkshopIndex(selectedComposerWorkshop.value?.id)
        if (workshopIndex >= 0) composerRuntime.flyToWorkshop(workshopIndex)
        return
    }
    if (composerPreviewMode.value === 'device' && selectedComposerDeviceId.value) {
        const model = composerRuntime.furnaces.get(selectedComposerDeviceId.value)
        if (model) composerRuntime.sceneManager?.flyToDevice(model)
        return
    }
    const lineIndex = getComposerLineIndex(selectedComposerLineId.value)
    if (lineIndex >= 0) composerRuntime.flyToLine(lineIndex)
}

async function renderComposerPreview() {
    if (activeTab.value !== 'composer' || !composerPreviewRef.value) return
    const token = ++composerPreviewSeq
    composerPreviewStatus.value = '正在刷新预览...'
    disposeComposerPreview()
    await nextTick()
    const container = composerPreviewRef.value
    if (!container || token !== composerPreviewSeq) return
    let runtime = null
    try {
        runtime = new SceneRuntime(container, {
            workshops: composerWorkshops.value,
            models: models.value || [],
            cameraMode: '4level',
            onLevelChange: () => {},
            onDeviceSelect: deviceId => {
                if (devices.value.some(device => device.id === deviceId)) {
                    selectedComposerDeviceId.value = deviceId
                    composerPreviewMode.value = 'device'
                }
            },
            onDeviceRegistered: () => {},
            interactionOptions: {
                enableDeviceDrag: true,
                canDragDevice: deviceId => isComposerTransferCart(deviceId),
                onDeviceDragStart: handleComposerDeviceDragStart,
                onDeviceDrag: handleComposerDeviceDrag,
                onDeviceDragEnd: handleComposerDeviceDragEnd
            }
        })
        if (token !== composerPreviewSeq || activeTab.value !== 'composer') {
            runtime.dispose()
            return
        }
        await runtime.start()
        if (token !== composerPreviewSeq || activeTab.value !== 'composer' || !composerPreviewRef.value) {
            runtime.dispose()
            return
        }
        composerRuntime = runtime
        connectComposerResizeObserver(container)
        resizeComposerPreview()
        focusComposerPreview()
        composerPreviewStatus.value = '预览已同步'
    } catch (e) {
        if (composerRuntime === runtime) composerRuntime = null
        runtime?.dispose()
        if (token === composerPreviewSeq) {
            composerPreviewStatus.value = `预览加载失败：${e.message || e}`
        }
    }
}

async function saveComposerDevice() {
    if (!composerDraft.id) return alert('请先选择设备')
    let parsedInstanceConfig = {}
    try {
        parsedInstanceConfig = parseEditableInstanceConfig(composerDraft.instance_config)
    } catch (e) {
        return alert('实例配置 JSON 格式不正确')
    }
    composerSaving.value = true
    try {
        const payload = buildDevicePayloadForSave(
            { ...composerDraft, instance_config: parsedInstanceConfig },
            getDeviceWorkshopId(composerDraft) || selectedComposerWorkshop.value?.id || workshops.value[0]?.id || ''
        )
        await adminApi.updateDevice(composerDraft.id, payload)
        await loadDevices()
        if (payload.line_id) selectedComposerLineId.value = payload.line_id
        selectedComposerDeviceId.value = composerDraft.id
        alert('设备布局已保存')
    } finally {
        composerSaving.value = false
    }
}

watch(selectedComposerLineId, () => {
    ensureComposerSelection()
    scheduleComposerPreview()
})

watch(selectedComposerDeviceId, () => {
    syncComposerDraftFromSelection()
    scheduleComposerPreview()
})

watch(composerPreviewMode, () => {
    focusComposerPreview()
})

watch(composerDraft, () => {
    scheduleComposerPreview()
}, { deep: true })

watch(() => composerDraft.line_id, (lineId) => {
    if (lineId && selectedComposerLineId.value !== lineId) {
        selectedComposerLineId.value = lineId
    }
})

watch(() => editingDevice.model_type, (nextModelType, prevModelType) => {
    if (isAuxiliaryDeviceConfig(editingDevice)) {
        editingDeviceWorkshopId.value ||= workshops.value[0]?.id || ''
        if (prevModelType && prevModelType !== nextModelType) {
            editingDevice.line_id = ''
        }
        if (editingDevice.line_id && !deviceFormLines.value.some(line => line.id === editingDevice.line_id)) {
            editingDevice.line_id = ''
        }
    } else if (!editingDevice.line_id) {
        editingDevice.line_id = lines.value[0]?.id || ''
    }
})

watch(editingDeviceWorkshopId, () => {
    if (!isAuxiliaryDeviceConfig(editingDevice)) return
    if (editingDevice.line_id && !deviceFormLines.value.some(line => line.id === editingDevice.line_id)) {
        editingDevice.line_id = ''
    }
})

watch([workshops, lines, devices, models], () => {
    ensureComposerSelection()
    scheduleComposerPreview()
}, { deep: true })

watch(activeTab, async (tab) => {
    if (tab === 'composer') {
        ensureComposerSelection()
        syncComposerDraftFromSelection()
        await nextTick()
        scheduleComposerPreview()
    } else {
        disposeComposerPreview()
    }
    if (tab === 'models') {
        await nextTick()
        await renderSelectedModelPreview()
    } else {
        disposeModelPreview()
    }
})

// ============ 生命周期 ============
onMounted(async () => {
    await loadWorkshops()
    await Promise.all([loadLines(), loadDevices(), loadSettings(), loadModels(), loadPlatform()])
    if (!newLine.workshop_id && workshops.value.length > 0) {
        newLine.workshop_id = workshops.value[0].id
    }
    ensureComposerSelection()
    syncComposerDraftFromSelection()
    await nextTick()
    scheduleComposerPreview()
})

onUnmounted(() => {
    disposeComposerPreview()
    disposeModelPreview({ revokeObjectUrl: true })
})

// 设备按产线分组
const devicesByLine = computed(() => {
    const map = {}
    devices.value.forEach(d => {
        if (isAuxiliaryDeviceConfig(d)) return
        if (!map[d.line_id]) map[d.line_id] = []
        map[d.line_id].push(d)
    })
    return map
})

const auxiliaryDevices = computed(() => devices.value.filter(device => isAuxiliaryDeviceConfig(device)))

const deviceFormLines = computed(() => {
    if (!isAuxiliaryDeviceConfig(editingDevice)) return lines.value
    if (!editingDeviceWorkshopId.value) return lines.value
    return lines.value.filter(line => line.workshop_id === editingDeviceWorkshopId.value)
})

const lineMemberDevicesByLine = computed(() => {
    const map = {}
    devices.value.forEach(d => {
        if (isAuxiliaryDeviceConfig(d)) return
        if (!map[d.line_id]) map[d.line_id] = []
        map[d.line_id].push(d)
    })
    return map
})

// 产线按车间分组
const linesByWorkshop = computed(() => {
    const map = {}
    lines.value.forEach(l => {
        if (!map[l.workshop_id]) map[l.workshop_id] = []
        map[l.workshop_id].push(l)
    })
    return map
})

const factoryTabs = [
    { key: 'workshops', label: '车间管理', icon: 'workshops' },
    { key: 'lines', label: '产线管理', icon: 'lines' },
    { key: 'devices', label: '设备管理', icon: 'devices' }
]
const factoryTabKeys = factoryTabs.map(tab => tab.key)
const mainTabs = [
    { key: 'composer', label: '现场编排器', icon: 'composer' },
    { key: 'models', label: '模型库', icon: 'models' },
    { key: 'platform', label: '组件配置', icon: 'platform' },
    { key: 'points', label: '点位映射', icon: 'points' },
    { key: 'settings', label: '连接设置', icon: 'settings' }
]
</script>

<template>
    <div class="admin-container" :class="{ 'nav-collapsed': isAdminNavCollapsed, 'composer-active': activeTab === 'composer' }">
        <!-- 顶部标题栏 -->
        <header class="admin-header">
            <div class="header-logo-section">
                <span class="header-logo-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <path d="M4 19V7l8-4 8 4v12" />
                        <path d="M8 19v-7h8v7" />
                        <path d="M10 8h4" />
                    </svg>
                </span>
                <h1>数字孪生后台配置管理</h1>
            </div>
            <a href="/" class="back-link">← 返回大屏</a>
        </header>

        <div class="admin-body">
            <!-- 左侧 Tab 导航 -->
            <nav class="admin-nav">
                <button
                    v-for="tab in mainTabs.slice(0, 1)"
                    :key="tab.key"
                    type="button"
                    class="nav-item"
                    :class="{ active: activeTab === tab.key }"
                    :title="tab.label"
                    @click="selectAdminTab(tab.key)"
                >
                    <span class="nav-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                            <path v-for="(path, index) in navIconPaths[tab.icon]" :key="index" :d="path" />
                        </svg>
                    </span>
                    <span class="nav-label">{{ tab.label }}</span>
                </button>
                <div class="nav-group" :class="{ active: factoryTabKeys.includes(activeTab), open: isFactoryMenuOpen }">
                    <button
                        type="button"
                        class="nav-item nav-group-toggle"
                        :class="{ active: factoryTabKeys.includes(activeTab) }"
                        title="工厂建模"
                        @click="isFactoryMenuOpen = !isFactoryMenuOpen"
                    >
                        <span class="nav-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <path v-for="(path, index) in navIconPaths.factory" :key="index" :d="path" />
                            </svg>
                        </span>
                        <span class="nav-label">工厂建模</span>
                        <span class="nav-chevron">{{ isFactoryMenuOpen ? '⌃' : '⌄' }}</span>
                    </button>
                    <div v-show="isFactoryMenuOpen || isAdminNavCollapsed" class="nav-submenu">
                        <button
                            v-for="tab in factoryTabs"
                            :key="tab.key"
                            type="button"
                            class="nav-item nav-subitem"
                            :class="{ active: activeTab === tab.key }"
                            :title="tab.label"
                            @click="selectAdminTab(tab.key)"
                        >
                            <span class="nav-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24">
                                    <path v-for="(path, index) in navIconPaths[tab.icon]" :key="index" :d="path" />
                                </svg>
                            </span>
                            <span class="nav-label">{{ tab.label }}</span>
                        </button>
                    </div>
                </div>
                <button
                    v-for="tab in mainTabs.slice(1)"
                    :key="tab.key"
                    type="button"
                    class="nav-item"
                    :class="{ active: activeTab === tab.key }"
                    :title="tab.label"
                    @click="selectAdminTab(tab.key)"
                >
                    <span class="nav-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                            <path v-for="(path, index) in navIconPaths[tab.icon]" :key="index" :d="path" />
                        </svg>
                    </span>
                    <span class="nav-label">{{ tab.label }}</span>
                </button>
            </nav>
            <button
                class="nav-collapse-btn"
                type="button"
                :title="isAdminNavCollapsed ? '展开导航' : '收起导航'"
                :aria-label="isAdminNavCollapsed ? '展开导航' : '收起导航'"
                @click="toggleAdminNavCollapsed"
            >
                <span class="nav-collapse-icon">{{ isAdminNavCollapsed ? '›' : '‹' }}</span>
            </button>

            <!-- 右侧内容区 -->
            <main class="admin-content">

                <!-- ======== 现场编排器 ======== -->
                <div v-if="activeTab === 'composer'" class="tab-content composer-tab" :class="{ 'preview-wide': isComposerPreviewWide }">
                    <section class="composer-editor">
                        <div class="composer-section">
                            <h2>现场编排器</h2>
                            <p class="desc">左侧调整车间、产线和设备布局，右侧实时预览大屏现场效果。</p>
                            <div class="composer-stat-grid">
                                <div><span>车间</span><strong>{{ composerStats.workshops }}</strong></div>
                                <div><span>产线</span><strong>{{ composerStats.lines }}</strong></div>
                                <div><span>设备</span><strong>{{ composerStats.devices }}</strong></div>
                                <div><span>当前线</span><strong>{{ composerStats.selectedLineDevices }}</strong></div>
                            </div>
                        </div>

                        <div class="composer-section">
                            <h3>产线选择</h3>
                            <select v-model="selectedComposerLineId" class="input composer-select">
                                <option v-for="line in lines" :key="line.id" :value="line.id">
                                    {{ workshops.find(w => w.id === line.workshop_id)?.name || line.workshop_id }} / {{ line.name }}
                                </option>
                            </select>
                            <div class="composer-line-list">
                                <button
                                    v-for="line in lines"
                                    :key="line.id"
                                    class="line-pill"
                                    :class="{ active: selectedComposerLineId === line.id }"
                                    @click="selectComposerLine(line.id)"
                                >
                                    <span>{{ line.name }}</span>
                                    <em>{{ (lineMemberDevicesByLine[line.id] || []).length }} 台</em>
                                </button>
                            </div>
                            <div class="composer-action-row">
                                <button class="btn btn-sm" type="button" @click="flipSelectedComposerLine" :disabled="composerBulkSaving || !selectedComposerDevices.length">
                                    产线反向
                                </button>
                            </div>
                        </div>

                        <div class="composer-section">
                            <h3>设备列表</h3>
                            <div class="composer-device-list" v-if="selectedComposerDevices.length">
                                <button
                                    v-for="device in selectedComposerDevices"
                                    :key="device.id"
                                    class="device-pill"
                                    :class="{ active: selectedComposerDeviceId === device.id }"
                                    @click="selectComposerDevice(device.id)"
                                >
                                    <strong>{{ device.name }}</strong>
                                    <span>X {{ device.pos_x }} / Z {{ device.pos_z }}</span>
                                </button>
                            </div>
                            <div v-else class="composer-empty">当前产线还没有设备</div>
                        </div>

                        <div class="composer-section" v-if="selectedComposerAuxDevices.length">
                            <h3>辅助设备</h3>
                            <div class="composer-device-list">
                                <button
                                    v-for="device in selectedComposerAuxDevices"
                                    :key="device.id"
                                    class="device-pill"
                                    :class="{ active: selectedComposerDeviceId === device.id }"
                                    @click="selectComposerDevice(device.id)"
                                >
                                    <strong>{{ device.name }}</strong>
                                    <span>X {{ device.pos_x }} / Z {{ device.pos_z }}</span>
                                </button>
                            </div>
                        </div>

                        <div class="composer-section composer-form" v-if="composerDraft.id">
                            <h3>设备布局</h3>
                            <label>设备名称<input v-model="composerDraft.name" class="input" /></label>
                            <label>{{ isAuxiliaryDeviceConfig(composerDraft) ? '参考产线' : '所属产线' }}
                                <select v-model="composerDraft.line_id" class="input">
                                    <option v-if="isAuxiliaryDeviceConfig(composerDraft)" value="">不挂产线，作为车间级设备</option>
                                    <option v-for="line in lines" :key="line.id" :value="line.id">{{ line.name }}</option>
                                </select>
                            </label>
                            <label>模型
                                <select v-model="composerDraft.model_type" class="input">
                                    <option v-for="m in availableModelOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
                                </select>
                            </label>
                            <div class="composer-grid-3">
                                <label>X<input v-model.number="composerDraft.pos_x" type="number" class="input" /></label>
                                <label>Y<input v-model.number="composerDraft.pos_y" type="number" class="input" /></label>
                                <label>Z<input v-model.number="composerDraft.pos_z" type="number" class="input" /></label>
                            </div>
                            <div class="composer-grid-3">
                                <label>旋转Y<input v-model.number="composerDraft.rotation_y" type="number" step="0.1" class="input" /></label>
                                <label>缩放<input v-model.number="composerDraft.scale" type="number" step="0.05" min="0.1" class="input" /></label>
                                <label>排序<input v-model.number="composerDraft.sort_order" type="number" class="input" /></label>
                            </div>
                            <div class="nudge-pad">
                                <button class="btn" @click="nudgeComposerDevice(0, -2)">上移</button>
                                <button class="btn" @click="nudgeComposerDevice(-2, 0)">左移</button>
                                <button class="btn" @click="nudgeComposerDevice(2, 0)">右移</button>
                                <button class="btn" @click="nudgeComposerDevice(0, 2)">下移</button>
                            </div>
                            <label>实例配置 JSON
                                <textarea v-model="composerDraft.instance_config" class="input composer-json"></textarea>
                            </label>
                            <button class="btn btn-primary composer-save" @click="saveComposerDevice" :disabled="composerSaving">
                                {{ composerSaving ? '保存中...' : '保存设备布局' }}
                            </button>
                        </div>
                    </section>

                    <section class="composer-preview">
                        <div class="composer-preview-toolbar">
                            <div>
                                <strong>{{ selectedComposerWorkshop?.name || '未选择车间' }}</strong>
                                <span>{{ selectedComposerLine?.name || '未选择产线' }}</span>
                            </div>
                            <div class="preview-mode-buttons">
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'factory' }" @click="composerPreviewMode = 'factory'">总览</button>
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'workshop' }" @click="composerPreviewMode = 'workshop'">车间</button>
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'line' }" @click="composerPreviewMode = 'line'">产线</button>
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'device' }" @click="composerPreviewMode = 'device'">设备</button>
                            </div>
                            <div class="preview-camera-buttons">
                                <button class="btn btn-sm" type="button" title="适配当前视图" @click="fitComposerPreview">适配</button>
                                <button class="btn btn-sm btn-icon" type="button" title="放大视角" @click="controlComposerCamera('zoomIn')">+</button>
                                <button class="btn btn-sm btn-icon" type="button" title="缩小视角" @click="controlComposerCamera('zoomOut')">-</button>
                                <button class="btn btn-sm btn-icon" type="button" title="向左旋转" @click="controlComposerCamera('rotateLeft')">↺</button>
                                <button class="btn btn-sm btn-icon" type="button" title="向右旋转" @click="controlComposerCamera('rotateRight')">↻</button>
                                <button class="btn btn-sm preview-wide-btn" type="button" @click="toggleComposerPreviewWide">
                                    {{ isComposerPreviewWide ? '恢复编辑' : '放大预览' }}
                                </button>
                            </div>
                        </div>
                        <div ref="composerPreviewRef" class="composer-preview-stage"></div>
                        <div class="composer-preview-footer">
                            <span>{{ composerPreviewStatus }}</span>
                            <span>预览修改不会写入数据库，点击保存后生效</span>
                        </div>
                    </section>
                </div>

                <!-- ======== 车间管理 ======== -->
                <div v-if="activeTab === 'workshops'" class="tab-content">
                    <h2>车间管理</h2>
                    <p class="desc">管理工厂的车间划分。每个车间可包含多条产线。</p>

                    <div class="form-row">
                        <input v-model="newWorkshop.id" placeholder="车间ID（如 ws_a）" class="input" />
                        <input v-model="newWorkshop.name" placeholder="车间名称（如 压铸车间）" class="input" />
                        <button @click="createWorkshop" class="btn btn-primary">+ 添加车间</button>
                    </div>

                    <table class="data-table">
                        <thead>
                            <tr><th>ID</th><th>名称</th><th>产线数量</th><th>操作</th></tr>
                        </thead>
                        <tbody>
                            <tr v-for="ws in workshops" :key="ws.id">
                                <td><code>{{ ws.id }}</code></td>
                                <td>{{ ws.name }}</td>
                                <td>{{ (linesByWorkshop[ws.id] || []).length }} 条</td>
                                <td>
                                    <button @click="deleteWorkshop(ws.id)" class="btn btn-danger btn-sm">删除</button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- ======== 产线管理 ======== -->
                <div v-if="activeTab === 'lines'" class="tab-content">
                    <h2>产线管理</h2>
                    <p class="desc">管理工厂车间的产线划分。每条产线可包含多台设备。</p>

                    <div class="form-row">
                        <input v-model="newLine.id" placeholder="产线ID（如 line_e）" class="input" />
                        <input v-model="newLine.name" placeholder="产线名称（如 E 产线）" class="input" />
                        <select v-model="newLine.workshop_id" class="input" style="min-width: 150px">
                            <option value="" disabled>选择所属车间</option>
                            <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                        </select>
                        <button @click="createLine" class="btn btn-primary">+ 添加产线</button>
                    </div>

                    <table class="data-table">
                        <thead>
                            <tr><th>ID</th><th>名称</th><th>所属车间</th><th>设备数量</th><th>操作</th></tr>
                        </thead>
                        <tbody>
                            <tr v-for="line in lines" :key="line.id">
                                <td><code>{{ line.id }}</code></td>
                                <td>{{ line.name }}</td>
                                <td>{{ workshops.find(w => w.id === line.workshop_id)?.name || line.workshop_id }}</td>
                                <td>{{ (lineMemberDevicesByLine[line.id] || []).length }} 台</td>
                                <td>
                                    <button @click="deleteLine(line.id)" class="btn btn-danger btn-sm">删除</button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- ======== 设备管理 ======== -->
                <div v-if="activeTab === 'devices'" class="tab-content">
                    <h2>设备管理</h2>
                    <p class="desc">管理所有设备，包括设备名称、所属产线、3D 位置和使用的模型。</p>

                    <button @click="openCreateDevice" class="btn btn-primary" style="margin-bottom:20px">+ 添加设备</button>

                    <!-- 设备表单弹窗 -->
                    <div v-if="showDeviceForm" class="modal-overlay" @click.self="showDeviceForm = false">
                        <div class="modal-box">
                            <h3>{{ isEditMode ? '编辑设备' : '新增设备' }}</h3>
                            <div class="form-grid">
                                <label>设备 ID<input v-model="editingDevice.id" :disabled="isEditMode" class="input" placeholder="如 Furnace_21" /></label>
                                <label>设备名称<input v-model="editingDevice.name" class="input" placeholder="如 21# 多用炉" /></label>
                                <label v-if="isAuxiliaryDeviceConfig(editingDevice)">所在车间
                                    <select v-model="editingDeviceWorkshopId" class="input">
                                        <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                                    </select>
                                </label>
                                <label>{{ isAuxiliaryDeviceConfig(editingDevice) ? '参考产线（可选）' : '所属产线' }}
                                    <select v-model="editingDevice.line_id" class="input">
                                        <option v-if="isAuxiliaryDeviceConfig(editingDevice)" value="">不挂产线，作为车间级设备</option>
                                        <option v-for="l in deviceFormLines" :key="l.id" :value="l.id">{{ l.name }}</option>
                                    </select>
                                </label>
                                <label>使用模型
                                    <select v-model="editingDevice.model_type" class="input">
                                        <option v-for="m in availableModelOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
                                    </select>
                                </label>
                                <label>设备模板
                                    <select v-model="editingDevice.template_id" class="input">
                                        <option value="">不使用模板</option>
                                        <option v-for="tpl in platform.deviceTemplates || []" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
                                    </select>
                                </label>
                                <div class="form-section wide-form-section">
                                    <div class="form-section-header">
                                        <strong>PLC 连接配置</strong>
                                        <span>每台设备可以连接不同 PLC；料车等辅助设备可保持未启用。</span>
                                    </div>
                                    <label class="inline-check">
                                        <input v-model="editingDevice.plc_enabled" type="checkbox" :true-value="1" :false-value="0" />
                                        启用此设备直连 PLC 采集
                                    </label>
                                    <div class="form-grid compact-form-grid" v-if="Number(editingDevice.plc_enabled || 0)">
                                        <label>协议
                                            <select v-model="editingDevice.plc_protocol" class="input">
                                                <option value="S7">西门子 S7</option>
                                            </select>
                                        </label>
                                        <label>PLC IP
                                            <input v-model="editingDevice.plc_ip" class="input" placeholder="192.168.1.10" />
                                        </label>
                                        <label>端口
                                            <input v-model.number="editingDevice.plc_port" type="number" class="input" placeholder="102" />
                                        </label>
                                        <label>Rack
                                            <input v-model.number="editingDevice.plc_rack" type="number" class="input" placeholder="0" />
                                        </label>
                                        <label>Slot
                                            <input v-model.number="editingDevice.plc_slot" type="number" class="input" placeholder="1" />
                                        </label>
                                        <label>连接超时(ms)
                                            <input v-model.number="editingDevice.plc_timeout" type="number" class="input" placeholder="5000" />
                                        </label>
                                        <label>重连间隔(ms)
                                            <input v-model.number="editingDevice.plc_retry_interval" type="number" class="input" placeholder="10000" />
                                        </label>
                                        <label>最大重试次数
                                            <input v-model.number="editingDevice.plc_max_retries" type="number" class="input" placeholder="0 表示一直重试" />
                                        </label>
                                    </div>
                                </div>
                                <label>X 坐标<input v-model.number="editingDevice.pos_x" type="number" class="input" /></label>
                                <label>Y 坐标<input v-model.number="editingDevice.pos_y" type="number" class="input" /></label>
                                <label>Z 坐标<input v-model.number="editingDevice.pos_z" type="number" class="input" /></label>
                                <label>旋转角度(Y)<input v-model.number="editingDevice.rotation_y" type="number" step="0.1" class="input" /></label>
                                <label>缩放比例<input v-model.number="editingDevice.scale" type="number" step="0.1" class="input" /></label>
                                <label>排序<input v-model.number="editingDevice.sort_order" type="number" class="input" /></label>
                                <label style="grid-column:1 / -1">实例配置 JSON<textarea v-model="editingDevice.instance_config" class="input widget-json" placeholder='{"caption":"1#炉","animationProfile":"furnace"}'></textarea></label>
                            </div>
                            <div class="modal-actions">
                                <button @click="saveDevice" class="btn btn-primary">保存</button>
                                <button @click="showDeviceForm = false" class="btn">取消</button>
                            </div>
                        </div>
                    </div>

                    <!-- 设备列表 -->
                    <div v-for="line in lines" :key="line.id" class="device-group">
                        <h3 class="group-title">{{ line.name }}</h3>
                        <table class="data-table">
                            <thead>
                                <tr><th>ID</th><th>名称</th><th>模型</th><th>PLC</th><th>坐标 (X,Y,Z)</th><th>操作</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="d in (devicesByLine[line.id] || [])" :key="d.id">
                                    <td><code>{{ d.id }}</code></td>
                                    <td>{{ d.name }}</td>
                                    <td>{{ d.model_type }}</td>
                                    <td>
                                        <span class="plc-status-pill" :class="'plc-' + (plcStatusByDevice[d.id]?.status || (Number(d.plc_enabled || 0) ? 'idle' : 'disabled'))">
                                            {{ formatPlcDeviceStatus(d) }}
                                        </span>
                                        <small>{{ formatPlcEndpoint(d) }}</small>
                                    </td>
                                    <td>{{ d.pos_x }}, {{ d.pos_y }}, {{ d.pos_z }}</td>
                                    <td>
                                        <button @click="openEditDevice(d)" class="btn btn-sm">编辑</button>
                                        <button @click="deleteDevice(d.id)" class="btn btn-danger btn-sm">删除</button>
                                    </td>
                                </tr>
                                <tr v-if="! (devicesByLine[line.id] || []).length">
                                    <td colspan="6" style="text-align:center;color:#888">暂无设备</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="device-group" v-if="auxiliaryDevices.length">
                        <h3 class="group-title">辅助设备 / 料车</h3>
                        <table class="data-table">
                            <thead>
                                <tr><th>ID</th><th>名称</th><th>车间</th><th>模型</th><th>PLC</th><th>坐标 (X,Y,Z)</th><th>操作</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="d in auxiliaryDevices" :key="d.id">
                                    <td><code>{{ d.id }}</code></td>
                                    <td>{{ d.name }}</td>
                                    <td>{{ workshops.find(w => w.id === getDeviceWorkshopId(d))?.name || getDeviceWorkshopId(d) || '未设置' }}</td>
                                    <td>{{ d.model_type }}</td>
                                    <td>
                                        <span class="plc-status-pill" :class="'plc-' + (plcStatusByDevice[d.id]?.status || (Number(d.plc_enabled || 0) ? 'idle' : 'disabled'))">
                                            {{ formatPlcDeviceStatus(d) }}
                                        </span>
                                        <small>{{ formatPlcEndpoint(d) }}</small>
                                    </td>
                                    <td>{{ d.pos_x }}, {{ d.pos_y }}, {{ d.pos_z }}</td>
                                    <td>
                                        <button @click="openEditDevice(d)" class="btn btn-sm">编辑</button>
                                        <button @click="deleteDevice(d.id)" class="btn btn-danger btn-sm">删除</button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ======== 模型库 ======== -->
                <div v-if="activeTab === 'models'" class="tab-content">
                    <h2>3D 模型库</h2>
                    <p class="desc">上传 <code>.glb</code> 格式的 3D 模型文件。设备可选择使用上传的自定义模型或内置默认模型。</p>

                    <div class="model-library-layout">
                        <section class="model-library-main">
                            <div class="upload-area">
                                <label class="btn btn-primary" style="cursor:pointer">
                                    📂 选择 .glb/.gltf 文件
                                    <input ref="modelFileInputRef" type="file" accept=".glb,.gltf" @change="selectModelFile" hidden />
                                </label>
                                <span v-if="selectedModelFile" class="model-file-chip">{{ selectedModelFile.name }} · {{ selectedModelFileSizeText }}</span>
                            </div>

                            <div v-if="selectedModelFile" class="model-import-form">
                                <label>模型 ID<input v-model="modelImportForm.id" class="input" /></label>
                                <label>模型名称<input v-model="modelImportForm.name" class="input" /></label>
                                <label>默认缩放<input v-model.number="modelImportForm.default_scale" type="number" min="0.01" step="0.05" class="input" /></label>
                                <label class="model-metadata-field">元数据 JSON<textarea v-model="modelImportForm.metadata" class="input model-metadata"></textarea></label>
                                <div class="model-import-actions">
                                    <button class="btn btn-primary" type="button" @click="uploadModel" :disabled="modelUploading">
                                        {{ modelUploading ? '上传中...' : '上传并入库' }}
                                    </button>
                                    <button class="btn" type="button" @click="clearSelectedModelFile" :disabled="modelUploading">取消</button>
                                </div>
                            </div>

                            <table class="data-table model-table">
                                <thead>
                                    <tr><th>ID</th><th>名称</th><th>文件路径</th><th>操作</th></tr>
                                </thead>
                                <tbody>
                                    <tr
                                        v-for="m in models"
                                        :key="m.id"
                                        :class="{ active: selectedPreviewModelId === m.id }"
                                        @click="previewExistingModel(m)"
                                    >
                                        <td><code>{{ m.id }}</code></td>
                                        <td>{{ m.name }}</td>
                                        <td>{{ m.file_path || '（内置）' }}</td>
                                        <td>
                                            <button v-if="!m.is_builtin" @click.stop="deleteModel(m.id)" class="btn btn-danger btn-sm">删除</button>
                                            <span v-else style="color:#888">系统内置</span>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>

                            <section class="model-binding-editor" v-if="activePreviewModel">
                                <div class="model-binding-header">
                                    <div>
                                        <h3>部位与点位绑定</h3>
                                        <p>{{ canEditModelBindings ? '选择模型节点，把 PLC 实时点位映射成旋转、平移、显隐或变色动作。' : '内置程序化模型不可编辑部位绑定，请使用上传的完整 GLB/GLTF 模型。' }}</p>
                                    </div>
                                    <button class="btn btn-primary" type="button" @click="saveModelPartBindings" :disabled="!canEditModelBindings || modelBindingSaving">
                                        {{ modelBindingSaving ? '保存中...' : '保存绑定' }}
                                    </button>
                                </div>

                                <template v-if="canEditModelBindings">
                                    <div class="model-binding-form">
                                        <label>模型部位
                                            <select v-model="selectedModelNodePath" class="input" @change="selectPreviewNode(selectedModelNodePath)">
                                                <option value="">选择右侧预览解析出的节点</option>
                                                <option v-for="node in modelPreviewNodes" :key="node.path" :value="node.path">
                                                    {{ formatModelNodeOption(node) }}
                                                </option>
                                            </select>
                                        </label>
                                        <label>绑定名称<input v-model="modelBindingForm.name" class="input" placeholder="如 后室循环风扇" /></label>
                                        <label>数据分组
                                            <select v-model="modelBindingForm.source_group" class="input">
                                                <option v-for="group in modelSourceGroups" :key="group.value" :value="group.value">{{ group.label }}</option>
                                            </select>
                                        </label>
                                        <label>点位字段<input v-model="modelBindingForm.source_key" class="input" placeholder="如 rear_fan_rpm" /></label>
                                        <label>动作
                                            <select v-model="modelBindingForm.action" class="input">
                                                <option v-for="action in modelBindingActions" :key="action.value" :value="action.value">{{ action.label }}</option>
                                            </select>
                                        </label>
                                        <label>轴向
                                            <select v-model="modelBindingForm.axis" class="input">
                                                <option v-for="axis in modelBindingAxes" :key="axis.value" :value="axis.value">{{ axis.label }}</option>
                                            </select>
                                        </label>
                                        <label>输入最小<input v-model.number="modelBindingForm.input_min" type="number" class="input" /></label>
                                        <label>输入最大<input v-model.number="modelBindingForm.input_max" type="number" class="input" /></label>
                                        <label>输出最小<input v-model.number="modelBindingForm.output_min" type="number" class="input" /></label>
                                        <label>输出最大<input v-model.number="modelBindingForm.output_max" type="number" class="input" /></label>
                                        <label>转速系数<input v-model.number="modelBindingForm.speed_factor" type="number" step="0.001" class="input" /></label>
                                        <label>反向
                                            <select v-model="modelBindingForm.invert" class="input">
                                                <option :value="false">否</option>
                                                <option :value="true">是</option>
                                            </select>
                                        </label>
                                        <label>开启颜色<input v-model="modelBindingForm.on_color" type="color" class="input color-input" /></label>
                                        <label>关闭颜色<input v-model="modelBindingForm.off_color" type="color" class="input color-input" /></label>
                                        <div class="model-binding-actions">
                                            <button class="btn btn-primary" type="button" @click="saveModelBindingDraft">
                                                {{ selectedModelBindingIndex >= 0 ? '更新此绑定' : '加入绑定列表' }}
                                            </button>
                                            <button class="btn" type="button" @click="resetModelBindingForm">清空表单</button>
                                        </div>
                                    </div>

                                    <table class="data-table model-binding-table">
                                        <thead>
                                            <tr><th>部位</th><th>点位</th><th>动作</th><th>轴</th><th>操作</th></tr>
                                        </thead>
                                        <tbody>
                                            <tr v-for="(binding, index) in modelPartBindings" :key="binding.id">
                                                <td>{{ formatModelBindingPartName(binding) }}</td>
                                                <td><code>{{ formatModelSourceGroup(binding.source_group) }}.{{ binding.source_key }}</code></td>
                                                <td>{{ formatModelBindingAction(binding.action) }}</td>
                                                <td>{{ formatModelAxis(binding.axis) }}</td>
                                                <td>
                                                    <button class="btn btn-sm" type="button" @click="editModelBinding(index)">编辑</button>
                                                    <button class="btn btn-danger btn-sm" type="button" @click="removeModelBinding(index)">删除</button>
                                                </td>
                                            </tr>
                                            <tr v-if="!modelPartBindings.length">
                                                <td colspan="5" style="text-align:center;color:#888">暂无部位绑定</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </template>
                                <div class="model-binding-status">{{ modelBindingStatus }}</div>
                            </section>
                        </section>

                        <aside class="model-preview-panel">
                            <div class="model-preview-header">
                                <div class="model-preview-title">
                                    <strong>模型预览</strong>
                                    <span>{{ selectedModelFile ? '待上传模型' : selectedPreviewModelId || '未选择' }}</span>
                                </div>
                                <div class="model-preview-mode-toggle" aria-label="模型预览模式">
                                    <button
                                        type="button"
                                        :class="{ active: modelPreviewMode === 'asset' }"
                                        @click="setModelPreviewMode('asset')"
                                    >模型预览</button>
                                    <button
                                        type="button"
                                        :class="{ active: modelPreviewMode === 'bindings' }"
                                        @click="setModelPreviewMode('bindings')"
                                    >部位绑定</button>
                                </div>
                            </div>
                            <div ref="modelPreviewRef" class="model-preview-stage">
                                <div v-if="!isModelPreviewActive" class="model-preview-empty">选择文件或点击模型列表</div>
                            </div>
                            <div class="model-preview-footer">{{ modelPreviewStatus }}</div>
                        </aside>
                    </div>
                </div>

                <!-- ======== 画面组件配置 ======== -->
                <div v-if="activeTab === 'platform'" class="tab-content">
                    <h2>画面组件配置</h2>
                    <p class="desc">管理当前项目、场景、组件布局和发布版本。工程师后续通过这里调整画面，不再改源码。</p>

                    <div class="settings-section" v-if="platform.activeProject">
                        <h3 class="section-title">项目与当前场景</h3>
                        <div class="settings-grid" v-if="platform.activeScene">
                            <label>项目名称
                                <input :value="platform.activeProject.name" disabled class="input" />
                            </label>
                            <label>场景名称
                                <input v-model="platform.activeScene.name" class="input" />
                            </label>
                            <label>场景类型
                                <select v-model="platform.activeScene.scene_type" class="input">
                                    <option value="factory_overview">工厂总览</option>
                                    <option value="workshop_overview">车间总览</option>
                                    <option value="line_overview">产线总览</option>
                                    <option value="device_detail">设备详情</option>
                                </select>
                            </label>
                            <label>主题预设
                                <select v-model="platform.activeScene.theme.preset" class="input">
                                    <option value="industrial_twin">真实工业数字孪生</option>
                                    <option value="classic_blue">经典科技蓝</option>
                                </select>
                            </label>
                            <label>相机模式
                                <select v-model="platform.activeScene.camera.mode" class="input">
                                    <option value="auto">自动</option>
                                    <option value="4level">四级运镜</option>
                                    <option value="3level">三级运镜</option>
                                </select>
                            </label>
                            <label>数据过期阈值(ms)
                                <input v-model.number="platform.activeScene.camera.staleMs" type="number" class="input" />
                            </label>
                        </div>
                        <button @click="saveActiveScene" class="btn btn-primary" style="margin-top:16px;">保存当前场景</button>
                    </div>

                    <div class="settings-section" style="margin-top:24px;">
                        <h3 class="section-title">组件布局</h3>
                        <div class="table-scroll">
                            <table class="data-table platform-table widget-layout-table">
                                <thead>
                                    <tr>
                                        <th>显示</th><th>ID</th><th>类型</th><th>标题</th>
                                        <th>左</th><th>上</th><th>宽</th><th>高</th><th>排序</th><th>配置 JSON</th><th>绑定 JSON</th><th>操作</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="widget in platform.widgets" :key="widget.id">
                                        <td><input v-model="widget.visible" type="checkbox" /></td>
                                        <td><code>{{ widget.id }}</code></td>
                                        <td>
                                            <select v-model="widget.widget_type" @change="applyWidgetDefaults(widget)" class="input input-sm">
                                                <option v-for="type in widgetTypeOptions" :key="type.value" :value="type.value">{{ type.label }}</option>
                                            </select>
                                        </td>
                                        <td><input v-model="widget.title" class="input input-sm" /></td>
                                        <td><input v-model.number="widget.x" type="number" class="input input-sm coord-input" /></td>
                                        <td><input v-model.number="widget.y" type="number" class="input input-sm coord-input" /></td>
                                        <td><input v-model.number="widget.w" type="number" class="input input-sm coord-input" /></td>
                                        <td><input v-model.number="widget.h" type="number" class="input input-sm coord-input" /></td>
                                        <td><input v-model.number="widget.sort_order" type="number" class="input input-sm coord-input" /></td>
                                        <td class="widget-editor-cell">
                                            <button type="button" @click="widget.configText = formatJsonForEditor(getWidgetDefaultConfig(widget.widget_type))" class="btn btn-sm widget-default-btn">默认</button>
                                            <textarea v-model="widget.configText" class="input widget-json widget-json-large" spellcheck="false"></textarea>
                                        </td>
                                        <td class="widget-editor-cell">
                                            <button type="button" @click="widget.bindingText = formatJsonForEditor(getWidgetDefaultBinding(widget.widget_type))" class="btn btn-sm widget-default-btn">默认</button>
                                            <textarea v-model="widget.bindingText" class="input widget-json widget-json-large" spellcheck="false"></textarea>
                                        </td>
                                        <td class="widget-action-cell">
                                            <button @click="saveWidget(widget)" class="btn btn-primary btn-sm">保存</button>
                                            <button @click="deleteWidget(widget.id)" class="btn btn-danger btn-sm">删除</button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div class="widget-create-row">
                            <input v-model="newWidget.id" class="input" placeholder="组件ID，如 widget_text_notice" />
                            <select v-model="newWidget.widget_type" @change="applyNewWidgetDefaults" class="input">
                                <option v-for="type in widgetTypeOptions.filter(item => item.value !== 'navigation')" :key="type.value" :value="type.value">{{ type.label }}</option>
                            </select>
                            <input v-model="newWidget.title" class="input" placeholder="标题" />
                            <input v-model.number="newWidget.x" type="number" class="input coord-input" placeholder="左" />
                            <input v-model.number="newWidget.y" type="number" class="input coord-input" placeholder="上" />
                            <input v-model.number="newWidget.w" type="number" class="input coord-input" placeholder="宽" />
                            <input v-model.number="newWidget.h" type="number" class="input coord-input" placeholder="高" />
                            <textarea v-model="newWidget.configText" class="input widget-json widget-json-large" title="组件配置 JSON" spellcheck="false"></textarea>
                            <textarea v-model="newWidget.bindingText" class="input widget-json widget-json-large" title="数据绑定 JSON" spellcheck="false"></textarea>
                            <button @click="createWidget" class="btn btn-primary">+ 新增组件</button>
                        </div>
                    </div>

                    <div class="settings-section" style="margin-top:24px;">
                        <h3 class="section-title">发布版本</h3>
                        <table class="data-table">
                            <thead><tr><th>版本</th><th>当前</th><th>发布时间</th></tr></thead>
                            <tbody>
                                <tr v-for="release in platform.releases" :key="release.id">
                                    <td>{{ release.version }}</td>
                                    <td>{{ release.is_current ? '是' : '否' }}</td>
                                    <td>{{ release.created_at }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ======== 点位映射 ======== -->
                <div v-if="activeTab === 'points'" class="tab-content">
                    <h2>PLC 点位映射</h2>
                    <p class="desc">为每台设备配置 PLC 数据地址和采集周期。可以直接填写 <code>DB1.DBW3000</code>，也可以填写 DB 块、字节偏移和位偏移让系统生成 S7 地址。</p>

                    <div class="form-row" style="margin-bottom:20px; align-items: flex-end;">
                        <div>
                            <label style="font-size:12px; color:#86868b; display:block; margin-bottom:5px;">选择要配置的设备</label>
                            <select v-model="selectedDeviceForPoints" @change="loadDataPoints" class="input" style="width:250px">
                                <option value="">-- 选择设备 --</option>
                                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} ({{ d.id }})</option>
                            </select>
                        </div>
                        <div v-if="selectedDeviceForPoints" style="display:flex; gap:10px; margin-left: 20px;">
                            <button @click="alert('即将支持导入电气点表(Excel)功能...')" class="btn">📥 导入点表(Excel)</button>
                            <div style="position: relative; display: inline-block;">
                                <select @change="copyPointsFrom($event.target.value); $event.target.value=''" class="input" style="width: 180px;">
                                    <option value="">📄 从其他设备复制...</option>
                                    <option v-for="d in devices.filter(x => x.id !== selectedDeviceForPoints)" :key="d.id" :value="d.id">复制自: {{ d.name }}</option>
                                </select>
                            </div>
                            <button @click="syncToLine" class="btn">⚡ 应用到同产线</button>
                        </div>
                    </div>

                    <div v-if="selectedDeviceForPoints">
                        <div class="point-toolbar">
                            <button @click="showPointAdvancedFields = !showPointAdvancedFields" class="btn btn-sm">
                                {{ showPointAdvancedFields ? '收起换算字段' : '显示换算字段' }}
                            </button>
                        </div>
                        <div class="table-scroll">
                            <table class="data-table points-table" :class="{ 'points-table-advanced': showPointAdvancedFields }">
                                <thead>
                                    <tr>
                                        <th>数据项名称</th><th>显示标签</th><th>PLC 地址</th><th>DB块</th><th>字节</th><th>位</th>
                                        <th>数据类型</th><th>采集周期(ms)</th><th>读写</th><th>数据分组</th>
                                        <th title="模型部件或画面组件绑定时使用的变量名，留空时默认使用数据项名称">绑定变量名</th>
                                        <th v-if="showPointAdvancedFields" title="PLC 原始值乘以这个数，常用于把整数缩放成工程值">换算倍率</th>
                                        <th v-if="showPointAdvancedFields" title="倍率换算后再加上的修正值，常用于传感器零点校准">偏移修正</th>
                                        <th v-if="showPointAdvancedFields" title="可选高级换算，x 代表倍率和偏移后的值，例如 x/10">自定义公式</th>
                                        <th v-if="showPointAdvancedFields" title="控制画面显示的小数位，例如 0、0.0、0.00">显示小数</th>
                                        <th>单位</th><th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="(p, idx) in dataPoints" :key="idx">
                                        <td><input v-model="p.name" @input="markPointsDirty" class="input input-sm" placeholder="actual_temp" /></td>
                                        <td><input v-model="p.label" @input="markPointsDirty" class="input input-sm" placeholder="实际温度" /></td>
                                        <td><input v-model="p.plc_tag" @input="markPointsDirty" class="input input-sm" placeholder="DB1.DBW3000" /></td>
                                        <td><input v-model.number="p.db_number" @input="markPointsDirty" type="number" class="input input-sm number-input" placeholder="1" /></td>
                                        <td><input v-model.number="p.db_byte_offset" @input="markPointsDirty" type="number" class="input input-sm number-input" placeholder="3000" /></td>
                                        <td><input v-model.number="p.bit_offset" @input="markPointsDirty" type="number" min="0" max="7" class="input input-sm bit-input" placeholder="0" /></td>
                                        <td>
                                            <select v-model="p.data_type" @change="markPointsDirty" class="input input-sm">
                                                <option value="BOOL">BOOL (DBX)</option>
                                                <option value="WORD">WORD (DBW)</option>
                                                <option value="INT">INT (DBW signed)</option>
                                                <option value="DWORD">DWORD (DBD)</option>
                                                <option value="REAL">REAL (DBD float)</option>
                                            </select>
                                        </td>
                                        <td><input v-model.number="p.sample_interval_ms" @input="markPointsDirty" type="number" min="100" step="50" class="input input-sm sample-input" placeholder="1000" /></td>
                                        <td>
                                            <select v-model="p.access_type" @change="markPointsDirty" class="input input-sm access-input">
                                                <option value="READ">读</option>
                                                <option value="READ_WRITE">读写</option>
                                                <option value="WRITE">仅写</option>
                                            </select>
                                        </td>
                                        <td>
                                            <select v-model="p.category" @change="markPointsDirty" class="input input-sm">
                                                <option v-for="category in pointCategories" :key="category.value" :value="category.value">{{ category.label }}</option>
                                            </select>
                                        </td>
                                        <td><input v-model="p.value_role" @input="markPointsDirty" class="input input-sm role-input" placeholder="留空=数据项名称" title="模型部件或画面组件绑定时使用的变量名，留空时默认使用数据项名称" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model.number="p.scale" @input="markPointsDirty" type="number" step="0.001" class="input input-sm number-input" placeholder="1" title="PLC 原始值乘以这个数，例如原始值 253、倍率 0.1，得到 25.3" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model.number="p.offset" @input="markPointsDirty" type="number" step="0.001" class="input input-sm number-input" placeholder="0" title="倍率换算后再加上的修正值，例如传感器整体偏低 2 度就填 2" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model="p.expression" @input="markPointsDirty" class="input input-sm expression-input" placeholder="可空，如 x/10" title="可选高级换算，x 代表倍率和偏移后的值，例如 x/10、(x-32)*5/9" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model="p.display_format" @input="markPointsDirty" class="input input-sm unit-input" placeholder="如 0.0" title="控制画面显示的小数位，例如 0 表示整数，0.0 表示 1 位小数，0.00 表示 2 位小数" /></td>
                                        <td><input v-model="p.unit" @input="markPointsDirty" class="input input-sm unit-input" placeholder="°C" /></td>
                                        <td><button @click="removeDataPoint(idx)" class="btn btn-danger btn-sm">✕</button></td>
                                    </tr>
                                    <tr v-if="dataPoints.length === 0">
                                        <td :colspan="showPointAdvancedFields ? 17 : 13" style="text-align:center; padding: 20px; color: #86868b;">该设备暂无点位配置，请手动添加或从其他设备复制。</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div style="margin-top:15px;display:flex; justify-content: space-between; align-items: center;">
                            <button @click="addDataPoint" class="btn">+ 手动添加数据项</button>
                            <div style="display:flex; align-items: center; gap: 15px;">
                                <span v-if="isPointsDirty" style="color: #ff9500; font-size: 13px;">存在未保存的修改</span>
                                <button @click="saveAllPoints" class="btn btn-primary" :disabled="!isPointsDirty && dataPoints.length > 0">保存当前设备配置</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- ======== 连接设置 ======== -->
                <div v-if="activeTab === 'settings'" class="tab-content">
                    <h2>连接设置</h2>
                    <p class="desc">配置数字孪生系统的数据通路、PLC 连接参数和通信方式。</p>

                    <!-- 引擎运行状态 -->
                    <div class="engine-status-card" :class="'status-' + engineStatus.plcStatus?.status">
                        <div class="engine-status-header">
                            <span class="engine-dot"></span>
                            <strong>数据引擎状态</strong>
                        </div>
                        <div class="engine-status-body">
                            <span>运行模式：{{ formatEngineMode(engineStatus.mode) }}</span>
                            <span>数据状态：{{ engineStatus.plcStatus?.message || '未知' }}</span>
                            <span v-if="engineStatus.collectorStatus?.lastFrameAt">最近帧：{{ new Date(engineStatus.collectorStatus.lastFrameAt).toLocaleTimeString() }}</span>
                        </div>
                    </div>

                    <div class="settings-form settings-form-wide">

                        <!-- ===== 数据库部署配置 ===== -->
                        <div class="settings-section">
                            <h3 class="section-title">数据库连接</h3>
                            <div class="settings-grid">
                                <label>数据库类型
                                    <select v-model="databaseConfig.type" class="input">
                                        <option value="mysql">MySQL / MariaDB</option>
                                        <option value="postgres">PostgreSQL</option>
                                        <option value="sqlserver">SQL Server</option>
                                        <option value="sqlite">SQLite 本地文件</option>
                                    </select>
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">数据库名
                                    <input v-model="databaseConfig.database" class="input" placeholder="dongtai_daping" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">主机
                                    <input v-model="databaseConfig.host" class="input" placeholder="127.0.0.1" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">端口
                                    <input v-model.number="databaseConfig.port" type="number" class="input" placeholder="3307" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">用户名
                                    <input v-model="databaseConfig.user" class="input" placeholder="root" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">密码
                                    <input v-model="databaseConfig.password" type="password" class="input" placeholder="留空或输入新密码" />
                                </label>
                                <label v-if="databaseConfig.type === 'sqlite'" style="grid-column: 1 / -1">SQLite 文件
                                    <input v-model="databaseConfig.filename" class="input" placeholder="backend/data/factory.db" />
                                </label>
                                <label v-if="databaseConfig.type === 'sqlserver'">
                                    <span><input v-model="databaseConfig.encrypt" type="checkbox" /> 启用加密连接</span>
                                </label>
                                <label v-if="databaseConfig.type === 'sqlserver'">
                                    <span><input v-model="databaseConfig.trustServerCertificate" type="checkbox" /> 信任服务器证书</span>
                                </label>
                            </div>
                            <div class="form-row" style="margin-top:16px; margin-bottom:0">
                                <button @click="testDatabaseConnection" class="btn">测试连接</button>
                                <button @click="saveDatabaseConnection" class="btn btn-primary" :disabled="databaseSaving">保存数据库连接</button>
                                <span style="font-size:13px; color:#515154">{{ databaseTestStatus }}</span>
                            </div>
                        </div>

                        <!-- ===== 基础设置 ===== -->
                        <div class="settings-section">
                            <h3 class="section-title">基础设置</h3>
                            <div class="settings-grid">
                                <label>大屏显示标题
                                    <input v-model="settings.factory_name" class="input" placeholder="智能热处理数字孪生控制中心" />
                                </label>
                                <label>大屏视角模式
                                    <select v-model="settings.camera_mode" class="input">
                                        <option value="auto">自动 (单车间3级 / 多车间4级)</option>
                                        <option value="4level">强制 4 级 (全局->车间->产线->设备)</option>
                                        <option value="3level">强制 3 级 (直接进车间->产线->设备)</option>
                                    </select>
                                </label>
                                <label>实时数据过期阈值 (ms)
                                    <input v-model="settings.realtime_stale_ms" type="number" class="input" placeholder="6000" />
                                </label>
                                <label>显示模式
                                    <select v-model="settings.display_mode" class="input">
                                        <option value="industrial_twin">真实工业数字孪生</option>
                                        <option value="classic_blue">经典科技蓝</option>
                                    </select>
                                </label>
                            </div>
                        </div>

                        <!-- ===== 数据通路选择 ===== -->
                        <div class="settings-section">
                            <h3 class="section-title">数据通路模式</h3>
                            <label>选择数据采集方式
                                <select v-model="settings.data_mode" class="input">
                                    <option value="integrated_plc">内置低延迟采集（推荐）</option>
                                    <option value="simulation">模拟数据（离线演示用）</option>
                                </select>
                            </label>
                            <div class="mode-hint">
                                <template v-if="settings.data_mode === 'integrated_plc'">
                                    <p><strong>推荐主链路：</strong>PLC → 大屏后端内置采集器 → WebSocket → 前台 3D。</p>
                                    <p style="color:#86868b; font-size:12px;">PLC 连接参数在“设备管理”里按设备配置，变量采集周期在“点位映射”里按点位配置。</p>
                                </template>
                                <template v-else>
                                    <p><strong>模拟模式：</strong>系统自动生成随机数据，无需连接任何外部设备。</p>
                                    <p style="color:#86868b; font-size:12px;">适用于离线演示、功能验收。数据为程序模拟生成。</p>
                                </template>
                            </div>
                        </div>

                        <!-- ===== PLC 实时状态 ===== -->
                        <div class="settings-section" v-if="settings.data_mode === 'integrated_plc'">
                            <h3 class="section-title">PLC 实时状态</h3>
                            <div class="table-scroll">
                                <table class="data-table plc-status-table">
                                    <thead>
                                        <tr><th>设备</th><th>状态</th><th>端点</th><th>采集周期</th><th>最近读取</th><th>错误</th></tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="status in (engineStatus.plcStatus?.devices || [])" :key="status.deviceId">
                                            <td>{{ status.deviceName }} <code>{{ status.deviceId }}</code></td>
                                            <td>
                                                <span class="plc-status-pill" :class="'plc-' + status.status">
                                                    {{ plcStatusLabels[status.status] || status.status }}
                                                </span>
                                            </td>
                                            <td>{{ status.endpoint || '-' }}</td>
                                            <td>{{ formatPlcIntervals(status) }}</td>
                                            <td>{{ status.lastReadAt ? new Date(status.lastReadAt).toLocaleTimeString() : '-' }}</td>
                                            <td>{{ status.lastError || status.message || '-' }}</td>
                                        </tr>
                                        <tr v-if="!(engineStatus.plcStatus?.devices || []).length">
                                            <td colspan="6" style="text-align:center;color:#86868b">暂无 PLC 设备状态，请先在设备管理里启用 PLC 采集。</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <button @click="saveSettings" class="btn btn-primary" style="margin-top:24px; padding: 10px 30px; font-size: 15px;">保存所有连接设置</button>
                    </div>
                </div>

            </main>
        </div>
    </div>
</template>

<style scoped>
* { box-sizing: border-box; }

.admin-container {
    width: 100vw; height: 100vh;
    background: #f5f5f7; color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    display: flex; flex-direction: column;
    overflow: hidden;
}

.admin-header {
    display: flex; justify-content: space-between; align-items: center;
    height: 64px; padding: 0 32px; background: rgba(255, 255, 255, 0.85);
    border-bottom: 1px solid rgba(0, 0, 0, 0.08); z-index: 100;
}
.header-logo-section {
    display: flex;
    align-items: center;
    gap: 10px;
}
.header-logo-mark {
    width: 30px;
    height: 30px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
    color: #1d1d1f;
}
.header-logo-mark svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.admin-header h1 { margin: 0; font-size: 19px; color: #1d1d1f; font-weight: 600; letter-spacing: -0.2px; }
.back-link {
    color: #0066cc; text-decoration: none; font-size: 14px; font-weight: 500;
    transition: all 0.2s ease; padding: 6px 14px; border-radius: 98px;
    background: rgba(0, 102, 204, 0.05);
}
.back-link:hover { color: #0077ed; background: rgba(0, 102, 204, 0.08); }

.admin-body { display: flex; flex: 1; overflow: hidden; position: relative; }

.admin-nav {
    width: 250px; background: rgba(245, 245, 247, 0.6);
    border-right: 1px solid rgba(0, 0, 0, 0.08);
    padding: 18px 12px 24px; overflow-y: auto; overflow-x: hidden;
    display: flex; flex-direction: column; gap: 4px;
    transition: width 0.22s ease, padding 0.22s ease;
}
.nav-item {
    appearance: none;
    border: 0;
    width: 100%;
    padding: 10px 16px; cursor: pointer; font-size: 14px; color: #434345;
    font-weight: 500; border-radius: 10px;
    transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1); position: relative;
    display: flex; align-items: center; gap: 10px;
    background: transparent;
    font-family: inherit;
    text-align: left;
}
.nav-collapse-btn {
    appearance: none;
    position: absolute;
    left: calc(250px - 18px);
    top: 50%;
    z-index: 30;
    width: 36px;
    height: 44px;
    padding: 0;
    transform: translateY(-50%);
    justify-content: center;
    display: flex;
    align-items: center;
    color: #6e6e73;
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 9px;
    cursor: pointer;
    transition: left 0.22s ease, background 0.2s ease, color 0.2s ease;
}
.nav-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.nav-group-toggle .nav-chevron {
    margin-left: auto;
    color: #86868b;
    font-size: 13px;
}
.nav-submenu {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-left: 16px;
}
.nav-subitem {
    min-height: 38px;
    padding-top: 8px;
    padding-bottom: 8px;
    font-size: 13px;
}
.nav-collapse-btn:hover,
.nav-item:hover { color: #1d1d1f; background: rgba(0, 0, 0, 0.04); }
.nav-item.active {
    color: #ffffff; background: #111827;
    box-shadow: 0 4px 12px rgba(17, 24, 39, 0.18); font-weight: 600;
}
.nav-item.active::after { display: none; }
.nav-icon,
.nav-collapse-icon {
    width: 20px;
    min-width: 20px;
    height: 20px;
    text-align: center;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.nav-icon svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.nav-collapse-icon {
    font-size: 22px;
}
.nav-label {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.admin-container.nav-collapsed .admin-nav {
    width: 68px;
    padding: 16px 8px 24px;
    align-items: center;
}
.admin-container.nav-collapsed .nav-item {
    justify-content: center;
    padding: 10px;
    width: 44px;
}
.admin-container.nav-collapsed .nav-collapse-btn {
    left: calc(68px - 18px);
}
.admin-container.nav-collapsed .nav-group,
.admin-container.nav-collapsed .nav-submenu {
    align-items: center;
    padding-left: 0;
}
.admin-container.nav-collapsed .nav-collapse-btn {
    height: 44px;
}
.admin-container.nav-collapsed .nav-label,
.admin-container.nav-collapsed .nav-chevron {
    display: none;
}

.admin-content {
    flex: 1; padding: 32px; overflow-y: auto; background: #f5f5f7;
}
.admin-container.composer-active .admin-content {
    padding: 14px 16px 16px;
}

.tab-content {
    background: #ffffff; padding: 32px; border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.03), 0 1px 2px rgba(0, 0, 0, 0.02);
    border: 1px solid rgba(0, 0, 0, 0.04);
    min-height: calc(100% - 10px);
}
.tab-content h2 { margin: 0 0 6px 0; font-size: 24px; color: #1d1d1f; font-weight: 600; letter-spacing: -0.5px; }
.desc { color: #86868b; font-size: 14px; margin-bottom: 28px; }

.composer-tab {
    height: calc(100vh - 94px);
    padding: 0;
    display: grid;
    grid-template-columns: minmax(300px, 340px) minmax(0, 1fr);
    overflow: hidden;
    background: #eef0f1;
}
.composer-tab.preview-wide {
    grid-template-columns: minmax(0, 1fr);
}
.composer-tab.preview-wide .composer-editor {
    display: none;
}

.composer-editor {
    min-width: 0;
    overflow-y: auto;
    padding: 18px;
    background: #fbfbfd;
    border-right: 1px solid rgba(0, 0, 0, 0.08);
}

.composer-section {
    padding: 16px;
    margin-bottom: 12px;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.025);
}

.composer-section h2 { font-size: 22px; }
.composer-section h3 { margin: 0 0 12px; font-size: 15px; color: #1d1d1f; }
.composer-section .desc { margin-bottom: 16px; line-height: 1.5; }

.composer-stat-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
}

.composer-stat-grid div {
    padding: 10px;
    background: #f5f5f7;
    border-radius: 8px;
}

.composer-stat-grid span {
    display: block;
    color: #86868b;
    font-size: 12px;
}

.composer-stat-grid strong {
    display: block;
    margin-top: 4px;
    color: #1d1d1f;
    font-size: 18px;
}

.composer-select { width: 100%; margin-bottom: 12px; }
.composer-line-list, .composer-device-list { display: grid; gap: 8px; }
.composer-action-row {
    display: grid;
    gap: 8px;
    margin-top: 10px;
}

.line-pill, .device-pill {
    width: 100%;
    border: 1px solid rgba(0, 0, 0, 0.08);
    background: #f7f7f9;
    color: #1d1d1f;
    border-radius: 10px;
    padding: 10px 12px;
    cursor: pointer;
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: space-between;
    transition: all 0.18s ease;
}

.line-pill:hover, .device-pill:hover { background: #ffffff; border-color: rgba(0, 113, 227, 0.28); }
.line-pill.active, .device-pill.active {
    background: rgba(0, 113, 227, 0.08);
    border-color: rgba(0, 113, 227, 0.45);
    box-shadow: inset 3px 0 0 #0071e3;
}

.line-pill em, .device-pill span {
    color: #86868b;
    font-style: normal;
    font-size: 12px;
}

.device-pill {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
}

.device-pill strong {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}

.composer-empty {
    padding: 14px;
    color: #86868b;
    background: #f5f5f7;
    border-radius: 8px;
    text-align: center;
}

.composer-form {
    display: grid;
    gap: 12px;
}

.composer-form label {
    display: grid;
    gap: 7px;
    min-width: 0;
    color: #515154;
    font-size: 13px;
    font-weight: 500;
}

.composer-form .input {
    width: 100%;
    min-width: 0;
}

.composer-grid-3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(58px, 1fr));
    gap: 8px;
}

.composer-grid-3 .input {
    padding-left: 9px;
    padding-right: 9px;
}

.nudge-pad {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
}

.composer-json {
    min-height: 128px;
    resize: vertical;
    font-family: SFMono-Regular, Consolas, Monaco, monospace;
    font-size: 12px;
    line-height: 1.45;
}

.composer-save { width: 100%; padding: 11px 16px; }

.composer-preview {
    min-width: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) 38px;
    background: #15191b;
}

.composer-preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 58px;
    padding: 8px 18px;
    background: #ffffff;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}

.composer-preview-toolbar strong {
    display: block;
    color: #1d1d1f;
    font-size: 15px;
}

.composer-preview-toolbar span {
    color: #86868b;
    font-size: 12px;
}

.preview-mode-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.preview-mode-buttons .btn.active {
    background: #1d1d1f;
    color: #ffffff;
}
.preview-camera-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.btn-icon {
    width: 30px;
    padding-left: 0;
    padding-right: 0;
    text-align: center;
}
.preview-wide-btn {
    min-width: 76px;
}

.composer-preview-stage {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #9ba29f;
    touch-action: none;
}

.composer-preview-stage canvas {
    display: block;
}

.composer-preview-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 18px;
    color: #b7bebc;
    background: #171b1d;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 12px;
}

.composer-preview-stage :deep(.furnace-label),
.composer-preview-stage :deep(.factory-guide-label) {
    color: #f4f7f6;
    background: rgba(18, 22, 24, .84);
    border: 1px solid rgba(242, 184, 91, .35);
    box-shadow: 0 8px 18px rgba(0,0,0,.32);
    pointer-events: none;
    font-size: 12px;
}

.composer-preview-stage :deep(.furnace-label) {
    min-width: 132px;
    padding: 8px 10px;
}

.composer-preview-stage :deep(.factory-guide-label) {
    min-width: 108px;
    padding: 7px 10px 8px;
    border-left: 3px solid #e0ad4f;
}

/* 表单元素 */
.input {
    border: 1px solid rgba(0, 0, 0, 0.15); padding: 8px 12px; border-radius: 8px; font-size: 14px; outline: none;
    transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1); background: #fbfbfd; color: #1d1d1f;
}
.input::placeholder { color: #86868b; }
.input:hover { border-color: rgba(0, 0, 0, 0.3); }
.input:focus {
    border-color: #0071e3; background: #ffffff;
    box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.15);
}
.input:disabled {
    background: #e8e8ed; color: #86868b; border-color: rgba(0, 0, 0, 0.05);
    cursor: not-allowed;
}
.input-sm { padding: 5px 10px; font-size: 13px; border-radius: 6px; }

.form-row { display: flex; gap: 12px; align-items: center; margin-bottom: 28px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 24px 0; }
.form-grid label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #515154; font-weight: 500; }
.wide-form-section { grid-column: 1 / -1; }
.form-section {
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #fbfbfd;
    padding: 16px;
}
.form-section-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
    margin-bottom: 14px;
}
.form-section-header strong { color: #1d1d1f; font-size: 14px; }
.form-section-header span { color: #86868b; font-size: 12px; line-height: 1.5; }
.inline-check {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center;
    gap: 8px !important;
    margin-bottom: 12px;
}
.compact-form-grid {
    margin: 12px 0 0;
    gap: 14px;
}

.settings-form { max-width: 700px; display: flex; flex-direction: column; gap: 28px; }
.settings-form-wide { max-width: 1080px; }
.settings-form label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #515154; font-weight: 500; }

/* 按钮 */
.btn {
    padding: 8px 16px; border: none; border-radius: 8px;
    background: #e8e8ed; color: #0066cc; cursor: pointer; font-size: 14px;
    font-weight: 500; transition: all 0.2s ease;
}
.btn:hover { background: #d8d8dd; color: #0055b3; }
.btn:disabled { background: #f5f5f7; color: #a1a1a6; cursor: not-allowed; }
.btn-primary { background: #0071e3; color: #ffffff; }
.btn-primary:hover { background: #0077ed; color: #ffffff; }
.btn-danger { background: rgba(255, 59, 48, 0.1); color: #ff3b30; }
.btn-danger:hover { background: rgba(255, 59, 48, 0.2); color: #ff3b30; }
.btn-sm { padding: 5px 12px; font-size: 12px; border-radius: 6px; }

/* 表格 */
.data-table { width: 100%; border-collapse: collapse; margin-bottom: 28px; font-size: 14px; }
.data-table th {
    text-align: left; padding: 14px 18px; background: #f5f5f7;
    border-bottom: 1px solid rgba(0, 0, 0, 0.05); color: #515154; font-weight: 600; font-size: 13px;
}
.data-table td {
    padding: 16px 18px; border-bottom: 1px solid rgba(0, 0, 0, 0.04); color: #1d1d1f;
    vertical-align: middle;
}
.data-table tbody tr { transition: background-color 0.2s ease; }
.data-table tbody tr:hover { background: rgba(0, 0, 0, 0.015); }
.data-table code {
    color: #b01a68; background: rgba(176, 26, 104, 0.06); border: none;
    padding: 2px 8px; border-radius: 4px; font-family: SFMono-Regular, Consolas, Monaco, monospace; font-size: 12px;
}

.table-scroll {
    width: 100%; overflow-x: auto; border-radius: 12px;
    border: 1px solid rgba(0, 0, 0, 0.06); background: #ffffff; margin-bottom: 20px;
}
.point-toolbar {
    display: flex;
    justify-content: flex-end;
    margin: 0 0 10px;
}
.points-table { min-width: 1540px; }
.points-table.points-table-advanced { min-width: 1960px; }
.points-table td { padding: 10px 6px; }
.points-table .input-sm { width: 100%; }
.points-table .number-input { width: 90px; }
.points-table .bit-input { width: 64px; }
.points-table .sample-input { width: 110px; }
.points-table .access-input { width: 86px; }
.points-table .role-input { min-width: 136px; }
.points-table .expression-input { min-width: 150px; }
.points-table .unit-input { width: 80px; }
.plc-status-table { min-width: 980px; margin-bottom: 0; }
.plc-status-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 64px;
    min-height: 24px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    color: #515154;
    background: #e8e8ed;
    border: 1px solid rgba(0, 0, 0, 0.06);
}
.plc-status-pill + small {
    display: block;
    margin-top: 6px;
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
    max-width: 260px;
}
.plc-connected { color: #1b6b3a; background: rgba(52, 199, 89, 0.12); border-color: rgba(52, 199, 89, 0.24); }
.plc-connecting, .plc-idle { color: #6c5800; background: rgba(255, 204, 0, 0.14); border-color: rgba(255, 204, 0, 0.24); }
.plc-retrying, .plc-no_points, .plc-unconfigured { color: #8a4b0f; background: rgba(255, 149, 0, 0.13); border-color: rgba(255, 149, 0, 0.24); }
.plc-error, .plc-unsupported { color: #9f1d17; background: rgba(255, 59, 48, 0.12); border-color: rgba(255, 59, 48, 0.24); }
.plc-disabled, .plc-stopped { color: #6e6e73; background: #f5f5f7; }
.platform-table { min-width: 1920px; }
.widget-layout-table {
    border-collapse: separate;
    border-spacing: 0;
}
.widget-layout-table th:last-child,
.widget-layout-table .widget-action-cell {
    position: sticky;
    right: 0;
    width: 104px;
    min-width: 104px;
    text-align: center;
    background: #ffffff;
    box-shadow: -10px 0 18px rgba(0, 0, 0, 0.06);
    z-index: 2;
}
.widget-layout-table th:last-child {
    background: #f5f5f7;
    z-index: 3;
}
.widget-layout-table tbody tr:hover .widget-action-cell {
    background: #fbfbfd;
}
.widget-action-cell .btn {
    display: block;
    width: 54px;
    margin: 0 auto;
}
.widget-action-cell .btn + .btn {
    margin-top: 8px;
}
.coord-input { width: 70px; }
.widget-editor-cell {
    min-width: 320px;
    vertical-align: top;
}
.widget-default-btn {
    margin-bottom: 8px;
}
.widget-json {
    width: 260px; height: 72px; font-family: SFMono-Regular, Consolas, Monaco, monospace; font-size: 12px;
    resize: vertical; border-radius: 6px; background: #f5f5f7; border: 1px solid rgba(0,0,0,0.08);
}
.widget-json-large {
    width: 300px;
    min-height: 150px;
    line-height: 1.45;
}
.widget-create-row {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start;
    padding: 20px; margin-top: 20px; border: 1px dashed rgba(0, 0, 0, 0.15);
    background: #fbfbfd; border-radius: 12px;
}

.device-group { margin-bottom: 44px; }
.group-title { color: #1d1d1f; font-size: 17px; margin-bottom: 18px; font-weight: 600; padding-left: 12px; border-left: 4px solid #0071e3; }

/* 弹窗 */
.modal-overlay {
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.3);
    display: flex; justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
    background: rgba(255, 255, 255, 0.96);
    border-radius: 20px; box-shadow: 0 30px 70px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04);
    padding: 32px; width: min(760px, calc(100vw - 48px)); max-height: 85vh; overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, 0.4);
    animation: sheetIn 0.35s cubic-bezier(0.25, 1, 0.5, 1);
}
@keyframes sheetIn {
    from { transform: scale(0.92) translateY(20px); opacity: 0; }
    to { transform: scale(1) translateY(0); opacity: 1; }
}
.modal-box h3 { color: #1d1d1f; margin: 0 0 24px 0; font-size: 20px; font-weight: 600; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 32px; border-top: 1px solid rgba(0, 0, 0, 0.08); padding-top: 20px; }

.upload-area {
    margin-bottom: 28px; padding: 32px; border: 2px dashed rgba(0, 0, 0, 0.1);
    border-radius: 16px; text-align: center; background: #fbfbfd;
    transition: border-color 0.25s ease;
}
.upload-area:hover { border-color: #0071e3; }
.model-library-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, 420px);
    gap: 24px;
    align-items: start;
}
.model-library-main {
    min-width: 0;
}
.model-library-layout .upload-area {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
}
.model-file-chip {
    color: #515154;
    background: #eef0f2;
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 12px;
}
.model-import-form {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
    padding: 16px;
    margin-bottom: 24px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #fbfbfd;
}
.model-import-form label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: #515154;
    font-weight: 500;
}
.model-metadata-field {
    grid-column: 1 / -1;
}
.model-metadata {
    min-height: 76px;
    resize: vertical;
    font-family: SFMono-Regular, Consolas, Monaco, monospace;
    font-size: 12px;
}
.model-import-actions {
    grid-column: 1 / -1;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}
.model-table tbody tr {
    cursor: pointer;
}
.model-table tbody tr.active {
    background: rgba(0, 113, 227, 0.08);
    box-shadow: inset 3px 0 0 #0071e3;
}
.model-binding-editor {
    margin-top: 18px;
    padding: 18px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #ffffff;
}
.model-binding-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
}
.model-binding-header h3 {
    margin: 0 0 5px;
    color: #1d1d1f;
    font-size: 16px;
}
.model-binding-header p {
    margin: 0;
    color: #68686d;
    font-size: 12px;
    line-height: 1.5;
}
.model-binding-form {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
}
.model-binding-form label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: #515154;
    font-size: 12px;
    font-weight: 500;
}
.model-binding-form label:first-child {
    grid-column: span 2;
}
.color-input {
    height: 38px;
    padding: 4px;
}
.model-binding-actions {
    grid-column: 1 / -1;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}
.model-binding-table {
    margin-bottom: 10px;
}
.model-binding-table td {
    padding-top: 10px;
    padding-bottom: 10px;
}
.model-binding-status {
    min-height: 18px;
    color: #68686d;
    font-size: 12px;
}
.model-preview-panel {
    position: sticky;
    top: 0;
    min-width: 0;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    overflow: hidden;
    background: #ffffff;
}
.model-preview-header {
    min-height: 54px;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}
.model-preview-title {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.model-preview-title strong {
    color: #1d1d1f;
    font-size: 15px;
}
.model-preview-title span {
    color: #86868b;
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.model-preview-mode-toggle {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    padding: 3px;
    border-radius: 8px;
    background: #f0f2f4;
    border: 1px solid rgba(0, 0, 0, 0.08);
}
.model-preview-mode-toggle button {
    min-width: 68px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #515154;
    font-size: 12px;
    cursor: pointer;
}
.model-preview-mode-toggle button.active {
    color: #1d1d1f;
    background: #ffffff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}
.model-preview-stage {
    position: relative;
    height: 360px;
    min-width: 0;
    background: #f3f4f5;
    overflow: hidden;
}
.model-preview-canvas {
    display: block;
    width: 100%;
    height: 100%;
}
.model-preview-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #86868b;
    font-size: 13px;
    pointer-events: none;
}
.model-preview-footer {
    min-height: 42px;
    padding: 10px 14px;
    color: #515154;
    background: #fbfbfd;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    font-size: 12px;
    line-height: 1.45;
}

/* 连接设置专属样式 */
.settings-section {
    padding: 24px; background: #fbfbfd; border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 12px; margin-bottom: 24px;
}
.section-title {
    margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f; font-weight: 600;
    padding-bottom: 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.settings-grid label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #515154; font-weight: 500; }
.mode-hint { margin-top: 16px; padding: 16px 20px; background: rgba(0, 102, 204, 0.03); border: 1px solid rgba(0, 102, 204, 0.1); border-radius: 8px; }
.mode-hint p { margin: 6px 0; font-size: 13px; color: #434345; line-height: 1.6; }
.mode-hint code { background: rgba(0, 0, 0, 0.04); padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #1d1d1f; }
.required { color: #ff3b30; font-weight: bold; margin-left: 2px; }

/* 引擎状态卡片 */
.engine-status-card {
    max-width: 700px; padding: 20px 24px; border-radius: 14px; margin-bottom: 28px;
    border: 1px solid rgba(0, 0, 0, 0.06); background: #ffffff;
    display: flex; flex-direction: column; gap: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.02);
}
.engine-status-header { display: flex; align-items: center; gap: 10px; font-size: 15px; color: #1d1d1f; font-weight: 600; }
.engine-dot { width: 10px; height: 10px; border-radius: 50%; background: #8e8e93; display: inline-block; flex-shrink: 0; }
.engine-status-body { display: flex; flex-wrap: wrap; gap: 10px 32px; font-size: 13px; color: #515154; }
.status-connected .engine-dot, .status-simulating .engine-dot, .status-heartbeat .engine-dot { background: #34c759; box-shadow: 0 0 8px rgba(52, 199, 89, 0.6); }
.status-connected, .status-simulating, .status-heartbeat { border-color: rgba(52, 199, 89, 0.15); background: rgba(52, 199, 89, 0.05); }
.status-error .engine-dot, .status-unconfigured .engine-dot { background: #ff3b30; box-shadow: 0 0 8px rgba(255, 59, 48, 0.6); }
.status-error, .status-unconfigured { border-color: rgba(255, 59, 48, 0.15); background: rgba(255, 59, 48, 0.05); }
.status-connecting .engine-dot, .status-retrying .engine-dot, .status-waiting .engine-dot { background: #ff9500; box-shadow: 0 0 8px rgba(255, 149, 0, 0.6); animation: pulse 1.5s infinite; }
.status-connecting, .status-retrying, .status-waiting { border-color: rgba(255, 149, 0, 0.15); background: rgba(255, 149, 0, 0.05); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

@media (max-width: 1180px) {
    .model-library-layout {
        grid-template-columns: 1fr;
    }
    .model-preview-panel {
        position: relative;
    }
}
</style>
