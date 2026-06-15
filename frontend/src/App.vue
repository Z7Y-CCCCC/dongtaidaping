<script setup>
import { onMounted, onUnmounted, ref, reactive, computed } from 'vue'
import { SceneManager } from './three/SceneManager'
import { createDeviceModel } from './three/ModelFactory.js'
import { useFactoryConfig } from './config/factoryConfig.js'
import * as echarts from 'echarts'

const threeContainer = ref(null)
const pieChart1Ref = ref(null)
const pieChart2Ref = ref(null)
const lineChartRef = ref(null)

let sceneManager = null
const currentLevel = ref(0)
const currentWorkshop = ref(-1) // 车间索引
const currentLine = ref(-1) // 全局产线索引
const selectedDeviceId = ref(null)
const selectedDeviceData = reactive({})
const currentTime = ref('')
const currentDate = ref('')

// 从配置引擎获取数据
const { config: factoryConfig, loadConfig, getWorkshops, getLines, getAllDevices, getSetting, getMqttBroker, getMqttTopicPrefix, getFactoryName } = useFactoryConfig()

// 产线列表（响应式计算属性，从配置读取）
const allWorkshops = computed(() => getWorkshops())

let pieChart1, pieChart2, lineChart;
let timer = null;

// 每台炉子的实时状态 (用于设备总览卡片)
const deviceStatusMap = reactive({})

// 滚动告警日志
const alarmLogs = reactive([
  { time: '16:22:05', msg: '1# 炉搅拌电机电流偏高 (12.3A)', level: 'warning' },
  { time: '15:48:12', msg: '3# 炉碳势偏差超限 ±0.08%', level: 'critical' },
  { time: '14:30:00', msg: '2# 炉前门开启超时 45s', level: 'warning' },
  { time: '13:15:22', msg: '4# 炉淬火油温正常 62°C', level: 'info' },
  { time: '12:00:00', msg: '甲班交接班点检完成', level: 'info' },
  { time: '11:22:30', msg: '1# 炉推拉链到位信号丢失 200ms', level: 'critical' },
  { time: '10:05:18', msg: '全线排产计划已更新 (工单 HT-20260427-003)', level: 'info' },
])

// 数值动画
const animatedOutput = ref(0)
const animatedOEE = ref(0)
const animatedEnergy = ref(0)

// 当前选中产线的设备列表（从配置读取，不再硬编码）
const currentLineDevices = computed(() => {
  if (currentLine.value < 0) return []
  let c = 0;
  for (let w of allWorkshops.value) {
    for (let l of w.lines || []) {
      if (c === currentLine.value) return l.devices || []
      c++;
    }
  }
  return []
})

// 详情抽屉状态
const isDrawerOpen = ref(true)

