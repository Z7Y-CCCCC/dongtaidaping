<script setup>
import { ref, reactive, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { adminApi } from '../config/factoryConfig.js'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { SceneRuntime } from '../runtime/SceneRuntime.js'
import { RENDER_PROFILE_OPTIONS, normalizeRenderSettings } from '../runtime/renderConfig.js'
import WidgetRenderer from '../runtime/WidgetRenderer.vue'
import { createDeviceModel, resolveBackendAssetUrl } from '../three/ModelFactory.js'
import {
    DEFAULT_DEVICE_LABEL_CONFIG,
    DEFAULT_DIAGNOSTIC_CONFIG,
    DEFAULT_LINE_OVERVIEW_CONFIG,
    buildDiagnosticGroups,
    normalizeDeviceLabelConfig
} from '../runtime/uiConfig.js'

const ADMIN_UI_STATE_KEY = 'digital_twin_admin_ui_state_v1'

function loadAdminUiState() {
    try {
        return JSON.parse(localStorage.getItem(ADMIN_UI_STATE_KEY) || '{}')
    } catch (e) {
        return {}
    }
}

const storedAdminUiState = loadAdminUiState()

// 当前选中的 Tab
const activeTab = ref(storedAdminUiState.activeTab || 'composer')
const isAdminNavCollapsed = ref(!!storedAdminUiState.isAdminNavCollapsed)
const isFactoryMenuOpen = ref(true)
const isDataMenuOpen = ref(true)
const navIconPaths = {
    composer: ['M4 5h16v14H4z', 'M8 9h8', 'M8 13h5', 'M16 13h1', 'M8 17h8'],
    factory: ['M4 20V9l4-3 4 3 4-3 4 3v11', 'M8 20v-6h3v6', 'M16 20v-6h3v6', 'M12 20V9'],
    workshops: ['M4 20V8l8-4 8 4v12', 'M8 20v-8h8v8', 'M10 8h4'],
    lines: ['M4 7h5', 'M15 7h5', 'M9 7c2 0 4 10 6 10', 'M4 17h5', 'M15 17h5'],
    devices: ['M6 8h12v8H6z', 'M9 8V5h6v3', 'M9 19h6', 'M12 16v3'],
    models: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
    platform: ['M5 5h6v6H5z', 'M13 5h6v6h-6z', 'M5 13h6v6H5z', 'M13 13h6v6h-6z'],
    data: ['M4 7h16', 'M4 12h16', 'M4 17h16', 'M7 7v10', 'M17 7v10'],
    points: ['M5 12h4', 'M15 12h4', 'M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0', 'M12 5V3', 'M12 21v-2'],
    settings: ['M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z', 'M12 2v3', 'M12 19v3', 'M4.93 4.93l2.12 2.12', 'M16.95 16.95l2.12 2.12', 'M2 12h3', 'M19 12h3', 'M4.93 19.07l2.12-2.12', 'M16.95 7.05l2.12-2.12']
}

const appDialog = reactive({
    visible: false,
    title: '提示',
    message: '',
    type: 'info',
    showCancel: false,
    confirmText: '确定',
    cancelText: '取消'
})
let appDialogResolve = null

function openAppDialog(options = {}) {
    return new Promise(resolve => {
        appDialogResolve = resolve
        Object.assign(appDialog, {
            visible: true,
            title: options.title || (options.showCancel ? '请确认操作' : '系统提示'),
            message: String(options.message ?? ''),
            type: options.type || 'info',
            showCancel: !!options.showCancel,
            confirmText: options.confirmText || '确定',
            cancelText: options.cancelText || '取消'
        })
    })
}

function closeAppDialog(result) {
    appDialog.visible = false
    const resolve = appDialogResolve
    appDialogResolve = null
    if (resolve) resolve(result)
}

function alert(message, options = {}) {
    return openAppDialog({ ...options, message, showCancel: false })
}

function confirm(message, options = {}) {
    return openAppDialog({ ...options, message, showCancel: true, type: options.type || 'warning' })
}

// ============ 车间管理 ============
const workshops = ref([])
const newWorkshop = reactive({ id: '', name: '' })

async function loadWorkshops() {
    workshops.value = await adminApi.getWorkshops()
}

async function createWorkshop() {
    if (!newWorkshop.id || !newWorkshop.name) return alert('请填写车间ID和名称')
    const result = await adminApi.createWorkshop({ id: newWorkshop.id, name: newWorkshop.name, sort_order: workshops.value.length })
    if (result?.error) return alert(result.error, { title: '新增车间失败', type: 'danger' })
    if (!result?.success) return alert('新增车间失败：后端没有返回成功状态', { title: '新增车间失败', type: 'danger' })
    const createdName = newWorkshop.name
    newWorkshop.id = ''
    newWorkshop.name = ''
    await loadWorkshops()
    await alert(`车间「${createdName}」已创建`, { title: '新增成功', type: 'success' })
}

async function deleteWorkshop(id) {
    if (!(await confirm(`确定删除车间 ${id}？该车间下的所有产线及设备也会被删除！`))) return
    const result = await adminApi.deleteWorkshop(id)
    if (result?.error) return alert(result.error, { title: '删除车间失败', type: 'danger' })
    if (!result?.success) return alert('删除车间失败：后端没有返回成功状态', { title: '删除车间失败', type: 'danger' })
    await loadWorkshops()
    await loadLines()
    await loadDevices()
    await alert(`车间「${id}」已删除`, { title: '删除成功', type: 'success' })
}

// ============ 产线管理 ============
const lines = ref([])
const newLine = reactive({ id: '', name: '', workshop_id: '' })
const selectedLineEditorId = ref(storedAdminUiState.selectedLineEditorId || '')
const isLinePlannerEditorCollapsed = ref(!!storedAdminUiState.isLinePlannerEditorCollapsed)
const isLineDevicePoolCollapsed = ref(!!storedAdminUiState.isLineDevicePoolCollapsed)
const lineDevicePoolDock = reactive({
    x: Number.isFinite(Number(storedAdminUiState.lineDevicePoolDockX)) ? Number(storedAdminUiState.lineDevicePoolDockX) : 28,
    y: Number.isFinite(Number(storedAdminUiState.lineDevicePoolDockY)) ? Number(storedAdminUiState.lineDevicePoolDockY) : 26,
    moving: false,
    moved: false
})
const linePreviewStageRef = ref(null)
const lineLayoutSaving = ref(false)
let linePreviewDragState = null
let lineDeviceDragState = null
let lineDevicePoolMoveState = null
const lineDeviceSavingId = ref('')
const lineFlowDirectionOptions = [
    { value: 'right', label: '向右' },
    { value: 'left', label: '向左' },
    { value: 'none', label: '隐藏' }
]
const lineDeviceDrag = reactive({
    active: false,
    deviceId: '',
    x: 0,
    z: 0,
    left: 0,
    top: 0,
    targetType: '',
    targetId: '',
    targetName: '',
    alignActive: false,
    alignX: 0,
    alignLeft: 0,
    canDrop: false,
    message: ''
})

function makeLineLayoutItem(type, index = 0) {
    const isRail = type === 'rail'
    const prefix = isRail ? 'rail' : 'lane'
    const name = isRail ? '小车导轨' : '设备线'
    return {
        id: `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
        name: `${name} ${index + 1}`,
        type: isRail ? 'cart_rail' : 'device_lane',
        offsetZ: isRail ? 4 + index * 6 : index * 6,
        length: 60,
        sort_order: index
    }
}

function defaultLineLayout() {
    return {
        version: 1,
        flowDirection: 'right',
        lanes: [{ ...makeLineLayoutItem('lane', 0), id: 'lane_1' }],
        rails: []
    }
}

function normalizeLineLayoutItems(items, type) {
    const isRail = type === 'rail'
    return (Array.isArray(items) ? items : [])
        .map((item, index) => ({
            id: String(item?.id || `${isRail ? 'rail' : 'lane'}_${index + 1}`),
            name: String(item?.name || `${isRail ? '小车导轨' : '设备线'} ${index + 1}`),
            type: isRail ? 'cart_rail' : 'device_lane',
            offsetZ: numberOrDefault(item?.offsetZ ?? item?.offset_z ?? item?.z, isRail ? 4 : 0),
            length: Math.max(1, numberOrDefault(item?.length, 60)),
            sort_order: numberOrDefault(item?.sort_order, index)
        }))
        .sort((a, b) => a.sort_order - b.sort_order)
}

function normalizeLineLayout(value) {
    const source = parseInstanceConfig(value) || {}
    const lanes = normalizeLineLayoutItems(source.lanes, 'lane')
    const rails = normalizeLineLayoutItems(source.rails, 'rail')
    const flowDirection = ['right', 'left', 'none'].includes(source.flowDirection) ? source.flowDirection : 'right'
    if (!lanes.length) lanes.push(defaultLineLayout().lanes[0])
    return { version: 1, flowDirection, lanes, rails }
}

function serializeLineLayout(layout) {
    return JSON.stringify(normalizeLineLayout(layout), null, 2)
}

function normalizeLineRecord(line) {
    const layout = normalizeLineLayout(line?.layout || line?.layout_json)
    return {
        ...line,
        layout,
        layout_json: JSON.stringify(layout)
    }
}

function ensureSelectedLineEditor() {
    if (!lines.value.length) {
        selectedLineEditorId.value = ''
        return
    }
    if (!selectedLineEditorId.value || !lines.value.some(line => line.id === selectedLineEditorId.value)) {
        selectedLineEditorId.value = sortByOrder(lines.value)[0]?.id || ''
    }
}

async function loadLines() {
    const result = await adminApi.getLines()
    lines.value = (Array.isArray(result) ? result : []).map(normalizeLineRecord)
    if (lines.value.length === 0 && workshops.value.length > 0) {
        newLine.workshop_id = workshops.value[0].id
    }
    ensureSelectedLineEditor()
}

async function createLine() {
    if (!newLine.id || !newLine.name || !newLine.workshop_id) return alert('请填写产线ID、名称和所属车间')
    const result = await adminApi.createLine({
        id: newLine.id,
        name: newLine.name,
        workshop_id: newLine.workshop_id,
        layout_json: serializeLineLayout(defaultLineLayout()),
        sort_order: lines.value.length
    })
    if (result?.error) return alert(result.error, { title: '新增产线失败', type: 'danger' })
    if (!result?.success) return alert('新增产线失败：后端没有返回成功状态', { title: '新增产线失败', type: 'danger' })
    const createdName = newLine.name
    selectedLineEditorId.value = newLine.id
    newLine.id = ''
    newLine.name = ''
    await loadLines()
    await alert(`产线「${createdName}」已创建`, { title: '新增成功', type: 'success' })
}

async function deleteLine(id) {
    if (!(await confirm(`确定删除产线 ${id}？该产线下的所有设备也会被删除！`))) return
    const result = await adminApi.deleteLine(id)
    if (result?.error) return alert(result.error, { title: '删除产线失败', type: 'danger' })
    if (!result?.success) return alert('删除产线失败：后端没有返回成功状态', { title: '删除产线失败', type: 'danger' })
    await loadLines()
    await loadDevices()
    await alert(`产线「${id}」已删除`, { title: '删除成功', type: 'success' })
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
    let result
    if (isEditMode.value) {
        result = await adminApi.updateDevice(editingDevice.id, payload)
    } else {
        result = await adminApi.createDevice(payload)
    }
    if (result?.error) return alert(result.error, { title: '设备保存失败', type: 'danger' })
    if (!result?.success) return alert('设备保存失败：后端没有返回成功状态', { title: '设备保存失败', type: 'danger' })
    showDeviceForm.value = false
    await loadDevices()
    setTimeout(() => loadEngineStatus(), 800)
    await alert(`设备「${payload.name}」已保存`, { title: '保存成功', type: 'success' })
}

async function deleteDevice(id) {
    if (!(await confirm(`确定删除设备 ${id}？`))) return
    const result = await adminApi.deleteDevice(id)
    if (result?.error) return alert(result.error, { title: '删除失败', type: 'danger' })
    if (!result?.success) return alert('删除失败：后端没有返回成功状态', { title: '删除失败', type: 'danger' })
    await loadDevices()
    setTimeout(() => loadEngineStatus(), 800)
    await alert(`设备「${id}」已删除`, { title: '删除成功', type: 'success' })
}

// ============ 点位映射 ============
const selectedDeviceForPoints = ref(storedAdminUiState.selectedDeviceForPoints || 'all')
const dataPoints = ref([])
const isPointsDirty = ref(false)
const showPointAdvancedFields = ref(!!storedAdminUiState.showPointAdvancedFields)
const loadedPointDeviceIds = ref([])
const alarmTextImportRaw = ref('')
const alarmTextFileInput = ref(null)
const pointUsageOptions = [
    { value: 'normal', label: '常规监控' },
    { value: 'alarm_trigger', label: '报警触发' },
    { value: 'alarm_text_record', label: '报警内容记录' },
    { value: 'alarm_start_record', label: '报警开始时间' },
    { value: 'alarm_end_record', label: '报警结束时间' },
    { value: 'alarm_number_record', label: '报警编号记录' },
    { value: 'alarm_state_record', label: '报警状态记录' }
]
const pointDataTypes = [
    { value: 'BOOL', label: 'BOOL 开关量' },
    { value: 'BYTE', label: 'BYTE 字节' },
    { value: 'WORD', label: 'WORD 无符号整数' },
    { value: 'INT', label: 'INT 有符号整数' },
    { value: 'DWORD', label: 'DWORD 双字' },
    { value: 'DINT', label: 'DINT 有符号双字' },
    { value: 'REAL', label: 'REAL 浮点数' },
    { value: 'LREAL', label: 'LREAL 双精度浮点' },
    { value: 'STRING', label: 'STRING 文本' },
    { value: 'CHAR', label: 'CHAR 字符数组' },
    { value: 'DT', label: 'DT 日期时间' },
    { value: 'DTL', label: 'DTL 新版日期时间' }
]
const alarmRecordRoleMeta = {
    txt_record: { usage: 'alarm_text_record', label: '报警内容', dataType: 'STRING', pointName: 'txt_record' },
    date1_record: { usage: 'alarm_start_record', label: '报警开始时间', dataType: 'DT', pointName: 'date1_record' },
    date2_record: { usage: 'alarm_end_record', label: '报警结束时间', dataType: 'DT', pointName: 'date2_record' },
    num_record: { usage: 'alarm_number_record', label: '报警编号', dataType: 'WORD', pointName: 'num_record' },
    state_record: { usage: 'alarm_state_record', label: '报警状态', dataType: 'WORD', pointName: 'state_record' }
}
const isAllPointsMode = computed(() => selectedDeviceForPoints.value === 'all')

function normalizePointUsage(point = {}) {
    if (point.__usage) return point.__usage
    const role = String(point.alarm_record_role || point.value_role || point.name || '').trim().toLowerCase()
    if (role === 'txt_record' || role === 'alarm_text_record') return 'alarm_text_record'
    if (role === 'date1_record' || role === 'alarm_start_record') return 'alarm_start_record'
    if (role === 'date2_record' || role === 'alarm_end_record') return 'alarm_end_record'
    if (role === 'num_record' || role === 'alarm_number_record') return 'alarm_number_record'
    if (role === 'state_record' || role === 'alarm_state_record') return 'alarm_state_record'
    if (point.point_kind === 'alarm' || point.is_alarm || /^bj\d+$/i.test(String(point.name || point.label || '').trim())) return 'alarm_trigger'
    return 'normal'
}

function pointDisplayName(point = {}) {
    return String(point.label || point.name || '').trim()
}

function normalizeLoadedPoint(point) {
    const usage = normalizePointUsage(point)
    const displayName = pointDisplayName(point)
    return {
        ...point,
        __usage: usage,
        __originalName: point.name || '',
        device_id: point.device_id || (isAllPointsMode.value ? devices.value[0]?.id || '' : selectedDeviceForPoints.value),
        name: point.name || '',
        label: displayName,
        plc_tag: point.plc_tag || composePlcAddressFromParts(point),
        data_type: point.data_type || 'WORD',
        category: point.category || '',
        value_role: point.value_role || '',
        quality: point.quality || 'good',
        scale: point.scale ?? 1,
        offset: point.offset ?? 0,
        expression: point.expression || '',
        display_format: point.display_format || '',
        unit: String(point.data_type || '').toUpperCase() === 'BOOL' ? '' : (point.unit || ''),
        sample_interval_ms: point.sample_interval_ms ?? 1000,
        access_type: point.access_type || 'READ',
        db_number: point.db_number ?? null,
        db_byte_offset: point.db_byte_offset ?? null,
        bit_offset: point.bit_offset ?? null,
        point_kind: point.point_kind || (usage === 'normal' ? 'normal' : 'alarm'),
        alarm_record_role: point.alarm_record_role || '',
        alarm_text: point.alarm_text || '',
        alarm_level: point.alarm_level || 'WARNING',
        alarm_condition: point.alarm_condition || '=1'
    }
}

async function loadDataPoints() {
    if (!selectedDeviceForPoints.value) { dataPoints.value = []; return }
    const points = await adminApi.getDataPoints(selectedDeviceForPoints.value)
    loadedPointDeviceIds.value = [...new Set(points.map(point => point.device_id).filter(Boolean))]
    dataPoints.value = points.map(normalizeLoadedPoint)
    isPointsDirty.value = false
}

function addDataPoint(usage = 'normal') {
    const deviceId = isAllPointsMode.value ? devices.value[0]?.id || '' : selectedDeviceForPoints.value
    const point = normalizeLoadedPoint({
        device_id: deviceId,
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
    setPointUsage(point, usage, { markDirty: false })
    dataPoints.value.push(point)
    isPointsDirty.value = true
}

function addAlarmTriggerPoint() {
    const nextIndex = getNextAlarmPointIndex()
    const deviceId = isAllPointsMode.value ? devices.value[0]?.id || '' : selectedDeviceForPoints.value
    const point = normalizeLoadedPoint({
        device_id: deviceId,
        name: `bj${nextIndex}`,
        label: `bj${nextIndex}`,
        plc_tag: '',
        data_type: 'BOOL',
        sample_interval_ms: 500,
        access_type: 'READ',
        point_kind: 'alarm',
        alarm_condition: '=1',
        alarm_level: 'WARNING'
    })
    setPointUsage(point, 'alarm_trigger', { markDirty: false })
    dataPoints.value.push(point)
    isPointsDirty.value = true
}

function removeDataPoint(idx) {
    dataPoints.value.splice(idx, 1)
    isPointsDirty.value = true
}

function markPointsDirty() {
    isPointsDirty.value = true
}

function isBoolPoint(point) {
    return String(point?.data_type || '').toUpperCase() === 'BOOL'
}

function handlePointDataTypeChange(point) {
    if (isBoolPoint(point)) point.unit = ''
    markPointsDirty()
}

function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === ''
}

function optionalNumber(value) {
    return isBlank(value) ? null : Number(value)
}

function composePlcAddressFromParts(point = {}) {
    const dbNumber = Number(point.db_number)
    const byteOffset = Number(point.db_byte_offset)
    if (!Number.isInteger(dbNumber) || dbNumber < 0 || !Number.isInteger(byteOffset) || byteOffset < 0) return ''

    const type = String(point.data_type || 'WORD').trim().toUpperCase()
    if (type === 'BOOL') {
        const bit = Number.isInteger(Number(point.bit_offset)) ? Math.max(0, Math.min(7, Number(point.bit_offset))) : 0
        return `DB${dbNumber}.DBX${byteOffset}.${bit}`
    }
    if (type === 'BYTE' || type === 'CHAR') return `DB${dbNumber}.DBB${byteOffset}`
    if (type === 'REAL' || type === 'DWORD' || type === 'DINT' || type === 'DT' || type === 'DTL') return `DB${dbNumber}.DBD${byteOffset}`
    return `DB${dbNumber}.DBW${byteOffset}`
}

function simpleHash(text) {
    let hash = 0
    const value = String(text || '')
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i)
        hash |= 0
    }
    return Math.abs(hash).toString(36)
}

function toInternalPointName(label, fallbackIndex = 0) {
    const raw = String(label || '').trim()
    const ascii = raw
        .replace(/[\u4e00-\u9fa5]+/g, '')
        .replace(/[^a-zA-Z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()
    if (ascii) return ascii.slice(0, 96)
    return `point_${simpleHash(raw || fallbackIndex)}`
}

function inferPointCategory(point, usage) {
    if (usage !== 'normal') return 'status'
    const name = pointDisplayName(point).toLowerCase()
    const type = String(point.data_type || '').toUpperCase()
    if (type === 'BOOL' || name.includes('报警') || name.includes('故障') || name.includes('状态') || name.includes('运行')) return 'status'
    if (name.includes('气') || name.includes('阀') || name.includes('流量')) return 'gas'
    if (name.includes('门')) return 'doors'
    if (name.includes('风机') || name.includes('风扇') || name.includes('搅拌') || name.includes('泵') || name.includes('电机')) return 'motors'
    if (name.includes('链') || name.includes('推') || name.includes('拉') || name.includes('机构')) return 'mechanisms'
    return 'analog'
}

function roleFromUsage(usage, internalName) {
    if (usage === 'alarm_text_record') return 'txt_record'
    if (usage === 'alarm_start_record') return 'date1_record'
    if (usage === 'alarm_end_record') return 'date2_record'
    if (usage === 'alarm_number_record') return 'num_record'
    if (usage === 'alarm_state_record') return 'state_record'
    return internalName
}

function setPointUsage(point, usage, options = {}) {
    const nextUsage = usage || 'normal'
    const currentType = String(point.data_type || '').toUpperCase()
    point.__usage = nextUsage
    point.point_kind = nextUsage === 'normal' ? 'normal' : 'alarm'
    point.alarm_record_role = ''
    if (nextUsage === 'alarm_trigger') {
        if (!currentType || currentType === 'WORD') point.data_type = 'BOOL'
        point.unit = ''
        point.sample_interval_ms = point.sample_interval_ms || 500
        point.alarm_condition = point.alarm_condition || '=1'
        point.alarm_level = point.alarm_level || 'WARNING'
    } else {
        const recordMeta = Object.entries(alarmRecordRoleMeta).find(([, meta]) => meta.usage === nextUsage)?.[1]
        if (recordMeta) {
            point.alarm_record_role = recordMeta.pointName
            if (!point.name) point.name = recordMeta.pointName
            if (!point.label) point.label = recordMeta.label
            if (!currentType || currentType === 'WORD') point.data_type = recordMeta.dataType
            point.sample_interval_ms = point.sample_interval_ms || 1000
        }
    }
    if (options.markDirty !== false) markPointsDirty()
}

function formatPointUsage(point) {
    const usage = typeof point === 'string' ? point : normalizePointUsage(point)
    return pointUsageOptions.find(item => item.value === usage)?.label || '常规监控'
}

function isTextPointType(point) {
    return ['STRING', 'CHAR'].includes(String(point.data_type || '').toUpperCase())
}

function getAlarmPointNumber(point, fallbackIndex = 0) {
    const text = String(point.name || point.label || '').trim()
    const match = text.match(/^bj(\d+)$/i)
    return match ? Number(match[1]) : fallbackIndex + 1
}

const currentAlarmTriggerPoints = computed(() => dataPoints.value
    .filter(point => normalizePointUsage(point) === 'alarm_trigger')
    .map((point, index) => ({ point, number: getAlarmPointNumber(point, index) }))
    .sort((a, b) => a.number - b.number))

const alarmRecordPointStatus = computed(() => Object.entries(alarmRecordRoleMeta).map(([role, meta]) => ({
    role,
    label: meta.label,
    configured: dataPoints.value.some(point => normalizePointUsage(point) === meta.usage),
    point: dataPoints.value.find(point => normalizePointUsage(point) === meta.usage)
})))

function getNextAlarmPointIndex() {
    const used = currentAlarmTriggerPoints.value.map(item => item.number).filter(Number.isFinite)
    return used.length ? Math.max(...used) + 1 : 1
}

function parseAlarmText(text) {
    const raw = String(text || '')
    const lines = raw.split(/\r?\n/)
    const map = new Map()
    const hasArrowFormat = /=>/.test(raw)
    let sequence = 1

    lines.forEach((line) => {
        const source = String(line || '').trim()
        if (!source) return
        if (hasArrowFormat) {
            const match = source.match(/(\d+)\s*=>\s*["'“”‘’（(]?(.*?)["'“”‘’）)]?\s*[,，;；]?$/)
            if (!match) return
            const number = Number(match[1])
            const message = String(match[2] || '').trim()
            if (Number.isFinite(number) && message) map.set(number, message)
            return
        }

        const message = source
            .replace(/^\d+[\s.、:：-]+/, '')
            .replace(/^["'“”‘’（(,\s]+|["'“”‘’）),\s;，；]+$/g, '')
            .trim()
        if (message && !/^[\]\};,.\s]+$/.test(message)) {
            map.set(sequence, message)
            sequence += 1
        }
    })

    return map
}

const parsedAlarmTextEntries = computed(() => Array.from(parseAlarmText(alarmTextImportRaw.value).entries())
    .map(([number, text]) => ({ number, text }))
    .sort((a, b) => a.number - b.number))

const alarmTextImportSummary = computed(() => {
    const alarmCount = currentAlarmTriggerPoints.value.length
    const textCount = parsedAlarmTextEntries.value.length
    if (!alarmTextImportRaw.value.trim()) return `当前设备已配置 ${alarmCount} 个报警触发点位`
    if (alarmCount === textCount) return `数量匹配：${alarmCount} 个报警点位，${textCount} 条报警说明`
    return `数量不一致：当前 ${alarmCount} 个报警点位，导入文本 ${textCount} 条，请核对`
})

function fillAlarmTextTemplate() {
    if (isAllPointsMode.value) {
        return alert('请先筛选到某一台设备，再生成该设备的报警文本模板。', { title: '需要选择设备', type: 'warning' })
    }
    alarmTextImportRaw.value = currentAlarmTriggerPoints.value
        .map(({ point, number }) => `    ${number} => "${point.alarm_text || point.label || ''}",`)
        .join('\n')
}

function triggerAlarmTextFileSelect() {
    alarmTextFileInput.value?.click()
}

async function handleAlarmTextFileChange(event) {
    const file = event?.target?.files?.[0]
    if (!file) return
    alarmTextImportRaw.value = await file.text()
    event.target.value = ''
}

async function applyAlarmTextImport() {
    if (isAllPointsMode.value) {
        return alert('请先筛选到某一台设备，再导入该设备的报警文本。', { title: '需要选择设备', type: 'warning' })
    }
    const textMap = parseAlarmText(alarmTextImportRaw.value)
    if (textMap.size === 0) {
        return alert('没有解析到报警文本。可以粘贴 1 => "报警内容" 这种格式，也可以一行一条按顺序粘贴。', { title: '报警文本为空', type: 'warning' })
    }
    const triggers = currentAlarmTriggerPoints.value
    if (triggers.length === 0) {
        return alert('当前设备还没有报警触发点位，请先添加 bj1、bj2 这类报警点位并填写 PLC 地址。', { title: '没有报警点位', type: 'warning' })
    }

    let updated = 0
    triggers.forEach(({ point, number }) => {
        const text = textMap.get(number)
        if (!text) return
        point.alarm_text = text
        updated += 1
    })
    markPointsDirty()
    await alert(`已匹配 ${updated} 条报警说明。请点击“保存点位配置”写入数据库。`, { title: '报警文本已导入', type: 'success' })
}

function ensureAlarmRecordPoints() {
    if (isAllPointsMode.value) {
        return alert('请先筛选到某一台设备，再补齐报警记录字段。', { title: '需要选择设备', type: 'warning' })
    }
    let added = 0
    Object.entries(alarmRecordRoleMeta).forEach(([role, meta]) => {
        if (role === 'num_record' || role === 'state_record') return
        if (dataPoints.value.some(point => normalizePointUsage(point) === meta.usage)) return
        const point = normalizeLoadedPoint({
            device_id: selectedDeviceForPoints.value,
            name: meta.pointName,
            label: meta.label,
            plc_tag: '',
            data_type: meta.dataType,
            sample_interval_ms: 1000,
            access_type: 'READ',
            point_kind: 'alarm',
            alarm_record_role: role
        })
        setPointUsage(point, meta.usage, { markDirty: false })
        dataPoints.value.push(point)
        added += 1
    })
    if (added > 0) markPointsDirty()
    alert(added > 0 ? `已添加 ${added} 个报警记录字段，请补 PLC 地址后保存。` : '报警内容、开始时间、结束时间字段已经存在。', {
        title: added > 0 ? '已补齐字段' : '无需重复添加',
        type: added > 0 ? 'success' : 'info'
    })
}

function validatePointRows(points) {
    const errors = []
    const allowedTypes = pointDataTypes.map(item => item.value)
    const allowedAccessTypes = ['READ', 'READ_WRITE', 'WRITE']

    points.forEach((point, index) => {
        const row = index + 1
        if (isAllPointsMode.value && isBlank(point.device_id)) errors.push(`第 ${row} 行：必须选择设备`)
        if (isBlank(pointDisplayName(point))) errors.push(`第 ${row} 行：点位名称不能为空`)

        const hasPlcTag = !isBlank(point.plc_tag)
        if (!hasPlcTag) {
            errors.push(`第 ${row} 行：必须填写 PLC 地址`)
        }
        if (isTextPointType(point) && !hasPlcTag) {
            errors.push(`第 ${row} 行：文本点位请直接填写完整 PLC 地址，例如 DB10,S20.30`)
        }

        if (!allowedTypes.includes(String(point.data_type || '').toUpperCase())) {
            errors.push(`第 ${row} 行：数据类型不正确`)
        }
        const interval = Number(point.sample_interval_ms)
        if (!Number.isFinite(interval) || interval < 100 || interval > 60000) {
            errors.push(`第 ${row} 行：采集周期必须在 100-60000ms 之间`)
        }
        if (!allowedAccessTypes.includes(String(point.access_type || '').toUpperCase())) {
            errors.push(`第 ${row} 行：读写类型不正确`)
        }
    })

    return errors
}

function buildDataPointPayload(point) {
    const { id, device_id, alarm_high, alarm_low, __usage, __originalName, ...payload } = point
    const usage = normalizePointUsage({ ...point, __usage })
    const displayName = pointDisplayName(point)
    const internalName = String(payload.name || '').trim() || toInternalPointName(displayName, id || displayName)
    const fieldName = roleFromUsage(usage, internalName)
    const plcTag = String(payload.plc_tag || '').trim()
    const dataType = String(payload.data_type || 'WORD').toUpperCase()
    return {
        ...payload,
        name: internalName,
        label: displayName,
        plc_tag: plcTag,
        data_type: dataType,
        access_type: String(payload.access_type || 'READ').toUpperCase(),
        category: inferPointCategory(point, usage),
        value_role: fieldName,
        quality: 'good',
        scale: payload.scale ?? 1,
        offset: payload.offset ?? 0,
        expression: payload.expression || '',
        display_format: payload.display_format || '',
        unit: dataType === 'BOOL' ? '' : (payload.unit || ''),
        db_number: plcTag ? null : optionalNumber(payload.db_number),
        db_byte_offset: plcTag ? null : optionalNumber(payload.db_byte_offset),
        bit_offset: plcTag ? null : optionalNumber(payload.bit_offset),
        point_kind: usage === 'normal' ? 'normal' : 'alarm',
        alarm_record_role: usage === 'alarm_trigger' || usage === 'normal' ? '' : fieldName,
        alarm_text: String(payload.alarm_text || '').trim(),
        alarm_level: payload.alarm_level || 'WARNING',
        alarm_condition: payload.alarm_condition || '=1'
    }
}

async function saveAllPoints() {
    if (!selectedDeviceForPoints.value) return alert('请先选择设备')
    const errors = validatePointRows(dataPoints.value)
    if (errors.length) {
        return alert(errors.slice(0, 8).join('\n'), { title: '点位配置未保存', type: 'warning' })
    }

    const points = dataPoints.value.map(buildDataPointPayload)
    let savedCount = 0
    if (isAllPointsMode.value) {
        const deviceIds = new Set([...loadedPointDeviceIds.value, ...dataPoints.value.map(point => point.device_id).filter(Boolean)])
        for (const deviceId of deviceIds) {
            const rows = dataPoints.value
                .filter(point => point.device_id === deviceId)
                .map(buildDataPointPayload)
            const result = await adminApi.saveDataPointsBatch(deviceId, rows)
            if (result?.error) return alert(result.error)
            if (!result?.success) return alert('保存失败：后端没有返回成功状态', { title: '保存失败', type: 'danger' })
            savedCount += result.count ?? rows.length
        }
    } else {
        const result = await adminApi.saveDataPointsBatch(selectedDeviceForPoints.value, points)
        if (result?.error) return alert(result.error)
        if (!result?.success) return alert('保存失败：后端没有返回成功状态', { title: '保存失败', type: 'danger' })
        savedCount = result.count ?? points.length
    }
    await alert(`保存成功，已写入 ${savedCount} 个点位。`, { title: '点位配置已保存', type: 'success' })
    isPointsDirty.value = false
    await loadDataPoints()
    selectedDeviceForMonitor.value = selectedDeviceForPoints.value
    await loadRealtimePointValues()
    setTimeout(() => loadEngineStatus(), 800)
}

const selectedDeviceForMonitor = ref(storedAdminUiState.selectedDeviceForMonitor || 'all')
const realtimePointRows = ref([])
const realtimePointDeviceStatus = ref(null)
const realtimePointDeviceStatuses = ref([])
const realtimePointSnapshotAt = ref(null)
const realtimePointLoading = ref(false)
const realtimePointError = ref('')
const pointMonitorAutoRefresh = ref(storedAdminUiState.pointMonitorAutoRefresh !== false)
const pointMonitorRefreshIntervalMs = 1000
let pointMonitorTimer = null
let realtimePointRequestSeq = 0
let realtimePointInFlight = false
const selectedMonitorDevice = computed(() => devices.value.find(d => d.id === selectedDeviceForMonitor.value) || null)
const isAllPointMonitorMode = computed(() => selectedDeviceForMonitor.value === 'all')
const pointMonitorStatusSummary = computed(() => {
    if (!isAllPointMonitorMode.value) return realtimePointDeviceStatus.value
    const statuses = realtimePointDeviceStatuses.value || []
    const total = devices.value.length
    const online = statuses.filter(status => status.quality === 'good' || status.status === 'connected').length
    const bad = statuses.filter(status => status.quality === 'bad' || ['error', 'unconfigured', 'unsupported', 'disabled'].includes(status.status)).length
    return {
        status: online === total && total > 0 ? 'connected' : bad > 0 ? 'error' : 'idle',
        message: `全部设备：${online}/${total} 在线`,
        endpoint: '全部设备',
        lastError: bad > 0 ? `${bad} 台设备离线或未配置` : ''
    }
})

function ensurePointMonitorDevice() {
    if (selectedDeviceForMonitor.value) return
    selectedDeviceForMonitor.value = 'all'
}

function pointRuntimeKey(point) {
    return `${point.device_id || ''}:${point.id || point.name || ''}`
}

function mergeRealtimePointRows(nextRows = []) {
    const existing = new Map(realtimePointRows.value.map(row => [row.__runtimeKey || pointRuntimeKey(row), row]))
    const merged = nextRows.map((row) => {
        const key = pointRuntimeKey(row)
        const current = existing.get(key)
        if (current) {
            Object.assign(current, row, { __runtimeKey: key })
            return current
        }
        return { ...row, __runtimeKey: key }
    })
    realtimePointRows.value = merged
}

async function loadRealtimePointValues(options = {}) {
    const silent = !!options.silent
    ensurePointMonitorDevice()
    if (!selectedDeviceForMonitor.value) {
        realtimePointRows.value = []
        realtimePointDeviceStatus.value = null
        realtimePointSnapshotAt.value = null
        return
    }
    if (realtimePointInFlight && silent) return

    const requestSeq = ++realtimePointRequestSeq
    realtimePointInFlight = true
    if (!silent) {
        realtimePointLoading.value = true
        realtimePointError.value = ''
    }
    try {
        const result = await adminApi.getRealtimePointValues(selectedDeviceForMonitor.value)
        if (requestSeq !== realtimePointRequestSeq) return
        if (result?.error) {
            if (!silent || !realtimePointRows.value.length) realtimePointError.value = result.error
            return
        }
        mergeRealtimePointRows(result.points || [])
        realtimePointDeviceStatus.value = result.deviceStatus || null
        realtimePointDeviceStatuses.value = result.deviceStatuses || []
        realtimePointSnapshotAt.value = result.snapshotTimestamp || null
        if (!silent) realtimePointError.value = ''
    } catch (e) {
        if (!silent || !realtimePointRows.value.length) realtimePointError.value = e.message || '读取实时点位失败'
    } finally {
        if (requestSeq === realtimePointRequestSeq) realtimePointInFlight = false
        if (!silent) realtimePointLoading.value = false
    }
}

function startPointMonitor() {
    stopPointMonitor()
    ensurePointMonitorDevice()
    loadRealtimePointValues({ silent: realtimePointRows.value.length > 0 })
    if (pointMonitorAutoRefresh.value) {
        pointMonitorTimer = setInterval(() => loadRealtimePointValues({ silent: true }), pointMonitorRefreshIntervalMs)
    }
}

function stopPointMonitor() {
    if (pointMonitorTimer) {
        clearInterval(pointMonitorTimer)
        pointMonitorTimer = null
    }
}

function formatPointValue(point) {
    if (point.value === undefined || point.value === null) return '-'
    if (typeof point.value === 'boolean') return point.value ? 'ON / true' : 'OFF / false'
    if (typeof point.value === 'number') {
        const format = String(point.display_format || '').trim()
        const decimals = format.includes('.') ? Math.min(6, format.split('.')[1].length) : null
        const text = decimals === null ? String(point.value) : point.value.toFixed(decimals)
        return point.unit ? `${text} ${point.unit}` : text
    }
    return String(point.value)
}

function formatQualityLabel(quality) {
    const labels = { good: '正常', stale: '过期', bad: '异常' }
    return labels[quality] || quality || '-'
}

function formatPointTime(value) {
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
    return new Date(timestamp).toLocaleTimeString()
}

// 扩展功能：从其他设备复制
async function copyPointsFrom(sourceDeviceId) {
    if (isAllPointsMode.value) return alert('请先筛选到某一台设备，再从其他设备复制点位配置。')
    if (!sourceDeviceId || sourceDeviceId === selectedDeviceForPoints.value) return
    if (isPointsDirty.value && !(await confirm('当前有未保存的修改，复制将覆盖这些修改，确定继续？'))) return
    
    const sourcePoints = await adminApi.getDataPoints(sourceDeviceId)
    if (sourcePoints.length === 0) {
        return alert('源设备没有点位配置')
    }
    
    // 复制时去掉 id 相关的字段（如果后端有的话），保持干净的映射
    dataPoints.value = sourcePoints.map(p => normalizeLoadedPoint({ ...p, id: undefined }))
    isPointsDirty.value = true
    alert(`已成功复制 ${sourcePoints.length} 个点位配置，请检查后点击保存。`)
}

// 扩展功能：同步到同产线其他设备
async function syncToLine() {
    if (isAllPointsMode.value) return alert('请先筛选到某一台设备，再同步到同产线设备。')
    if (isPointsDirty.value) {
        return alert('请先保存当前设备的点位配置，再执行同步操作！')
    }
    const currentDevice = devices.value.find(d => d.id === selectedDeviceForPoints.value)
    if (!currentDevice) return
    
    const targetDevices = devices.value.filter(d => d.line_id === currentDevice.line_id && d.id !== currentDevice.id)
    if (targetDevices.length === 0) return alert('该产线下没有其他设备。')
    
    if (!(await confirm(`确定将当前点位配置同步到同产线的 ${targetDevices.length} 台设备吗？\n（目标设备的原有配置将被覆盖）`))) return
    
    const errors = validatePointRows(dataPoints.value)
    if (errors.length) return alert(errors.slice(0, 8).join('\n'), { title: '点位配置未保存', type: 'warning' })
    const validPoints = dataPoints.value.map(buildDataPointPayload)
    
    try {
        for (const d of targetDevices) {
            const result = await adminApi.saveDataPointsBatch(d.id, validPoints)
            if (result?.error || !result?.success) {
                throw new Error(`${d.name || d.id}: ${result?.error || '后端没有返回成功状态'}`)
            }
        }
        alert('批量同步成功！现在同产线的所有设备都使用了相同的点位结构。', { title: '同步成功', type: 'success' })
    } catch (e) {
        alert(`同步过程中发生错误：${e.message || e}`, { title: '同步失败', type: 'danger' })
    }
}

// ============ 连接设置 ============
const settings = reactive({
    factory_name: '',
    data_mode: 'integrated_plc',
    realtime_stale_ms: '6000',
    display_mode: 'industrial_twin',
    // 视角模式
    camera_mode: 'auto',
    render_profile: 'balanced',
    render_target_fps: 45,
    render_scale: 1,
    render_antialias: false,
    render_label_fps: 12
})

const renderProfileOptions = RENDER_PROFILE_OPTIONS
const resolvedRenderSettings = computed(() => normalizeRenderSettings(settings))
const selectedRenderProfile = computed(() => (
    renderProfileOptions.find(item => item.value === settings.render_profile)
    || renderProfileOptions.find(item => item.value === 'balanced')
))

async function loadSettings() {
    const s = await adminApi.getSettings()
    if (s.data_mode !== 'simulation') s.data_mode = 'integrated_plc'
    Object.assign(settings, s)
    settings.render_target_fps = Number(settings.render_target_fps || 45)
    settings.render_scale = Number(settings.render_scale || 1)
    settings.render_label_fps = Number(settings.render_label_fps || 12)
    settings.render_antialias = ['1', 'true', 'yes', 'on'].includes(String(settings.render_antialias).toLowerCase())
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
    if (status.status === 'unconfigured' && device.plc_ip && !status.plc_ip) return '配置已更新'
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

function formatPlcTime(value) {
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
    return new Date(timestamp).toLocaleTimeString()
}

function formatModelName(modelType) {
    const model = availableModelOptions.value.find(item => item.id === modelType)
    return model?.name || modelType || '未设置'
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
const databaseBackupBusy = ref(false)
const databaseBackupMessage = ref('')
const databaseBackupStatus = reactive({
    supported: false,
    automatic: false,
    intervalMs: 0,
    retention: 0,
    directory: '',
    lastBackup: null,
    lastRecovery: null,
    backups: []
})
const databaseDefaultPorts = {
    mysql: 3307,
    postgres: 5432,
    sqlserver: 1433
}

async function loadDatabaseConfig() {
    try {
        const config = await adminApi.getDatabaseConfig()
        Object.assign(databaseConfig, config)
        await loadDatabaseBackups()
    } catch (e) {
        databaseTestStatus.value = '数据库配置读取失败'
    }
}

async function loadDatabaseBackups() {
    try {
        const status = await adminApi.getDatabaseBackups()
        Object.assign(databaseBackupStatus, status, { backups: status.backups || [] })
    } catch (e) {
        databaseBackupMessage.value = `备份状态读取失败：${e.message || e}`
    }
}

async function createDatabaseBackup() {
    databaseBackupBusy.value = true
    databaseBackupMessage.value = '正在创建一致性备份...'
    try {
        const result = await adminApi.createDatabaseBackup()
        Object.assign(databaseBackupStatus, result.status || {})
        databaseBackupMessage.value = `备份完成：${result.backup?.filename || ''}`
    } catch (e) {
        databaseBackupMessage.value = `备份失败：${e.message || e}`
    } finally {
        databaseBackupBusy.value = false
    }
}

async function restoreDatabaseBackup(backup) {
    if (!(await confirm(`恢复备份 ${backup.filename}？当前数据库会先自动备份，然后数据引擎将重新启动。`))) return
    databaseBackupBusy.value = true
    databaseBackupMessage.value = '正在校验并恢复备份...'
    try {
        const result = await adminApi.restoreDatabaseBackup(backup.filename)
        Object.assign(databaseBackupStatus, result.status || {})
        databaseBackupMessage.value = `已恢复：${backup.filename}`
        await Promise.all([loadSettings(), loadWorkshops(), loadLines(), loadDevices(), loadModels(), loadPlatform()])
    } catch (e) {
        databaseBackupMessage.value = `恢复失败：${e.message || e}`
    } finally {
        databaseBackupBusy.value = false
    }
}

function downloadDatabaseBackup(backup) {
    const link = document.createElement('a')
    link.href = adminApi.databaseBackupDownloadUrl(backup.filename)
    link.download = backup.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
}

function formatBackupSize(bytes) {
    const value = Number(bytes || 0)
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
    return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatBackupInterval(milliseconds) {
    const hours = Number(milliseconds || 0) / 3600000
    return hours >= 1 ? `${Number(hours.toFixed(1))} 小时` : `${Math.round(milliseconds / 60000)} 分钟`
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
    if (!(await confirm('保存数据库连接后，后端会重新初始化数据库并重启数据引擎，确定继续吗？'))) return
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
        await loadDatabaseBackups()
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
        const res = await fetch(`${API_BASE}/engine/status`)
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
    const result = await adminApi.saveSettings({
        factory_name: settings.factory_name,
        data_mode: settings.data_mode,
        realtime_stale_ms: settings.realtime_stale_ms,
        display_mode: settings.display_mode,
        camera_mode: settings.camera_mode,
        render_profile: settings.render_profile,
        render_target_fps: settings.render_target_fps,
        render_scale: settings.render_scale,
        render_antialias: settings.render_antialias,
        render_label_fps: settings.render_label_fps
    })
    if (result?.error) return alert(result.error, { title: '设置保存失败', type: 'danger' })
    if (!result?.success) return alert('设置保存失败：后端没有返回成功状态', { title: '设置保存失败', type: 'danger' })
    // 保存后自动重启数据引擎
    try {
        await fetch(`${API_BASE}/engine/restart`, { method: 'POST' })
        alert('设置已保存。数据引擎正在重启；渲染性能设置将在大屏刷新后生效。', { title: '保存成功', type: 'success' })
    } catch (e) {
        alert('设置已保存，但数据引擎重启失败，请手动重启后端服务', { title: '保存成功', type: 'warning' })
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
const defaultModelAssetSpec = {
    version: '1.0.0',
    device_family: '',
    unit: 'm',
    axis_rule: 'Y-up / Z-forward',
    max_triangles: 200000,
    max_nodes: 800,
    max_texture_size: 2048,
    lod_policy: 'LOD0 必须可用，LOD1/LOD2 可选',
    node_naming_rule: 'role_part_action，例如 fan_rear_rotate、door_front_lift、valve_gas_01',
    delivery_status: 'draft',
    owner: '',
    notes: ''
}
const modelWorkflowStepLabels = {
    imported: '导入',
    parsed: '解析',
    specified: '规范',
    bound: '绑定',
    accepted: '验收',
    released: '发布'
}

function createDefaultModelMetadata() {
    return {
        batchable: true,
        assetSpec: { ...defaultModelAssetSpec },
        partBindings: [],
        acceptance: {
            status: 'draft',
            checked_at: '',
            checks: []
        },
        release: {
            version: '0.1.0',
            status: 'draft',
            published_at: ''
        }
    }
}

function defaultModelMetadataText() {
    return JSON.stringify(createDefaultModelMetadata(), null, 2)
}

const modelImportForm = reactive({
    id: '',
    name: '',
    default_scale: 1,
    metadata: defaultModelMetadataText()
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
let modelPreviewHighlightState = null
let modelPreviewRootObject = null
let modelPreviewAnimationState = null

const modelPreviewNodes = ref([])
const modelPreviewStats = reactive({
    loaded: false,
    nodeCount: 0,
    meshCount: 0,
    triangleCount: 0,
    materialCount: 0,
    textureCount: 0,
    maxTextureSize: 0,
    bounds: { x: 0, y: 0, z: 0 }
})
const modelPartBindings = ref([])
const modelAssetSpec = reactive({ ...defaultModelAssetSpec })
const selectedModelNodePath = ref('')
const modelNodeSearchText = ref('')
const showOnlyBindableNodes = ref(true)
const selectedModelBindingIndex = ref(-1)
const previewModelBindingIndex = ref(-1)
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
const filteredModelPreviewNodes = computed(() => {
    const keyword = String(modelNodeSearchText.value || '').trim().toLowerCase()
    return modelPreviewNodes.value.filter((node) => {
        if (showOnlyBindableNodes.value && Number(node.meshCount || 0) <= 0) return false
        if (!keyword) return true
        const haystack = `${node.displayName || ''} ${node.name || ''} ${node.path || ''}`.toLowerCase()
        return haystack.includes(keyword)
    })
})
const selectedModelNodeInfo = computed(() => {
    if (!selectedModelNodePath.value) return null
    const node = modelPreviewNodes.value.find(item => item.path === selectedModelNodePath.value)
    if (!node) return null
    const target = modelPreviewNodeMap.get(node.path)
    let sizeText = ''
    if (target) {
        const box = new THREE.Box3().setFromObject(target)
        if (!box.isEmpty()) {
            const size = box.getSize(new THREE.Vector3())
            sizeText = `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`
        }
    }
    return {
        ...node,
        sizeText
    }
})
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

function resolveModelBindingTarget(binding) {
    if (!binding) return null
    if (binding.node_path && modelPreviewNodeMap.has(binding.node_path)) return modelPreviewNodeMap.get(binding.node_path)
    const nodeName = String(binding.node_name || binding.nodeName || '').trim()
    if (!nodeName) return null
    for (const target of modelPreviewNodeMap.values()) {
        if (target?.name === nodeName) return target
    }
    return null
}

function countUnresolvedModelBindings() {
    return modelPartBindings.value.filter(binding => !resolveModelBindingTarget(binding)).length
}

const activePreviewModel = computed(() => getActivePreviewModel())
const canEditModelBindings = computed(() => !!activePreviewModel.value?.file_path && !activePreviewModel.value?.is_builtin)
const modelAcceptanceChecks = computed(() => {
    const model = activePreviewModel.value
    const maxTriangles = Number(modelAssetSpec.max_triangles || defaultModelAssetSpec.max_triangles)
    const maxNodes = Number(modelAssetSpec.max_nodes || defaultModelAssetSpec.max_nodes)
    const maxTextureSize = Number(modelAssetSpec.max_texture_size || defaultModelAssetSpec.max_texture_size)
    const checks = [
        {
            id: 'uploaded_glb',
            label: '上传模型文件',
            required: true,
            passed: !!model?.file_path && !model?.is_builtin,
            detail: model?.file_path || '内置模型不能作为现场交付资产'
        },
        {
            id: 'preview_loaded',
            label: '预览可加载',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.meshCount > 0,
            detail: `${modelPreviewStats.meshCount} 个网格 / ${modelPreviewStats.nodeCount} 个节点`
        },
        {
            id: 'triangle_budget',
            label: '三角面预算',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.triangleCount <= maxTriangles,
            detail: `${formatModelNumber(modelPreviewStats.triangleCount)} / ${formatModelNumber(maxTriangles)}`
        },
        {
            id: 'node_budget',
            label: '节点数量预算',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.nodeCount <= maxNodes,
            detail: `${modelPreviewStats.nodeCount} / ${maxNodes}`
        },
        {
            id: 'texture_budget',
            label: '贴图尺寸预算',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.maxTextureSize <= maxTextureSize,
            detail: modelPreviewStats.textureCount
                ? `${modelPreviewStats.textureCount} 张贴图，最大 ${modelPreviewStats.maxTextureSize}px`
                : '未检测到贴图'
        },
        {
            id: 'binding_nodes',
            label: '绑定节点可解析',
            required: true,
            passed: countUnresolvedModelBindings() === 0,
            detail: countUnresolvedModelBindings() === 0
                ? `${modelPartBindings.value.length} 条绑定`
                : `${countUnresolvedModelBindings()} 条绑定找不到节点`
        },
        {
            id: 'binding_keys',
            label: '绑定点位字段完整',
            required: true,
            passed: modelPartBindings.value.every(binding => binding.source_group && binding.source_key),
            detail: modelPartBindings.value.length ? '字段完整' : '暂无动作绑定'
        },
        {
            id: 'interactive_parts',
            label: '存在可动部位',
            required: false,
            passed: modelPartBindings.value.length > 0,
            detail: modelPartBindings.value.length ? `${modelPartBindings.value.length} 个可动部位` : '静态模型，仅可展示'
        }
    ]
    return checks
})
const modelAcceptanceSummary = computed(() => {
    const required = modelAcceptanceChecks.value.filter(item => item.required)
    const passed = required.filter(item => item.passed)
    const warnings = modelAcceptanceChecks.value.filter(item => !item.required && !item.passed)
    return {
        passed: passed.length,
        required: required.length,
        warnings: warnings.length,
        ready: required.length > 0 && passed.length === required.length
    }
})
const canAcceptModelAsset = computed(() => !!activePreviewModel.value && canEditModelBindings.value && modelAcceptanceSummary.value.ready)
const canPublishModelAsset = computed(() => canAcceptModelAsset.value && modelAssetSpec.delivery_status === 'accepted')
const modelAssetWorkflow = computed(() => {
    const model = activePreviewModel.value
    return [
        {
            id: 'imported',
            label: modelWorkflowStepLabels.imported,
            passed: !!model?.file_path && !model?.is_builtin,
            detail: model?.file_path ? '文件已入库' : '等待上传'
        },
        {
            id: 'parsed',
            label: modelWorkflowStepLabels.parsed,
            passed: modelPreviewStats.loaded && modelPreviewStats.meshCount > 0,
            detail: modelPreviewStats.loaded ? `${modelPreviewStats.nodeCount} 节点` : '等待预览'
        },
        {
            id: 'specified',
            label: modelWorkflowStepLabels.specified,
            passed: !!modelAssetSpec.device_family && !!modelAssetSpec.node_naming_rule,
            detail: modelAssetSpec.device_family || '未设置设备类型'
        },
        {
            id: 'bound',
            label: modelWorkflowStepLabels.bound,
            passed: modelPartBindings.value.length > 0,
            optional: true,
            detail: modelPartBindings.value.length ? `${modelPartBindings.value.length} 条动作` : '可先静态交付'
        },
        {
            id: 'accepted',
            label: modelWorkflowStepLabels.accepted,
            passed: ['accepted', 'released'].includes(modelAssetSpec.delivery_status),
            detail: modelAcceptanceSummary.value.ready ? '检查通过' : `${modelAcceptanceSummary.value.passed}/${modelAcceptanceSummary.value.required}`
        },
        {
            id: 'released',
            label: modelWorkflowStepLabels.released,
            passed: modelAssetSpec.delivery_status === 'released',
            detail: modelAssetSpec.version || '未发布'
        }
    ]
})
const modelReleaseHistory = computed(() => {
    const metadata = parseModelMetadata(activePreviewModel.value)
    const history = metadata.release?.history
    return Array.isArray(history) ? [...history].reverse() : []
})

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

function formatModelNumber(value) {
    const number = Number(value) || 0
    if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`
    return String(Math.round(number))
}

function formatModelBounds(bounds) {
    if (!bounds) return '-'
    return `${Number(bounds.x || 0).toFixed(2)} x ${Number(bounds.y || 0).toFixed(2)} x ${Number(bounds.z || 0).toFixed(2)}`
}

function formatAssetStatus(status) {
    const labels = {
        draft: '草稿',
        review: '待验收',
        accepted: '验收通过',
        released: '已发布'
    }
    return labels[status] || status || '草稿'
}

function getModelAssetStatus(model) {
    const metadata = parseModelMetadata(model)
    return metadata.assetSpec?.delivery_status || metadata.acceptance?.status || metadata.release?.status || 'draft'
}

function getModelBindingCount(model) {
    const metadata = parseModelMetadata(model)
    return Array.isArray(metadata.partBindings) ? metadata.partBindings.length : 0
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

function getModelBindingPreviewLabel(binding) {
    return `${formatModelBindingAction(binding?.action)} · ${formatModelAxis(binding?.axis)} 轴`
}

function toPreviewNumber(value, fallback = 0) {
    if (typeof value === 'boolean') return value ? 1 : 0
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
}

function toPreviewBool(value) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return ['1', 'true', 'on', 'open', 'running', 'yes'].includes(value.toLowerCase())
    return !!value
}

function clampPreview01(value) {
    return Math.max(0, Math.min(1, value))
}

function mapPreviewRange(value, inMin, inMax, outMin, outMax) {
    const span = inMax - inMin
    const t = Math.abs(span) < 1e-6 ? 0 : clampPreview01((value - inMin) / span)
    return outMin + (outMax - outMin) * t
}

function normalizePreviewAxis(axis) {
    return ['x', 'y', 'z'].includes(axis) ? axis : 'y'
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
    clearModelPreviewAnimation()
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
    resetModelPreviewStats()
    if (options.revokeObjectUrl && selectedModelObjectUrl) {
        URL.revokeObjectURL(selectedModelObjectUrl)
        selectedModelObjectUrl = ''
    }
    modelPreviewNodeMap = new Map()
    modelPreviewSelectionBox = null
    modelPreviewHighlightState = null
    modelPreviewRootObject = null
    previewModelBindingIndex.value = -1
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

function resetModelPreviewStats() {
    Object.assign(modelPreviewStats, {
        loaded: false,
        nodeCount: 0,
        meshCount: 0,
        triangleCount: 0,
        materialCount: 0,
        textureCount: 0,
        maxTextureSize: 0,
        bounds: { x: 0, y: 0, z: 0 }
    })
}

function collectModelPreviewStats(root) {
    const stats = {
        loaded: !!root,
        nodeCount: 0,
        meshCount: 0,
        triangleCount: 0,
        materialCount: 0,
        textureCount: 0,
        maxTextureSize: 0,
        bounds: { x: 0, y: 0, z: 0 }
    }
    const materials = new Set()
    const textures = new Set()
    root?.traverse?.((child) => {
        stats.nodeCount += 1
        if (!child.isMesh) return
        stats.meshCount += 1
        const geometry = child.geometry
        if (geometry) {
            if (geometry.index) {
                stats.triangleCount += Math.floor(geometry.index.count / 3)
            } else if (geometry.attributes?.position) {
                stats.triangleCount += Math.floor(geometry.attributes.position.count / 3)
            }
        }
        const materialList = Array.isArray(child.material) ? child.material : [child.material]
        materialList.filter(Boolean).forEach((material) => {
            materials.add(material)
            Object.values(material).forEach((value) => {
                if (!value?.isTexture || textures.has(value)) return
                textures.add(value)
                const image = value.image
                const width = Number(image?.width || 0)
                const height = Number(image?.height || 0)
                stats.maxTextureSize = Math.max(stats.maxTextureSize, width, height)
            })
        })
    })
    const box = new THREE.Box3().setFromObject(root)
    if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3())
        stats.bounds = { x: size.x, y: size.y, z: size.z }
    }
    stats.materialCount = materials.size
    stats.textureCount = textures.size
    Object.assign(modelPreviewStats, stats)
    return stats
}

function clearModelPreviewSelectionBox() {
    if (!modelPreviewSelectionBox || !modelPreviewRuntime?.scene) return
    modelPreviewRuntime.scene.remove(modelPreviewSelectionBox)
    modelPreviewSelectionBox.geometry?.dispose?.()
    modelPreviewSelectionBox.material?.dispose?.()
    modelPreviewSelectionBox = null
}

function restoreModelPreviewHighlight() {
    if (!modelPreviewHighlightState) return
    modelPreviewHighlightState.materials.forEach((entry) => {
        const material = entry.material
        if (!material) return
        if (entry.color && material.color) material.color.copy(entry.color)
        if (entry.emissive && material.emissive) material.emissive.copy(entry.emissive)
        material.opacity = entry.opacity
        material.transparent = entry.transparent
        material.depthWrite = entry.depthWrite
        material.needsUpdate = true
    })
    modelPreviewHighlightState = null
}

function collectPreviewMeshes(object) {
    const meshes = []
    object?.traverse?.((child) => {
        if (child.isMesh) meshes.push(child)
    })
    return meshes
}

function previewMaterialEntries(root) {
    const entries = []
    const seen = new Set()
    collectPreviewMeshes(root).forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            if (seen.has(material.uuid)) return
            seen.add(material.uuid)
            entries.push({
                material,
                color: material.color?.clone?.() || null,
                emissive: material.emissive?.clone?.() || null,
                opacity: material.opacity,
                transparent: material.transparent,
                depthWrite: material.depthWrite
            })
        })
    })
    return entries
}

