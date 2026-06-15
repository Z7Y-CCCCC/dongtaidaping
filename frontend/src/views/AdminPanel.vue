<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { adminApi } from '../config/factoryConfig.js'

// 当前选中的 Tab
const activeTab = ref('workshops')

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
const editingDevice = reactive({
    id: '', name: '', line_id: '', model_type: 'builtin_furnace', model_file: '',
    pos_x: 0, pos_y: 0, pos_z: 0, rotation_y: 0, scale: 1.0
})
const isEditMode = ref(false)

async function loadDevices() {
    devices.value = await adminApi.getDevices()
}

function openCreateDevice() {
    isEditMode.value = false
    Object.assign(editingDevice, { 
        id: '', name: '', line_id: lines.value[0]?.id || '', 
        model_type: 'builtin_furnace', model_file: '',
        pos_x: 0, pos_y: 0, pos_z: 0, rotation_y: 0, scale: 1.0 
    })
    showDeviceForm.value = true
}

function openEditDevice(d) {
    isEditMode.value = true
    Object.assign(editingDevice, d)
    showDeviceForm.value = true
}

async function saveDevice() {
    if (!editingDevice.id || !editingDevice.name || !editingDevice.line_id) {
        return alert('请填写设备ID、名称和所属产线')
    }
    if (isEditMode.value) {
        await adminApi.updateDevice(editingDevice.id, { ...editingDevice })
    } else {
        await adminApi.createDevice({ ...editingDevice })
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

async function loadDataPoints() {
    if (!selectedDeviceForPoints.value) { dataPoints.value = []; return }
    dataPoints.value = await adminApi.getDataPoints(selectedDeviceForPoints.value)
    isPointsDirty.value = false
}

function addDataPoint() {
    dataPoints.value.push({
        name: '', label: '', plc_tag: '', data_type: 'WORD', unit: '', alarm_high: null, alarm_low: null
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

async function saveAllPoints() {
    if (!selectedDeviceForPoints.value) return alert('请先选择设备')
    const validPoints = dataPoints.value.filter(p => p.name && p.label && p.plc_tag)
    await adminApi.saveDataPointsBatch(selectedDeviceForPoints.value, validPoints)
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
    data_mode: 'mqtt',
    // MQTT 通道参数（方案A）
    mqtt_broker: '',
    mqtt_topic_prefix: '',
    // C# 上位机参数（方案A 补充）
    csharp_host_ip: '',
    csharp_host_port: '8080',
    // PLC 通信参数（方案B 直连 / 方案A 中 C# 上位机也需要这些）
    plc_ip: '',
    plc_port: '102',
    plc_rack: '0',
    plc_slot: '1',
    plc_poll_interval: '2000',
    // PLC 连接超时与重试
    plc_timeout: '5000',
    plc_retry_interval: '10000',
    // 视角模式
    camera_mode: 'auto'
})

async function loadSettings() {
    const s = await adminApi.getSettings()
    Object.assign(settings, s)
    // 同时获取引擎状态
    loadEngineStatus()
}

const engineStatus = reactive({ mode: null, plcStatus: { status: 'unknown', message: '未知' } })

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

async function saveSettings() {
    await adminApi.saveSettings({ ...settings })
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

async function loadModels() {
    models.value = await adminApi.getModels()
}

async function uploadModel(event) {
    const file = event.target.files[0]
    if (!file) return
    const modelId = file.name.replace(/\.[^.]+$/, '').replace(/\s+/g, '_')
    const fd = new FormData()
    fd.append('modelFile', file)
    fd.append('id', modelId)
    fd.append('name', file.name)
    await adminApi.uploadModel(fd)
    await loadModels()
    event.target.value = ''
}

async function deleteModel(id) {
    if (!confirm(`确定删除模型 ${id}？`)) return
    await adminApi.deleteModel(id)
    await loadModels()
}

// ============ 生命周期 ============
onMounted(async () => {
    await loadWorkshops()
    await Promise.all([loadLines(), loadDevices(), loadSettings(), loadModels()])
    if (!newLine.workshop_id && workshops.value.length > 0) {
        newLine.workshop_id = workshops.value[0].id
    }
})

// 设备按产线分组
const devicesByLine = computed(() => {
    const map = {}
    devices.value.forEach(d => {
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

const tabs = [
    { key: 'workshops', label: '🏢 车间管理', icon: '🏢' },
    { key: 'lines', label: '🏭 产线管理', icon: '🏭' },
    { key: 'devices', label: '🔧 设备管理', icon: '🔧' },
    { key: 'models', label: '📦 模型库', icon: '📦' },
    { key: 'points', label: '📡 点位映射', icon: '📡' },
    { key: 'settings', label: '⚙️ 连接设置', icon: '⚙️' }
]
</script>

<template>
    <div class="admin-container">
        <!-- 顶部标题栏 -->
        <header class="admin-header">
            <h1>🛠️ 数字孪生后台配置管理</h1>
            <a href="/" class="back-link">← 返回大屏</a>
        </header>

        <div class="admin-body">
            <!-- 左侧 Tab 导航 -->
            <nav class="admin-nav">
                <div v-for="tab in tabs" :key="tab.key"
                     class="nav-item" :class="{ active: activeTab === tab.key }"
                     @click="activeTab = tab.key">
                    {{ tab.label }}
                </div>
            </nav>

            <!-- 右侧内容区 -->
            <main class="admin-content">

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
                                <td>{{ (devicesByLine[line.id] || []).length }} 台</td>
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
                                <label>所属产线
                                    <select v-model="editingDevice.line_id" class="input">
                                        <option v-for="l in lines" :key="l.id" :value="l.id">{{ l.name }}</option>
                                    </select>
                                </label>
                                <label>使用模型
                                    <select v-model="editingDevice.model_type" class="input">
                                        <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
                                    </select>
                                </label>
                                <label>X 坐标<input v-model.number="editingDevice.pos_x" type="number" class="input" /></label>
                                <label>Y 坐标<input v-model.number="editingDevice.pos_y" type="number" class="input" /></label>
                                <label>Z 坐标<input v-model.number="editingDevice.pos_z" type="number" class="input" /></label>
                                <label>旋转角度(Y)<input v-model.number="editingDevice.rotation_y" type="number" step="0.1" class="input" /></label>
                                <label>缩放比例<input v-model.number="editingDevice.scale" type="number" step="0.1" class="input" /></label>
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
                                <tr><th>ID</th><th>名称</th><th>模型</th><th>坐标 (X,Y,Z)</th><th>操作</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="d in (devicesByLine[line.id] || [])" :key="d.id">
                                    <td><code>{{ d.id }}</code></td>
                                    <td>{{ d.name }}</td>
                                    <td>{{ d.model_type }}</td>
                                    <td>{{ d.pos_x }}, {{ d.pos_y }}, {{ d.pos_z }}</td>
                                    <td>
                                        <button @click="openEditDevice(d)" class="btn btn-sm">编辑</button>
                                        <button @click="deleteDevice(d.id)" class="btn btn-danger btn-sm">删除</button>
                                    </td>
                                </tr>
                                <tr v-if="!(devicesByLine[line.id] || []).length">
                                    <td colspan="5" style="text-align:center;color:#888">暂无设备</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ======== 模型库 ======== -->
                <div v-if="activeTab === 'models'" class="tab-content">
                    <h2>3D 模型库</h2>
                    <p class="desc">上传 <code>.glb</code> 格式的 3D 模型文件。设备可选择使用上传的自定义模型或内置默认模型。</p>

                    <div class="upload-area">
                        <label class="btn btn-primary" style="cursor:pointer">
                            📂 选择 .glb 文件上传
                            <input type="file" accept=".glb,.gltf" @change="uploadModel" hidden />
                        </label>
                    </div>

                    <table class="data-table">
                        <thead>
                            <tr><th>ID</th><th>名称</th><th>文件路径</th><th>操作</th></tr>
                        </thead>
                        <tbody>
                            <tr v-for="m in models" :key="m.id">
                                <td><code>{{ m.id }}</code></td>
                                <td>{{ m.name }}</td>
                                <td>{{ m.file_path || '（内置）' }}</td>
                                <td>
                                    <button v-if="!m.is_builtin" @click="deleteModel(m.id)" class="btn btn-danger btn-sm">删除</button>
                                    <span v-else style="color:#888">系统内置</span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- ======== 点位映射 ======== -->
                <div v-if="activeTab === 'points'" class="tab-content">
                    <h2>PLC 点位映射</h2>
                    <p class="desc">为每台设备配置 PLC 数据地址。地址格式为西门子标准格式，如 <code>DB1.DBW3000</code>。</p>

                    <div class="form-row" style="margin-bottom:20px; align-items: flex-end;">
                        <div>
                            <label style="font-size:12px; color:#8c8c8c; display:block; margin-bottom:5px;">选择要配置的设备</label>
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
                        <table class="data-table points-table">
                            <thead>
                                <tr>
                                    <th>数据项名称</th><th>显示标签</th><th>PLC 地址</th>
                                    <th>数据类型</th><th>单位</th><th>报警上限</th><th>报警下限</th><th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="(p, idx) in dataPoints" :key="idx">
                                    <td><input v-model="p.name" @input="markPointsDirty" class="input input-sm" placeholder="actual_temp" /></td>
                                    <td><input v-model="p.label" @input="markPointsDirty" class="input input-sm" placeholder="实际温度" /></td>
                                    <td><input v-model="p.plc_tag" @input="markPointsDirty" class="input input-sm" placeholder="DB1.DBW3000" /></td>
                                    <td>
                                        <select v-model="p.data_type" @change="markPointsDirty" class="input input-sm">
                                            <option value="BOOL">BOOL (DBX)</option>
                                            <option value="WORD">WORD (DBW)</option>
                                            <option value="INT">INT (DBW signed)</option>
                                            <option value="DWORD">DWORD (DBD)</option>
                                            <option value="REAL">REAL (DBD float)</option>
                                        </select>
                                    </td>
                                    <td><input v-model="p.unit" @input="markPointsDirty" class="input input-sm" placeholder="°C" style="width:60px" /></td>
                                    <td><input v-model.number="p.alarm_high" @input="markPointsDirty" type="number" class="input input-sm" style="width:80px" /></td>
                                    <td><input v-model.number="p.alarm_low" @input="markPointsDirty" type="number" class="input input-sm" style="width:80px" /></td>
                                    <td><button @click="removeDataPoint(idx)" class="btn btn-danger btn-sm">✕</button></td>
                                </tr>
                                <tr v-if="dataPoints.length === 0">
                                    <td colspan="8" style="text-align:center; padding: 20px; color: #8c8c8c;">该设备暂无点位配置，请手动添加或从其他设备复制。</td>
                                </tr>
                            </tbody>
                        </table>

                        <div style="margin-top:15px;display:flex; justify-content: space-between; align-items: center;">
                            <button @click="addDataPoint" class="btn">+ 手动添加数据项</button>
                            <div style="display:flex; align-items: center; gap: 15px;">
                                <span v-if="isPointsDirty" style="color: #faad14; font-size: 13px;">⚠️ 存在未保存的修改</span>
                                <button @click="saveAllPoints" class="btn btn-primary" :disabled="!isPointsDirty && dataPoints.length > 0">💾 保存当前设备配置</button>
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
                            <span>运行模式：{{ engineStatus.mode === 'mqtt' ? '方案A (MQTT)' : engineStatus.mode === 'node_s7' ? '方案B (S7直连)' : engineStatus.mode === 'simulation' ? '模拟模式' : '未启动' }}</span>
                            <span>PLC 状态：{{ engineStatus.plcStatus?.message || '未知' }}</span>
                        </div>
                    </div>

                    <div class="settings-form" style="max-width:700px">

                        <!-- ===== 基础设置 ===== -->
                        <div class="settings-section">
                            <h3 class="section-title">🏭 基础设置</h3>
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
                            </div>
                        </div>

                        <!-- ===== 数据通路选择 ===== -->
                        <div class="settings-section">
                            <h3 class="section-title">🔀 数据通路模式</h3>
                            <label>选择数据采集方式
                                <select v-model="settings.data_mode" class="input">
                                    <option value="mqtt">方案A: C# 上位机 → MQTT 中转</option>
                                    <option value="node_s7">方案B: Node.js 直连 S7 PLC</option>
                                    <option value="simulation">模拟数据（离线演示用）</option>
                                </select>
                            </label>
                            <div class="mode-hint">
                                <template v-if="settings.data_mode === 'mqtt'">
                                    <p>📋 <strong>方案A 数据流：</strong>PLC ← C# 上位机读取 → MQTT Broker → 前端 WebSocket 订阅</p>
                                    <p style="color:#8c8c8c; font-size:12px;">适用于已有 C# 上位机程序、通过 MQTT 中转数据的场景。前端通过 WebSocket 连接 MQTT Broker 实时接收数据。</p>
                                </template>
                                <template v-else-if="settings.data_mode === 'node_s7'">
                                    <p>📋 <strong>方案B 数据流：</strong>PLC ← Node.js 后端直连 (S7comm) → WebSocket → 前端</p>
                                    <p style="color:#8c8c8c; font-size:12px;">适用于无 C# 上位机、后端直接通过 S7 协议读取西门子 PLC 数据的场景。需要 PLC 端开放 ISO-on-TCP 通信。</p>
                                </template>
                                <template v-else>
                                    <p>📋 <strong>模拟模式：</strong>系统自动生成随机数据，无需连接任何外部设备。</p>
                                    <p style="color:#8c8c8c; font-size:12px;">适用于离线演示、功能验收。数据为程序模拟生成。</p>
                                </template>
                            </div>
                        </div>

                        <!-- ===== PLC 连接参数 ===== -->
                        <div class="settings-section">
                            <h3 class="section-title">🔌 PLC 连接参数</h3>
                            <p style="color:#8c8c8c; font-size:12px; margin-bottom:16px;">
                                此参数用于 Node.js 后端直连 PLC，或者作为 C# 上位机的参考配置。
                            </p>
                            <div class="settings-grid">
                                <label>PLC IP 地址 <span class="required">*</span>
                                    <input v-model="settings.plc_ip" class="input" placeholder="192.168.1.10" />
                                </label>
                                <label>PLC 端口
                                    <input v-model="settings.plc_port" type="number" class="input" placeholder="102" />
                                </label>
                                <label>机架号 (Rack)
                                    <input v-model="settings.plc_rack" type="number" class="input" placeholder="0" />
                                </label>
                                <label>槽号 (Slot)
                                    <input v-model="settings.plc_slot" type="number" class="input" placeholder="1" />
                                </label>
                                <label>轮询间隔 (ms)
                                    <input v-model="settings.plc_poll_interval" type="number" class="input" placeholder="2000" />
                                </label>
                                <label>连接超时 (ms)
                                    <input v-model="settings.plc_timeout" type="number" class="input" placeholder="5000" />
                                </label>
                                <label>断线重连间隔 (ms)
                                    <input v-model="settings.plc_retry_interval" type="number" class="input" placeholder="10000" />
                                </label>
                            </div>
                        </div>

                        <!-- ===== 方案A 专属：C# 上位机 + MQTT ===== -->
                        <div class="settings-section" v-if="settings.data_mode === 'mqtt'">
                            <h3 class="section-title">📡 C# 上位机 & MQTT 参数</h3>
                            <label>C# 上位机 IP 地址
                                <input v-model="settings.csharp_host_ip" class="input" placeholder="192.168.1.100（运行上位机程序的电脑 IP）" />
                            </label>
                            <label>C# 上位机端口
                                <input v-model="settings.csharp_host_port" type="number" class="input" placeholder="8080" />
                            </label>
                            <label>MQTT Broker 地址
                                <input v-model="settings.mqtt_broker" class="input" placeholder="ws://192.168.1.100:8083/mqtt" />
                            </label>
                            <label>MQTT Topic 前缀
                                <input v-model="settings.mqtt_topic_prefix" class="input" placeholder="factory/workshop1" />
                            </label>
                            <div class="mode-hint" style="margin-top:12px;">
                                <p style="color:#8c8c8c; font-size:12px;">💡 提示：MQTT Broker 地址需要填写 WebSocket 协议的地址（以 <code>ws://</code> 开头），因为浏览器只支持通过 WebSocket 连接 MQTT。如果使用 EMQX，默认 WebSocket 端口为 <code>8083</code>。</p>
                            </div>
                        </div>

                        <!-- ===== 方案B 专属提示 ===== -->
                        <div class="settings-section" v-if="settings.data_mode === 'node_s7'">
                            <h3 class="section-title">⚙️ Node.js 直连说明</h3>
                            <div class="mode-hint">
                                <p style="color:#8c8c8c; font-size:12px;">💡 方案B 由后端 Node.js 使用 <code>nodes7</code> 库直接与 PLC 建立 S7 TCP 连接。后端启动时会自动根据上方配置的 PLC IP 和点位映射表发起连接。</p>
                                <p style="color:#8c8c8c; font-size:12px;">⚠️ 请确保：① PLC 侧允许 PUT/GET 通信 ② 网络防火墙未阻止 TCP 端口 102 ③ DB 块的优化访问已关闭（S7-1200/1500 需在 TIA 中设置）。</p>
                            </div>
                        </div>

                        <button @click="saveSettings" class="btn btn-primary" style="margin-top:24px; padding: 10px 30px; font-size: 15px;">💾 保存所有连接设置</button>
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
    background: #f0f2f5; color: #333;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    display: flex; flex-direction: column;
}

.admin-header {
    display: flex; justify-content: space-between; align-items: center;
    height: 60px; padding: 0 24px; background: #fff;
    box-shadow: 0 1px 4px rgba(0,21,41,0.08); z-index: 10;
}
.admin-header h1 { margin: 0; font-size: 20px; color: #1890ff; font-weight: 600; letter-spacing: 1px; }
.back-link { color: #666; text-decoration: none; font-size: 14px; transition: color 0.3s; }
.back-link:hover { color: #1890ff; }

.admin-body { display: flex; flex: 1; overflow: hidden; }

.admin-nav {
    width: 220px; background: #fff; border-right: 1px solid #e8e8e8;
    padding: 16px 0; overflow-y: auto;
}
.nav-item {
    padding: 14px 24px; cursor: pointer; font-size: 14px; color: #595959;
    transition: all 0.3s; position: relative;
}
.nav-item:hover { color: #1890ff; }
.nav-item.active {
    color: #1890ff; background: #e6f7ff; font-weight: 500;
}
.nav-item.active::after {
    content: ''; position: absolute; right: 0; top: 0; bottom: 0;
    width: 3px; background: #1890ff;
}

.admin-content { 
    flex: 1; padding: 24px; overflow-y: auto; background: #f0f2f5; 
}

.tab-content {
    background: #fff; padding: 24px; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    min-height: calc(100% - 10px);
}
.tab-content h2 { margin: 0 0 8px 0; font-size: 20px; color: #262626; font-weight: 500; }
.desc { color: #8c8c8c; font-size: 14px; margin-bottom: 24px; }

/* 表单元素 */
.input {
    border: 1px solid #d9d9d9; padding: 6px 11px; border-radius: 4px; font-size: 14px; outline: none;
    transition: all 0.3s; background: #fff; color: #333;
}
.input:focus { border-color: #40a9ff; box-shadow: 0 0 0 2px rgba(24,144,255,0.2); }
.input-sm { padding: 4px 8px; font-size: 13px; }

.form-row { display: flex; gap: 16px; align-items: center; margin-bottom: 24px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 24px 0; }
.form-grid label { display: flex; flex-direction: column; gap: 8px; font-size: 14px; color: #262626; }

.settings-form { max-width: 500px; display: flex; flex-direction: column; gap: 24px; }
.settings-form label { display: flex; flex-direction: column; gap: 8px; font-size: 14px; color: #262626; }

/* 按钮 */
.btn {
    padding: 6px 15px; border: 1px solid #d9d9d9; border-radius: 4px;
    background: #fff; color: #333; cursor: pointer; font-size: 14px;
    transition: all 0.3s; box-shadow: 0 2px 0 rgba(0,0,0,0.015);
}
.btn:hover { color: #40a9ff; border-color: #40a9ff; }
.btn-primary { background: #1890ff; border-color: #1890ff; color: #fff; box-shadow: 0 2px 0 rgba(0,0,0,0.045); }
.btn-primary:hover { background: #40a9ff; border-color: #40a9ff; color: #fff; }
.btn-danger { background: #ff4d4f; border-color: #ff4d4f; color: #fff; }
.btn-danger:hover { background: #ff7875; border-color: #ff7875; color: #fff; }
.btn-sm { padding: 4px 10px; font-size: 12px; }

/* 表格 */
.data-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 14px; }
.data-table th {
    text-align: left; padding: 12px 16px; background: #fafafa;
    border-bottom: 1px solid #f0f0f0; color: #262626; font-weight: 500;
}
.data-table td {
    padding: 12px 16px; border-bottom: 1px solid #f0f0f0; color: #595959;
}
.data-table tbody tr:hover { background: #fafafa; }
.data-table code { color: #c41d7f; background: #fff0f6; border: 1px solid #ffadd2; padding: 2px 6px; border-radius: 3px; font-family: monospace; }

.points-table td { padding: 8px 4px; }
.points-table .input-sm { width: 100%; }

.device-group { margin-bottom: 40px; }
.group-title { color: #262626; font-size: 16px; margin-bottom: 16px; font-weight: 500; padding-left: 10px; border-left: 4px solid #1890ff; }

/* 弹窗 */
.modal-overlay {
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.45); display: flex; justify-content: center; align-items: center;
    z-index: 1000;
}
.modal-box {
    background: #fff; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    padding: 24px; width: 600px; max-height: 80vh; overflow-y: auto;
}
.modal-box h3 { color: #262626; margin: 0 0 24px 0; font-size: 18px; font-weight: 500; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 24px; border-top: 1px solid #f0f0f0; padding-top: 16px; }

.upload-area { margin-bottom: 24px; }

/* 连接设置专属样式 */
.settings-section {
    padding: 20px; background: #fafafa; border: 1px solid #f0f0f0; border-radius: 6px;
}
.section-title {
    margin: 0 0 16px 0; font-size: 16px; color: #262626; font-weight: 500;
    padding-bottom: 10px; border-bottom: 1px solid #e8e8e8;
}
.settings-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
}
.settings-grid label {
    display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: #262626;
}
.mode-hint {
    margin-top: 12px; padding: 12px 16px; background: #fff; border: 1px dashed #d9d9d9; border-radius: 4px;
}
.mode-hint p { margin: 4px 0; font-size: 13px; color: #595959; line-height: 1.6; }
.mode-hint code { background: #f5f5f5; padding: 1px 5px; border-radius: 3px; font-size: 12px; color: #c41d7f; }
.required { color: #ff4d4f; font-weight: bold; margin-left: 2px; }

/* 引擎状态卡片 */
.engine-status-card {
    max-width: 700px; padding: 16px 20px; border-radius: 6px; margin-bottom: 24px;
    border: 1px solid #d9d9d9; background: #fafafa;
    display: flex; flex-direction: column; gap: 8px;
}
.engine-status-header { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.engine-dot {
    width: 10px; height: 10px; border-radius: 50%; background: #8c8c8c;
    display: inline-block; flex-shrink: 0;
}
.engine-status-body { display: flex; gap: 24px; font-size: 13px; color: #595959; }
.status-connected .engine-dot, .status-simulating .engine-dot { background: #52c41a; box-shadow: 0 0 6px rgba(82,196,26,0.5); }
.status-connected, .status-simulating { border-color: #b7eb8f; background: #f6ffed; }
.status-error .engine-dot, .status-unconfigured .engine-dot { background: #ff4d4f; box-shadow: 0 0 6px rgba(255,77,79,0.5); }
.status-error, .status-unconfigured { border-color: #ffa39e; background: #fff1f0; }
.status-connecting .engine-dot, .status-retrying .engine-dot { background: #faad14; box-shadow: 0 0 6px rgba(250,173,20,0.5); animation: pulse 1.5s infinite; }
.status-connecting, .status-retrying { border-color: #ffe58f; background: #fffbe6; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