function animateNumber(refObj, target, duration = 2000) {
  const start = refObj.value
  const diff = target - start
  const startTime = performance.now()
  function step(now) {
    const elapsed = now - startTime
    const progress = Math.min(elapsed / duration, 1)
    const eased = 1 - Math.pow(1 - progress, 3) // easeOutCubic
    refObj.value = Math.round(start + diff * eased)
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
}

// 模拟的后端排产数据库静态统计数据
const productionData = reactive({
  dailyTarget: 5000,
  currentOutput: 3420,
  overallOEE: 85.4,
  energyConsumption: 12400
})

const furnaces = new Map()
const latestDeviceDataMap = new Map()
let reconnectTimer = null
let isUnmounted = false

function handleWorkshopSelected(e) {
  currentWorkshop.value = e.detail
  currentLevel.value = 1
}

function handleLineSelected(e) {
  currentLine.value = e.detail
  currentLevel.value = 2
}

function handleFactorySelected() {
  currentLevel.value = 0
}

onMounted(async () => {
  isUnmounted = false
  // 时钟更新
  updateTime()
  timer = setInterval(updateTime, 1000)

  // 数值滚动动画
  setTimeout(() => {
    animateNumber(animatedOutput, productionData.currentOutput)
    animateNumber(animatedOEE, Math.round(productionData.overallOEE * 10))
    animateNumber(animatedEnergy, productionData.energyConsumption)
  }, 300)

  // 1. 加载后端配置
  await loadConfig()

  // 2. 初始化 3D 场景
  sceneManager = new SceneManager(
    threeContainer.value, 
    (level) => { currentLevel.value = level },
    (deviceId) => {
      selectedDeviceId.value = deviceId
      const cachedData = latestDeviceDataMap.get(deviceId)
      if (cachedData) Object.assign(selectedDeviceData, cachedData)
    }
  )

  // 3. 根据配置动态创建设备
  const workshops = getWorkshops()
  let gLineIdx = 0;
  const deviceDefs = []
  workshops.forEach((ws, wsIdx) => {
    (ws.lines || []).forEach((line) => {
      const lineDevices = line.devices || []
      lineDevices.forEach((deviceCfg, devIdx) => {
        deviceDefs.push({ deviceCfg, devIdx, wsIdx, gLineIdx })
      })
      gLineIdx++;
    })
  })

  const deviceModels = await Promise.all(deviceDefs.map(async (def) => {
    const deviceModel = await createDeviceModel(def.deviceCfg, factoryConfig.models || [])
    return { ...def, deviceModel }
  }))

  deviceModels.forEach(({ deviceCfg, devIdx, wsIdx, gLineIdx, deviceModel }) => {
    deviceModel.position.set(
      deviceCfg.pos_x ?? (devIdx - 2) * 14,
      deviceCfg.pos_y ?? 0,
      deviceCfg.pos_z ?? -gLineIdx * 16 - wsIdx * 20
    )
    if (deviceCfg.rotation_y) deviceModel.rotation.y = deviceCfg.rotation_y

    const defaultScale = deviceModel.userData?.defaultScale || 1
    const configuredScale = deviceCfg.scale || 1
    if (defaultScale !== 1 || configuredScale !== 1) {
      deviceModel.scale.setScalar(defaultScale * configuredScale)
    }

    sceneManager.addFurnace(deviceModel)
    deviceStatusMap[deviceCfg.id] = { name: deviceCfg.name, temp: '--', carbon: '--', running: false, alarm: false }
    furnaces.set(deviceCfg.id, deviceModel)
  })

  // 4. 通知 SceneManager 拓扑信息
  const cameraMode = getSetting('camera_mode', 'auto')
  sceneManager.setTopologyConfig(workshops, cameraMode)

  sceneManager.animate()
  initWebSocket()
  
  // 监听来自 3D 场景的运镜事件
  window.addEventListener('workshop-selected', handleWorkshopSelected);
  window.addEventListener('line-selected', handleLineSelected);
  window.addEventListener('factory-selected', handleFactorySelected);

  // 初始化 ECharts
  setTimeout(() => {
    initCharts()
  }, 100)

  window.addEventListener('resize', resizeCharts)
})

onUnmounted(() => {
  isUnmounted = true
  clearInterval(timer)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  window.removeEventListener('resize', resizeCharts)
  window.removeEventListener('workshop-selected', handleWorkshopSelected)
  window.removeEventListener('line-selected', handleLineSelected)
  window.removeEventListener('factory-selected', handleFactorySelected)
  // 销毁 ECharts 实例
  if (pieChart1) { pieChart1.dispose(); pieChart1 = null }
  if (pieChart2) { pieChart2.dispose(); pieChart2 = null }
  if (lineChart) { lineChart.dispose(); lineChart = null }
  // 销毁 Three.js 渲染器，释放 WebGL 上下文
  if (sceneManager) {
    sceneManager.dispose()
    sceneManager = null
  }
  // 关闭 WebSocket 连接
  if (wsClient) {
    wsClient.onclose = null  // 防止触发自动重连
    wsClient.close()
    wsClient = null
  }
})

function updateTime() {
  const now = new Date()
  currentTime.value = now.toLocaleTimeString()
  currentDate.value = now.toLocaleDateString()
}

function initCharts() {
  // 图表 1: OEE 饼图
  if (pieChart1Ref.value) {
    pieChart1 = echarts.init(pieChart1Ref.value)
    pieChart1.setOption({
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie',
        radius: ['60%', '80%'],
        itemStyle: { borderRadius: 5, borderColor: '#000', borderWidth: 2 },
        label: { show: true, position: 'center', formatter: '{c}%\nOEE', color: '#00ffcc', fontSize: 16, fontWeight: 'bold' },
        data: [
          { value: 85.4, name: '有效', itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{offset: 0, color: '#00ffcc'}, {offset: 1, color: '#0088ff'}]) } },
          { value: 14.6, name: '损耗', itemStyle: { color: '#333' } }
        ]
      }]
    })
  }

  // 图表 2: 进度饼图
  if (pieChart2Ref.value) {
    pieChart2 = echarts.init(pieChart2Ref.value)
    const percentage = ((productionData.currentOutput / productionData.dailyTarget) * 100).toFixed(1)
    pieChart2.setOption({
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie',
        radius: ['60%', '80%'],
        itemStyle: { borderRadius: 5, borderColor: '#000', borderWidth: 2 },
        label: { show: true, position: 'center', formatter: `${percentage}%\n进度`, color: '#ffaa00', fontSize: 16, fontWeight: 'bold' },
        data: [
          { value: productionData.currentOutput, name: '已完成', itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{offset: 0, color: '#ffaa00'}, {offset: 1, color: '#ff4400'}]) } },
          { value: productionData.dailyTarget - productionData.currentOutput, name: '未完成', itemStyle: { color: '#333' } }
        ]
      }]
    })
  }

  // 图表 3: 历史折线图
  if (lineChartRef.value) {
    lineChart = echarts.init(lineChartRef.value)
    lineChart.setOption({
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(0,0,0,0.8)', textStyle: { color: '#fff' } },
      grid: { left: '10%', right: '5%', bottom: '15%', top: '20%' },
      xAxis: { type: 'category', boundaryGap: false, data: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'], axisLabel: { color: '#888' } },
      yAxis: { type: 'value', axisLabel: { color: '#888' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } } },
      series: [
        {
          name: '平均温度', type: 'line', smooth: true,
          lineStyle: { color: '#00ffcc', width: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(0, 255, 204, 0.5)' },
              { offset: 1, color: 'rgba(0, 255, 204, 0.0)' }
            ])
          },
          data: [840, 852, 850, 855, 848, 850]
        }
      ]
    })
  }
}