function applyModelPreviewHighlight(target) {
    restoreModelPreviewHighlight()
    const root = modelPreviewRootObject
    if (!root || !target) return

    const targetMeshes = new Set(collectPreviewMeshes(target))
    const entries = previewMaterialEntries(root)
    modelPreviewHighlightState = { materials: entries }
    entries.forEach((entry) => {
        const material = entry.material
        if (!material) return
        material.transparent = true
        material.opacity = 0.16
        material.depthWrite = false
        material.needsUpdate = true
    })
    targetMeshes.forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            material.transparent = false
            material.opacity = 1
            material.depthWrite = true
            if (material.color) material.color.set('#f0b000')
            if (material.emissive) material.emissive.set('#6a3b00')
            material.needsUpdate = true
        })
    })
}

function capturePreviewAnimationMaterials(target) {
    const entries = []
    const seen = new Set()
    collectPreviewMeshes(target).forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            if (seen.has(material.uuid)) return
            seen.add(material.uuid)
            entries.push({
                material,
                color: material.color?.clone?.() || null,
                emissive: material.emissive?.clone?.() || null,
                opacity: material.opacity,
                transparent: material.transparent,
                depthWrite: material.depthWrite
            })
        })
    })
    return entries
}

function restorePreviewAnimationMaterials(entries = []) {
    entries.forEach((entry) => {
        const material = entry.material
        if (!material) return
        if (entry.color && material.color) material.color.copy(entry.color)
        if (entry.emissive && material.emissive) material.emissive.copy(entry.emissive)
        material.opacity = entry.opacity
        material.transparent = entry.transparent
        material.depthWrite = entry.depthWrite
        material.needsUpdate = true
    })
}