function resizeCharts() {
  if (pieChart1) pieChart1.resize()
  if (pieChart2) pieChart2.resize()
  if (lineChart) lineChart.resize()
}

let wsClient = null
const wsConnected = ref(false)
const plcStatusText = ref('等待连接...')

function applyDeviceRealtimeData(data) {
  if (!data?.furnace_id) return

  const furnace = furnaces.get(data.furnace_id)
  if (!furnace) return

  latestDeviceDataMap.set(data.furnace_id, data)
  furnace.updateData(data)

  deviceStatusMap[data.furnace_id] = {
    name: data.furnace_name,
    temp: data.analog?.actual_temp,
    carbon: data.analog?.actual_carbon,
    running: data.status?.running,
    alarm: data.status?.alarm
  }

  if (currentLevel.value === 3 && selectedDeviceId.value === data.furnace_id) {
    Object.assign(selectedDeviceData, data)
  }
}

function initWebSocket() {
  if (isUnmounted) return

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  // WebSocket 连接后端，统一接收所有实时数据
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsHost = window.location.hostname || 'localhost'
  const wsUrl = `${wsProtocol}//${wsHost}:3001/ws`
  
  console.log(`[大屏] 正在连接 WebSocket: ${wsUrl}`)
  wsClient = new WebSocket(wsUrl)

  wsClient.onopen = () => {
    console.log('[大屏] WebSocket 已连接')
    wsConnected.value = true
    plcStatusText.value = '通信正常'
  }

  wsClient.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      
      if (msg.type === 'realtime_frame') {
        const devices = msg.payload?.devices || []
        devices.forEach(applyDeviceRealtimeData)
      } else if (msg.type === 'device_data') {
        applyDeviceRealtimeData(msg.payload)
      } else if (msg.type === 'plc_status') {
        plcStatusText.value = msg.payload.message || msg.payload.status
      }
    } catch (e) { /* 忽略非 JSON 消息 */ }
  }

  wsClient.onclose = () => {
    if (isUnmounted) return
    console.log('[大屏] WebSocket 断开，5秒后重连...')
    wsConnected.value = false
    plcStatusText.value = '连接断开，重连中...'
    reconnectTimer = setTimeout(() => initWebSocket(), 5000)
  }

  wsClient.onerror = (err) => {
    console.error('[大屏] WebSocket 错误:', err)
    wsConnected.value = false
  }
}

function goBack() {
  if (sceneManager) {
    sceneManager.goUp();
    isDrawerOpen.value = true;
  }
}

function selectGlobal() {
  sceneManager.flyToFactory();
}

function selectWorkshop(idx) {
  sceneManager.flyToWorkshop(idx);
}

function selectLine(idx) {
  sceneManager.flyToLine(idx);
}

function getGlobalLineIdx(wIdx, lIdx) {
  let count = 0;
  for(let i=0; i<wIdx; i++) count += (allWorkshops.value[i].lines || []).length;
  return count + lIdx;
}

// 视角控制方法
function controlCamera(action) {
  if (!sceneManager) return
  switch (action) {
    case 'rotateLeft': sceneManager.rotateCamera(Math.PI / 8); break;
    case 'rotateRight': sceneManager.rotateCamera(-Math.PI / 8); break;
    case 'zoomIn': sceneManager.zoomCamera(true); break;
    case 'zoomOut': sceneManager.zoomCamera(false); break;
  }
}
</script>