function applyPreviewColorToTarget(target, colorValue) {
    const color = new THREE.Color(colorValue)
    collectPreviewMeshes(target).forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            if (material.color) material.color.copy(color)
            if (material.emissive) material.emissive.copy(color)
            material.needsUpdate = true
        })
    })
}

function clearModelPreviewAnimation() {
    if (!modelPreviewAnimationState) return
    const { target, basePosition, baseRotation, baseVisible, materials } = modelPreviewAnimationState
    if (target) {
        target.position.copy(basePosition)
        target.rotation.copy(baseRotation)
        target.visible = baseVisible
    }
    restorePreviewAnimationMaterials(materials)
    modelPreviewAnimationState = null
}

function startModelPreviewAnimation(binding, target) {
    clearModelPreviewAnimation()
    if (!binding || !target) return
    modelPreviewAnimationState = {
        binding: normalizeModelBinding(binding),
        target,
        axis: normalizePreviewAxis(binding.axis),
        basePosition: target.position.clone(),
        baseRotation: target.rotation.clone(),
        baseVisible: target.visible,
        materials: capturePreviewAnimationMaterials(target),
        elapsed: 0
    }
}

function updateModelPreviewAnimation(delta) {
    if (!modelPreviewAnimationState) return
    const state = modelPreviewAnimationState
    const { binding, target, axis } = state
    state.elapsed += delta
    const action = binding.action || 'rotate_speed'

    if (action === 'rotate_speed') {
        const previewRpm = Math.max(
            12,
            Math.abs(toPreviewNumber(binding.input_max, 100)) || Math.abs(toPreviewNumber(binding.output_max, 90)) || 60
        )
        const factor = Number.isFinite(Number(binding.speed_factor)) ? Number(binding.speed_factor) : (Math.PI * 2 / 60)
        target.rotation[axis] += delta * previewRpm * factor
        return
    }

    const wave = (Math.sin(state.elapsed * Math.PI * 1.15) + 1) / 2
    const inputMin = toPreviewNumber(binding.input_min, 0)
    const inputMax = toPreviewNumber(binding.input_max, 100)
    const simulatedValue = inputMin + (inputMax - inputMin) * wave

    if (action === 'rotate_angle') {
        const angleDeg = mapPreviewRange(
            simulatedValue,
            inputMin,
            inputMax,
            toPreviewNumber(binding.output_min, 0),
            toPreviewNumber(binding.output_max, 90)
        )
        target.rotation[axis] = state.baseRotation[axis] + THREE.MathUtils.degToRad(angleDeg)
        return
    }

    if (action === 'translate') {
        const offset = mapPreviewRange(
            simulatedValue,
            inputMin,
            inputMax,
            toPreviewNumber(binding.output_min, 0),
            toPreviewNumber(binding.output_max, 1)
        )
        target.position[axis] = state.basePosition[axis] + offset
        return
    }

    if (action === 'visibility') {
        const visible = Math.floor(state.elapsed / 0.75) % 2 === 0
        target.visible = binding.invert ? !visible : visible
        return
    }

    if (action === 'color') {
        const on = toPreviewBool(Math.floor(state.elapsed / 0.75) % 2)
        applyPreviewColorToTarget(target, on ? (binding.on_color || '#00ff88') : (binding.off_color || '#666666'))
    }
}

function focusPreviewCameraOnNode(target) {
    if (!target || !modelPreviewRuntime?.camera || !modelPreviewRuntime?.controls) return
    const targetBox = new THREE.Box3().setFromObject(target)
    if (targetBox.isEmpty()) return

    const rootBox = modelPreviewRootObject ? new THREE.Box3().setFromObject(modelPreviewRootObject) : targetBox
    const targetCenter = targetBox.getCenter(new THREE.Vector3())
    const targetSize = targetBox.getSize(new THREE.Vector3())
    const rootSize = rootBox.getSize(new THREE.Vector3())
    const targetDim = Math.max(targetSize.x, targetSize.y, targetSize.z, 0.08)
    const rootDim = Math.max(rootSize.x, rootSize.y, rootSize.z, targetDim)
    const distance = Math.max(targetDim * 4.2, rootDim * 0.18)

    const camera = modelPreviewRuntime.camera
    const controls = modelPreviewRuntime.controls
    const currentDirection = camera.position.clone().sub(controls.target)
    if (currentDirection.lengthSq() < 0.001) currentDirection.set(0.8, 0.55, 1)
    currentDirection.normalize()
    camera.near = Math.max(0.01, targetDim / 100)
    camera.far = Math.max(1000, rootDim * 20)
    camera.position.copy(targetCenter).add(currentDirection.multiplyScalar(distance))
    camera.lookAt(targetCenter)
    camera.updateProjectionMatrix()
    controls.target.copy(targetCenter)
    controls.update()
}

function highlightPreviewNode(path) {
    selectedModelNodePath.value = path || ''
    clearModelPreviewAnimation()
    clearModelPreviewSelectionBox()
    restoreModelPreviewHighlight()
    if (!path || !modelPreviewRuntime?.scene) return
    const target = modelPreviewNodeMap.get(path)
    if (!target) return
    if (modelPreviewRuntime.controls) modelPreviewRuntime.controls.autoRotate = false
    applyModelPreviewHighlight(target)
    modelPreviewSelectionBox = new THREE.BoxHelper(target, 0xffb000)
    modelPreviewSelectionBox.name = 'model_preview_selected_part'
    modelPreviewRuntime.scene.add(modelPreviewSelectionBox)
    focusPreviewCameraOnNode(target)
}

function findPreviewNodePathByTarget(target) {
    for (const [path, object] of modelPreviewNodeMap.entries()) {
        if (object === target) return path
    }
    return ''
}

function highlightPreviewTarget(target) {
    const path = findPreviewNodePathByTarget(target)
    selectedModelNodePath.value = path
    clearModelPreviewAnimation()
    clearModelPreviewSelectionBox()
    restoreModelPreviewHighlight()
    if (!target || !modelPreviewRuntime?.scene) return
    if (modelPreviewRuntime.controls) modelPreviewRuntime.controls.autoRotate = false
    applyModelPreviewHighlight(target)
    modelPreviewSelectionBox = new THREE.BoxHelper(target, 0xffb000)
    modelPreviewSelectionBox.name = 'model_preview_selected_part'
    modelPreviewRuntime.scene.add(modelPreviewSelectionBox)
    focusPreviewCameraOnNode(target)
}

function resetModelPreviewCamera() {
    if (!modelPreviewRuntime?.camera || !modelPreviewRuntime?.controls || !modelPreviewRootObject) return
    fitPreviewCamera(modelPreviewRuntime.camera, modelPreviewRuntime.controls, modelPreviewRootObject)
    modelPreviewRuntime.controls.autoRotate = false
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
        updateModelPreviewAnimation(delta)
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
        modelPreviewRootObject = root
        const { nodes, map } = collectModelPreviewNodes(root)
        modelPreviewNodes.value = nodes
        modelPreviewNodeMap = map
        collectModelPreviewStats(root)
        fitPreviewCamera(runtime.camera, runtime.controls, root)
        if (modelBindingForm.node_path) highlightPreviewNode(modelBindingForm.node_path)
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
        modelPreviewRootObject = deviceModel

        const { nodes, map } = collectModelPreviewNodes(deviceModel)
        modelPreviewNodes.value = nodes
        modelPreviewNodeMap = map
        collectModelPreviewStats(deviceModel)
        fitPreviewCamera(runtime.camera, runtime.controls, deviceModel)
        if (modelBindingForm.node_path) highlightPreviewNode(modelBindingForm.node_path)
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

function normalizeModelAssetSpec(spec = {}) {
    return {
        ...defaultModelAssetSpec,
        ...(spec || {}),
        max_triangles: Number(spec.max_triangles ?? defaultModelAssetSpec.max_triangles),
        max_nodes: Number(spec.max_nodes ?? defaultModelAssetSpec.max_nodes),
        max_texture_size: Number(spec.max_texture_size ?? defaultModelAssetSpec.max_texture_size)
    }
}

function loadModelAssetSpec(model) {
    const metadata = parseModelMetadata(model)
    Object.assign(modelAssetSpec, normalizeModelAssetSpec(metadata.assetSpec || metadata.asset_spec || {}))
}

function makeAcceptanceSnapshot(status = modelAssetSpec.delivery_status || 'draft') {
    return {
        status,
        checked_at: new Date().toISOString(),
        stats: {
            nodeCount: modelPreviewStats.nodeCount,
            meshCount: modelPreviewStats.meshCount,
            triangleCount: modelPreviewStats.triangleCount,
            materialCount: modelPreviewStats.materialCount,
            textureCount: modelPreviewStats.textureCount,
            maxTextureSize: modelPreviewStats.maxTextureSize,
            bounds: modelPreviewStats.bounds
        },
        checks: modelAcceptanceChecks.value.map(item => ({
            id: item.id,
            label: item.label,
            required: item.required,
            passed: item.passed,
            detail: item.detail
        }))
    }
}

function normalizeSaveOverrides(overrides = {}) {
    if (!overrides || typeof overrides !== 'object') return {}
    if (typeof overrides.preventDefault === 'function') return {}
    return overrides
}

function buildCurrentModelMetadata(model, overrides = {}) {
    overrides = normalizeSaveOverrides(overrides)
    const metadata = parseModelMetadata(model)
    const normalizedPartBindings = dedupeModelBindings(modelPartBindings.value)
    const assetSpec = normalizeModelAssetSpec({
        ...(metadata.assetSpec || {}),
        ...modelAssetSpec,
        ...(overrides.assetSpec || {})
    })
    const existingRelease = metadata.release || {}
    const release = {
        version: overrides.releaseVersion || assetSpec.version || existingRelease.version || '0.1.0',
        status: overrides.releaseStatus || assetSpec.delivery_status || existingRelease.status || 'draft',
        published_at: overrides.publishedAt || existingRelease.published_at || '',
        history: Array.isArray(existingRelease.history) ? existingRelease.history : []
    }
    return {
        ...metadata,
        schema_version: 1,
        batchable: metadata.batchable ?? true,
        assetSpec,
        partBindings: normalizedPartBindings,
        acceptance: overrides.acceptance || makeAcceptanceSnapshot(assetSpec.delivery_status),
        release,
        runtime: {
            ...(metadata.runtime || {}),
            enableGenericBindings: normalizedPartBindings.length > 0
        }
    }
}

async function persistModelMetadata(model, metadata, successMessage) {
    const result = await adminApi.updateModel(model.id, {
        name: model.name,
        tags: model.tags,
        default_scale: model.default_scale,
        metadata: JSON.stringify(metadata)
    })
    if (result.error) throw new Error(result.error)
    if (!result.success) throw new Error('后端没有返回成功状态')
    await loadModels()
    const updated = models.value.find(item => item.id === model.id) || result.model || model
    modelPreviewModel = updated
    selectedPreviewModelId.value = updated.id
    loadModelBindingState(updated)
    modelBindingStatus.value = successMessage
    return updated
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

function getModelBindingSignature(binding = {}) {
    const normalized = normalizeModelBinding(binding)
    const nodeIdentity = String(normalized.node_path || normalized.node_name || '').trim()
    const sourceIdentity = `${normalized.source_group}.${normalized.source_key}`.trim()
    if (!nodeIdentity || !normalized.source_key) return ''
    return [
        nodeIdentity,
        sourceIdentity,
        normalized.action,
        normalized.axis
    ].join('|').toLowerCase()
}

function dedupeModelBindings(bindings = []) {
    const result = []
    const indexBySignature = new Map()
    bindings.map(normalizeModelBinding).forEach((binding) => {
        const signature = getModelBindingSignature(binding)
        if (!signature) {
            result.push(binding)
            return
        }
        if (indexBySignature.has(signature)) {
            result[indexBySignature.get(signature)] = binding
            return
        }
        indexBySignature.set(signature, result.length)
        result.push(binding)
    })
    return result
}

function upsertModelBinding(binding, editingIndex = -1) {
    const signature = getModelBindingSignature(binding)
    let duplicateCount = 0
    const nextBindings = modelPartBindings.value
        .map(normalizeModelBinding)
        .filter((item, index) => {
            if (index === editingIndex) return false
            if (signature && getModelBindingSignature(item) === signature) {
                duplicateCount += 1
                return false
            }
            return true
        })
    nextBindings.push(binding)
    modelPartBindings.value = dedupeModelBindings(nextBindings)
    return duplicateCount
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
    loadModelAssetSpec(model)
    const metadata = parseModelMetadata(model)
    const rawBindings = Array.isArray(metadata.partBindings)
        ? metadata.partBindings.map(normalizeModelBinding)
        : []
    modelPartBindings.value = dedupeModelBindings(rawBindings)
    selectedModelNodePath.value = ''
    modelBindingStatus.value = model?.file_path
        ? `已读取 ${modelPartBindings.value.length} 条部位绑定${rawBindings.length !== modelPartBindings.value.length ? `，已合并 ${rawBindings.length - modelPartBindings.value.length} 条重复绑定` : ''}`
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
    previewModelBinding(index)
}

async function removeModelBinding(index) {
    const binding = modelPartBindings.value[index]
    if (!binding) return
    const bindingName = formatModelBindingPartName(binding)
    if (!(await confirm(`确定删除部位绑定「${bindingName}」？\n\n删除后会立即保存到模型资产。`, { title: '删除部位绑定', type: 'warning' }))) return

    const previousBindings = modelPartBindings.value.map(item => normalizeModelBinding(item))
    const previousPreviewIndex = previewModelBindingIndex.value
    const previousEditingIndex = selectedModelBindingIndex.value

    if (previewModelBindingIndex.value === index) {
        clearModelPreviewAnimation()
        previewModelBindingIndex.value = -1
    } else if (previewModelBindingIndex.value > index) {
        previewModelBindingIndex.value -= 1
    }
    modelPartBindings.value.splice(index, 1)
    if (selectedModelBindingIndex.value === index) resetModelBindingForm()
    else if (selectedModelBindingIndex.value > index) selectedModelBindingIndex.value -= 1
    modelBindingStatus.value = `正在删除并保存「${bindingName}」...`

    const saved = await saveModelPartBindings({
        showAlert: false,
        successMessage: `已删除部位绑定「${bindingName}」`
    })
    if (saved) {
        await alert(`部位绑定「${bindingName}」已删除并保存`, { title: '删除成功', type: 'success' })
        return
    }

    modelPartBindings.value = previousBindings
    previewModelBindingIndex.value = previousPreviewIndex
    selectedModelBindingIndex.value = previousEditingIndex
    modelBindingStatus.value = `删除失败，已恢复「${bindingName}」`
}

function previewModelBinding(index) {
    const binding = modelPartBindings.value[index]
    if (!binding) return
    const normalized = normalizeModelBinding(binding)
    const target = resolveModelBindingTarget(normalized)
    previewModelBindingIndex.value = index

    if (!target) {
        clearModelPreviewAnimation()
        modelBindingStatus.value = `无法预览「${formatModelBindingPartName(normalized)}」：模型节点未解析到，请检查节点路径或节点名称`
        return
    }

    highlightPreviewTarget(target)
    startModelPreviewAnimation(normalized, target)
    modelBindingStatus.value = `正在预览「${formatModelBindingPartName(normalized)}」：${getModelBindingPreviewLabel(normalized)}`
}

function saveModelBindingDraft() {
    if (!modelBindingForm.node_path) return alert('请先选择模型部位节点')
    if (!modelBindingForm.source_key) return alert('请填写点位字段，例如 rear_fan_rpm / front_door_open / valve_1_flow')

    const binding = normalizeModelBinding({
        ...modelBindingForm,
        id: modelBindingForm.id || `binding_${Date.now()}`
    })
    const duplicateCount = upsertModelBinding(binding, selectedModelBindingIndex.value)
    modelBindingStatus.value = duplicateCount
        ? `绑定已更新，并合并 ${duplicateCount} 条重复项，保存后生效`
        : (selectedModelBindingIndex.value >= 0 ? '绑定已更新，保存后生效' : '绑定已加入，保存后生效')
    resetModelBindingForm()
}

async function saveModelPartBindings(options = {}) {
    const model = activePreviewModel.value
    const showAlert = options.showAlert !== false
    if (!model?.id || !canEditModelBindings.value) return false

    modelBindingSaving.value = true
    modelBindingStatus.value = '正在保存部位绑定...'
    try {
        modelPartBindings.value = dedupeModelBindings(modelPartBindings.value)
        const metadata = buildCurrentModelMetadata(model)
        const successMessage = options.successMessage || `已保存 ${modelPartBindings.value.length} 条部位绑定`
        await persistModelMetadata(model, metadata, successMessage)
        if (showAlert) await alert(successMessage, { title: '保存成功', type: 'success' })
        return true
    } catch (e) {
        const message = `保存失败：${e.message || e}`
        modelBindingStatus.value = message
        if (showAlert) await alert(message, { title: '保存失败', type: 'danger' })
        return false
    } finally {
        modelBindingSaving.value = false
    }
}

async function saveModelAssetSpec(overrides = {}) {
    overrides = normalizeSaveOverrides(overrides)
    const model = activePreviewModel.value
    if (!model?.id || !canEditModelBindings.value) return

    modelBindingSaving.value = true
    modelBindingStatus.value = '正在保存模型资产规范...'
    try {
        const metadata = buildCurrentModelMetadata(model, overrides)
        await persistModelMetadata(model, metadata, overrides.successMessage || '模型资产规范已保存')
    } catch (e) {
        modelBindingStatus.value = `保存失败：${e.message || e}`
    } finally {
        modelBindingSaving.value = false
    }
}

async function submitModelAssetReview() {
    modelAssetSpec.delivery_status = 'review'
    await saveModelAssetSpec({
        assetSpec: { delivery_status: 'review' },
        releaseStatus: 'review',
        successMessage: '模型已提交待验收'
    })
}

async function markModelAssetAccepted() {
    if (!canAcceptModelAsset.value) return
    modelAssetSpec.delivery_status = 'accepted'
    await saveModelAssetSpec({
        assetSpec: {
            delivery_status: 'accepted'
        },
        acceptance: makeAcceptanceSnapshot('accepted'),
        releaseStatus: 'accepted',
        successMessage: '模型已标记为验收通过'
    })
}

async function publishModelAsset() {
    if (!canPublishModelAsset.value) return
    const model = activePreviewModel.value
    if (!model?.id) return

    const now = new Date().toISOString()
    modelAssetSpec.delivery_status = 'released'
    modelBindingSaving.value = true
    modelBindingStatus.value = '正在发布模型资产...'
    try {
        const metadata = buildCurrentModelMetadata(model, {
            assetSpec: { delivery_status: 'released' },
            acceptance: makeAcceptanceSnapshot('released'),
            releaseStatus: 'released',
            releaseVersion: modelAssetSpec.version || '1.0.0',
            publishedAt: now
        })
        const releaseRecord = {
            id: `release_${Date.now()}`,
            version: metadata.release.version,
            status: 'released',
            published_at: now,
            stats: metadata.acceptance?.stats || {},
            snapshot: {
                schema_version: metadata.schema_version,
                assetSpec: metadata.assetSpec,
                partBindings: metadata.partBindings,
                acceptance: metadata.acceptance,
                runtime: metadata.runtime
            }
        }
        metadata.release.history = [...(metadata.release.history || []), releaseRecord]
        await persistModelMetadata(model, metadata, `模型已发布：${metadata.release.version}`)
    } catch (e) {
        modelBindingStatus.value = `发布失败：${e.message || e}`
    } finally {
        modelBindingSaving.value = false
    }
}

async function restoreModelRelease(record) {
    const model = activePreviewModel.value
    if (!model?.id || !record?.snapshot) return

    const now = new Date().toISOString()
    modelBindingSaving.value = true
    modelBindingStatus.value = '正在恢复发布版本...'
    try {
        const current = parseModelMetadata(model)
        const history = Array.isArray(current.release?.history) ? current.release.history : []
        const snapshot = record.snapshot
        const restoredBindings = Array.isArray(snapshot.partBindings)
            ? snapshot.partBindings.map(binding => normalizeModelBinding(binding))
            : []
        const restoredSpec = normalizeModelAssetSpec({
            ...(snapshot.assetSpec || {}),
            delivery_status: 'released'
        })
        const metadata = {
            ...current,
            schema_version: snapshot.schema_version || 1,
            assetSpec: restoredSpec,
            partBindings: restoredBindings,
            acceptance: snapshot.acceptance || makeAcceptanceSnapshot('released'),
            runtime: {
                ...(current.runtime || {}),
                ...(snapshot.runtime || {}),
                enableGenericBindings: restoredBindings.length > 0
            },
            release: {
                ...(current.release || {}),
                version: record.version || restoredSpec.version || current.release?.version || '1.0.0',
                status: 'released',
                published_at: now,
                history: [
                    ...history,
                    {
                        id: `rollback_${Date.now()}`,
                        version: record.version || restoredSpec.version || '1.0.0',
                        status: 'rollback',
                        restored_from: record.id,
                        published_at: now,
                        stats: snapshot.acceptance?.stats || {},
                        snapshot
                    }
                ]
            }
        }
        Object.assign(modelAssetSpec, restoredSpec)
        modelPartBindings.value = restoredBindings
        await persistModelMetadata(model, metadata, `已恢复发布版本：${metadata.release.version}`)
    } catch (e) {
        modelBindingStatus.value = `恢复失败：${e.message || e}`
    } finally {
        modelBindingSaving.value = false
    }
}

function resetModelImportForm(file) {
    const modelId = makeModelIdFromFileName(file.name)
    modelImportForm.id = modelId
    modelImportForm.name = file.name.replace(/\.[^.]+$/, '')
    modelImportForm.default_scale = 1
    const metadata = createDefaultModelMetadata()
    metadata.assetSpec.device_family = modelImportForm.name
    Object.assign(modelAssetSpec, metadata.assetSpec)
    modelImportForm.metadata = JSON.stringify(metadata, null, 2)
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
    Object.assign(modelAssetSpec, { ...defaultModelAssetSpec })
    resetModelBindingForm()
    modelImportForm.id = ''
    modelImportForm.name = ''
    modelImportForm.default_scale = 1
    modelImportForm.metadata = defaultModelMetadataText()
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
        const result = await adminApi.uploadModel(fd)
        if (result?.error) return alert(result.error, { title: '上传模型失败', type: 'danger' })
        if (!result?.success) return alert('上传模型失败：后端没有返回成功状态', { title: '上传模型失败', type: 'danger' })
        await loadModels()
        const uploadedName = modelImportForm.name
        clearSelectedModelFile()
        modelPreviewStatus.value = `已上传：${uploadedName}`
        await alert(`模型「${uploadedName}」已上传`, { title: '上传成功', type: 'success' })
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
    const target = models.value.find(model => model.id === id) || { id }
    const targetName = target.name || target.id
    if (!(await confirm(`确定删除模型「${targetName}」？\n\n如果已有设备正在使用此模型，系统会拒绝删除。`))) return

    try {
        const result = await adminApi.deleteModel(id)
        if (result?.error) throw new Error(result.error)

        if (selectedPreviewModelId.value === id) {
            selectedPreviewModelId.value = ''
            modelPreviewModel = null
            modelPartBindings.value = []
            Object.assign(modelAssetSpec, { ...defaultModelAssetSpec })
            resetModelBindingForm()
            disposeModelPreview({ revokeObjectUrl: true })
        }

        await loadModels()
        modelPreviewStatus.value = result?.fileDeleted
            ? `已删除模型和文件：${targetName}`
            : `已删除模型记录：${targetName}`
        modelBindingStatus.value = modelPreviewStatus.value
        await alert(modelPreviewStatus.value, { title: '删除成功', type: 'success' })
    } catch (e) {
        const message = `删除失败：${e.message || e}`
        modelPreviewStatus.value = message
        modelBindingStatus.value = message
        alert(message)
    }
}

// ============ 现场编排器 ============
const platform = ref({ scenes: [], widgets: [], activeScene: null, activeProject: null })
const selectedWidgetPreviewId = ref(storedAdminUiState.selectedWidgetPreviewId || '')
const widgetPreviewHover = reactive({
    visible: false,
    id: '',
    x: 0,
    y: 0
})
const widgetTypeOptions = [
    { value: 'navigation', label: '导航' },
    { value: 'metrics', label: '指标' },
    { value: 'trend', label: '趋势' },
    { value: 'alarm_list', label: '报警列表' },
    { value: 'marquee', label: '跑马灯' },
    { value: 'text', label: '文本' },
    { value: 'device_label', label: '设备浮标配置' },
    { value: 'diagnostics', label: '诊断面板配置' },
    { value: 'line_overview_cards', label: '产线设备卡片配置' }
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

function safeParseJsonText(value, fallback = {}) {
    try {
        return parseJsonText(value || '{}')
    } catch (e) {
        return fallback
    }
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
        marquee: { speed: 30, limit: 20, eventWindowHours: 24 },
        text: { text: '现场提示 {value}', tone: 'normal' },
        device_label: DEFAULT_DEVICE_LABEL_CONFIG,
        diagnostics: DEFAULT_DIAGNOSTIC_CONFIG,
        line_overview_cards: DEFAULT_LINE_OVERVIEW_CONFIG
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
        text: { path: 'metrics.current_output' },
        device_label: {},
        diagnostics: {},
        line_overview_cards: {}
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

const widgetPreviewMetrics = reactive({
    current_output: 128,
    daily_target: 200,
    progress_percent: 64,
    overall_oee: 82.4,
    energy_consumption: 3260,
    online_devices: 9,
    total_devices: 10,
    running_devices: 7,
    alarm_devices: 1
})
const widgetPreviewDeviceData = reactive({
    furnace_id: 'Furnace_01',
    name: '1# 多用炉',
    analog: {
        actual_temp: 836,
        setpoint_temp: 880,
        actual_carbon: 0.88,
        setpoint_carbon: 0.9
    },
    motors: {
        rear_fan: true,
        front_fan: true,
        rear_fan_speed: 960,
        front_fan_speed: 720,
        oil_stir_1: true,
        oil_stir_2: true,
        oil_stir_3: false,
        oil_stir_4: true,
        oil_stir_1_speed: 520,
        oil_stir_2_speed: 536,
        oil_stir_3_speed: 0,
        oil_stir_4_speed: 580
    },
    doors: {
        front_door_open: true,
        middle_door_open: false
    },
    status: {
        running: true,
        alarm: false
    },
    gas: {
        valve_1_on: true,
        valve_1_flow: 12.5,
        valve_2_on: false,
        valve_2_flow: 0,
        valve_3_on: true,
        valve_3_flow: 8.2
    },
    quality: {
        analog: { actual_temp: 'good', setpoint_temp: 'good', actual_carbon: 'good', setpoint_carbon: 'good' },
        motors: { rear_fan: 'good', front_fan: 'good' },
        doors: { front_door_open: 'good', middle_door_open: 'good' },
        status: { running: 'good', alarm: 'good' }
    }
})
const widgetPreviewEvents = ref([
    { id: 'preview_alarm_1', time: '09:42:18', title: '2# 多用炉前门未到位', level: 'warning' },
    { id: 'preview_alarm_2', time: '09:38:06', title: '油槽搅拌转速偏低', level: 'critical' },
    { id: 'preview_alarm_3', time: '09:30:11', title: '后室温度进入保温段', level: 'info' }
])
const widgetPreviewTrendPoints = ref([
    { time: '09:00', value: 760 },
    { time: '09:05', value: 782 },
    { time: '09:10', value: 801 },
    { time: '09:15', value: 816 },
    { time: '09:20', value: 806 },
    { time: '09:25', value: 823 }
])
const previewableWidgetTypes = new Set(['metrics', 'trend', 'alarm_list', 'marquee', 'text'])
const standalonePreviewWidgetTypes = new Set(['diagnostics', 'device_label', 'line_overview_cards'])
const widgetTypeLabelMap = computed(() => Object.fromEntries(widgetTypeOptions.map(item => [item.value, item.label])))
const widgetPreviewGrid = computed(() => ({
    columns: Number(platform.value.activeScene?.layout?.grid?.columns || 24),
    rows: Number(platform.value.activeScene?.layout?.grid?.rows || 12)
}))
const livePreviewWidgets = computed(() => {
    const widgets = Array.isArray(platform.value.widgets) ? platform.value.widgets : []
    return widgets
        .map(widget => ({
            ...widget,
            visible: widget.visible !== 0 && widget.visible !== false,
            config: {
                ...getWidgetDefaultConfig(widget.widget_type),
                ...safeParseJsonText(widget.configText, {})
            },
            binding: {
                ...getWidgetDefaultBinding(widget.widget_type),
                ...safeParseJsonText(widget.bindingText, {})
            }
        }))
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
})
const dashboardPreviewWidgets = computed(() => livePreviewWidgets.value.filter(widget => !standalonePreviewWidgetTypes.has(widget.widget_type)))
const visiblePreviewWidgets = computed(() => livePreviewWidgets.value.filter(widget => widget.visible))
const selectedPreviewWidget = computed(() => livePreviewWidgets.value.find(widget => widget.id === selectedWidgetPreviewId.value) || visiblePreviewWidgets.value[0] || livePreviewWidgets.value[0] || null)
const hoveredPreviewWidget = computed(() => livePreviewWidgets.value.find(widget => widget.id === widgetPreviewHover.id) || null)
const widgetPreviewPopoverStyle = computed(() => ({
    left: `${widgetPreviewHover.x}px`,
    top: `${widgetPreviewHover.y}px`
}))
const widgetPreviewDiagnosticGroups = computed(() => {
    const config = hoveredPreviewWidget.value?.widget_type === 'diagnostics'
        ? hoveredPreviewWidget.value.config
        : DEFAULT_DIAGNOSTIC_CONFIG
    return buildDiagnosticGroups(widgetPreviewDeviceData, config).slice(0, 4)
})

function getAdminWidgetGridStyle(widget) {
    const columns = widgetPreviewGrid.value.columns || 24
    const rows = widgetPreviewGrid.value.rows || 12
    const x = Number.isFinite(Number(widget.x)) ? Number(widget.x) : 0
    const y = Number.isFinite(Number(widget.y)) ? Number(widget.y) : 0
    const w = Number.isFinite(Number(widget.w)) ? Number(widget.w) : 4
    const h = Number.isFinite(Number(widget.h)) ? Number(widget.h) : 2
    return {
        left: `${Math.max(0, Math.min(columns, x)) / columns * 100}%`,
        top: `${Math.max(0, Math.min(rows, y)) / rows * 100}%`,
        width: `${Math.max(1, Math.min(columns, w)) / columns * 100}%`,
        height: `${Math.max(1, Math.min(rows, h)) / rows * 100}%`
    }
}

function selectWidgetPreview(widget) {
    selectedWidgetPreviewId.value = widget?.id || ''
}

function moveWidgetPreviewPopover(event) {
    if (shouldSuppressWidgetPreview(event)) {
        hideWidgetPreview()
        return
    }
    const width = 560
    const height = 420
    const margin = 16
    const viewportWidth = window.innerWidth || 1280
    const viewportHeight = window.innerHeight || 720
    const nextX = event.clientX + 18 + width > viewportWidth
        ? event.clientX - width - 18
        : event.clientX + 18
    let nextY = event.clientY - height - 18
    if (nextY < margin) nextY = margin
    if (nextY + height > viewportHeight - margin) nextY = viewportHeight - height - margin
    widgetPreviewHover.x = Math.max(margin, nextX)
    widgetPreviewHover.y = Math.max(margin, nextY)
}

function showWidgetPreview(widget, event) {
    if (shouldSuppressWidgetPreview(event)) {
        hideWidgetPreview()
        return
    }
    widgetPreviewHover.visible = true
    widgetPreviewHover.id = widget?.id || ''
    moveWidgetPreviewPopover(event)
}

function hideWidgetPreview() {
    widgetPreviewHover.visible = false
    widgetPreviewHover.id = ''
}

function shouldSuppressWidgetPreview(event) {
    return !!event?.target?.closest?.('.widget-action-cell')
}

function isDashboardGridPreview(widget) {
    return !!widget && !standalonePreviewWidgetTypes.has(widget.widget_type)
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value))
}

function getWidgetFocusCanvasStyle(widget) {
    const columns = widgetPreviewGrid.value.columns || 24
    const rows = widgetPreviewGrid.value.rows || 12
    const x = Number.isFinite(Number(widget?.x)) ? Number(widget.x) : 0
    const y = Number.isFinite(Number(widget?.y)) ? Number(widget.y) : 0
    const w = Math.max(1, Number.isFinite(Number(widget?.w)) ? Number(widget.w) : 4)
    const h = Math.max(1, Number.isFinite(Number(widget?.h)) ? Number(widget.h) : 2)
    const centerX = clampNumber((x + w / 2) / columns, 0, 1)
    const centerY = clampNumber((y + h / 2) / rows, 0, 1)
    const scale = clampNumber(Math.min((columns * 0.58) / w, (rows * 0.58) / h), 1.1, 2.2)
    const translateX = 50 - centerX * 100 * scale
    const translateY = 50 - centerY * 100 * scale
    return {
        transform: `translate(${translateX}%, ${translateY}%) scale(${scale})`
    }
}

function getWidgetPreviewModeLabel(widget) {
    if (!widget) return ''
    if (widget.widget_type === 'diagnostics') return '设备详情态：点击设备后出现'
    if (widget.widget_type === 'device_label') return '3D 设备浮标态'
    if (widget.widget_type === 'line_overview_cards') return '产线视角态'
    return '大屏总览网格态'
}

function formatPreviewTemplate(template, data = {}) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, key) => data[key] ?? '')
}

function getDeviceLabelPreviewConfig(widget) {
    return normalizeDeviceLabelConfig(widget?.config || DEFAULT_DEVICE_LABEL_CONFIG)
}

function getDeviceLabelPreviewTitle(widget) {
    const config = getDeviceLabelPreviewConfig(widget)
    if (config.showTitle === false) return ''
    return formatPreviewTemplate(config.titleTemplate || '{name}', { name: '1# 多用炉', id: 'Furnace_01' }) || '1# 多用炉'
}

function getDeviceLabelPreviewStyle(widget) {
    const style = getDeviceLabelPreviewConfig(widget).style || {}
    return {
        minWidth: style.minWidth,
        padding: style.padding,
        fontSize: style.fontSize,
        background: style.background,
        borderColor: style.borderColor,
        '--device-label-title-color': style.titleColor,
        '--device-label-text-color': style.textColor,
        '--device-label-value-color': style.valueColor
    }
}

function getWidgetPlacementText(widget) {
    if (!widget) return ''
    return `位置 ${widget.x ?? 0},${widget.y ?? 0} / 尺寸 ${widget.w ?? 1}x${widget.h ?? 1}`
}

function getWidgetPreviewDescription(widget) {
    if (!widget) return '未选择组件'
    if (previewableWidgetTypes.has(widget.widget_type)) return '该组件会显示在大屏总览网格中'
    if (widget.widget_type === 'navigation') return '导航组件在大屏左侧显示层级结构'
    if (widget.widget_type === 'device_label') return '设备浮标配置影响 3D 模型上方铭牌，不属于面板网格'
    if (widget.widget_type === 'diagnostics') return '诊断面板在点击设备后出现，不属于总览画面'
    if (widget.widget_type === 'line_overview_cards') return '产线设备卡片在产线视角出现，不属于工厂总览面板'
    return '当前组件暂无专用预览'
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
    if (!selectedWidgetPreviewId.value || !platform.value.widgets.some(widget => widget.id === selectedWidgetPreviewId.value)) {
        selectedWidgetPreviewId.value = platform.value.widgets[0]?.id || ''
    }
}

async function saveActiveScene() {
    const scene = platform.value.activeScene
    if (!scene) return
    const result = await adminApi.updateScene(scene.id, {
        name: scene.name,
        scene_type: scene.scene_type,
        layout: scene.layout,
        camera: scene.camera,
        theme: scene.theme,
        is_active: true,
        sort_order: scene.sort_order
    })
    if (result?.error) return alert(result.error, { title: '场景保存失败', type: 'danger' })
    if (!result?.success) return alert('场景保存失败：后端没有返回成功状态', { title: '场景保存失败', type: 'danger' })
    await alert('场景配置已保存', { title: '保存成功', type: 'success' })
    await loadPlatform()
}

async function saveWidget(widget) {
    if (!widget) return alert('没有选中可保存的组件', { title: '保存组件失败', type: 'danger' })
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

function saveSelectedPreviewWidget() {
    const widget = platform.value.widgets.find(item => item.id === selectedPreviewWidget.value?.id)
    return saveWidget(widget)
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
    if (result?.error) return alert(result.error, { title: '新增组件失败', type: 'danger' })
    if (!result?.success) return alert('新增组件失败：后端没有返回成功状态', { title: '新增组件失败', type: 'danger' })
    newWidget.id = `widget_text_${Date.now()}`
    await loadPlatform()
    await alert('组件已新增', { title: '新增成功', type: 'success' })
}

async function deleteWidget(id) {
    if (!(await confirm(`确定删除组件 ${id}？`))) return
    const result = await adminApi.deleteWidget(id)
    if (result?.error) return alert(result.error, { title: '删除组件失败', type: 'danger' })
    if (!result?.success) return alert('删除组件失败：后端没有返回成功状态', { title: '删除组件失败', type: 'danger' })
    await loadPlatform()
    await alert(`组件「${id}」已删除`, { title: '删除成功', type: 'success' })
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
const composerRotationPresets = [0, 90, 180, 270]
const composerRotationNudges = [-5, -1, 1, 5]
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
const composerRotationDegrees = computed(() => formatComposerRotationDegrees(composerDraft.rotation_y))

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
    if (isComposerTransferCart(composerDraft.id)) {
        snapComposerTransferCartToRail({
            x: numberOrDefault(composerDraft.pos_x, 0) + dx,
            y: composerDraft.pos_y,
            z: numberOrDefault(composerDraft.pos_z, 0) + dz
        })
        return
    }
    composerDraft.pos_x = numberOrDefault(composerDraft.pos_x, 0) + dx
    composerDraft.pos_z = numberOrDefault(composerDraft.pos_z, 0) + dz
}

function radiansToDegrees(value) {
    const degrees = numberOrDefault(value, 0) * 180 / Math.PI
    const normalized = ((degrees % 360) + 360) % 360
    return Math.abs(normalized - 360) < 0.0001 ? 0 : normalized
}

function degreesToRadians(value) {
    return normalizeComposerAngle(numberOrDefault(value, 0) * Math.PI / 180)
}

function formatComposerRotationDegrees(value) {
    const degrees = radiansToDegrees(value)
    return Number.isInteger(Number(degrees.toFixed(1)))
        ? `${Math.round(degrees)}°`
        : `${degrees.toFixed(1)}°`
}

function setComposerRotationDegrees(degrees) {
    composerDraft.rotation_y = degreesToRadians(degrees)
}

function nudgeComposerRotationDegrees(delta) {
    setComposerRotationDegrees(radiansToDegrees(composerDraft.rotation_y) + delta)
}

function isComposerTransferCart(deviceId) {
    const device = composerPreviewDevices.value.find(item => item.id === deviceId)
    const config = parseInstanceConfig(device?.instance_config)
    return device?.model_type === 'transfer_cart' || config.role === 'transfer_cart'
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

    if (isComposerTransferCart(deviceId)) {
        snapComposerTransferCartToRail(position)
        return
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
    if (!(await confirm(`确定调转 ${lineName} 的整体朝向吗？这会镜像位置、旋转设备并反转排序。`))) return

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
        const results = await Promise.all(sortedDevices.map((device, index) => {
            const nextDevice = normalizeDeviceConfig(device)
            nextDevice[mirrorAxis] = roundComposerNumber((mirrorCenter * 2) - numberOrDefault(nextDevice[mirrorAxis], 0))
            nextDevice.rotation_y = normalizeComposerAngle(numberOrDefault(nextDevice.rotation_y, 0) + Math.PI)
            nextDevice.sort_order = sortOrders[sortOrders.length - 1 - index] ?? nextDevice.sort_order
            return adminApi.updateDevice(nextDevice.id, nextDevice)
        }))
        const failed = results.find(result => result?.error || !result?.success)
        if (failed) {
            return alert(failed.error || '产线调转失败：后端没有返回成功状态', { title: '产线调转失败', type: 'danger' })
        }
        await loadDevices()
        composerPreviewMode.value = 'line'
        composerPreviewStatus.value = `${lineName} 已完成整体反向`
        await alert(`${lineName} 已完成整体反向`, { title: '调转成功', type: 'success' })
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
    if (isComposerTransferCart(composerDraft.id)) {
        if (!composerRailOptions.value.length) return alert('请先在产线管理中为当前车间添加小车导轨')
        if (!parseInstanceConfig(composerDraft.instance_config).railId) {
            snapComposerTransferCartToRail({ x: composerDraft.pos_x, y: composerDraft.pos_y, z: composerDraft.pos_z })
        }
    }
    const parsedInstanceConfig = {
        ...getDeviceDefaultInstanceConfig(composerDraft),
        ...parseInstanceConfig(composerDraft.instance_config)
    }
    composerSaving.value = true
    try {
        const payload = buildDevicePayloadForSave(
            { ...composerDraft, instance_config: parsedInstanceConfig },
            getDeviceWorkshopId(composerDraft) || selectedComposerWorkshop.value?.id || workshops.value[0]?.id || ''
        )
        const result = await adminApi.updateDevice(composerDraft.id, payload)
        if (result?.error) return alert(result.error, { title: '设备布局保存失败', type: 'danger' })
        if (!result?.success) return alert('设备布局保存失败：后端没有返回成功状态', { title: '设备布局保存失败', type: 'danger' })
        await loadDevices()
        if (payload.line_id) selectedComposerLineId.value = payload.line_id
        selectedComposerDeviceId.value = composerDraft.id
        await alert('设备布局已保存', { title: '保存成功', type: 'success' })
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
    if (tab === 'point-monitor') {
        startPointMonitor()
    } else {
        stopPointMonitor()
    }
    if (tab === 'points' && dataPoints.value.length === 0) {
        loadDataPoints()
    }
})

watch(selectedDeviceForMonitor, () => {
    if (activeTab.value === 'point-monitor') startPointMonitor()
})

watch(pointMonitorAutoRefresh, () => {
    if (activeTab.value === 'point-monitor') startPointMonitor()
})

watch([
    activeTab,
    isAdminNavCollapsed,
    selectedDeviceForPoints,
    showPointAdvancedFields,
    selectedDeviceForMonitor,
    pointMonitorAutoRefresh,
    selectedLineEditorId,
    selectedWidgetPreviewId,
    isLinePlannerEditorCollapsed,
    isLineDevicePoolCollapsed,
    () => lineDevicePoolDock.x,
    () => lineDevicePoolDock.y
], () => {
    localStorage.setItem(ADMIN_UI_STATE_KEY, JSON.stringify({
        activeTab: activeTab.value,
        isAdminNavCollapsed: isAdminNavCollapsed.value,
        selectedDeviceForPoints: selectedDeviceForPoints.value,
        showPointAdvancedFields: showPointAdvancedFields.value,
        selectedDeviceForMonitor: selectedDeviceForMonitor.value,
        pointMonitorAutoRefresh: pointMonitorAutoRefresh.value,
        selectedLineEditorId: selectedLineEditorId.value,
        selectedWidgetPreviewId: selectedWidgetPreviewId.value,
        isLinePlannerEditorCollapsed: isLinePlannerEditorCollapsed.value,
        isLineDevicePoolCollapsed: isLineDevicePoolCollapsed.value,
        lineDevicePoolDockX: lineDevicePoolDock.x,
        lineDevicePoolDockY: lineDevicePoolDock.y
    }))
})

// ============ 生命周期 ============
onMounted(async () => {
    await loadWorkshops()
    await Promise.all([loadLines(), loadDevices(), loadSettings(), loadModels(), loadPlatform()])
    if (!newLine.workshop_id && workshops.value.length > 0) {
        newLine.workshop_id = workshops.value[0].id
    }
    selectedDeviceForMonitor.value ||= 'all'
    selectedDeviceForPoints.value ||= 'all'
    if (selectedDeviceForMonitor.value !== 'all' && !devices.value.some(device => device.id === selectedDeviceForMonitor.value)) {
        selectedDeviceForMonitor.value = 'all'
    }
    if (selectedDeviceForPoints.value !== 'all' && !devices.value.some(device => device.id === selectedDeviceForPoints.value)) {
        selectedDeviceForPoints.value = 'all'
    }
    if (activeTab.value === 'points') await loadDataPoints()
    ensureComposerSelection()
    syncComposerDraftFromSelection()
    await nextTick()
    scheduleComposerPreview()
})

onUnmounted(() => {
    finishLinePreviewDrag()
    cancelLineDeviceDrag()
    cancelLineDevicePoolMove()
    stopPointMonitor()
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

const selectedLineEditor = computed(() => {
    return lines.value.find(line => line.id === selectedLineEditorId.value) || lines.value[0] || null
})

const selectedLineLayout = computed(() => {
    return selectedLineEditor.value ? getLineLayout(selectedLineEditor.value) : defaultLineLayout()
})

const selectedLineEditorWorkshopName = computed(() => {
    const line = selectedLineEditor.value
    return workshops.value.find(workshop => workshop.id === line?.workshop_id)?.name || line?.workshop_id || ''
})

const selectedLineEditorDevices = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return []
    return sortByOrder(devices.value.filter(device => {
        if (isAuxiliaryDeviceConfig(device)) return false
        return resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'lane'
    }))
})

const selectedLineTotalDeviceCount = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return 0
    return (lineMemberDevicesByLine.value[line.id] || []).length
})

const selectedLineEditorCarts = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return []
    return sortByOrder(devices.value.filter(device => {
        if (!isAuxiliaryDeviceConfig(device)) return false
        return resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'rail'
    }))
})

const selectedLineWorkshopDevices = computed(() => {
    const line = selectedLineEditor.value
    if (!line?.workshop_id) return []
    return sortByOrder(devices.value.filter(device => getDeviceWorkshopId(device) === line.workshop_id))
})

const selectedLineDevicePool = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return []
    return sortByOrder(devices.value.filter(device => {
        if (isAuxiliaryDeviceConfig(device)) {
            if (getDeviceWorkshopId(device) !== line.workshop_id) return false
            const config = parseInstanceConfig(device.instance_config)
            if (config.railLineId && config.railLineId !== line.id) return false
            return resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type !== 'rail'
        }
        return device.line_id === line.id
            && resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type !== 'lane'
    }))
})

function getLineLayout(line) {
    if (!line) return defaultLineLayout()
    if (line.layout && typeof line.layout === 'object' && Array.isArray(line.layout.lanes) && Array.isArray(line.layout.rails)) {
        return line.layout
    }
    const layout = normalizeLineLayout(line.layout || line.layout_json)
    line.layout = layout
    line.layout_json = JSON.stringify(layout)
    return layout
}

function syncLineLayout(line, layout) {
    if (!line) return
    const normalized = normalizeLineLayout(layout)
    line.layout = normalized
    line.layout_json = JSON.stringify(normalized)
}

function touchLineLayout(line) {
    if (!line) return
    line.layout_json = JSON.stringify(normalizeLineLayout(line.layout), null, 2)
}

function selectLineEditor(lineId) {
    selectedLineEditorId.value = lineId
}

function toggleLinePlannerEditor() {
    isLinePlannerEditorCollapsed.value = !isLinePlannerEditorCollapsed.value
}

function toggleLineDevicePool() {
    isLineDevicePoolCollapsed.value = !isLineDevicePoolCollapsed.value
}

function setSelectedLineFlowDirection(direction) {
    const line = selectedLineEditor.value
    if (!line) return
    const layout = getLineLayout(line)
    layout.flowDirection = ['right', 'left', 'none'].includes(direction) ? direction : 'right'
    touchLineLayout(line)
}

function lineFlowDirectionClass() {
    return `direction-${selectedLineLayout.value.flowDirection || 'right'}`
}

function lineDevicePoolDockStyle() {
    return {
        left: `${lineDevicePoolDock.x}px`,
        bottom: `${lineDevicePoolDock.y}px`
    }
}

function clampLineDevicePoolDock(x, y, state) {
    const padding = 12
    const maxX = Math.max(padding, state.hostWidth - state.dockWidth - padding)
    const maxY = Math.max(padding, state.hostHeight - state.dockHeight - padding)
    return {
        x: Math.min(maxX, Math.max(padding, x)),
        y: Math.min(maxY, Math.max(padding, y))
    }
}

function startLineDevicePoolMove(event) {
    if (event.button !== 0) return
    if (event.target.closest?.('.line-device-pool-chip, .line-device-pool-close')) return
    const dock = event.currentTarget.closest?.('.line-device-pool-dock')
    const host = event.currentTarget.closest?.('.line-planner-preview')
    if (!dock || !host) return
    event.stopPropagation()

    const dockRect = dock.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    lineDevicePoolMoveState = {
        startX: event.clientX,
        startY: event.clientY,
        startDockX: lineDevicePoolDock.x,
        startDockY: lineDevicePoolDock.y,
        dockWidth: dockRect.width,
        dockHeight: dockRect.height,
        hostWidth: hostRect.width,
        hostHeight: hostRect.height
    }
    lineDevicePoolDock.moving = true
    lineDevicePoolDock.moved = false
    document.body.classList.add('line-preview-dragging')
    window.addEventListener('pointermove', handleLineDevicePoolMove)
    window.addEventListener('pointerup', finishLineDevicePoolMove, { once: true })
}

function handleLineDevicePoolMove(event) {
    const state = lineDevicePoolMoveState
    if (!state) return
    const deltaX = event.clientX - state.startX
    const deltaY = event.clientY - state.startY
    const next = clampLineDevicePoolDock(
        state.startDockX + deltaX,
        state.startDockY - deltaY,
        state
    )
    lineDevicePoolDock.x = Math.round(next.x)
    lineDevicePoolDock.y = Math.round(next.y)
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        lineDevicePoolDock.moved = true
    }
}

function finishLineDevicePoolMove() {
    lineDevicePoolMoveState = null
    lineDevicePoolDock.moving = false
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDevicePoolMove)
    window.setTimeout(() => {
        lineDevicePoolDock.moved = false
    }, 0)
}

function cancelLineDevicePoolMove() {
    lineDevicePoolMoveState = null
    lineDevicePoolDock.moving = false
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDevicePoolMove)
}

function handleLineDevicePoolTabClick() {
    if (lineDevicePoolDock.moved) {
        lineDevicePoolDock.moved = false
        return
    }
    toggleLineDevicePool()
}

function addLineLayoutItem(type) {
    const line = selectedLineEditor.value
    if (!line) return
    const layout = getLineLayout(line)
    const collection = type === 'rail' ? layout.rails : layout.lanes
    const item = makeLineLayoutItem(type, collection.length)
    const usedOffsets = [...layout.lanes, ...layout.rails].map(entry => numberOrDefault(entry.offsetZ, 0))
    let nextOffset = item.offsetZ
    while (usedOffsets.some(offset => Math.abs(offset - nextOffset) < 2.5)) {
        nextOffset += 6
    }
    item.offsetZ = nextOffset
    const lengthSource = collection[collection.length - 1] || layout.lanes[0] || layout.rails[0]
    item.length = numberOrDefault(lengthSource?.length, 60)
    collection.push(item)
    collection.forEach((item, index) => { item.sort_order = index })
    touchLineLayout(line)
}

function removeLineLayoutItem(type, itemId) {
    const line = selectedLineEditor.value
    if (!line) return
    const layout = getLineLayout(line)
    const key = type === 'rail' ? 'rails' : 'lanes'
    if (key === 'lanes' && layout.lanes.length <= 1) {
        alert('至少保留一条设备线')
        return
    }
    layout[key] = layout[key].filter(item => item.id !== itemId)
    layout[key].forEach((item, index) => { item.sort_order = index })
    syncLineLayout(line, layout)
}

async function saveSelectedLineLayout() {
    const line = selectedLineEditor.value
    if (!line) return
    lineLayoutSaving.value = true
    try {
        const layout = normalizeLineLayout(getLineLayout(line))
        line.layout = layout
        line.layout_json = JSON.stringify(layout, null, 2)
        const boundDeviceIds = syncLineBoundDevicesToLayout(line)
        const result = await adminApi.updateLine(line.id, {
            name: line.name,
            workshop_id: line.workshop_id,
            sort_order: line.sort_order,
            layout,
            layout_json: line.layout_json
        })
        if (result?.error) return alert(result.error, { title: '保存产线结构失败', type: 'danger' })
        const deviceResult = await saveLineBoundDevices(boundDeviceIds, line)
        if (deviceResult?.error) {
            await loadDevices()
            return alert(`${deviceResult.device?.name || deviceResult.device?.id || '设备'} 保存失败：${deviceResult.error}`, { title: '设备位置保存失败', type: 'danger' })
        }
        await loadLines()
        await loadDevices()
        return alert(deviceResult?.saved ? `产线结构已保存，${deviceResult.saved} 台设备位置已同步` : '产线结构已保存', { type: 'success' })
    } finally {
        lineLayoutSaving.value = false
    }
}

function getLineBaseZ(lineId) {
    const lineIndex = sortByOrder(lines.value).findIndex(line => line.id === lineId)
    return lineIndex >= 0 ? -lineIndex * 16 : 0
}

function resolveDeviceLayoutTarget(device, line = selectedLineEditor.value, options = {}) {
    if (!device || !line) return null
    const layout = getLineLayout(line)
    const config = parseInstanceConfig(device.instance_config)
    const allowFallback = options.allowFallback !== false

    if (isAuxiliaryDeviceConfig(device)) {
        if (config.railLineId === line.id && config.railId) {
            const rail = layout.rails.find(item => item.id === config.railId)
            if (rail) return { type: 'rail', item: rail, explicit: true }
        }
        if (allowFallback && (config.railLineId === line.id || device.line_id === line.id) && layout.rails.length) {
            const baseZ = getLineBaseZ(line.id)
            const relativeZ = numberOrDefault(device.pos_z, baseZ) - baseZ
            const rail = [...layout.rails]
                .sort((a, b) => Math.abs(numberOrDefault(a.offsetZ, 0) - relativeZ) - Math.abs(numberOrDefault(b.offsetZ, 0) - relativeZ))[0]
            if (rail) return { type: 'rail', item: rail, explicit: false }
        }
        return null
    }

    if (config.laneLineId === line.id && config.laneId) {
        const lane = layout.lanes.find(item => item.id === config.laneId)
        if (lane) return { type: 'lane', item: lane, explicit: true }
    }

    if (allowFallback && device.line_id === line.id && layout.lanes.length) {
        const baseZ = getLineBaseZ(line.id)
        const relativeZ = numberOrDefault(device.pos_z, baseZ) - baseZ
        const lane = [...layout.lanes]
            .sort((a, b) => Math.abs(numberOrDefault(a.offsetZ, 0) - relativeZ) - Math.abs(numberOrDefault(b.offsetZ, 0) - relativeZ))[0]
        if (lane) return { type: 'lane', item: lane, explicit: false }
    }

    return null
}