<template>
  <div class="dashboard-container">
    <!-- 3D 渲染层在最底 -->
    <div ref="threeContainer" class="three-layer"></div>

    <!-- UI 遮罩层在上面 -->
    <div class="ui-layer" :class="'level-' + currentLevel">
      
      <!-- 极具科技感的顶部标题栏 -->
      <header class="header">
        <div class="header-left">
          <div class="deco-lines">
             <svg width="150" height="20" viewBox="0 0 150 20"><path d="M0,10 L30,10 L40,2 L150,2" stroke="#00ffcc" fill="none" stroke-width="2" opacity="0.6"/><path d="M0,15 L35,15 L45,7 L150,7" stroke="#0088ff" fill="none" stroke-width="1" opacity="0.4"/></svg>
          </div>
        </div>
        <div class="header-center">
          <h1>{{ getFactoryName() }}</h1>
        </div>
        <div class="header-right">
          <div class="time"><span class="date">{{ currentDate }}</span> {{ currentTime }}</div>
          <button class="icon-btn" @click="toggleFullscreen" title="全屏切换">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00ffcc" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
          </button>
        </div>
      </header>

      <!-- 左侧全局菜单和统计面板 -->
      <transition name="fade-slide-left">
        <div class="side-panel left-panel" v-if="currentLevel === 0 || currentLevel === 1 || currentLevel === 2">
          <!-- 产线导航菜单 -->
          <div class="sidebar-menu sci-fi-border" style="overflow-y: auto; max-height: 40vh;">
            <div v-if="sceneManager && sceneManager.topLevel === 0" class="menu-item" :class="{active: currentLevel === 0}" @click="selectGlobal">
              <span class="icon">▤</span> 全局总览
            </div>
            <template v-for="(ws, wIdx) in allWorkshops" :key="ws.id">
                <div class="menu-item workshop-item" :class="{active: currentLevel === 1 && currentWorkshop === wIdx}" @click="selectWorkshop(wIdx)">
                  <span class="icon">🏭</span> {{ ws.name }}
                </div>
                <div v-for="(line, lIdx) in ws.lines" :key="line.id" 
                     class="menu-item line-item" :class="{active: currentLevel === 2 && currentLine === getGlobalLineIdx(wIdx, lIdx)}" 
                     @click="selectLine(getGlobalLineIdx(wIdx, lIdx))"
                     style="padding-left: 30px;">
                  <span class="icon">▶</span> {{ line.name }}
                </div>
            </template>
          </div>

          <!-- 全局统计只在 Level 0/1 显示 -->
          <div v-if="currentLevel === 0 || currentLevel === 1" class="global-stats">
            <div class="panel-box sci-fi-border mt-4">
              <div class="box-title"><i></i>集群资源监控</div>
              <div class="charts-row">
                <div ref="pieChart1Ref" class="chart-small"></div>
                <div ref="pieChart2Ref" class="chart-small"></div>
              </div>
            </div>
            
            <div class="panel-box sci-fi-border mt-4">
              <div class="box-title"><i></i>集群数据统计</div>
              <div class="data-grid">
                <div class="data-block">
                  <i class="icon-bolt">⚡</i>
                  <div>
                    <div class="data-label">年度用电量</div>
                    <div class="data-value">{{ animatedEnergy }}<span style="font-size:12px"> KJ</span></div>
                  </div>
                </div>
                <div class="data-block">
                  <i class="icon-bolt">⚡</i>
                  <div>
                    <div class="data-label">车间综合 OEE</div>
                    <div class="data-value">{{ animatedOEE / 10 }}<span style="font-size:12px"> %</span></div>
                  </div>
                </div>
                <div class="data-block">
                  <i class="icon-bolt">⚡</i>
                  <div>
                    <div class="data-label">日均产出件</div>
                    <div class="data-value highlight">{{ animatedOutput }}</div>
                  </div>
                </div>
                <div class="data-block">
                  <i class="icon-bolt">⚡</i>
                  <div>
                    <div class="data-label">设备在线数量</div>
                    <div class="data-value">{{ getAllDevices().length }}<span style="font-size:12px">/{{ getAllDevices().length }}</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <transition name="fade-slide-right">
        <div class="side-panel right-panel" v-if="currentLevel === 0 || currentLevel === 1">
          <div class="panel-box sci-fi-border">
            <div class="box-title"><i></i>历史趋势数据信息</div>
            <div ref="lineChartRef" class="chart-large"></div>
          </div>
          <div class="panel-box sci-fi-border mt-4">
            <div class="box-title"><i></i>设备报警日志 TOP5</div>
            <ul class="alarm-list">
              <li><span class="rank hot">1</span> <span class="alarm-txt">1# 炉搅拌电机异常发热</span> <span class="tag critical">危</span></li>
              <li><span class="rank warn">2</span> <span class="alarm-txt">2# 炉碳势偏差报警</span> <span class="tag warning">警</span></li>
              <li><span class="rank norm">3</span> <span class="alarm-txt">4# 炉前门开启超时</span> <span class="tag info">消</span></li>
            </ul>
          </div>
        </div>
      </transition>

      <!-- Level 3 专用的底部抽屉详细诊断面板 -->
      <transition name="slide-up">
        <div class="bottom-drawer-panel sci-fi-border" v-if="currentLevel === 3" :class="{ 'drawer-closed': !isDrawerOpen }">
          
          <!-- 抽屉开关把手 -->
          <div class="drawer-handle" @click="isDrawerOpen = !isDrawerOpen">
            <span class="handle-icon">{{ isDrawerOpen ? '▼ 收起诊断面板' : '▲ 展开诊断面板' }}</span>
          </div>

          <div class="drawer-content">
            <h2 class="panel-title">{{ selectedDeviceData.furnace_name }} 详细诊断</h2>
            <div class="diagnostic-grid">
              <!-- 温度监控 -->
              <div class="diag-card">
                <h3>温度监控</h3>
                <div class="diag-row"><span>实际:</span> <span class="val highlight-orange">{{ selectedDeviceData.analog?.actual_temp || '--' }}</span> <span class="unit">°C</span></div>
                <div class="diag-row"><span>设定:</span> <span class="val">{{ selectedDeviceData.analog?.setpoint_temp || '--' }}</span> <span class="unit">°C</span></div>
              </div>
              <!-- 碳势监控 -->
              <div class="diag-card">
                <h3>碳势监控</h3>
                <div class="diag-row"><span>实际:</span> <span class="val highlight-orange">{{ selectedDeviceData.analog?.actual_carbon || '--' }}</span> <span class="unit">%</span></div>
                <div class="diag-row"><span>设定:</span> <span class="val">{{ selectedDeviceData.analog?.setpoint_carbon || '--' }}</span> <span class="unit">%</span></div>
              </div>
              <!-- 电机状态 -->
              <div class="diag-card">
                <h3>电机状态</h3>
                <div class="diag-row"><span>搅拌:</span> <span class="status" :class="{ running: selectedDeviceData.motors?.stir_motor }">{{ selectedDeviceData.motors?.stir_motor ? '运行' : '停止' }}</span></div>
                <div class="diag-row"><span>风扇:</span> <span class="status" :class="{ running: selectedDeviceData.motors?.fan_motor }">{{ selectedDeviceData.motors?.fan_motor ? '运行' : '停止' }}</span></div>
              </div>
              <!-- 机构状态 -->
              <div class="diag-card">
                <h3>机构状态</h3>
                <div class="diag-row"><span>推链:</span> <span>{{ selectedDeviceData.mechanisms?.push_chain_forward ? '向前推入' : '默认位置' }}</span></div>
                <div class="diag-row"><span>前门:</span> <span>{{ selectedDeviceData.doors?.front_door_open ? '已开启' : '关闭中' }}</span></div>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <!-- 交互控制按钮 -->
      <div class="camera-controls" v-if="currentLevel === 3">
        <button class="tool-btn" @click="controlCamera('rotateLeft')" title="向左旋转">↺</button>
        <button class="tool-btn" @click="controlCamera('rotateRight')" title="向右旋转">↻</button>
        <button class="tool-btn" @click="controlCamera('zoomIn')" title="拉近放大">＋</button>
        <button class="tool-btn" @click="controlCamera('zoomOut')" title="拉远缩小">－</button>
      </div>

      <!-- 返回按钮 -->
      <button class="back-btn" v-if="currentLevel > 0 && currentLevel < 4 && !(currentLevel === 1 && sceneManager?.topLevel === 1)" @click="goBack">
        <span class="btn-icon">←</span> 返回上一级
      </button>

      <!-- 中间底部：产线设备总览卡片条 (仅在 Level 2 时显示选定产线的设备) -->
      <transition name="fade-up">
        <div class="device-overview-bar" v-if="currentLevel === 2 && currentLineDevices.length > 0">
          <div v-for="deviceCfg in currentLineDevices" :key="deviceCfg.id" 
               class="device-mini-card sci-fi-border" 
               :class="{ 'alarm-flash': deviceStatusMap[deviceCfg.id]?.alarm }">
            <div class="card-header">
              <span class="dot" :class="deviceStatusMap[deviceCfg.id]?.alarm ? 'red' : (deviceStatusMap[deviceCfg.id]?.running ? 'green' : 'gray')"></span>
              {{ deviceStatusMap[deviceCfg.id]?.name || deviceCfg.name }}
            </div>
            <div class="card-body">
              <span>{{ deviceStatusMap[deviceCfg.id]?.temp || '--' }} °C</span>
              <span style="color:#00ffcc">{{ deviceStatusMap[deviceCfg.id]?.carbon || '--' }} %</span>
            </div>
          </div>
        </div>
      </transition>

      <!-- 底部跑马灯：实时告警日志条 (仅 Level 0/1 显示) -->
      <div class="bottom-marquee-bar sci-fi-border" v-if="currentLevel < 2">
        <div class="marquee-title">集群实时日志</div>
        <div class="marquee-content-wrap">
          <div class="marquee-content">
             <span v-for="(log, idx) in alarmLogs" :key="idx" class="marquee-item" :class="log.level">
                [{{ log.time }}] {{ log.msg }}
             </span>
             <!-- 复制一份实现无缝滚动 -->
             <span v-for="(log, idx) in alarmLogs" :key="'copy'+idx" class="marquee-item" :class="log.level">
                [{{ log.time }}] {{ log.msg }}
             </span>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap');