function getDevicesBoundToLayoutItem(type, itemId, line = selectedLineEditor.value, sourceDevices = devices.value) {
    if (!line || !itemId) return []
    return sourceDevices.filter(device => {
        const target = resolveDeviceLayoutTarget(device, line, { allowFallback: false })
        return target?.type === type && target.item?.id === itemId
    })
}

function buildDeviceLayoutBindingPatch(device, type, item, line) {
    const config = {
        ...parseInstanceConfig(device.instance_config)
    }
    const halfLength = Math.max(1, numberOrDefault(item.length, 60) / 2)
    const nextX = roundLineLayoutValue(Math.min(halfLength, Math.max(-halfLength, numberOrDefault(device.pos_x, 0))), 0.5)
    const nextZ = roundLineLayoutValue(getLineBaseZ(line.id) + numberOrDefault(item.offsetZ, 0), 0.5)

    if (type === 'rail') {
        config.role = device.model_type === 'transfer_cart' ? 'transfer_cart' : (config.role || 'auxiliary')
        config.workshop_id = line.workshop_id
        config.railLineId = line.id
        config.railId = item.id
        config.railName = item.name
        delete config.laneLineId
        delete config.laneId
        delete config.laneName
    } else {
        config.laneLineId = line.id
        config.laneId = item.id
        config.laneName = item.name
        delete config.railLineId
        delete config.railId
        delete config.railName
        delete config.workshop_id
        delete config.workshopId
        if (config.role === 'auxiliary' || config.role === 'transfer_cart') delete config.role
    }

    return {
        line_id: line.id,
        pos_x: nextX,
        pos_z: nextZ,
        instance_config: JSON.stringify(config, null, 2)
    }
}

function patchBoundDevicesForLayoutItem(type, itemId, item, line = selectedLineEditor.value, deviceIds = null) {
    if (!line || !item) return []
    const boundIds = new Set(deviceIds || getDevicesBoundToLayoutItem(type, itemId, line).map(device => device.id))
    if (!boundIds.size) return []
    devices.value = devices.value.map(device => {
        if (!boundIds.has(device.id)) return device
        return {
            ...device,
            ...buildDeviceLayoutBindingPatch(device, type, item, line)
        }
    })
    return [...boundIds]
}

function syncLineBoundDevicesToLayout(line = selectedLineEditor.value) {
    if (!line) return []
    const layout = getLineLayout(line)
    const sourceDevices = [...devices.value]
    const patches = new Map()

    layout.lanes.forEach(lane => {
        getDevicesBoundToLayoutItem('lane', lane.id, line, sourceDevices).forEach(device => {
            patches.set(device.id, buildDeviceLayoutBindingPatch(device, 'lane', lane, line))
        })
    })

    layout.rails.forEach(rail => {
        getDevicesBoundToLayoutItem('rail', rail.id, line, sourceDevices).forEach(device => {
            patches.set(device.id, buildDeviceLayoutBindingPatch(device, 'rail', rail, line))
        })
    })

    if (!patches.size) return []
    devices.value = devices.value.map(device => patches.has(device.id) ? { ...device, ...patches.get(device.id) } : device)
    return [...patches.keys()]
}

async function saveLineBoundDevices(deviceIds, line = selectedLineEditor.value) {
    const ids = [...new Set(deviceIds || [])]
    if (!ids.length) return { success: true, saved: 0 }

    try {
        for (const deviceId of ids) {
            const device = getLineDeviceById(deviceId)
            if (!device) continue
            lineDeviceSavingId.value = device.id
            const payload = buildDevicePayloadForSave(device, getDeviceWorkshopId(device) || line?.workshop_id)
            const result = await adminApi.updateDevice(device.id, payload)
            if (result?.error) return { error: result.error, device }
        }
        return { success: true, saved: ids.length }
    } finally {
        lineDeviceSavingId.value = ''
    }
}

function getDeviceRelativeZOnLine(device, line = selectedLineEditor.value) {
    const target = resolveDeviceLayoutTarget(device, line, { allowFallback: true })
    if (target) return numberOrDefault(target.item.offsetZ, 0)
    return numberOrDefault(device.pos_z, 0) - getLineBaseZ(line?.id)
}

function linePreviewBounds(line) {
    const layout = getLineLayout(line)
    const baseZ = getLineBaseZ(line?.id)
    const lineDevices = line?.id === selectedLineEditor.value?.id
        ? selectedLineEditorDevices.value
        : devices.value.filter(device => !isAuxiliaryDeviceConfig(device) && resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'lane')
    const carts = line?.id === selectedLineEditor.value?.id
        ? selectedLineEditorCarts.value
        : devices.value.filter(device => isAuxiliaryDeviceConfig(device) && resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'rail')
    const allX = [...lineDevices, ...carts].map(device => Number(device.pos_x)).filter(Number.isFinite)
    const allZ = [
        0,
        ...layout.lanes.map(item => Number(item.offsetZ)),
        ...layout.rails.map(item => Number(item.offsetZ)),
        ...lineDevices.map(device => getDeviceRelativeZOnLine(device, line)),
        ...carts.map(device => getDeviceRelativeZOnLine(device, line))
    ].filter(Number.isFinite)
    const maxHalfLength = Math.max(24, ...[...layout.lanes, ...layout.rails].map(item => numberOrDefault(item.length, 60) / 2), ...allX.map(Math.abs)) + 6
    const minZ = Math.min(-8, ...allZ) - 4
    const maxZ = Math.max(8, ...allZ) + 4
    return { minX: -maxHalfLength, maxX: maxHalfLength, minZ, maxZ, baseZ }
}

function linePreviewPercent(value, min, max) {
    if (max === min) return 50
    return Math.min(96, Math.max(4, ((value - min) / (max - min)) * 100))
}

function linePreviewItemStyle(item, line = selectedLineEditor.value) {
    const bounds = linePreviewBounds(line)
    const length = Math.max(1, numberOrDefault(item.length, 60))
    const left = linePreviewPercent(-length / 2, bounds.minX, bounds.maxX)
    const right = linePreviewPercent(length / 2, bounds.minX, bounds.maxX)
    const top = linePreviewPercent(numberOrDefault(item.offsetZ, 0), bounds.minZ, bounds.maxZ)
    return {
        left: `${left}%`,
        width: `${Math.max(8, right - left)}%`,
        top: `${top}%`
    }
}

function linePreviewDeviceStyle(device, line = selectedLineEditor.value) {
    const bounds = linePreviewBounds(line)
    return {
        left: `${linePreviewPercent(numberOrDefault(device.pos_x, 0), bounds.minX, bounds.maxX)}%`,
        top: `${linePreviewPercent(getDeviceRelativeZOnLine(device, line), bounds.minZ, bounds.maxZ)}%`
    }
}

function roundLineLayoutValue(value, step = 0.5) {
    const next = Number(value)
    if (!Number.isFinite(next)) return 0
    return Number((Math.round(next / step) * step).toFixed(2))
}

function findLineLayoutItem(type, itemId) {
    const layout = selectedLineLayout.value
    const collection = type === 'rail' ? layout.rails : layout.lanes
    return collection.find(item => item.id === itemId) || null
}

function previewClientYToZ(clientY, state) {
    const percent = (clientY - state.rect.top) / Math.max(1, state.rect.height)
    return state.bounds.minZ + percent * (state.bounds.maxZ - state.bounds.minZ)
}

function previewDeltaXToUnits(clientX, state) {
    const deltaPx = clientX - state.startX
    return deltaPx / Math.max(1, state.rect.width) * (state.bounds.maxX - state.bounds.minX)
}

function previewClientXToUnits(clientX, state) {
    const percent = (clientX - state.rect.left) / Math.max(1, state.rect.width)
    return state.bounds.minX + percent * (state.bounds.maxX - state.bounds.minX)
}

function startLinePreviewDrag(type, itemId, mode, event) {
    if (!selectedLineEditor.value || event.button !== 0) return
    const item = findLineLayoutItem(type, itemId)
    const stage = event.currentTarget.closest?.('.line-preview-stage')
    if (!item || !stage) return
    event.preventDefault()
    event.stopPropagation()

    linePreviewDragState = {
        type,
        itemId,
        mode,
        rect: stage.getBoundingClientRect(),
        bounds: linePreviewBounds(selectedLineEditor.value),
        startX: event.clientX,
        startY: event.clientY,
        startOffsetZ: numberOrDefault(item.offsetZ, 0),
        startLength: Math.max(1, numberOrDefault(item.length, 60)),
        boundDeviceIds: getDevicesBoundToLayoutItem(type, itemId, selectedLineEditor.value).map(device => device.id)
    }
    document.body.classList.add('line-preview-dragging')
    window.addEventListener('pointermove', handleLinePreviewDrag)
    window.addEventListener('pointerup', finishLinePreviewDrag, { once: true })
}

function handleLinePreviewDrag(event) {
    const state = linePreviewDragState
    if (!state || !selectedLineEditor.value) return
    const item = findLineLayoutItem(state.type, state.itemId)
    if (!item) return

    if (state.mode === 'move') {
        item.offsetZ = roundLineLayoutValue(previewClientYToZ(event.clientY, state), 0.5)
    } else {
        const deltaUnits = previewDeltaXToUnits(event.clientX, state)
        const signedDelta = state.mode === 'resize-left' ? -deltaUnits : deltaUnits
        item.length = Math.max(4, roundLineLayoutValue(state.startLength + signedDelta * 2, 0.5))
    }
    patchBoundDevicesForLayoutItem(state.type, state.itemId, item, selectedLineEditor.value, state.boundDeviceIds)
    touchLineLayout(selectedLineEditor.value)
}

function finishLinePreviewDrag() {
    if (selectedLineEditor.value) touchLineLayout(selectedLineEditor.value)
    linePreviewDragState = null
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLinePreviewDrag)
}

function resetLineDeviceDrag() {
    Object.assign(lineDeviceDrag, {
        active: false,
        deviceId: '',
        x: 0,
        z: 0,
        left: 0,
        top: 0,
        targetType: '',
        targetId: '',
        targetName: '',
        alignActive: false,
        alignX: 0,
        alignLeft: 0,
        canDrop: false,
        message: ''
    })
}

function getLineDeviceById(deviceId) {
    return devices.value.find(device => device.id === deviceId) || null
}

function getLineDropTargets(device) {
    const layout = selectedLineLayout.value
    return isAuxiliaryDeviceConfig(device)
        ? layout.rails.map(item => ({ type: 'rail', item }))
        : layout.lanes.map(item => ({ type: 'lane', item }))
}

function findNearestLineDropTarget(device, z) {
    const targets = getLineDropTargets(device)
    if (!targets.length) return null
    return targets
        .map(target => ({
            ...target,
            distance: Math.abs(numberOrDefault(target.item.offsetZ, 0) - z)
        }))
        .sort((a, b) => a.distance - b.distance)[0]
}

function findLineDropTargetFromPoint(device, event) {
    const element = document.elementFromPoint(event.clientX, event.clientY)
    const targetElement = element?.closest?.('[data-line-target-type][data-line-target-id]')
    if (!targetElement) return null
    const type = targetElement.dataset.lineTargetType
    const itemId = targetElement.dataset.lineTargetId
    const item = findLineLayoutItem(type, itemId)
    if (!item) return null
    if (isAuxiliaryDeviceConfig(device) && type !== 'rail') return null
    if (!isAuxiliaryDeviceConfig(device) && type !== 'lane') return null
    return { type, item }
}

function linePreviewItemClass(type, item) {
    const isTarget = lineDeviceDrag.active
        && lineDeviceDrag.targetType === type
        && lineDeviceDrag.targetId === item.id
    const device = getLineDeviceById(lineDeviceDrag.deviceId)
    const compatible = device
        ? (isAuxiliaryDeviceConfig(device) ? type === 'rail' : type === 'lane')
        : false
    return {
        'drop-compatible': lineDeviceDrag.active && compatible,
        'drop-target': isTarget
    }
}

function lineDeviceDragGhostStyle() {
    return {
        left: `${lineDeviceDrag.left}%`,
        top: `${lineDeviceDrag.top}%`
    }
}

function lineAlignmentGuideStyle() {
    return {
        left: `${lineDeviceDrag.alignLeft}%`
    }
}

function findLineDeviceAlignment(deviceId, x, bounds) {
    const candidates = [...selectedLineEditorDevices.value, ...selectedLineEditorCarts.value]
        .filter(device => device.id !== deviceId)
        .map(device => numberOrDefault(device.pos_x, 0))
        .filter(Number.isFinite)
    if (!candidates.length) return null

    const snapDistance = Math.max(0.8, (bounds.maxX - bounds.minX) * 0.012)
    const nearest = candidates
        .map(value => ({ value, distance: Math.abs(value - x) }))
        .sort((a, b) => a.distance - b.distance)[0]
    if (!nearest || nearest.distance > snapDistance) return null
    return {
        x: nearest.value,
        left: linePreviewPercent(nearest.value, bounds.minX, bounds.maxX)
    }
}

function startLineDeviceDrag(deviceId, event) {
    if (!selectedLineEditor.value || event.button !== 0) return
    const device = getLineDeviceById(deviceId)
    const stage = linePreviewStageRef.value || event.currentTarget.closest?.('.line-preview-stage')
    if (!device || !stage) return
    event.preventDefault()
    event.stopPropagation()

    const rect = stage.getBoundingClientRect()
    const bounds = linePreviewBounds(selectedLineEditor.value)
    try {
        event.currentTarget?.setPointerCapture?.(event.pointerId)
    } catch (e) {
        // 浏览器可能在按钮快速拖出时拒绝捕获，忽略即可。
    }
    lineDeviceDragState = { deviceId, rect, bounds, pointerTarget: event.currentTarget, pointerId: event.pointerId }
    Object.assign(lineDeviceDrag, {
        active: true,
        deviceId,
        x: numberOrDefault(device.pos_x, 0),
        z: numberOrDefault(device.pos_z, 0) - bounds.baseZ,
        left: linePreviewPercent(numberOrDefault(device.pos_x, 0), bounds.minX, bounds.maxX),
        top: linePreviewPercent(numberOrDefault(device.pos_z, 0) - bounds.baseZ, bounds.minZ, bounds.maxZ),
        targetType: '',
        targetId: '',
        targetName: '',
        alignActive: false,
        alignX: 0,
        alignLeft: 0,
        canDrop: false,
        message: ''
    })
    document.body.classList.add('line-preview-dragging')
    window.addEventListener('pointermove', handleLineDeviceDrag)
    window.addEventListener('pointerup', finishLineDeviceDrag, { once: true })
    handleLineDeviceDrag(event)
}

function handleLineDeviceDrag(event) {
    const state = lineDeviceDragState
    if (!state || !selectedLineEditor.value) return
    const device = getLineDeviceById(state.deviceId)
    if (!device) return
    const insideStage = event.clientX >= state.rect.left
        && event.clientX <= state.rect.right
        && event.clientY >= state.rect.top
        && event.clientY <= state.rect.bottom
    let x = previewClientXToUnits(event.clientX, state)
    const z = previewClientYToZ(event.clientY, state)
    const elementTarget = findLineDropTargetFromPoint(device, event)
    const target = elementTarget || (insideStage ? findNearestLineDropTarget(device, z) : null)
    const targetZ = target ? numberOrDefault(target.item.offsetZ, 0) : z
    const alignment = insideStage ? findLineDeviceAlignment(state.deviceId, x, state.bounds) : null
    if (alignment) x = alignment.x

    lineDeviceDrag.x = x
    lineDeviceDrag.z = targetZ
    lineDeviceDrag.left = linePreviewPercent(x, state.bounds.minX, state.bounds.maxX)
    lineDeviceDrag.top = linePreviewPercent(targetZ, state.bounds.minZ, state.bounds.maxZ)
    lineDeviceDrag.targetType = target?.type || ''
    lineDeviceDrag.targetId = target?.item?.id || ''
    lineDeviceDrag.targetName = target?.item?.name || ''
    lineDeviceDrag.alignActive = !!alignment
    lineDeviceDrag.alignX = alignment?.x || 0
    lineDeviceDrag.alignLeft = alignment?.left || 0
    lineDeviceDrag.canDrop = !!target
    lineDeviceDrag.message = target
        ? `放到 ${target.item.name}`
        : insideStage
            ? (isAuxiliaryDeviceConfig(device) ? '当前产线没有小车导轨' : '当前产线没有设备线')
            : '拖回预览区域后松手'
}

async function finishLineDeviceDrag(event) {
    if (lineDeviceDragState && event) {
        handleLineDeviceDrag(event)
    }
    const drag = { ...lineDeviceDrag }
    try {
        lineDeviceDragState?.pointerTarget?.releasePointerCapture?.(lineDeviceDragState.pointerId)
    } catch (e) {
        // 指针可能已被浏览器释放，忽略即可。
    }
    lineDeviceDragState = null
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDeviceDrag)
    resetLineDeviceDrag()
    if (!drag.active || !drag.canDrop) {
        if (drag.active && drag.message) alert(drag.message, { type: 'warning' })
        return
    }
    await placeLineDeviceOnTarget(drag)
}

function cancelLineDeviceDrag() {
    try {
        lineDeviceDragState?.pointerTarget?.releasePointerCapture?.(lineDeviceDragState.pointerId)
    } catch (e) {
        // 指针可能已被浏览器释放，忽略即可。
    }
    lineDeviceDragState = null
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDeviceDrag)
    resetLineDeviceDrag()
}

function patchDeviceLocally(deviceId, patch) {
    devices.value = devices.value.map(device => device.id === deviceId ? { ...device, ...patch } : device)
}

async function placeLineDeviceOnTarget(drag) {
    const line = selectedLineEditor.value
    const device = getLineDeviceById(drag.deviceId)
    if (!line || !device) return
    const target = findLineLayoutItem(drag.targetType, drag.targetId)
    if (!target) return alert('目标线不存在，可能已经被删除', { type: 'warning' })

    const halfLength = Math.max(1, numberOrDefault(target.length, 60) / 2)
    const nextX = roundLineLayoutValue(Math.min(halfLength, Math.max(-halfLength, drag.x)), 0.5)
    const nextZ = roundLineLayoutValue(getLineBaseZ(line.id) + numberOrDefault(target.offsetZ, 0), 0.5)
    const config = {
        ...parseInstanceConfig(device.instance_config)
    }

    if (drag.targetType === 'rail') {
        config.role = device.model_type === 'transfer_cart' ? 'transfer_cart' : (config.role || 'auxiliary')
        config.workshop_id = line.workshop_id
        config.railLineId = line.id
        config.railId = target.id
        config.railName = target.name
        delete config.laneLineId
        delete config.laneId
        delete config.laneName
    } else {
        config.laneLineId = line.id
        config.laneId = target.id
        config.laneName = target.name
        delete config.railLineId
        delete config.railId
        delete config.railName
    }

    const patch = {
        line_id: line.id,
        pos_x: nextX,
        pos_z: nextZ,
        instance_config: JSON.stringify(config, null, 2)
    }
    patchDeviceLocally(device.id, patch)
    lineDeviceSavingId.value = device.id
    try {
        const payload = buildDevicePayloadForSave({ ...device, ...patch, instance_config: config }, line.workshop_id)
        const result = await adminApi.updateDevice(device.id, payload)
        if (result?.error) {
            await loadDevices()
            return alert(result.error, { title: '设备归位失败', type: 'danger' })
        }
        await loadDevices()
    } finally {
        lineDeviceSavingId.value = ''
    }
}

async function removeDeviceFromLineCanvas(device) {
    const line = selectedLineEditor.value
    if (!line || !device) return
    const config = {
        ...parseInstanceConfig(device.instance_config)
    }

    if (isAuxiliaryDeviceConfig(device)) {
        config.workshop_id = config.workshop_id || getDeviceWorkshopId(device) || line.workshop_id
        delete config.railLineId
        delete config.railId
        delete config.railName
    } else {
        delete config.laneLineId
        delete config.laneId
        delete config.laneName
    }

    const patch = {
        line_id: isAuxiliaryDeviceConfig(device) ? (device.line_id || null) : line.id,
        instance_config: JSON.stringify(config, null, 2)
    }
    patchDeviceLocally(device.id, patch)
    lineDeviceSavingId.value = device.id
    try {
        const payload = buildDevicePayloadForSave({ ...device, ...patch, instance_config: config }, line.workshop_id)
        const result = await adminApi.updateDevice(device.id, payload)
        if (result?.error) {
            await loadDevices()
            return alert(result.error, { title: '移出画布失败', type: 'danger' })
        }
        await loadDevices()
    } finally {
        lineDeviceSavingId.value = ''
    }
}

function getWorkshopRailOptions(workshopId) {
    return sortByOrder(lines.value)
        .filter(line => line.workshop_id === workshopId)
        .flatMap(line => getLineLayout(line).rails.map(rail => ({
            ...rail,
            lineId: line.id,
            lineName: line.name,
            workshopId: line.workshop_id,
            worldZ: getLineBaseZ(line.id) + numberOrDefault(rail.offsetZ, 0)
        })))
}

const composerRailOptions = computed(() => {
    const workshopId = selectedComposerWorkshop.value?.id || getDeviceWorkshopId(composerDraft)
    return workshopId ? getWorkshopRailOptions(workshopId) : []
})

function updateComposerDraftInstanceConfig(patch) {
    const config = {
        ...getDeviceDefaultInstanceConfig(composerDraft),
        ...parseInstanceConfig(composerDraft.instance_config),
        ...patch
    }
    if (config.mirrorX === false) delete config.mirrorX
    composerDraft.instance_config = JSON.stringify(config, null, 2)
}

const composerDraftMirrorX = computed({
    get: () => !!parseInstanceConfig(composerDraft.instance_config).mirrorX,
    set: (value) => updateComposerDraftInstanceConfig({ mirrorX: !!value })
})

function toggleComposerMirrorX() {
    composerDraftMirrorX.value = !composerDraftMirrorX.value
}

function railOptionKey(rail) {
    return `${rail.lineId}::${rail.id}`
}

function findRailOptionByKey(key) {
    return composerRailOptions.value.find(rail => railOptionKey(rail) === key) || null
}

function applyRailBindingToComposerDraft(rail) {
    if (!rail) return
    const halfLength = numberOrDefault(rail.length, 60) / 2
    const nextX = Math.min(halfLength, Math.max(-halfLength, numberOrDefault(composerDraft.pos_x, 0)))
    composerDraft.pos_x = roundComposerNumber(nextX, 2)
    composerDraft.pos_z = roundComposerNumber(rail.worldZ, 2)
    composerDraft.line_id = rail.lineId
    updateComposerDraftInstanceConfig({
        role: 'transfer_cart',
        workshop_id: rail.workshopId,
        railLineId: rail.lineId,
        railId: rail.id,
        railName: rail.name
    })
}

const composerDraftRailKey = computed({
    get: () => {
        const config = parseInstanceConfig(composerDraft.instance_config)
        if (!config.railLineId || !config.railId) return ''
        return `${config.railLineId}::${config.railId}`
    },
    set: (value) => {
        const rail = findRailOptionByKey(value)
        if (rail) applyRailBindingToComposerDraft(rail)
    }
})

function findNearestComposerRail(position) {
    if (!composerRailOptions.value.length) return null
    const config = parseInstanceConfig(composerDraft.instance_config)
    const selectedRail = config.railLineId && config.railId
        ? findRailOptionByKey(`${config.railLineId}::${config.railId}`)
        : null
    if (selectedRail) return selectedRail
    const z = numberOrDefault(position?.z, numberOrDefault(composerDraft.pos_z, 0))
    return [...composerRailOptions.value].sort((a, b) => Math.abs(a.worldZ - z) - Math.abs(b.worldZ - z))[0] || null
}

function snapComposerTransferCartToRail(position = {}) {
    const config = parseInstanceConfig(composerDraft.instance_config)
    if (composerDraft.model_type !== 'transfer_cart' && config.role !== 'transfer_cart') return
    const rail = findNearestComposerRail(position)
    if (!rail) return
    const halfLength = numberOrDefault(rail.length, 60) / 2
    const x = numberOrDefault(position.x, numberOrDefault(composerDraft.pos_x, 0))
    composerDraft.pos_x = roundComposerNumber(Math.min(halfLength, Math.max(-halfLength, x)), 2)
    composerDraft.pos_y = roundComposerNumber(position.y ?? composerDraft.pos_y, 2)
    composerDraft.pos_z = roundComposerNumber(rail.worldZ, 2)
    if (composerDraft.line_id !== rail.lineId) composerDraft.line_id = rail.lineId
    updateComposerDraftInstanceConfig({
        role: 'transfer_cart',
        workshop_id: rail.workshopId,
        railLineId: rail.lineId,
        railId: rail.id,
        railName: rail.name
    })
}

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
const dataTabs = [
    { key: 'points', label: '点位映射', icon: 'points' },
    { key: 'point-monitor', label: '点位监视', icon: 'points' }
]
const dataTabKeys = dataTabs.map(tab => tab.key)
const mainTabs = [
    { key: 'composer', label: '现场编排器', icon: 'composer' },
    { key: 'models', label: '模型库', icon: 'models' },
    { key: 'platform', label: '组件配置', icon: 'platform' },
    { key: 'settings', label: '系统设置', icon: 'settings' }
]
</script>

<template>
    <div class="admin-container" :class="{ 'nav-collapsed': isAdminNavCollapsed, 'composer-active': activeTab === 'composer', 'line-planner-active': activeTab === 'lines' }">
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
                <div class="nav-group" :class="{ active: dataTabKeys.includes(activeTab), open: isDataMenuOpen }">
                    <button
                        type="button"
                        class="nav-item nav-group-toggle"
                        :class="{ active: dataTabKeys.includes(activeTab) }"
                        title="数据采集"
                        @click="isDataMenuOpen = !isDataMenuOpen"
                    >
                        <span class="nav-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <path v-for="(path, index) in navIconPaths.data" :key="index" :d="path" />
                            </svg>
                        </span>
                        <span class="nav-label">数据采集</span>
                        <span class="nav-chevron">{{ isDataMenuOpen ? '⌃' : '⌄' }}</span>
                    </button>
                    <div v-show="isDataMenuOpen || isAdminNavCollapsed" class="nav-submenu">
                        <button
                            v-for="tab in dataTabs"
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
                            <div class="composer-rotation-control">
                                <div class="composer-control-header">
                                    <span>朝向</span>
                                    <strong>{{ composerRotationDegrees }}</strong>
                                </div>
                                <div class="composer-rotation-presets">
                                    <button
                                        v-for="degrees in composerRotationPresets"
                                        :key="degrees"
                                        type="button"
                                        class="btn btn-sm"
                                        :class="{ active: composerRotationDegrees === `${degrees}°` }"
                                        @click="setComposerRotationDegrees(degrees)"
                                    >{{ degrees }}°</button>
                                </div>
                                <div class="composer-rotation-nudges">
                                    <button
                                        v-for="delta in composerRotationNudges"
                                        :key="delta"
                                        type="button"
                                        class="btn btn-sm"
                                        @click="nudgeComposerRotationDegrees(delta)"
                                    >{{ delta > 0 ? `+${delta}°` : `${delta}°` }}</button>
                                </div>
                            </div>
                            <div class="composer-mirror-control">
                                <div>
                                    <strong>左右镜像</strong>
                                    <span>同型号设备左右相反时使用，只影响当前实例</span>
                                </div>
                                <button
                                    type="button"
                                    class="btn btn-sm"
                                    :class="{ active: composerDraftMirrorX }"
                                    @click="toggleComposerMirrorX"
                                >
                                    {{ composerDraftMirrorX ? '已镜像' : '未镜像' }}
                                </button>
                            </div>
                            <label v-if="isComposerTransferCart(composerDraft.id)">小车导轨
                                <select v-model="composerDraftRailKey" class="input">
                                    <option value="" disabled>选择小车导轨</option>
                                    <option v-for="rail in composerRailOptions" :key="railOptionKey(rail)" :value="railOptionKey(rail)">
                                        {{ rail.lineName }} / {{ rail.name }}
                                    </option>
                                </select>
                            </label>
                            <div class="composer-grid-2">
                                <label>缩放<input v-model.number="composerDraft.scale" type="number" step="0.05" min="0.1" class="input" /></label>
                                <label>排序<input v-model.number="composerDraft.sort_order" type="number" class="input" /></label>
                            </div>
                            <div class="nudge-pad">
                                <button class="btn" @click="nudgeComposerDevice(0, -2)">上移</button>
                                <button class="btn" @click="nudgeComposerDevice(-2, 0)">左移</button>
                                <button class="btn" @click="nudgeComposerDevice(2, 0)">右移</button>
                                <button class="btn" @click="nudgeComposerDevice(0, 2)">下移</button>
                            </div>
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
                <div v-if="activeTab === 'lines'" class="tab-content line-planner-tab">
                    <div class="line-planner-shell">
                        <div class="line-planner-header">
                            <div>
                                <h2>产线结构管理</h2>
                                <p class="desc">先定义设备线和小车导轨，再到现场编排器里摆放设备实例。</p>
                            </div>
                            <button class="btn btn-primary" @click="saveSelectedLineLayout" :disabled="lineLayoutSaving || !selectedLineEditor">
                                {{ lineLayoutSaving ? '保存中...' : '保存产线结构' }}
                            </button>
                        </div>

                        <div class="line-planner-steps">
                            <span class="active">1 选择产线</span>
                            <span>2 定义设备线 / 导轨</span>
                            <span>3 保存后进入现场编排</span>
                        </div>

                        <div class="line-planner-layout" :class="{ 'editor-collapsed': isLinePlannerEditorCollapsed }">
                            <section class="line-planner-editor">
                                <div class="line-editor-panel">
                                    <div class="line-panel-title">
                                        <strong>新增产线</strong>
                                        <span>结构先建，设备后摆</span>
                                    </div>
                                    <div class="line-create-row">
                                        <input v-model="newLine.id" placeholder="产线ID，如 line_e" class="input" />
                                        <input v-model="newLine.name" placeholder="产线名称，如 E 产线" class="input" />
                                        <select v-model="newLine.workshop_id" class="input">
                                            <option value="" disabled>选择所属车间</option>
                                            <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                                        </select>
                                        <button @click="createLine" class="btn btn-primary">+ 添加产线</button>
                                    </div>
                                </div>

                                <div class="line-editor-panel">
                                    <div class="line-panel-title">
                                        <strong>产线列表</strong>
                                        <span>{{ lines.length }} 条</span>
                                    </div>
                                    <div class="line-selector-list">
                                        <div
                                            v-for="line in lines"
                                            :key="line.id"
                                            class="line-card"
                                            :class="{ active: selectedLineEditorId === line.id }"
                                        >
                                            <button type="button" class="line-card-select" @click="selectLineEditor(line.id)">
                                                <strong>{{ line.name }}</strong>
                                                <span>{{ workshops.find(w => w.id === line.workshop_id)?.name || line.workshop_id }} · {{ (lineMemberDevicesByLine[line.id] || []).length }} 台设备</span>
                                            </button>
                                            <div class="line-card-fields" v-if="selectedLineEditorId === line.id">
                                                <input v-model="line.name" class="input input-sm" placeholder="产线名称" />
                                                <select v-model="line.workshop_id" class="input input-sm">
                                                    <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                                                </select>
                                                <input v-model.number="line.sort_order" type="number" class="input input-sm" title="排序" />
                                                <button class="btn btn-danger btn-sm" type="button" @click="deleteLine(line.id)">删除</button>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div v-if="selectedLineEditor" class="line-structure-editor">
                                    <div class="line-structure-section">
                                        <div class="line-structure-title">
                                            <strong>产线方向</strong>
                                            <span class="line-flow-hint">保存后同步到大屏地面箭头</span>
                                        </div>
                                        <div class="line-flow-controls">
                                            <button
                                                v-for="option in lineFlowDirectionOptions"
                                                :key="option.value"
                                                type="button"
                                                class="line-flow-btn"
                                                :class="{ active: selectedLineLayout.flowDirection === option.value }"
                                                @click="setSelectedLineFlowDirection(option.value)"
                                            >
                                                {{ option.label }}
                                            </button>
                                        </div>
                                    </div>
                                    <div class="line-structure-section">
                                        <div class="line-structure-title">
                                            <strong>设备线</strong>
                                            <button class="btn btn-sm" type="button" @click="addLineLayoutItem('lane')">+ 设备线</button>
                                        </div>
                                        <div class="line-layout-row" v-for="lane in selectedLineLayout.lanes" :key="lane.id">
                                            <input v-model="lane.name" class="input input-sm" />
                                            <label>偏移Z<input v-model.number="lane.offsetZ" type="number" class="input input-sm" /></label>
                                            <label>长度<input v-model.number="lane.length" type="number" min="1" class="input input-sm" /></label>
                                            <button class="btn btn-danger btn-sm" type="button" @click="removeLineLayoutItem('lane', lane.id)">删除</button>
                                        </div>
                                    </div>

                                    <div class="line-structure-section">
                                        <div class="line-structure-title">
                                            <strong>小车导轨</strong>
                                            <button class="btn btn-sm" type="button" @click="addLineLayoutItem('rail')">+ 小车导轨</button>
                                        </div>
                                        <div class="line-layout-row" v-for="rail in selectedLineLayout.rails" :key="rail.id">
                                            <input v-model="rail.name" class="input input-sm" />
                                            <label>偏移Z<input v-model.number="rail.offsetZ" type="number" class="input input-sm" /></label>
                                            <label>长度<input v-model.number="rail.length" type="number" min="1" class="input input-sm" /></label>
                                            <button class="btn btn-danger btn-sm" type="button" @click="removeLineLayoutItem('rail', rail.id)">删除</button>
                                        </div>
                                        <div v-if="!selectedLineLayout.rails.length" class="composer-empty">当前产线还没有小车导轨</div>
                                    </div>
                                </div>
                            </section>

                            <section class="line-planner-preview">
                                <button
                                    class="line-editor-float-toggle"
                                    type="button"
                                    :class="{ collapsed: isLinePlannerEditorCollapsed }"
                                    :title="isLinePlannerEditorCollapsed ? '展开左侧配置' : '收起左侧配置'"
                                    @click="toggleLinePlannerEditor"
                                >
                                    {{ isLinePlannerEditorCollapsed ? '›' : '‹' }}
                                </button>
                                <div class="line-preview-toolbar">
                                    <div>
                                        <strong>{{ selectedLineEditor?.name || '未选择产线' }}</strong>
                                        <span>{{ selectedLineEditorWorkshopName }}</span>
                                    </div>
                                    <div class="line-preview-metrics">
                                        <span>{{ selectedLineLayout.lanes.length }} 条设备线</span>
                                        <span>{{ selectedLineLayout.rails.length }} 条导轨</span>
                                        <span>{{ selectedLineEditorDevices.length }}/{{ selectedLineTotalDeviceCount }} 台设备</span>
                                    </div>
                                </div>
                                <div ref="linePreviewStageRef" class="line-preview-stage" v-if="selectedLineEditor">
                                    <div class="line-preview-legend">
                                        <span><i class="legend-lane"></i>设备线</span>
                                        <span><i class="legend-rail"></i>小车导轨</span>
                                        <span><i class="legend-device"></i>设备</span>
                                        <span><i class="legend-cart"></i>小车</span>
                                    </div>
                                    <div class="line-preview-axis axis-x">X 方向</div>
                                    <div class="line-preview-axis axis-z">Z 偏移</div>
                                    <div
                                        v-if="lineDeviceDrag.active && lineDeviceDrag.alignActive"
                                        class="line-align-guide"
                                        :style="lineAlignmentGuideStyle()"
                                    ></div>
                                    <div
                                        v-for="lane in selectedLineLayout.lanes"
                                        :key="lane.id"
                                        class="line-map-item line-map-lane"
                                        :class="linePreviewItemClass('lane', lane)"
                                        :style="linePreviewItemStyle(lane)"
                                        data-line-target-type="lane"
                                        :data-line-target-id="lane.id"
                                        title="拖动调整设备线偏移，拖左右把手调整长度"
                                        @pointerdown="startLinePreviewDrag('lane', lane.id, 'move', $event)"
                                    >
                                        <span>{{ lane.name }}</span>
                                        <i
                                            v-if="selectedLineLayout.flowDirection !== 'none'"
                                            class="line-map-flow-arrow"
                                            :class="lineFlowDirectionClass()"
                                        ></i>
                                        <i class="line-map-handle handle-left" @pointerdown.stop="startLinePreviewDrag('lane', lane.id, 'resize-left', $event)"></i>
                                        <i class="line-map-handle handle-right" @pointerdown.stop="startLinePreviewDrag('lane', lane.id, 'resize-right', $event)"></i>
                                    </div>
                                    <div
                                        v-for="rail in selectedLineLayout.rails"
                                        :key="rail.id"
                                        class="line-map-item line-map-rail"
                                        :class="linePreviewItemClass('rail', rail)"
                                        :style="linePreviewItemStyle(rail)"
                                        data-line-target-type="rail"
                                        :data-line-target-id="rail.id"
                                        title="拖动调整小车导轨偏移，拖左右把手调整长度"
                                        @pointerdown="startLinePreviewDrag('rail', rail.id, 'move', $event)"
                                    >
                                        <span>{{ rail.name }}</span>
                                        <i class="line-map-handle handle-left" @pointerdown.stop="startLinePreviewDrag('rail', rail.id, 'resize-left', $event)"></i>
                                        <i class="line-map-handle handle-right" @pointerdown.stop="startLinePreviewDrag('rail', rail.id, 'resize-right', $event)"></i>
                                    </div>
                                    <div
                                        v-for="device in selectedLineEditorDevices"
                                        :key="device.id"
                                        class="line-map-device"
                                        :class="{ saving: lineDeviceSavingId === device.id }"
                                        :style="linePreviewDeviceStyle(device)"
                                        title="拖到设备线重新归位"
                                        @pointerdown="startLineDeviceDrag(device.id, $event)"
                                    >
                                        <strong>{{ device.name }}</strong>
                                        <small>{{ formatModelName(device.model_type) }}</small>
                                        <button
                                            type="button"
                                            class="line-map-remove"
                                            title="从画布移出，回到设备池"
                                            @pointerdown.stop
                                            @click.stop="removeDeviceFromLineCanvas(device)"
                                        >
                                            移出
                                        </button>
                                    </div>
                                    <div
                                        v-for="cart in selectedLineEditorCarts"
                                        :key="cart.id"
                                        class="line-map-device line-map-cart"
                                        :class="{ saving: lineDeviceSavingId === cart.id }"
                                        :style="linePreviewDeviceStyle(cart)"
                                        title="拖到小车导轨重新归位"
                                        @pointerdown="startLineDeviceDrag(cart.id, $event)"
                                    >
                                        <strong>{{ cart.name }}</strong>
                                        <small>{{ formatModelName(cart.model_type) }}</small>
                                        <button
                                            type="button"
                                            class="line-map-remove"
                                            title="从画布移出，回到设备池"
                                            @pointerdown.stop
                                            @click.stop="removeDeviceFromLineCanvas(cart)"
                                        >
                                            移出
                                        </button>
                                    </div>
                                    <div
                                        v-if="lineDeviceDrag.active"
                                        class="line-map-device line-device-ghost"
                                        :class="{ 'line-map-cart': isAuxiliaryDeviceConfig(getLineDeviceById(lineDeviceDrag.deviceId) || {}) }"
                                        :style="lineDeviceDragGhostStyle()"
                                    >
                                        <strong>{{ getLineDeviceById(lineDeviceDrag.deviceId)?.name || '设备' }}</strong>
                                        <small>{{ lineDeviceDrag.message }}</small>
                                    </div>
                                    <div v-if="!selectedLineEditorDevices.length && !selectedLineEditorCarts.length" class="line-preview-empty-state">
                                        当前产线还没有设备，保存结构后到现场编排器摆放设备
                                    </div>
                                </div>
                                <div v-else class="line-preview-stage line-preview-empty">请先创建或选择一条产线</div>
                                <div
                                    class="line-device-pool-dock"
                                    v-if="selectedLineEditor && selectedLineDevicePool.length"
                                    :class="{ collapsed: isLineDevicePoolCollapsed }"
                                    :style="lineDevicePoolDockStyle()"
                                >
                                    <button
                                        v-if="isLineDevicePoolCollapsed"
                                        type="button"
                                        class="line-device-pool-tab"
                                        @pointerdown="startLineDevicePoolMove"
                                        @click="handleLineDevicePoolTabClick"
                                    >
                                        <span class="line-device-pool-grip" aria-hidden="true"></span>
                                        设备池 {{ selectedLineDevicePool.length }}
                                    </button>
                                    <div v-else class="line-device-pool">
                                        <div class="line-device-pool-title" @pointerdown="startLineDevicePoolMove">
                                            <span class="line-device-pool-grip" aria-hidden="true"></span>
                                            <strong>车间设备池</strong>
                                            <span>拖到设备线或小车导轨</span>
                                        </div>
                                        <button
                                        v-for="device in selectedLineDevicePool"
                                        :key="device.id"
                                        type="button"
                                        draggable="false"
                                        class="line-device-pool-chip"
                                            :class="{ cart: isAuxiliaryDeviceConfig(device), saving: lineDeviceSavingId === device.id }"
                                            @pointerdown="startLineDeviceDrag(device.id, $event)"
                                        >
                                            <strong>{{ device.name }}</strong>
                                            <span>{{ formatModelName(device.model_type) }}</span>
                                        </button>
                                        <button
                                            type="button"
                                            class="line-device-pool-close"
                                            title="收起设备池"
                                            @click="toggleLineDevicePool"
                                        >
                                            收起
                                        </button>
                                    </div>
                                </div>
                            </section>
                        </div>
                    </div>
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
                                    <td class="model-name-cell">
                                        <strong>{{ formatModelName(d.model_type) }}</strong>
                                        <small>{{ d.model_type }}</small>
                                    </td>
                                    <td>
                                        <span class="plc-status-pill" :class="'plc-' + (plcStatusByDevice[d.id]?.status || (Number(d.plc_enabled || 0) ? 'idle' : 'disabled'))">
                                            {{ formatPlcDeviceStatus(d) }}
                                        </span>
                                        <small>{{ formatPlcEndpoint(d) }}</small>
                                        <div class="plc-meta-lines" v-if="Number(d.plc_enabled || 0)">
                                            <span>上次连接：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastConnectedAt) }}</span>
                                            <span>最近读取：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastReadAt) }}</span>
                                        </div>
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
                                    <td class="model-name-cell">
                                        <strong>{{ formatModelName(d.model_type) }}</strong>
                                        <small>{{ d.model_type }}</small>
                                    </td>
                                    <td>
                                        <span class="plc-status-pill" :class="'plc-' + (plcStatusByDevice[d.id]?.status || (Number(d.plc_enabled || 0) ? 'idle' : 'disabled'))">
                                            {{ formatPlcDeviceStatus(d) }}
                                        </span>
                                        <small>{{ formatPlcEndpoint(d) }}</small>
                                        <div class="plc-meta-lines" v-if="Number(d.plc_enabled || 0)">
                                            <span>上次连接：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastConnectedAt) }}</span>
                                            <span>最近读取：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastReadAt) }}</span>
                                        </div>
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
                                    <tr><th>ID</th><th>名称</th><th>交付状态</th><th>绑定数</th><th>文件路径</th><th>操作</th></tr>
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
                                        <td><span class="asset-status-pill" :class="'asset-status-' + getModelAssetStatus(m)">{{ formatAssetStatus(getModelAssetStatus(m)) }}</span></td>
                                        <td>{{ getModelBindingCount(m) }}</td>
                                        <td>{{ m.file_path || '（内置）' }}</td>
                                        <td>
                                            <button v-if="!m.is_builtin" @click.stop="deleteModel(m.id)" class="btn btn-danger btn-sm">删除</button>
                                            <span v-else style="color:#888">系统内置</span>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>

                            <section class="model-asset-governance" v-if="activePreviewModel">
                                <div class="model-binding-header">
                                    <div>
                                        <h3>模型资产规范</h3>
                                        <p>当前状态：<span class="asset-status-pill" :class="'asset-status-' + modelAssetSpec.delivery_status">{{ formatAssetStatus(modelAssetSpec.delivery_status) }}</span></p>
                                    </div>
                                    <div class="model-governance-actions">
                                        <button class="btn" type="button" @click="saveModelAssetSpec" :disabled="!canEditModelBindings || modelBindingSaving">保存规范</button>
                                        <button class="btn" type="button" @click="submitModelAssetReview" :disabled="!canEditModelBindings || modelBindingSaving">提交验收</button>
                                        <button class="btn btn-primary" type="button" @click="markModelAssetAccepted" :disabled="!canAcceptModelAsset || modelBindingSaving">标记验收通过</button>
                                        <button class="btn btn-primary" type="button" @click="publishModelAsset" :disabled="!canPublishModelAsset || modelBindingSaving">发布模型</button>
                                    </div>
                                </div>

                                <div class="model-workflow-rail">
                                    <div
                                        v-for="(step, index) in modelAssetWorkflow"
                                        :key="step.id"
                                        class="model-workflow-step"
                                        :class="{ passed: step.passed, optional: step.optional && !step.passed }"
                                    >
                                        <strong>{{ index + 1 }}</strong>
                                        <span>{{ step.label }}</span>
                                        <small>{{ step.detail }}</small>
                                    </div>
                                </div>

                                <div class="model-stats-strip">
                                    <span>节点 {{ modelPreviewStats.nodeCount }}</span>
                                    <span>网格 {{ modelPreviewStats.meshCount }}</span>
                                    <span>三角面 {{ formatModelNumber(modelPreviewStats.triangleCount) }}</span>
                                    <span>材质 {{ modelPreviewStats.materialCount }}</span>
                                    <span>贴图 {{ modelPreviewStats.textureCount }}</span>
                                    <span>尺寸 {{ formatModelBounds(modelPreviewStats.bounds) }}</span>
                                </div>

                                <template v-if="canEditModelBindings">
                                    <div class="model-spec-form">
                                        <label>资产版本<input v-model="modelAssetSpec.version" class="input" /></label>
                                        <label>设备类型<input v-model="modelAssetSpec.device_family" class="input" placeholder="如 箱式气氛多用炉" /></label>
                                        <label>尺寸单位
                                            <select v-model="modelAssetSpec.unit" class="input">
                                                <option value="m">m</option>
                                                <option value="mm">mm</option>
                                            </select>
                                        </label>
                                        <label>坐标规范<input v-model="modelAssetSpec.axis_rule" class="input" /></label>
                                        <label>最大三角面<input v-model.number="modelAssetSpec.max_triangles" type="number" min="1000" step="1000" class="input" /></label>
                                        <label>最大节点数<input v-model.number="modelAssetSpec.max_nodes" type="number" min="1" step="10" class="input" /></label>
                                        <label>最大贴图尺寸<input v-model.number="modelAssetSpec.max_texture_size" type="number" min="256" step="256" class="input" /></label>
                                        <label>交付状态
                                            <select v-model="modelAssetSpec.delivery_status" class="input">
                                                <option value="draft">草稿</option>
                                                <option value="review">待验收</option>
                                                <option value="accepted">验收通过</option>
                                                <option value="released">已发布</option>
                                            </select>
                                        </label>
                                        <label class="wide-form-section">节点命名规则<input v-model="modelAssetSpec.node_naming_rule" class="input" /></label>
                                        <label class="wide-form-section">LOD 策略<input v-model="modelAssetSpec.lod_policy" class="input" /></label>
                                        <label class="wide-form-section">交付备注<textarea v-model="modelAssetSpec.notes" class="input model-metadata"></textarea></label>
                                    </div>

                                    <div class="model-acceptance-summary" :class="{ ready: modelAcceptanceSummary.ready }">
                                        必检 {{ modelAcceptanceSummary.passed }}/{{ modelAcceptanceSummary.required }}
                                        <span v-if="modelAcceptanceSummary.warnings">，提示 {{ modelAcceptanceSummary.warnings }} 项</span>
                                    </div>
                                    <div class="model-acceptance-grid">
                                        <div
                                            v-for="check in modelAcceptanceChecks"
                                            :key="check.id"
                                            class="model-acceptance-item"
                                            :class="{ passed: check.passed, warning: !check.required && !check.passed }"
                                        >
                                            <strong>{{ check.passed ? '通过' : (check.required ? '未过' : '提示') }}</strong>
                                            <span>{{ check.label }}</span>
                                            <small>{{ check.detail }}</small>
                                        </div>
                                    </div>

                                    <div class="model-release-history">
                                        <div class="model-release-header">
                                            <strong>发布记录</strong>
                                            <span>{{ modelReleaseHistory.length ? `共 ${modelReleaseHistory.length} 次` : '暂无发布快照' }}</span>
                                        </div>
                                        <table class="data-table" v-if="modelReleaseHistory.length">
                                            <thead>
                                                <tr><th>版本</th><th>状态</th><th>时间</th><th>三角面</th><th>绑定</th><th>操作</th></tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="release in modelReleaseHistory" :key="release.id">
                                                    <td>{{ release.version }}</td>
                                                    <td>{{ release.status === 'rollback' ? '回滚' : '发布' }}</td>
                                                    <td>{{ release.published_at || '-' }}</td>
                                                    <td>{{ formatModelNumber(release.stats?.triangleCount) }}</td>
                                                    <td>{{ release.snapshot?.partBindings?.length || 0 }}</td>
                                                    <td>
                                                        <button class="btn btn-sm" type="button" @click="restoreModelRelease(release)" :disabled="modelBindingSaving || !release.snapshot">恢复此版</button>
                                                    </td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </template>
                            </section>

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
                                        <label class="model-node-picker">模型部位
                                            <div class="model-node-tools">
                                                <input v-model="modelNodeSearchText" class="input" placeholder="搜索节点名称 / 路径" />
                                                <span class="inline-toggle node-filter-toggle">
                                                    <input v-model="showOnlyBindableNodes" type="checkbox" />
                                                    只看可绑定网格
                                                </span>
                                            </div>
                                            <select v-model="selectedModelNodePath" class="input" @change="selectPreviewNode(selectedModelNodePath)">
                                                <option value="">选择右侧预览解析出的节点</option>
                                                <option v-for="node in filteredModelPreviewNodes" :key="node.path" :value="node.path">
                                                    {{ formatModelNodeOption(node) }}
                                                </option>
                                            </select>
                                            <small class="field-hint">当前显示 {{ filteredModelPreviewNodes.length }} / {{ modelPreviewNodes.length }} 个节点。若列表全是 bolt、chain 这类名字，说明模型导出时节点命名还没按资产规范整理。</small>
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
                                            <tr
                                                v-for="(binding, index) in modelPartBindings"
                                                :key="binding.id"
                                                class="model-binding-row"
                                                :class="{ active: previewModelBindingIndex === index }"
                                                @click="previewModelBinding(index)"
                                            >
                                                <td>{{ formatModelBindingPartName(binding) }}</td>
                                                <td><code>{{ formatModelSourceGroup(binding.source_group) }}.{{ binding.source_key }}</code></td>
                                                <td>{{ formatModelBindingAction(binding.action) }}</td>
                                                <td>{{ formatModelAxis(binding.axis) }}</td>
                                                <td>
                                                    <button class="btn btn-sm" type="button" @click.stop="editModelBinding(index)">编辑</button>
                                                    <button class="btn btn-danger btn-sm" type="button" @click.stop="removeModelBinding(index)">删除</button>
                                                </td>
                                            </tr>
                                            <tr v-if="!modelPartBindings.length">
                                                <td colspan="5" style="text-align:center;color:#888">暂无部位绑定</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                    <div class="model-binding-bottom-actions">
                                        <span>修改绑定后请保存；删除操作会自动保存。</span>
                                        <button class="btn btn-primary" type="button" @click="saveModelPartBindings" :disabled="modelBindingSaving">
                                            {{ modelBindingSaving ? '保存中...' : '保存绑定' }}
                                        </button>
                                    </div>
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
                                <div v-if="selectedModelNodeInfo" class="model-preview-node-card">
                                    <strong>{{ selectedModelNodeInfo.displayName || selectedModelNodeInfo.name }}</strong>
                                    <span>{{ formatModelNodeType(selectedModelNodeInfo.type) }} · {{ formatMeshCount(selectedModelNodeInfo.meshCount) }}</span>
                                    <small>{{ selectedModelNodeInfo.path }}</small>
                                </div>
                                <button v-if="isModelPreviewActive" class="model-preview-reset" type="button" @click="resetModelPreviewCamera">看全模型</button>
                            </div>
                            <div class="model-preview-footer">
                                <div>{{ modelPreviewStatus }}</div>
                                <div v-if="selectedModelNodeInfo" class="model-preview-selected-text">
                                    已选：{{ selectedModelNodeInfo.displayName || selectedModelNodeInfo.name }}
                                    <template v-if="selectedModelNodeInfo.sizeText"> · 尺寸 {{ selectedModelNodeInfo.sizeText }}</template>
                                </div>
                            </div>
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
                        <div class="widget-layout-editor">
                            <div class="widget-layout-form">
                                <div class="table-scroll">
                                    <table class="data-table platform-table widget-layout-table">
                                        <thead>
                                            <tr>
                                                <th>显示</th><th>ID</th><th>类型</th><th>标题</th>
                                                <th>左</th><th>上</th><th>宽</th><th>高</th><th>排序</th><th>配置 JSON</th><th>绑定 JSON</th><th>操作</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr
                                                v-for="widget in platform.widgets"
                                                :key="widget.id"
                                                class="widget-layout-row"
                                                :class="{ active: selectedWidgetPreviewId === widget.id }"
                                                @click="selectWidgetPreview(widget)"
                                                @mouseenter="showWidgetPreview(widget, $event)"
                                                @mousemove="moveWidgetPreviewPopover($event)"
                                                @mouseleave="hideWidgetPreview"
                                            >
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
                                                    <button type="button" @click.stop="widget.configText = formatJsonForEditor(getWidgetDefaultConfig(widget.widget_type))" class="btn btn-sm widget-default-btn">默认</button>
                                                    <textarea v-model="widget.configText" class="input widget-json widget-json-large" spellcheck="false"></textarea>
                                                </td>
                                                <td class="widget-editor-cell">
                                                    <button type="button" @click.stop="widget.bindingText = formatJsonForEditor(getWidgetDefaultBinding(widget.widget_type))" class="btn btn-sm widget-default-btn">默认</button>
                                                    <textarea v-model="widget.bindingText" class="input widget-json widget-json-large" spellcheck="false"></textarea>
                                                </td>
                                                <td class="widget-action-cell" @mouseenter.stop="hideWidgetPreview" @mousemove.stop="hideWidgetPreview">
                                                    <button @click.stop="saveWidget(widget)" class="btn btn-primary btn-sm">保存</button>
                                                    <button @click.stop="deleteWidget(widget.id)" class="btn btn-danger btn-sm">删除</button>
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                        <Teleport to="body">
                            <div
                                v-if="widgetPreviewHover.visible && hoveredPreviewWidget"
                                class="widget-preview-popover"
                                :style="widgetPreviewPopoverStyle"
                            >
                                <div class="widget-live-preview-header">
                                    <div>
                                        <strong>实时预览</strong>
                                        <span>{{ hoveredPreviewWidget.title || hoveredPreviewWidget.id }}</span>
                                    </div>
                                    <small>{{ getWidgetPreviewModeLabel(hoveredPreviewWidget) }}</small>
                                </div>
                                <div class="widget-hover-preview-stage">
                                    <template v-if="isDashboardGridPreview(hoveredPreviewWidget)">
                                        <div class="widget-hover-preview-canvas" :style="getWidgetFocusCanvasStyle(hoveredPreviewWidget)">
                                            <div
                                                v-for="previewWidget in dashboardPreviewWidgets"
                                                :key="previewWidget.id"
                                                class="widget-preview-slot"
                                                :class="{ active: hoveredPreviewWidget.id === previewWidget.id, hidden: !previewWidget.visible }"
                                                :style="getAdminWidgetGridStyle(previewWidget)"
                                            >
                                                <WidgetRenderer
                                                    v-if="previewWidget.visible && previewableWidgetTypes.has(previewWidget.widget_type)"
                                                    :widget="previewWidget"
                                                    :metrics="widgetPreviewMetrics"
                                                    :events="widgetPreviewEvents"
                                                    :trend-points="widgetPreviewTrendPoints"
                                                />
                                                <div v-else class="widget-preview-placeholder">
                                                    <strong>{{ previewWidget.title || previewWidget.id }}</strong>
                                                    <span>{{ widgetTypeLabelMap[previewWidget.widget_type] || previewWidget.widget_type }}</span>
                                                    <small>{{ previewWidget.visible ? getWidgetPreviewDescription(previewWidget) : '当前已隐藏' }}</small>
                                                </div>
                                            </div>
                                        </div>
                                    </template>
                                    <div v-else-if="hoveredPreviewWidget.widget_type === 'diagnostics'" class="widget-device-detail-preview">
                                        <div class="widget-device-card">
                                            <div class="device-card-header">
                                                <strong>1# 多用炉</strong>
                                                <span>点击设备后的诊断面板</span>
                                            </div>
                                            <div class="diagnostic-preview-grid">
                                                <div v-for="group in widgetPreviewDiagnosticGroups" :key="group.title" class="diagnostic-preview-group">
                                                    <strong>{{ group.title }}</strong>
                                                    <div v-for="row in group.rows.slice(0, 3)" :key="row.label" class="diagnostic-preview-row">
                                                        <span>{{ row.label }}</span>
                                                        <b>{{ row.value }}<small v-if="row.unit"> {{ row.unit }}</small></b>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div v-else-if="hoveredPreviewWidget.widget_type === 'device_label'" class="widget-device-label-preview">
                                        <div class="mock-device-block"></div>
                                        <div class="mock-device-label" :style="getDeviceLabelPreviewStyle(hoveredPreviewWidget)">
                                            <strong v-if="getDeviceLabelPreviewTitle(hoveredPreviewWidget)">{{ getDeviceLabelPreviewTitle(hoveredPreviewWidget) }}</strong>
                                            <span>温度：836 °C</span>
                                            <span>碳势：0.88 %</span>
                                        </div>
                                        <small>设备浮标配置不会占用大屏面板网格</small>
                                    </div>
                                    <div v-else-if="hoveredPreviewWidget.widget_type === 'line_overview_cards'" class="widget-line-card-preview">
                                        <div v-for="index in 4" :key="index" class="mock-line-card">
                                            <strong>{{ index }}# 多用炉</strong>
                                            <span>温度 {{ 820 + index * 8 }} °C</span>
                                            <span>碳势 0.8{{ index }} %</span>
                                        </div>
                                    </div>
                                    <div v-else class="widget-preview-empty">当前组件暂无专用预览</div>
                                </div>
                                <div class="widget-live-preview-footer">
                                    <span>{{ getWidgetPreviewDescription(hoveredPreviewWidget) }}</span>
                                    <small>{{ getWidgetPlacementText(hoveredPreviewWidget) }}</small>
                                </div>
                            </div>
                        </Teleport>
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
                    <p class="desc">为每台设备配置 PLC 点位名称、地址和采集周期。用户只需要维护现场点位，系统会自动生成大屏和模型绑定需要的内部标识。</p>

                    <div class="form-row" style="margin-bottom:20px; align-items: flex-end;">
                        <div>
                            <label style="font-size:12px; color:#86868b; display:block; margin-bottom:5px;">筛选设备</label>
                            <select v-model="selectedDeviceForPoints" @change="loadDataPoints" class="input" style="width:250px">
                                <option value="all">全部设备</option>
                                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} ({{ d.id }})</option>
                            </select>
                        </div>
                        <div v-if="selectedDeviceForPoints" style="display:flex; gap:10px; margin-left: 20px;">
                            <button @click="alert('点表导入会做成模板校验后批量导入，当前请先手动配置关键点位。', { title: '点表导入', type: 'info' })" class="btn">导入点表</button>
                            <div v-if="!isAllPointsMode" style="position: relative; display: inline-block;">
                                <select @change="copyPointsFrom($event.target.value); $event.target.value=''" class="input" style="width: 180px;">
                                    <option value="">从其他设备复制...</option>
                                    <option v-for="d in devices.filter(x => x.id !== selectedDeviceForPoints)" :key="d.id" :value="d.id">复制自: {{ d.name }}</option>
                                </select>
                            </div>
                            <button v-if="!isAllPointsMode" @click="syncToLine" class="btn">应用到同产线</button>
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
                                        <th v-if="isAllPointsMode">设备</th>
                                        <th>点位名称</th><th>点位用途</th><th>PLC 地址</th>
                                        <th>数据类型</th><th>采集周期(ms)</th><th>读写</th>
                                        <th v-if="showPointAdvancedFields" title="PLC 原始值乘以这个数，常用于把整数缩放成工程值">换算倍率</th>
                                        <th v-if="showPointAdvancedFields" title="倍率换算后再加上的修正值，常用于传感器零点校准">偏移修正</th>
                                        <th v-if="showPointAdvancedFields" title="可选高级换算，x 代表倍率和偏移后的值，例如 x/10">自定义公式</th>
                                        <th v-if="showPointAdvancedFields" title="控制画面显示的小数位，例如 0、0.0、0.00">显示小数</th>
                                        <th>单位</th><th>报警说明</th><th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="(p, idx) in dataPoints" :key="idx">
                                        <td v-if="isAllPointsMode">
                                            <select v-model="p.device_id" @change="markPointsDirty" class="input input-sm device-point-select">
                                                <option value="">选择设备</option>
                                                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} ({{ d.id }})</option>
                                            </select>
                                        </td>
                                        <td><input v-model="p.label" @input="markPointsDirty" class="input input-sm point-name-input" placeholder="实际温度 / bj1" /></td>
                                        <td>
                                            <select v-model="p.__usage" @change="setPointUsage(p, p.__usage)" class="input input-sm point-usage-input">
                                                <option v-for="item in pointUsageOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
                                            </select>
                                        </td>
                                        <td><input v-model="p.plc_tag" @input="markPointsDirty" class="input input-sm plc-address-input" placeholder="DB1.DBW3000 / DB1.DBX6.0 / DB10,S20.30" /></td>
                                        <td>
                                            <select v-model="p.data_type" @change="handlePointDataTypeChange(p)" class="input input-sm">
                                                <option v-for="type in pointDataTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
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
                                        <td v-if="showPointAdvancedFields"><input v-model.number="p.scale" @input="markPointsDirty" type="number" step="0.001" class="input input-sm number-input" placeholder="1" title="PLC 原始值乘以这个数，例如原始值 253、倍率 0.1，得到 25.3" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model.number="p.offset" @input="markPointsDirty" type="number" step="0.001" class="input input-sm number-input" placeholder="0" title="倍率换算后再加上的修正值，例如传感器整体偏低 2 度就填 2" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model="p.expression" @input="markPointsDirty" class="input input-sm expression-input" placeholder="可空，如 x/10" title="可选高级换算，x 代表倍率和偏移后的值，例如 x/10、(x-32)*5/9" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model="p.display_format" @input="markPointsDirty" class="input input-sm unit-input" placeholder="如 0.0" title="控制画面显示的小数位，例如 0 表示整数，0.0 表示 1 位小数，0.00 表示 2 位小数" /></td>
                                        <td><input v-model="p.unit" @input="markPointsDirty" class="input input-sm unit-input" :disabled="isBoolPoint(p)" :placeholder="isBoolPoint(p) ? 'BOOL无单位' : '°C'" /></td>
                                        <td>
                                            <input v-if="normalizePointUsage(p) === 'alarm_trigger'" v-model="p.alarm_text" @input="markPointsDirty" class="input input-sm alarm-text-input" placeholder="报警说明" />
                                            <span v-else class="muted-cell">-</span>
                                        </td>
                                        <td><button @click="removeDataPoint(idx)" class="btn btn-danger btn-sm">✕</button></td>
                                    </tr>
                                    <tr v-if="dataPoints.length === 0">
                                        <td :colspan="(showPointAdvancedFields ? 12 : 8) + (isAllPointsMode ? 1 : 0)" style="text-align:center; padding: 20px; color: #86868b;">暂无点位配置，请手动添加或从其他设备复制。</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div style="margin-top:15px;display:flex; justify-content: space-between; align-items: center;">
                            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                                <button @click="addDataPoint('normal')" class="btn">+ 添加点位</button>
                                <button @click="addAlarmTriggerPoint" class="btn">+ 添加报警点位</button>
                                <button @click="ensureAlarmRecordPoints" class="btn" :disabled="isAllPointsMode">补齐报警记录字段</button>
                            </div>
                            <div style="display:flex; align-items: center; gap: 15px;">
                                <span v-if="isPointsDirty" style="color: #ff9500; font-size: 13px;">存在未保存的修改</span>
                                <button @click="saveAllPoints" class="btn btn-primary" :disabled="!isPointsDirty && dataPoints.length > 0">{{ isAllPointsMode ? '保存全部设备配置' : '保存当前设备配置' }}</button>
                            </div>
                        </div>

                        <section class="alarm-config-card">
                            <div class="alarm-config-header">
                                <div>
                                    <h3>报警点位与报警文本</h3>
                                    <p>按排产软件习惯，报警触发点位建议命名为 bj1、bj2、bj3...，报警说明可粘贴 <code>1 =&gt; "报警内容"</code> 格式，也可以一行一条按顺序导入。</p>
                                </div>
                                <span class="alarm-config-count">{{ alarmTextImportSummary }}</span>
                            </div>

                            <div class="alarm-record-status">
                                <div v-for="item in alarmRecordPointStatus.slice(0, 3)" :key="item.role" :class="{ configured: item.configured }">
                                    <span>{{ item.label }}</span>
                                    <strong>{{ item.configured ? '已配置' : '未配置' }}</strong>
                                </div>
                            </div>

                            <div class="alarm-import-layout">
                                <textarea v-model="alarmTextImportRaw" class="input alarm-textarea" placeholder="例如：