</style>

<style>
/* 全局 body 基础重置（不含颜色和 overflow，避免污染 /admin 路由） */
html, body {
  margin: 0; padding: 0;
}
/* 大屏专属样式 */
.dashboard-container {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #fff;
  background-color: #020813;
  overflow: hidden;
}

.dashboard-container { width: 100vw; height: 100vh; position: relative; }
.three-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; }
.ui-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 10; pointer-events: none; }
.ui-layer > div, .ui-layer > button, .ui-layer > header { pointer-events: auto; }

/* 头部 Header 科技感 */
.header {
  display: flex; justify-content: space-between; align-items: flex-start;
  height: 80px; width: 100%; position: absolute; top: 0; left: 0;
  background: url('data:image/svg+xml;utf8,<svg viewBox="0 0 1920 80" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1920 0 L1920 30 L1300 30 L1250 80 L670 80 L620 30 L0 30 Z" fill="rgba(0,30,60,0.6)" stroke="%2300ffcc" stroke-width="2"/></svg>') no-repeat center top;
  background-size: 100% 100%;
}
.header-center {
  width: 600px; text-align: center; margin-top: 15px;
}
.header-center h1 {
  margin: 0; font-size: 32px; font-weight: bold; letter-spacing: 4px;
  background: linear-gradient(to bottom, #fff, #00ffcc);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  text-shadow: 0 0 20px rgba(0, 255, 204, 0.5);
}
.header-right { 
  padding: 25px 30px 15px 30px; /* 增加 top-padding 让时间整体往下挪，避开截断线 */
  font-family: 'Orbitron', sans-serif; font-size: 20px; color: #00ffcc; text-shadow: 0 0 10px #00ffcc; 
  display: flex; align-items: center; gap: 20px;
}
.header-left { padding: 15px 30px; width: 200px; display: flex; align-items: center;}
.icon-btn { background: transparent; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 5px; border-radius: 4px; transition: all 0.3s; }
.icon-btn:hover { background: rgba(0, 255, 204, 0.2); }

/* 科技感边框容器 */
.sci-fi-border {
  background: rgba(4, 15, 30, 0.7);
  border: 1px solid rgba(0, 200, 255, 0.3);
  box-shadow: 0 0 30px rgba(0, 150, 255, 0.2) inset, 0 0 10px rgba(0,0,0,0.8);
  position: relative;
  backdrop-filter: blur(5px);
}
.sci-fi-border::before, .sci-fi-border::after {
  content: ''; position: absolute; width: 20px; height: 20px; border: 2px solid #00ffcc; transition: all 0.3s;
}
.sci-fi-border::before { top: -2px; left: -2px; border-right: none; border-bottom: none; }
.sci-fi-border::after { bottom: -2px; right: -2px; border-left: none; border-top: none; }

.side-panel { position: absolute; top: 100px; bottom: 30px; width: 420px; display: flex; flex-direction: column; gap: 20px; }
.left-panel { left: 30px; }
.right-panel { right: 30px; }
.panel-box { padding: 20px; flex: 1; display: flex; flex-direction: column; }
.mt-4 { margin-top: 10px; }

.box-title {
  font-size: 18px; color: #fff; display: flex; align-items: center; margin-bottom: 15px; font-weight: bold;
  text-shadow: 0 0 5px rgba(255,255,255,0.5);
}
.box-title i { display: inline-block; width: 4px; height: 18px; background: #00ffcc; margin-right: 10px; box-shadow: 0 0 8px #00ffcc; }

/* 左侧图表与网格 */
.charts-row { display: flex; justify-content: space-around; height: 180px; }
.chart-small { width: 45%; height: 100%; }

.data-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; flex: 1; }
.data-block { 
  background: linear-gradient(90deg, rgba(0, 150, 255, 0.1) 0%, transparent 100%); 
  border-left: 3px solid #0088ff; padding: 15px; display: flex; align-items: center;
}
.icon-bolt { font-size: 24px; margin-right: 15px; color: #00ffcc; font-style: normal; text-shadow: 0 0 10px #00ffcc; }
.data-label { font-size: 12px; color: #88ccee; margin-bottom: 5px; }
.data-value { font-size: 20px; font-family: 'Orbitron', sans-serif; color: #fff; }
.data-value.highlight { color: #ffaa00; text-shadow: 0 0 10px #ffaa00; }

/* 右侧大图表与列表 */
.chart-large { width: 100%; height: 250px; }

/* 抽屉式底部诊断面板 */
.bottom-drawer-panel {
  position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
  width: 900px; background: rgba(2, 10, 20, 0.85); backdrop-filter: blur(10px);
  padding: 0; border-radius: 10px 10px 0 0; border-bottom: none;
  transition: transform 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
}
.bottom-drawer-panel.drawer-closed {
  transform: translateX(-50%) translateY(calc(100% - 30px));
}
.drawer-handle {
  height: 30px; display: flex; justify-content: center; align-items: center;
  cursor: pointer; background: linear-gradient(0deg, rgba(0,255,204,0.1), transparent);
  border-bottom: 1px solid rgba(0,255,204,0.3); border-radius: 10px 10px 0 0;
}
.drawer-handle:hover { background: rgba(0,255,204,0.2); }
.handle-icon { color: #00ffcc; font-size: 12px; letter-spacing: 2px; }

.drawer-content { padding: 20px 40px 30px 40px; }

.panel-title { text-align: center; color: #00ffcc; margin-bottom: 20px; font-size: 20px; letter-spacing: 2px; text-shadow: 0 0 10px #00ffcc; }
.diagnostic-grid { display: flex; justify-content: space-between; gap: 20px; }
.diag-card { flex: 1; background: rgba(0, 50, 100, 0.2); border: 1px solid rgba(0, 136, 255, 0.3); padding: 15px; border-radius: 5px; }
.diag-card h3 { color: #0088ff; font-size: 14px; margin-bottom: 15px; border-bottom: 1px solid rgba(0, 136, 255, 0.2); padding-bottom: 5px; }
.diag-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 14px; color: #ccc; }
.diag-row .val { font-family: 'Orbitron', sans-serif; font-size: 18px; font-weight: bold; }
.highlight-orange { color: #ffaa00; text-shadow: 0 0 5px rgba(255,170,0,0.5); }
.unit { font-size: 12px; color: #888; }
.status { padding: 2px 8px; border-radius: 3px; font-size: 12px; border: 1px solid #555; color: #888; }
.status.running { color: #00ffcc; border-color: #00ffcc; box-shadow: 0 0 8px rgba(0,255,204,0.3); }

/* 3D 视角操作按钮 */
.camera-controls {
  position: absolute; right: 30px; top: 50%; transform: translateY(-50%);
  display: flex; flex-direction: column; gap: 15px; z-index: 20;
}
.tool-btn {
  width: 40px; height: 40px; border-radius: 50%;
  background: rgba(0, 20, 40, 0.8); border: 1px solid #00ffcc; color: #00ffcc;
  font-size: 18px; font-weight: bold; cursor: pointer;
  box-shadow: 0 0 10px rgba(0,255,204,0.2); transition: all 0.2s;
  display: flex; justify-content: center; align-items: center;
}
.tool-btn:hover {
  background: #00ffcc; color: #000; box-shadow: 0 0 15px #00ffcc; transform: scale(1.1);
}

.alarm-list { list-style: none; padding: 0; margin: 0; flex: 1; }
.alarm-list li { 
  display: flex; align-items: center; padding: 12px 0; border-bottom: 1px dashed rgba(255,255,255,0.1); 
  font-size: 14px; color: #ddd;
}
.rank { display: inline-block; width: 20px; height: 20px; text-align: center; line-height: 20px; font-weight: bold; border-radius: 3px; margin-right: 15px; }
.rank.hot { background: #ff3333; color: #fff; }
.rank.warn { background: #ffaa00; color: #000; }
.rank.norm { background: #444; color: #fff; }
.alarm-txt { flex: 1; }
.tag { padding: 2px 6px; border-radius: 2px; font-size: 12px; font-weight: bold; }
.tag.critical { background: rgba(255,51,51,0.2); color: #ff3333; border: 1px solid #ff3333; }
.tag.warning { background: rgba(255,170,0,0.2); color: #ffaa00; border: 1px solid #ffaa00; }
.tag.info { background: rgba(0,255,204,0.2); color: #00ffcc; border: 1px solid #00ffcc; }

/* 详情面板 */
.detail-panel {
  position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); width: 800px;
  padding: 25px;
}
.detail-panel h3 { margin: 0 0 20px 0; color: #00ffcc; text-align: center; font-size: 22px; text-shadow: 0 0 10px #00ffcc; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 20px; }
.detail-card { 
  background: rgba(0,20,40,0.6); padding: 15px; border-radius: 4px; border: 1px solid rgba(0,136,255,0.3); 
  box-shadow: inset 0 0 15px rgba(0,136,255,0.1);
}
.detail-card h4 { margin: 0 0 12px 0; color: #00ffcc; font-size: 15px; border-bottom: 1px solid rgba(0,255,204,0.2); padding-bottom: 5px; }
.detail-card p { margin: 8px 0; color: #ccc; font-size: 14px; display: flex; justify-content: space-between;}
.hl-value { color: #ffaa00; font-family: 'Orbitron', sans-serif; font-size: 16px; font-weight: bold; }
span.on { color: #00ffcc; font-weight: bold; text-shadow: 0 0 8px #00ffcc; }

/* 按钮 */
.back-btn {
  position: absolute; top: 100px; left: 30px; padding: 10px 25px; 
  background: linear-gradient(90deg, rgba(0, 255, 204, 0.2), transparent); 
  border: 1px solid #00ffcc; border-right: none;
  color: #00ffcc; cursor: pointer; font-weight: bold; font-size: 16px;
  clip-path: polygon(0 0, 90% 0, 100% 50%, 90% 100%, 0 100%);
  transition: all 0.3s; text-shadow: 0 0 5px #00ffcc;
}
.back-btn:hover { background: rgba(0, 255, 204, 0.4); padding-left: 30px; }

/* 动画类 */
.fade-slide-left-enter-active, .fade-slide-left-leave-active,
.fade-slide-right-enter-active, .fade-slide-right-leave-active,
.fade-up-enter-active, .fade-up-leave-active { transition: all 0.8s cubic-bezier(0.25, 0.8, 0.25, 1); }
.fade-slide-left-enter-from, .fade-slide-left-leave-to { opacity: 0; transform: translateX(-150px) scale(0.9); }
.fade-slide-right-enter-from, .fade-slide-right-leave-to { opacity: 0; transform: translateX(150px) scale(0.9); }
.fade-up-enter-from, .fade-up-leave-to { opacity: 0; transform: translate(-50%, 100px) scale(0.9); }

/* 3D 悬浮标签修改 */
.furnace-label {
  background: rgba(2, 8, 19, 0.85); border: 1px solid #0088ff; color: #fff; padding: 10px 15px; font-size: 14px;
  pointer-events: none; box-shadow: 0 0 15px rgba(0, 136, 255, 0.4);
  border-radius: 2px;
}
.furnace-label::before {
  content: ''; position: absolute; left: -5px; top: 50%; width: 10px; height: 2px; background: #0088ff;
}
.furnace-label .header { font-weight: bold; color: #00ffcc; border-bottom: 1px dashed rgba(0,255,204,0.3); margin-bottom: 5px; padding-bottom: 5px; }
.furnace-label .data-row span { font-family: 'Orbitron', sans-serif; font-size: 16px; color: #ffaa00; font-weight: bold; }

/* 头部小控件 */
.header-left { display: flex; align-items: center; justify-content: space-between; }
.icon-btn { background: none; border: none; cursor: pointer; padding: 5px; transition: transform 0.2s; }
.icon-btn:hover { transform: scale(1.1); }
.time .date { font-size: 14px; margin-right: 10px; color: #88ccee; }

/* 设备总览卡片条 */
.device-overview-bar {
  position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 15px; z-index: 10;
  width: 90%; flex-wrap: wrap; justify-content: center; max-height: 200px; overflow-y: auto;
}
.device-mini-card {
  width: 140px; padding: 10px 15px; background: rgba(0, 20, 40, 0.8);
  display: flex; flex-direction: column; gap: 8px;
}
.card-header { font-size: 14px; font-weight: bold; color: #fff; display: flex; align-items: center; border-bottom: 1px solid rgba(0,255,204,0.2); padding-bottom: 5px; }
.card-header .dot { width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; box-shadow: 0 0 5px currentColor; }
.dot.green { background: #00ffcc; color: #00ffcc; }
.dot.red { background: #ff3333; color: #ff3333; }
.dot.gray { background: #666; color: #666; }
.card-body { display: flex; justify-content: space-between; font-family: 'Orbitron', sans-serif; font-size: 14px; color: #ffaa00; }

/* 报警闪烁动效 */
@keyframes flashAlarm {
  0% { box-shadow: 0 0 10px rgba(255, 51, 51, 0.5) inset, 0 0 5px rgba(255, 0, 0, 0.8); }
  50% { box-shadow: 0 0 30px rgba(255, 51, 51, 0.8) inset, 0 0 15px rgba(255, 0, 0, 1); border-color: #ff3333; }
  100% { box-shadow: 0 0 10px rgba(255, 51, 51, 0.5) inset, 0 0 5px rgba(255, 0, 0, 0.8); }
}
.alarm-flash { animation: flashAlarm 1s infinite; }

/* 底部滚动跑马灯 */
.bottom-marquee-bar {
  position: absolute; bottom: 15px; left: 50%; transform: translateX(-50%); width: 80%; height: 40px;
  background: rgba(4, 15, 30, 0.85); display: flex; align-items: center; overflow: hidden; padding: 0;
  border-radius: 4px;
}
.marquee-title {
  background: linear-gradient(90deg, #0088ff, transparent); padding: 0 20px; height: 100%; line-height: 40px;
  font-weight: bold; color: #fff; white-space: nowrap; z-index: 2; position: relative; border-right: 2px solid #00ffcc;
}
.marquee-content-wrap {
  flex: 1; overflow: hidden; position: relative; height: 100%; mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent);
}
.marquee-content {
  display: flex; position: absolute; left: 0; top: 0; height: 100%; align-items: center; white-space: nowrap;
  animation: marqueeRoll 30s linear infinite;
}
.marquee-content:hover { animation-play-state: paused; }
.marquee-item { margin-right: 50px; font-size: 14px; display: inline-flex; align-items: center; }
.marquee-item::before { content: '>'; margin-right: 8px; color: #00ffcc; font-weight: bold; }
.marquee-item.critical { color: #ff3333; }
.marquee-item.warning { color: #ffaa00; }
.marquee-item.info { color: #00ffcc; }

@keyframes marqueeRoll {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); } /* 移出自己宽度的一半，因为复制了一份 */
}

/* 左侧导航菜单样式 */
.sidebar-menu {
  display: flex; flex-direction: column; gap: 10px; padding: 15px; margin-bottom: 20px;
}
.menu-item {
  padding: 12px 20px; color: #88ccee; cursor: pointer; border-left: 3px solid transparent;
  transition: all 0.3s; font-size: 16px; font-weight: bold; background: rgba(0, 136, 255, 0.05);
  display: flex; align-items: center;
}
.menu-item .icon {
  margin-right: 10px; font-size: 12px; transition: transform 0.3s;
}
.menu-item:hover {
  background: rgba(0, 136, 255, 0.15); color: #fff;
}
.menu-item:hover .icon {
  transform: translateX(3px);
}
.menu-item.active {
  border-left-color: #00ffcc; background: linear-gradient(90deg, rgba(0,255,204,0.2) 0%, transparent 100%);
  color: #00ffcc; text-shadow: 0 0 8px #00ffcc;
}
</style>