1 => &quot;循环风扇冷却水流量低故障&quot;,
2 => &quot;油搅拌1不运行&quot;,
3 => &quot;内推链电机空开跌落&quot;," />
                                <div class="alarm-import-side">
                                    <button @click="fillAlarmTextTemplate" class="btn" :disabled="isAllPointsMode">生成当前报警模板</button>
                                    <button @click="triggerAlarmTextFileSelect" class="btn" :disabled="isAllPointsMode">导入文本文件</button>
                                    <button @click="applyAlarmTextImport" class="btn btn-primary" :disabled="isAllPointsMode">匹配到报警点位</button>
                                    <input ref="alarmTextFileInput" type="file" accept=".txt,.csv" style="display:none" @change="handleAlarmTextFileChange" />
                                    <div class="alarm-preview">
                                        <strong>解析预览</strong>
                                        <div v-if="parsedAlarmTextEntries.length === 0" class="muted-cell">暂无可解析文本</div>
                                        <div v-for="entry in parsedAlarmTextEntries.slice(0, 8)" :key="entry.number">
                                            bj{{ entry.number }}：{{ entry.text }}
                                        </div>
                                        <div v-if="parsedAlarmTextEntries.length > 8" class="muted-cell">还有 {{ parsedAlarmTextEntries.length - 8 }} 条...</div>
                                    </div>
                                </div>
                            </div>
                        </section>
                    </div>
                </div>

                <!-- ======== 点位实时监视 ======== -->
                <div v-if="activeTab === 'point-monitor'" class="tab-content">
                    <h2>PLC 点位实时监视</h2>
                    <p class="desc">查看已配置 PLC 点位的实时值、质量、标准地址和最近读取时间。这里读取的是后端采集缓存，不会因为刷新页面而强行插队读取 PLC。</p>

                    <div class="form-row point-monitor-toolbar">
                        <div>
                            <label style="font-size:12px; color:#86868b; display:block; margin-bottom:5px;">筛选设备</label>
                            <select v-model="selectedDeviceForMonitor" class="input" style="width:280px">
                                <option value="all">全部设备</option>
                                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} ({{ d.id }})</option>
                            </select>
                        </div>
                        <button @click="loadRealtimePointValues" class="btn" :disabled="realtimePointLoading">
                            {{ realtimePointLoading ? '读取中...' : '读取最新缓存' }}
                        </button>
                        <label class="inline-toggle">
                            <input v-model="pointMonitorAutoRefresh" type="checkbox" />
                            自动刷新
                        </label>
                    </div>

                    <div class="point-monitor-status">
                        <div>
                            <span class="status-label">监视范围</span>
                            <span class="plc-status-pill" :class="'plc-' + (pointMonitorStatusSummary?.status || 'idle')">
                                {{ isAllPointMonitorMode ? pointMonitorStatusSummary.message : (plcStatusLabels[realtimePointDeviceStatus?.status] || formatPlcDeviceStatus(selectedMonitorDevice || {})) }}
                            </span>
                        </div>
                        <div>
                            <span class="status-label">端点</span>
                            <strong>{{ isAllPointMonitorMode ? '全部设备' : (realtimePointDeviceStatus?.endpoint || (selectedMonitorDevice ? formatPlcEndpoint(selectedMonitorDevice) : '-')) }}</strong>
                        </div>
                        <div>
                            <span class="status-label">页面刷新周期</span>
                            <strong>{{ pointMonitorAutoRefresh ? `${pointMonitorRefreshIntervalMs}ms` : '手动刷新' }}</strong>
                        </div>
                        <div>
                            <span class="status-label">PLC采集周期</span>
                            <strong>按每行配置执行</strong>
                        </div>
                        <div>
                            <span class="status-label">最近数据快照</span>
                            <strong>{{ formatPointTime(realtimePointSnapshotAt) }}</strong>
                        </div>
                    </div>

                    <div v-if="realtimePointError" class="inline-error">{{ realtimePointError }}</div>

                    <div class="table-scroll">
                        <table class="data-table realtime-points-table">
                            <thead>
                                <tr>
                                    <th>设备</th>
                                    <th>点位名称</th>
                                    <th>点位用途</th>
                                    <th>当前值</th>
                                    <th>质量</th>
                                    <th>PLC 标准地址</th>
                                    <th>数据类型</th>
                                    <th>采集周期</th>
                                    <th>报警说明</th>
                                    <th>最近读取</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="point in realtimePointRows" :key="point.__runtimeKey">
                                    <td>{{ point.device_name || point.device_id || '-' }}</td>
                                    <td>{{ pointDisplayName(point) || '-' }}</td>
                                    <td>{{ formatPointUsage(point) }}</td>
                                    <td class="point-value-cell">{{ formatPointValue(point) }}</td>
                                    <td>
                                        <span class="point-quality-pill" :class="'quality-' + (point.quality || 'bad')">
                                            {{ formatQualityLabel(point.quality) }}
                                        </span>
                                    </td>
                                    <td>{{ point.plc_address || point.plc_tag || '-' }}</td>
                                    <td>{{ point.data_type || '-' }}</td>
                                    <td>{{ point.sample_interval_ms || '-' }}ms</td>
                                    <td>{{ point.alarm_text || '-' }}</td>
                                    <td>{{ formatPointTime(point.lastReadAt) }}</td>
                                </tr>
                                <tr v-if="!realtimePointRows.length">
                                    <td colspan="10" style="text-align:center; padding: 22px; color:#86868b;">暂无点位，先到“点位映射”里配置 PLC 地址。</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ======== 系统设置 ======== -->
                <div v-if="activeTab === 'settings'" class="tab-content">
                    <h2>系统设置</h2>
                    <p class="desc">配置大屏渲染性能、数据通路、PLC 连接参数和通信方式。</p>

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

                            <div v-if="databaseConfig.type === 'sqlite' && databaseBackupStatus.supported" class="database-backup-panel">
                                <div class="database-backup-header">
                                    <div>
                                        <strong>断电恢复与备份</strong>
                                        <p>
                                            WAL 全同步写入；每 {{ formatBackupInterval(databaseBackupStatus.intervalMs) }} 自动备份，
                                            保留最近 {{ databaseBackupStatus.retention }} 份，退出时再备份一次。
                                        </p>
                                    </div>
                                    <button @click="createDatabaseBackup" class="btn" :disabled="databaseBackupBusy">立即备份</button>
                                </div>
                                <p v-if="databaseBackupStatus.lastRecovery" class="database-recovery-notice">
                                    最近恢复：{{ new Date(databaseBackupStatus.lastRecovery.recoveredAt).toLocaleString() }}，
                                    来源 {{ databaseBackupStatus.lastRecovery.source }}
                                </p>
                                <p v-if="databaseBackupMessage" class="database-backup-message">{{ databaseBackupMessage }}</p>
                                <div class="database-backup-list">
                                    <div v-for="backup in databaseBackupStatus.backups" :key="backup.filename" class="database-backup-row">
                                        <div>
                                            <strong>{{ backup.filename }}</strong>
                                            <span>{{ new Date(backup.createdAt).toLocaleString() }} · {{ formatBackupSize(backup.size) }}</span>
                                        </div>
                                        <span class="backup-validity" :class="backup.valid ? 'is-valid' : 'is-invalid'">
                                            {{ backup.valid ? '校验通过' : '已损坏' }}
                                        </span>
                                        <button @click="downloadDatabaseBackup(backup)" class="btn btn-small" :disabled="!backup.valid">下载</button>
                                        <button @click="restoreDatabaseBackup(backup)" class="btn btn-small" :disabled="databaseBackupBusy || !backup.valid">恢复</button>
                                    </div>
                                    <div v-if="databaseBackupStatus.backups.length === 0" class="empty-hint">暂无备份</div>
                                </div>
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

                        <!-- ===== 渲染性能 ===== -->
                        <div class="settings-section">
                            <h3 class="section-title">大屏渲染性能</h3>
                            <div class="settings-grid">
                                <label>性能档位
                                    <select v-model="settings.render_profile" class="input">
                                        <option v-for="profile in renderProfileOptions" :key="profile.value" :value="profile.value">
                                            {{ profile.label }}
                                        </option>
                                    </select>
                                </label>
                                <label>当前生效参数
                                    <div class="input render-setting-readonly">
                                        {{ resolvedRenderSettings.targetFps }} FPS / {{ Math.round(resolvedRenderSettings.renderScale * 100) }}% 分辨率
                                    </div>
                                </label>
                            </div>

                            <div class="mode-hint render-profile-hint">
                                <p><strong>{{ selectedRenderProfile?.label }}：</strong>{{ selectedRenderProfile?.description }}</p>
                                <p>浮标刷新 {{ resolvedRenderSettings.labelFps }} FPS；抗锯齿{{ resolvedRenderSettings.antialias ? '开启' : '关闭' }}。保存后刷新大屏页面生效。</p>
                            </div>

                            <div v-if="settings.render_profile === 'custom'" class="settings-grid render-custom-grid">
                                <label>目标帧率 (15-144 FPS)
                                    <input v-model.number="settings.render_target_fps" type="number" min="15" max="144" step="1" class="input" />
                                </label>
                                <label>渲染分辨率倍率 (0.5-1.5)
                                    <input v-model.number="settings.render_scale" type="number" min="0.5" max="1.5" step="0.05" class="input" />
                                </label>
                                <label>3D 浮标刷新率 (1-30 FPS)
                                    <input v-model.number="settings.render_label_fps" type="number" min="1" max="30" step="1" class="input" />
                                </label>
                                <label>抗锯齿
                                    <span class="checkbox-line"><input v-model="settings.render_antialias" type="checkbox" /> 启用 WebGL 抗锯齿</span>
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
                                        <tr><th>设备</th><th>状态</th><th>端点</th><th>采集周期</th><th>上次连接</th><th>最近读取</th><th>错误</th></tr>
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
                                            <td>{{ formatPlcTime(status.lastConnectedAt) }}</td>
                                            <td>{{ formatPlcTime(status.lastReadAt) }}</td>
                                            <td>{{ status.lastError || status.message || '-' }}</td>
                                        </tr>
                                        <tr v-if="!(engineStatus.plcStatus?.devices || []).length">
                                            <td colspan="7" style="text-align:center;color:#86868b">暂无 PLC 设备状态，请先在设备管理里启用 PLC 采集。</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <button @click="saveSettings" class="btn btn-primary" style="margin-top:24px; padding: 10px 30px; font-size: 15px;">保存所有系统设置</button>
                    </div>
                </div>

            </main>
        </div>

        <div v-if="appDialog.visible" class="app-dialog-overlay" @click.self="appDialog.showCancel ? closeAppDialog(false) : null">
            <section class="app-dialog" :class="'dialog-' + appDialog.type" role="dialog" aria-modal="true">
                <div class="app-dialog-mark"></div>
                <div class="app-dialog-body">
                    <h3>{{ appDialog.title }}</h3>
                    <p>{{ appDialog.message }}</p>
                </div>
                <div class="app-dialog-actions">
                    <button v-if="appDialog.showCancel" type="button" class="btn" @click="closeAppDialog(false)">
                        {{ appDialog.cancelText }}
                    </button>
                    <button type="button" class="btn btn-primary" @click="closeAppDialog(true)">
                        {{ appDialog.confirmText }}
                    </button>
                </div>
            </section>
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
.admin-container.line-planner-active {
    height: auto;
    min-height: 100vh;
    overflow: visible;
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
.admin-container.line-planner-active .admin-body {
    overflow: visible;
}

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
.admin-container.line-planner-active .admin-content {
    padding: 10px 12px 12px;
    overflow: visible;
}

.tab-content {
    background: #ffffff; padding: 32px; border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.03), 0 1px 2px rgba(0, 0, 0, 0.02);
    border: 1px solid rgba(0, 0, 0, 0.04);
    min-height: calc(100% - 10px);
}
.tab-content h2 { margin: 0 0 6px 0; font-size: 24px; color: #1d1d1f; font-weight: 600; letter-spacing: -0.5px; }
.desc { color: #86868b; font-size: 14px; margin-bottom: 28px; }

.line-planner-tab {
    min-height: calc(100vh - 86px);
    padding: 0;
    overflow: visible;
    background: #f2f4f6;
}
.line-planner-tab > h2,
.line-planner-tab > .desc,
.line-planner-tab > .form-row,
.line-planner-tab > .data-table {
    display: none;
}
.line-planner-shell {
    min-height: calc(100vh - 86px);
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
}
.line-planner-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 72px;
    padding: 16px 22px;
    background: #ffffff;
    border-bottom: 1px solid rgba(25, 33, 38, 0.08);
}
.line-planner-header h2 {
    margin: 0 0 4px;
    font-size: 22px;
    color: #172027;
    letter-spacing: 0;
}
.line-planner-header .desc { margin: 0; color: #6b737a; }
.line-planner-steps {
    display: flex;
    gap: 8px;
    padding: 10px 22px;
    background: #f8fafb;
    border-bottom: 1px solid rgba(25, 33, 38, 0.07);
}
.line-planner-steps span {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 10px;
    color: #687179;
    background: #eef1f4;
    border: 1px solid rgba(25, 33, 38, 0.06);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
}
.line-planner-steps .active {
    color: #ffffff;
    background: #1e4f6b;
    border-color: #1e4f6b;
}
.line-planner-layout {
    position: relative;
    min-height: calc(100vh - 220px);
    display: grid;
    grid-template-columns: minmax(380px, 440px) minmax(0, 1fr);
    transition: grid-template-columns 0.22s ease;
    overflow: visible;
}
.line-planner-layout.editor-collapsed {
    grid-template-columns: minmax(0, 1fr);
}
.line-planner-layout.editor-collapsed .line-planner-editor {
    display: none;
}
.line-planner-editor {
    min-width: 0;
    overflow: visible;
    padding: 16px;
    background: #f5f7f8;
    border-right: 1px solid rgba(25, 33, 38, 0.08);
}
.line-editor-panel,
.line-basic-grid,
.line-structure-section {
    margin-bottom: 14px;
    padding: 14px;
    background: #ffffff;
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 8px;
}
.line-panel-title,
.line-structure-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
}
.line-panel-title strong,
.line-structure-title strong {
    color: #172027;
    font-size: 15px;
}
.line-panel-title span {
    color: #77818a;
    font-size: 12px;
}
.line-create-row,
.line-selector-list,
.line-structure-editor,
.line-structure-section {
    display: grid;
    gap: 10px;
}
.line-create-row .btn {
    min-height: 38px;
}
.line-card {
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 8px;
    background: #f8fafb;
    overflow: hidden;
}
.line-card.active {
    background: #eef5f8;
    border-color: #3e7da0;
    box-shadow: inset 3px 0 0 #245c7a;
}
.line-card-select {
    width: 100%;
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 11px;
    color: #172027;
    background: transparent;
    border: 0;
    cursor: pointer;
    text-align: left;
}
.line-card-select strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
}
.line-card-select span {
    color: #77818a;
    font-size: 12px;
    white-space: nowrap;
}
.line-card-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(120px, 150px) 64px 58px;
    gap: 8px;
    padding: 0 10px 10px 13px;
}
.line-card-fields .input {
    min-width: 0;
    height: 32px;
    padding: 5px 8px;
}
.line-card-fields .btn {
    width: 58px;
    padding: 7px 0;
}
.line-basic-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
}
.line-basic-grid label,
.line-layout-row label {
    display: grid;
    gap: 6px;
    min-width: 0;
    color: #4d5861;
    font-size: 12px;
    font-weight: 600;
}
.line-basic-grid .btn {
    grid-column: 2;
    justify-self: end;
    align-self: end;
}
.line-structure-section {
    margin-bottom: 0;
}
.line-structure-title .btn {
    background: #eef1f4;
    color: #245c7a;
}
.line-flow-hint {
    color: #77818a;
    font-size: 12px;
}
.line-flow-controls {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
}
.line-flow-btn {
    min-height: 34px;
    color: #46545e;
    background: #eef1f4;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
}
.line-flow-btn:hover {
    background: #ffffff;
}
.line-flow-btn.active {
    color: #ffffff;
    background: #245c7a;
    border-color: #245c7a;
}
.line-layout-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 92px 92px 60px;
    gap: 8px;
    align-items: end;
    padding: 8px;
    background: #f8fafb;
    border: 1px solid rgba(25, 33, 38, 0.06);
    border-radius: 8px;
}
.line-layout-row .input {
    min-width: 0;
    height: 32px;
    padding: 5px 8px;
}
.line-layout-row .btn {
    width: 60px;
    min-width: 60px;
    padding: 7px 0;
}
.line-planner-preview {
    position: relative;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: #e6ebef;
}
.line-editor-float-toggle {
    appearance: none;
    position: absolute;
    left: -18px;
    top: 50%;
    z-index: 20;
    width: 36px;
    height: 48px;
    padding: 0;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #50616c;
    background: rgba(255,255,255,.92);
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 10px;
    box-shadow: 0 8px 22px rgba(38, 50, 58, .14);
    cursor: pointer;
    font-size: 24px;
    line-height: 1;
}
.line-editor-float-toggle:hover {
    color: #1e4f6b;
    background: #ffffff;
}
.line-editor-float-toggle.collapsed {
    left: 12px;
}
.line-preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 62px;
    padding: 12px 18px;
    color: #172027;
    background: #ffffff;
    border-bottom: 1px solid rgba(25, 33, 38, 0.08);
}
.line-preview-toolbar strong,
.line-preview-toolbar span {
    display: block;
}
.line-preview-toolbar strong {
    font-size: 17px;
}
.line-preview-toolbar span {
    color: #6b737a;
    font-size: 12px;
}
.line-preview-metrics {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
}
.line-preview-metrics span {
    min-height: 26px;
    padding: 5px 9px;
    color: #3d474f;
    background: #f0f3f5;
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 999px;
    font-weight: 600;
}
.line-preview-stage {
    position: relative;
    align-self: stretch;
    height: 100%;
    min-height: clamp(620px, calc(100vh - 240px), 860px);
    margin: 12px;
    overflow: hidden;
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 8px;
    background:
        linear-gradient(rgba(68, 82, 91, .07) 1px, transparent 1px),
        linear-gradient(90deg, rgba(68, 82, 91, .07) 1px, transparent 1px),
        #edf2f4;
    background-size: 34px 34px;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.62);
}
.line-preview-stage::before {
    content: '';
    position: absolute;
    inset: 26px;
    border: 1px dashed rgba(74, 90, 100, 0.22);
    border-radius: 8px;
    pointer-events: none;
}
.line-preview-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #66727c;
}
.line-preview-legend {
    position: absolute;
    right: 18px;
    top: 14px;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    max-width: 520px;
}
.line-preview-legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 4px 8px;
    color: #44515a;
    background: rgba(255,255,255,.82);
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
}
.line-preview-legend i {
    width: 14px;
    height: 6px;
    border-radius: 999px;
}
.legend-lane { background: #98b7c9; }
.legend-rail { background: #c9953e; }
.legend-device { background: #596873; }
.legend-cart { background: #d4a43c; }
.line-preview-axis {
    position: absolute;
    z-index: 4;
    color: #66727c;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0;
}
.axis-x {
    left: 34px;
    bottom: 18px;
}
.axis-z {
    left: 18px;
    top: 44px;
    writing-mode: vertical-rl;
}
.line-align-guide {
    position: absolute;
    top: 28px;
    bottom: 28px;
    z-index: 7;
    width: 0;
    transform: translateX(-50%);
    border-left: 1px dashed rgba(28, 91, 126, 0.72);
    pointer-events: none;
}
.line-align-guide::before,
.line-align-guide::after {
    content: '';
    position: absolute;
    left: -4px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #2b7197;
    box-shadow: 0 0 0 3px rgba(43, 113, 151, 0.12);
}
.line-align-guide::before {
    top: 0;
}
.line-align-guide::after {
    bottom: 0;
}
.line-map-item {
    position: absolute;
    transform: translateY(-50%);
    display: flex;
    align-items: flex-start;
    padding: 8px 12px;
    color: #26323a;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    border-radius: 8px;
    cursor: grab;
    touch-action: none;
    user-select: none;
}
.line-map-item:active {
    cursor: grabbing;
}
.line-map-lane {
    height: 72px;
    background: rgba(117, 154, 176, 0.22);
    border: 1px solid rgba(70, 113, 139, 0.35);
}
.line-map-item.drop-compatible {
    outline: 1px dashed rgba(36, 92, 122, 0.38);
    outline-offset: 4px;
}
.line-map-item.drop-target {
    background: rgba(80, 149, 186, 0.30);
    border-color: rgba(36, 92, 122, 0.72);
    box-shadow: 0 0 0 4px rgba(36, 92, 122, 0.10);
}
.line-map-lane::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    top: 50%;
    height: 2px;
    transform: translateY(-50%);
    background: rgba(36, 92, 122, 0.42);
}
.line-map-flow-arrow {
    position: absolute;
    top: 50%;
    right: 18px;
    z-index: 2;
    width: 48px;
    height: 0;
    transform: translateY(-50%);
    border-top: 2px solid rgba(30, 79, 107, 0.78);
    pointer-events: none;
}
.line-map-flow-arrow::after {
    content: '';
    position: absolute;
    right: -1px;
    top: -5px;
    width: 8px;
    height: 8px;
    border-top: 2px solid rgba(30, 79, 107, 0.78);
    border-right: 2px solid rgba(30, 79, 107, 0.78);
    transform: rotate(45deg);
}
.line-map-flow-arrow.direction-left {
    left: 18px;
    right: auto;
}
.line-map-flow-arrow.direction-left::after {
    left: -1px;
    right: auto;
    transform: rotate(-135deg);
}
.line-map-rail {
    height: 30px;
    align-items: center;
    color: #6b4a0f;
    background: rgba(201, 149, 62, 0.18);
    border: 1px solid rgba(169, 113, 31, 0.45);
}
.line-map-rail.drop-target {
    background: rgba(209, 153, 55, 0.26);
    border-color: rgba(152, 107, 36, 0.78);
    box-shadow: 0 0 0 4px rgba(152, 107, 36, 0.11);
}
.line-map-rail::before,
.line-map-rail::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    height: 3px;
    background: #986b24;
    border-radius: 999px;
}
.line-map-rail::before { top: 9px; }
.line-map-rail::after { bottom: 9px; }
.line-map-rail span {
    position: relative;
    z-index: 1;
    padding: 2px 7px;
    background: rgba(255,255,255,.76);
    border-radius: 999px;
}
.line-map-handle {
    position: absolute;
    top: 50%;
    z-index: 3;
    width: 12px;
    height: 34px;
    transform: translateY(-50%);
    border-radius: 999px;
    background: rgba(255,255,255,.88);
    border: 1px solid rgba(25, 33, 38, 0.22);
    box-shadow: 0 2px 6px rgba(25, 33, 38, 0.12);
    cursor: ew-resize;
}
.line-map-handle::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 8px;
    bottom: 8px;
    width: 2px;
    transform: translateX(-50%);
    background: rgba(36, 92, 122, 0.45);
    border-radius: 999px;
}
.handle-left { left: -6px; }
.handle-right { right: -6px; }
.line-preview-dragging,
.line-preview-dragging * {
    cursor: grabbing !important;
    user-select: none !important;
}
.line-map-device {
    position: absolute;
    width: 126px;
    min-height: 54px;
    transform: translate(-50%, -50%);
    display: grid;
    gap: 2px;
    align-content: center;
    padding: 8px 10px;
    color: #f7fafb;
    background: linear-gradient(180deg, #6c7a84, #46535c);
    border: 1px solid rgba(25, 33, 38, 0.18);
    border-radius: 6px;
    box-shadow: 0 12px 24px rgba(38, 50, 58, .20);
    text-align: left;
    cursor: grab;
    touch-action: none;
    user-select: none;
}
.line-map-device::before {
    content: '';
    position: absolute;
    left: 8px;
    top: 8px;
    bottom: 8px;
    width: 4px;
    background: #9fb0ba;
    border-radius: 999px;
}
.line-map-device strong,
.line-map-device small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 10px;
}
.line-map-device strong {
    font-size: 12px;
}
.line-map-device small {
    color: rgba(255,255,255,.72);
    font-size: 11px;
}
.line-map-remove {
    position: absolute;
    right: 6px;
    top: 6px;
    z-index: 4;
    min-width: 38px;
    height: 24px;
    padding: 0 8px;
    color: #ffffff;
    background: rgba(23, 32, 39, 0.70);
    border: 1px solid rgba(255,255,255,0.22);
    border-radius: 999px;
    opacity: 0;
    transform: translateY(-3px);
    transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
}
.line-map-device:hover .line-map-remove,
.line-map-remove:focus-visible {
    opacity: 1;
    transform: translateY(0);
}
.line-map-remove:hover {
    background: rgba(137, 45, 45, 0.88);
}
.line-map-device.saving {
    opacity: .62;
    pointer-events: none;
}
.line-map-cart {
    color: #33240a;
    background: linear-gradient(180deg, #e2ba5f, #c8912e);
}
.line-map-cart::before {
    background: #765115;
}
.line-map-cart small {
    color: rgba(51,36,10,.72);
}
.line-device-ghost {
    z-index: 8;
    opacity: .88;
    pointer-events: none;
    box-shadow: 0 18px 42px rgba(38, 50, 58, .28);
}
.line-device-pool-dock {
    position: absolute;
    left: 28px;
    bottom: 26px;
    z-index: 18;
    max-width: min(760px, calc(100% - 56px));
    pointer-events: none;
}
.line-device-pool-dock.collapsed {
    max-width: none;
}
.line-device-pool-tab {
    pointer-events: auto;
    min-height: 38px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #ffffff;
    background: #245c7a;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 999px;
    box-shadow: 0 12px 28px rgba(38, 50, 58, .20);
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
}
.line-device-pool-dock:not(.collapsed) .line-device-pool-title {
    cursor: move;
    touch-action: none;
}
.line-device-pool-dock.collapsed .line-device-pool-tab {
    cursor: move;
    touch-action: none;
}
.line-device-pool-grip {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    opacity: .62;
    background:
        radial-gradient(currentColor 1px, transparent 1.5px) 0 0 / 6px 6px,
        radial-gradient(currentColor 1px, transparent 1.5px) 3px 3px / 6px 6px;
}
.line-device-pool {
    pointer-events: auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    max-width: 100%;
    padding: 10px 12px;
    overflow: visible;
    background: rgba(255,255,255,.94);
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 14px;
    box-shadow: 0 16px 40px rgba(38, 50, 58, .18);
    backdrop-filter: blur(10px);
}
.line-device-pool-title {
    min-width: 120px;
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    gap: 2px;
    padding-right: 8px;
    border-right: 1px solid rgba(25, 33, 38, 0.08);
}
.line-device-pool-title .line-device-pool-grip {
    grid-row: 1 / 3;
    align-self: center;
    color: #66727c;
}
.line-device-pool-title strong {
    color: #172027;
    font-size: 13px;
}
.line-device-pool-title span {
    color: #6b737a;
    font-size: 11px;
    white-space: nowrap;
}
.line-device-pool-chip {
    min-width: 118px;
    max-width: 150px;
    min-height: 46px;
    display: grid;
    gap: 2px;
    align-content: center;
    padding: 7px 10px;
    color: #34434c;
    background: #eef2f4;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 8px;
    cursor: grab;
    text-align: left;
    touch-action: none;
}
.line-device-pool-close {
    min-width: 52px;
    height: 34px;
    padding: 0 10px;
    color: #50616c;
    background: #edf1f3;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
}
.line-device-pool-close:hover {
    color: #1e4f6b;
    background: #ffffff;
}
.line-device-pool-chip.cart {
    color: #5f4311;
    background: #f4e5bd;
    border-color: rgba(152, 107, 36, 0.25);
}
.line-device-pool-chip.saving {
    opacity: .58;
    pointer-events: none;
}
.line-device-pool-chip strong,
.line-device-pool-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.line-device-pool-chip strong {
    font-size: 12px;
}
.line-device-pool-chip span {
    color: currentColor;
    opacity: .72;
    font-size: 11px;
}
.line-preview-empty-state {
    position: absolute;
    left: 50%;
    bottom: 26px;
    transform: translateX(-50%);
    padding: 8px 12px;
    color: #596873;
    background: rgba(255,255,255,.82);
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
}

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

.composer-grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.composer-grid-3 .input {
    padding-left: 9px;
    padding-right: 9px;
}

.composer-rotation-control {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: #f7f8fa;
}

.composer-control-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: #515154;
    font-size: 13px;
    font-weight: 600;
}

.composer-control-header strong {
    color: #1d1d1f;
    font-size: 16px;
}

.composer-rotation-presets,
.composer-rotation-nudges {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
}

.composer-rotation-presets .btn,
.composer-rotation-nudges .btn {
    min-width: 0;
    padding: 8px 6px;
}

.composer-rotation-presets .btn.active {
    color: #ffffff;
    background: #0071e3;
}

.composer-mirror-control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: #f7f8fa;
}
.composer-mirror-control strong {
    display: block;
    color: #1d1d1f;
    font-size: 13px;
}
.composer-mirror-control span {
    display: block;
    margin-top: 3px;
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
}
.composer-mirror-control .btn.active {
    color: #ffffff;
    background: #1f7a4d;
}

.nudge-pad {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
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
.points-table { min-width: 1080px; }
.points-table.points-table-advanced { min-width: 1480px; }
.points-table td { padding: 10px 6px; }
.points-table .input-sm { width: 100%; }
.points-table .number-input { width: 90px; }
.points-table .bit-input { width: 64px; }
.points-table .sample-input { width: 110px; }
.points-table .access-input { width: 86px; }
.points-table .point-name-input { min-width: 150px; }
.points-table .point-usage-input { min-width: 132px; }
.points-table .plc-address-input { min-width: 280px; }
.points-table .expression-input { min-width: 150px; }
.points-table .unit-input { width: 80px; }
.points-table .alarm-text-input { min-width: 180px; }
.points-table .device-point-select { min-width: 180px; }
.muted-cell { color: #86868b; font-size: 12px; }
.alarm-config-card {
    margin-top: 18px;
    padding: 18px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
}
.alarm-config-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
    margin-bottom: 14px;
}
.alarm-config-header h3 { margin: 0 0 6px; font-size: 16px; color: #1d1d1f; }
.alarm-config-header p { margin: 0; color: #6e6e73; font-size: 13px; line-height: 1.6; }
.alarm-config-count {
    white-space: nowrap;
    padding: 6px 10px;
    border-radius: 999px;
    background: #f5f5f7;
    color: #515154;
    font-size: 12px;
}
.alarm-record-status {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
}
.alarm-record-status > div {
    padding: 10px 12px;
    border-radius: 8px;
    background: #f5f5f7;
    color: #6e6e73;
    display: flex;
    justify-content: space-between;
    font-size: 13px;
}
.alarm-record-status > div.configured {
    background: #eef7f1;
    color: #1f7a3a;
}
.alarm-import-layout {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) 260px;
    gap: 14px;
}
.alarm-textarea {
    min-height: 170px;
    resize: vertical;
    line-height: 1.6;
    font-family: Consolas, "Microsoft YaHei", monospace;
}
.alarm-import-side {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.alarm-preview {
    flex: 1;
    min-height: 80px;
    padding: 10px 12px;
    border-radius: 8px;
    background: #f5f5f7;
    color: #515154;
    font-size: 12px;
    line-height: 1.7;
    overflow: auto;
}
.plc-status-table { min-width: 980px; margin-bottom: 0; }
.point-monitor-toolbar {
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 18px;
}
.inline-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 38px;
    padding: 0 12px;
    color: #515154;
    font-size: 13px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
    background: #fbfbfd;
}
.point-monitor-status {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 18px;
}
.point-monitor-status > div {
    min-width: 0;
    display: grid;
    gap: 8px;
    padding: 14px;
    background: #fbfbfd;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 10px;
}
.point-monitor-status strong {
    min-width: 0;
    color: #1d1d1f;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.status-label {
    color: #86868b;
    font-size: 12px;
}
.inline-error {
    margin-bottom: 14px;
    padding: 10px 12px;
    color: #9f1d17;
    background: rgba(255, 59, 48, 0.08);
    border: 1px solid rgba(255, 59, 48, 0.16);
    border-radius: 8px;
    font-size: 13px;
    white-space: pre-line;
}
.realtime-points-table { min-width: 1180px; margin-bottom: 0; }
.point-value-cell {
    color: #111827;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}
.point-quality-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 52px;
    min-height: 24px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    border: 1px solid rgba(0, 0, 0, 0.06);
}
.quality-good { color: #1b6b3a; background: rgba(52, 199, 89, 0.12); border-color: rgba(52, 199, 89, 0.22); }
.quality-stale { color: #7a4b00; background: rgba(255, 204, 0, 0.16); border-color: rgba(255, 204, 0, 0.28); }
.quality-bad { color: #9f1d17; background: rgba(255, 59, 48, 0.12); border-color: rgba(255, 59, 48, 0.24); }
.model-name-cell {
    display: grid;
    gap: 4px;
}
.model-name-cell strong {
    color: #1d1d1f;
    font-size: 13px;
    font-weight: 600;
}
.model-name-cell small {
    color: #86868b;
    font-family: SFMono-Regular, Consolas, Monaco, monospace;
    font-size: 11px;
}
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
.plc-meta-lines {
    display: grid;
    gap: 2px;
    margin-top: 6px;
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
}
.plc-connected { color: #1b6b3a; background: rgba(52, 199, 89, 0.12); border-color: rgba(52, 199, 89, 0.24); }
.plc-connecting, .plc-idle { color: #6c5800; background: rgba(255, 204, 0, 0.14); border-color: rgba(255, 204, 0, 0.24); }
.plc-retrying, .plc-no_points, .plc-unconfigured { color: #8a4b0f; background: rgba(255, 149, 0, 0.13); border-color: rgba(255, 149, 0, 0.24); }
.plc-error, .plc-unsupported { color: #9f1d17; background: rgba(255, 59, 48, 0.12); border-color: rgba(255, 59, 48, 0.24); }
.plc-disabled, .plc-stopped { color: #6e6e73; background: #f5f5f7; }
.widget-layout-editor {
    display: block;
}
.widget-layout-form {
    min-width: 0;
}
.widget-layout-row {
    cursor: pointer;
}
.widget-layout-row.active {
    background: rgba(0, 113, 227, 0.08);
    box-shadow: inset 3px 0 0 #0071e3;
}
.widget-preview-popover {
    position: fixed;
    width: 560px;
    max-width: calc(100vw - 32px);
    overflow: hidden;
    border: 1px solid rgba(66, 165, 245, 0.32);
    border-radius: 14px;
    background: #10161b;
    box-shadow: 0 22px 60px rgba(8, 15, 20, 0.36);
    z-index: 9999;
    pointer-events: none;
}
.widget-live-preview {
    position: sticky;
    top: 16px;
    min-width: 0;
    overflow: hidden;
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 12px;
    background: #10161b;
    box-shadow: 0 18px 42px rgba(25, 33, 38, 0.16);
}
.widget-live-preview-header,
.widget-live-preview-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    color: #dfe7ec;
    background: #151d23;
    border-bottom: 1px solid rgba(255,255,255,0.08);
}
.widget-live-preview-header strong {
    display: block;
    font-size: 14px;
}
.widget-live-preview-header span,
.widget-live-preview-header small,
.widget-live-preview-footer span {
    color: #9eabb5;
    font-size: 12px;
}
.widget-live-preview-footer {
    border-top: 1px solid rgba(255,255,255,0.08);
    border-bottom: 0;
}
.widget-hover-preview-stage {
    position: relative;
    height: 310px;
    overflow: hidden;
    background:
        linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        radial-gradient(circle at 50% 34%, rgba(80, 115, 128, 0.26), transparent 48%),
        #0f151a;
}
.widget-hover-preview-canvas {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
    transition: transform .16s ease;
}
.widget-live-preview-stage {
    position: relative;
    aspect-ratio: 16 / 9;
    min-height: 360px;
    overflow: hidden;
    background:
        linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        radial-gradient(circle at 50% 34%, rgba(80, 115, 128, 0.26), transparent 48%),
        #0f151a;
}
.widget-preview-slot {
    position: absolute;
    min-width: 90px;
    min-height: 56px;
    padding: 5px;
    overflow: hidden;
    border: 1px solid rgba(120, 176, 205, 0.18);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color .15s ease, box-shadow .15s ease, opacity .15s ease;
}
.widget-preview-slot.active {
    border-color: #42a5f5;
    box-shadow: 0 0 0 2px rgba(66, 165, 245, .32), 0 12px 30px rgba(0,0,0,.28);
    z-index: 5;
}
.widget-preview-slot.hidden {
    opacity: .45;
    border-style: dashed;
}
.widget-preview-placeholder {
    width: 100%;
    height: 100%;
    display: grid;
    align-content: center;
    gap: 5px;
    padding: 10px;
    color: #dfe7ec;
    background: rgba(21, 29, 35, .88);
    border-radius: 6px;
}
.widget-preview-placeholder strong,
.widget-preview-placeholder span,
.widget-preview-placeholder small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.widget-preview-placeholder strong { font-size: 13px; }
.widget-preview-placeholder span { color: #9fd3f2; font-size: 12px; }
.widget-preview-placeholder small { color: #9eabb5; font-size: 11px; }
.widget-preview-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #9eabb5;
    font-size: 13px;
}
.widget-preview-slot :deep(.widget-shell) {
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px;
    color: #e8ecef;
    background: rgba(22, 29, 35, .9);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 7px;
}
.widget-preview-slot :deep(.widget-title) {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    color: #e8ecef;
    font-size: 12px;
    font-weight: 700;
}
.widget-preview-slot :deep(.widget-title i) {
    width: 3px;
    height: 13px;
    border-radius: 999px;
    background: #42a5f5;
}
.widget-preview-slot :deep(.metrics-layout) {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(96px, 38%) minmax(0, 1fr);
    gap: 8px;
}
.widget-preview-slot :deep(.widget-chart) {
    min-height: 0;
    height: 100%;
}
.widget-preview-slot :deep(.metric-list),
.widget-preview-slot :deep(.alarm-list) {
    min-height: 0;
    overflow: hidden;
}
.widget-preview-slot :deep(.metric-row) {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 0;
    color: #aeb7bf;
    font-size: 11px;
}
.widget-preview-slot :deep(.metric-row strong) {
    color: #fff;
}
.widget-preview-slot :deep(.alarm-list) {
    margin: 0;
    padding: 0;
    list-style: none;
}
.widget-preview-slot :deep(.alarm-list li) {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) 52px;
    gap: 6px;
    align-items: center;
    min-height: 26px;
    color: #cbd5dc;
    font-size: 11px;
}
.widget-preview-slot :deep(.alarm-txt) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.widget-preview-slot :deep(.rank),
.widget-preview-slot :deep(.tag) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 20px;
    border-radius: 999px;
    background: rgba(255,255,255,.08);
}
.widget-preview-slot :deep(.tag) {
    font-size: 10px;
}
.widget-preview-slot :deep(.critical) { color: #ff8a80; }
.widget-preview-slot :deep(.warning) { color: #ffd180; }
.widget-preview-slot :deep(.info) { color: #9ad4f5; }
.widget-preview-slot :deep(.marquee-content-wrap) {
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
.widget-preview-slot :deep(.marquee-content) {
    display: flex;
    height: 100%;
    align-items: center;
    white-space: nowrap;
    animation: marqueeRoll 30s linear infinite;
}
.widget-preview-slot :deep(.marquee-item) {
    margin-right: 32px;
    color: #d2d8dc;
    font-size: 12px;
}
.widget-preview-slot :deep(.text-widget-body) {
    flex: 1;
    display: grid;
    align-content: center;
    gap: 6px;
    color: #e8ecef;
    font-size: 14px;
    line-height: 1.45;
}
.widget-preview-slot :deep(.text-widget-body p) {
    margin: 0;
}
.widget-device-detail-preview,
.widget-device-label-preview,
.widget-line-card-preview {
    position: absolute;
    inset: 14px;
    display: grid;
    place-items: center;
}
.widget-device-card {
    width: min(500px, 100%);
    min-height: 246px;
    padding: 16px;
    border: 1px solid rgba(66, 165, 245, 0.24);
    border-radius: 14px;
    color: #e8ecef;
    background:
        linear-gradient(135deg, rgba(66,165,245,.13), transparent 32%),
        rgba(17, 25, 31, .94);
    box-shadow: 0 18px 40px rgba(0,0,0,.28);
}
.device-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
}
.device-card-header strong {
    font-size: 16px;
}
.device-card-header span {
    color: #9fd3f2;
    font-size: 12px;
}
.diagnostic-preview-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}
.diagnostic-preview-group {
    min-height: 84px;
    padding: 10px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 10px;
    background: rgba(255,255,255,.035);
}
.diagnostic-preview-group > strong {
    display: block;
    margin-bottom: 8px;
    color: #fff;
    font-size: 12px;
}
.diagnostic-preview-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 0;
    color: #aeb7bf;
    font-size: 11px;
}
.diagnostic-preview-row b {
    color: #f6fbff;
    font-weight: 700;
}
.diagnostic-preview-row small {
    color: #91a3af;
    font-weight: 500;
}
.widget-device-label-preview {
    place-items: center;
    color: #dfe7ec;
}
.mock-device-block {
    width: 210px;
    height: 118px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 12px;
    background: linear-gradient(135deg, #343d42, #151a1d);
    box-shadow: inset 0 -24px 0 rgba(0,0,0,.28), 0 20px 45px rgba(0,0,0,.26);
}
.mock-device-label {
    position: absolute;
    top: 32px;
    left: 50%;
    display: grid;
    gap: 4px;
    min-width: 150px;
    padding: 10px 12px;
    border: 1px solid rgba(240, 179, 90, .48);
    border-radius: 8px;
    color: #f7fbff;
    background: rgba(20, 25, 29, .88);
    transform: translateX(-50%);
}
.mock-device-label strong {
    color: var(--device-label-title-color, #f2b85b);
}
.mock-device-label span {
    color: var(--device-label-text-color, #b7c4cc);
    font-size: 12px;
}
.mock-device-label span::first-letter {
    color: var(--device-label-value-color, #fff);
}
.widget-device-label-preview > small {
    position: absolute;
    bottom: 16px;
    color: #9eabb5;
}
.widget-line-card-preview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    place-items: stretch;
}
.mock-line-card {
    display: grid;
    align-content: center;
    gap: 8px;
    padding: 14px;
    border: 1px solid rgba(66, 165, 245, .22);
    border-radius: 12px;
    color: #e8ecef;
    background: rgba(18, 26, 32, .9);
}
.mock-line-card strong {
    color: #fff;
}
.mock-line-card span {
    color: #aeb7bf;
    font-size: 12px;
}
@keyframes marqueeRoll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
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

.app-dialog-overlay {
    position: fixed;
    inset: 0;
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(17, 24, 39, 0.28);
    backdrop-filter: blur(10px);
}
.app-dialog {
    width: min(440px, calc(100vw - 40px));
    display: grid;
    grid-template-columns: 4px 1fr;
    gap: 0 18px;
    padding: 20px;
    color: #1d1d1f;
    background: rgba(255, 255, 255, 0.96);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 14px;
    box-shadow: 0 24px 70px rgba(17, 24, 39, 0.22), 0 2px 6px rgba(17, 24, 39, 0.08);
    animation: sheetIn 0.22s cubic-bezier(0.25, 1, 0.5, 1);
}
.app-dialog-mark {
    grid-row: 1 / span 2;
    width: 4px;
    border-radius: 999px;
    background: #0071e3;
}
.dialog-success .app-dialog-mark { background: #34c759; }
.dialog-warning .app-dialog-mark { background: #ff9500; }
.dialog-danger .app-dialog-mark { background: #ff3b30; }
.app-dialog-body h3 {
    margin: 0 0 8px;
    color: #1d1d1f;
    font-size: 17px;
    font-weight: 700;
}
.app-dialog-body p {
    margin: 0;
    color: #515154;
    font-size: 14px;
    line-height: 1.55;
    white-space: pre-line;
}
.app-dialog-actions {
    grid-column: 2;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
}

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
.asset-status-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 64px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    color: #515154;
    background: #eef0f2;
}
.asset-status-review {
    color: #7a4b00;
    background: #fff0cc;
}
.asset-status-accepted {
    color: #11613a;
    background: #dff6ea;
}
.asset-status-released {
    color: #0b4f8a;
    background: #dceeff;
}
.model-asset-governance {
    margin-top: 18px;
    padding: 18px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #ffffff;
}
.model-governance-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.model-workflow-rail {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
}
.model-workflow-step {
    min-height: 64px;
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 2px 8px;
    align-items: center;
    padding: 8px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
    background: #f6f7f8;
}
.model-workflow-step strong {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: #707074;
    background: #e5e7ea;
    font-size: 12px;
}
.model-workflow-step span {
    color: #1d1d1f;
    font-size: 13px;
    font-weight: 700;
}
.model-workflow-step small {
    grid-column: 2;
    min-width: 0;
    overflow: hidden;
    color: #86868b;
    font-size: 12px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.model-workflow-step.passed {
    border-color: rgba(17, 97, 58, 0.25);
    background: #f1faf5;
}
.model-workflow-step.passed strong {
    color: #ffffff;
    background: #1b7f4f;
}
.model-workflow-step.optional {
    border-color: rgba(240, 179, 90, 0.35);
    background: #fffaf0;
}
.model-stats-strip {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
}
.model-stats-strip span {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 8px;
    border-radius: 8px;
    background: #f5f6f7;
    color: #515154;
    font-size: 12px;
    white-space: nowrap;
}
.model-spec-form {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 14px;
}
.model-spec-form label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: #515154;
    font-size: 12px;
    font-weight: 500;
}
.model-spec-form .wide-form-section {
    grid-column: 1 / -1;
}
.model-acceptance-summary {
    margin: 4px 0 10px;
    color: #7a4b00;
    font-size: 13px;
    font-weight: 600;
}
.model-acceptance-summary.ready {
    color: #11613a;
}
.model-acceptance-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
}
.model-acceptance-item {
    min-height: 74px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px;
    border: 1px solid rgba(217, 96, 96, 0.35);
    border-radius: 8px;
    background: #fff7f7;
}
.model-acceptance-item.passed {
    border-color: rgba(17, 97, 58, 0.25);
    background: #f2fbf6;
}
.model-acceptance-item.warning {
    border-color: rgba(240, 179, 90, 0.35);
    background: #fffaf0;
}
.model-acceptance-item strong {
    color: #1d1d1f;
    font-size: 12px;
}
.model-acceptance-item span {
    color: #515154;
    font-size: 13px;
    font-weight: 600;
}
.model-acceptance-item small {
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
}
.model-release-history {
    margin-top: 14px;
}
.model-release-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: #515154;
    font-size: 13px;
}
.model-release-header strong {
    color: #1d1d1f;
    font-size: 14px;
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

.model-node-picker {
    min-width: 0;
}
.model-node-tools {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}
.node-filter-toggle {
    min-height: 38px;
    white-space: nowrap;
    background: #ffffff;
}
.field-hint {
    color: #86868b;
    font-size: 11px;
    line-height: 1.45;
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
.model-binding-row {
    cursor: pointer;
}
.model-binding-row:hover {
    background: rgba(0, 113, 227, 0.04);
}
.model-binding-row.active {
    background: rgba(0, 113, 227, 0.08);
    box-shadow: inset 3px 0 0 #0071e3;
}
.model-binding-bottom-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 10px 0 8px;
    padding: 12px 14px;
    color: #68686d;
    background: #fbfbfd;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 10px;
    font-size: 12px;
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
.model-preview-node-card {
    position: absolute;
    left: 12px;
    top: 12px;
    z-index: 2;
    max-width: min(360px, calc(100% - 88px));
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    color: #172027;
    background: rgba(255, 255, 255, 0.88);
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 10px;
    box-shadow: 0 10px 28px rgba(25, 33, 38, 0.12);
    backdrop-filter: blur(10px);
    pointer-events: none;
}
.model-preview-node-card strong,
.model-preview-node-card small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.model-preview-node-card strong {
    font-size: 13px;
}
.model-preview-node-card span {
    color: #4b5a64;
    font-size: 12px;
}
.model-preview-node-card small {
    color: #7c858c;
    font-family: SFMono-Regular, Consolas, Monaco, monospace;
    font-size: 11px;
}
.model-preview-reset {
    position: absolute;
    right: 12px;
    top: 12px;
    z-index: 3;
    height: 32px;
    padding: 0 10px;
    color: #23323b;
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 999px;
    box-shadow: 0 8px 22px rgba(25, 33, 38, 0.12);
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
}
.model-preview-reset:hover {
    background: #ffffff;
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
.model-preview-selected-text {
    margin-top: 4px;
    color: #1d5f7c;
    font-weight: 600;
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
.render-setting-readonly { display: flex; align-items: center; color: #1d1d1f; background: #f5f5f7; }
.render-profile-hint { margin-top: 16px; }
.render-profile-hint p { margin: 4px 0; }
.render-custom-grid { margin-top: 18px; padding-top: 18px; border-top: 1px solid #e5e5e7; }
.checkbox-line { display: flex; align-items: center; gap: 8px; min-height: 38px; font-weight: 400; }
.database-backup-panel { margin-top: 22px; padding-top: 20px; border-top: 1px solid #e5e5e7; }
.database-backup-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.database-backup-header p { margin: 6px 0 0; color: #6e6e73; font-size: 13px; line-height: 1.6; }
.database-recovery-notice { margin: 14px 0 0; padding: 10px 12px; background: #fff8e6; border-left: 3px solid #c68a00; color: #5c4300; font-size: 13px; }
.database-backup-message { margin: 12px 0 0; color: #515154; font-size: 13px; }
.database-backup-list { margin-top: 14px; border-top: 1px solid #e5e5e7; }
.database-backup-row { display: grid; grid-template-columns: minmax(280px, 1fr) auto auto auto; align-items: center; gap: 10px; min-height: 58px; padding: 8px 0; border-bottom: 1px solid #ededee; }
.database-backup-row > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.database-backup-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.database-backup-row span { color: #6e6e73; font-size: 12px; }
.backup-validity { white-space: nowrap; }
.backup-validity.is-valid { color: #16713a; }
.backup-validity.is-invalid { color: #b42318; }
.btn-small { min-height: 32px; padding: 5px 10px; font-size: 12px; }
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
    .model-workflow-rail,
    .model-stats-strip,
    .model-acceptance-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .model-spec-form {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .database-backup-row {
        grid-template-columns: minmax(220px, 1fr) auto auto;
    }
    .backup-validity {
        grid-column: 1 / -1;
        grid-row: 2;
    }
}
</style>
