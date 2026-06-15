<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useFactoryConfig } from './config/factoryConfig.js'
import { SceneRuntime } from './runtime/SceneRuntime.js'
import { createDashboardDataStore } from './runtime/DataStore.js'
import { getFirstWidget, getSceneCamera } from './runtime/LayoutConfig.js'
import WidgetRenderer from './runtime/WidgetRenderer.vue'

const threeContainer = ref(null)
const currentLevel = ref(0)
const currentWorkshop = ref(-1)
const currentLine = ref(-1)
const currentTime = ref('')
const currentDate = ref('')
const isDrawerOpen = ref(true)
const topLevel = ref(0)

let sceneRuntime = null
let clockTimer = null

const dataStore = createDashboardDataStore()
const {
  config: factoryConfig,
  loadConfig,
  getWorkshops,
  getSetting,
  getFactoryName,
  getPlatform
} = useFactoryConfig()

const allWorkshops = computed(() => getWorkshops())
const platform = computed(() => getPlatform() || {})
const metricWidget = computed(() => getFirstWidget(platform.value, 'metrics', { widget_type: 'metrics', title: '生产指标', config: {} }))
const trendWidget = computed(() => getFirstWidget(platform.value, 'trend', { widget_type: 'trend', title: '历史趋势', config: {} }))
const alarmWidget = computed(() => getFirstWidget(platform.value, 'alarm_list', { widget_type: 'alarm_list', title: '报警履历', config: { limit: 5 } }))
const marqueeWidget = computed(() => getFirstWidget(platform.value, 'marquee', { widget_type: 'marquee', title: '实时日志', config: { speed: 30 } }))
const fixedWidgetIds = computed(() => new Set([
  metricWidget.value?.id,
  trendWidget.value?.id,
  alarmWidget.value?.id,
  marqueeWidget.value?.id
].filter(Boolean)))
const overlayWidgets = computed(() => (platform.value.widgets || []).filter(widget =>
  widget.widget_type !== 'navigation' &&
  widget.visible !== 0 &&
  widget.visible !== false &&
  !fixedWidgetIds.value.has(widget.id)
))

const currentLineDevices = computed(() => {
  if (currentLine.value < 0) return []
  let c = 0
  for (const ws of allWorkshops.value) {
    for (const line of ws.lines || []) {
      if (c === currentLine.value) return line.devices || []
      c++
    }
  }
  return []
})

const diagnosticGroups = computed(() => {
  const data = dataStore.selectedDeviceData
  return [
    { title: '温度监控', rows: [
      { label: '实际', value: data.analog?.actual_temp ?? '--', unit: '°C', quality: data.quality?.analog?.actual_temp },
      { label: '设定', value: data.analog?.setpoint_temp ?? '--', unit: '°C', quality: data.quality?.analog?.setpoint_temp }
    ] },
    { title: '碳势监控', rows: [
      { label: '实际', value: data.analog?.actual_carbon ?? '--', unit: '%', quality: data.quality?.analog?.actual_carbon },
      { label: '设定', value: data.analog?.setpoint_carbon ?? '--', unit: '%', quality: data.quality?.analog?.setpoint_carbon }
    ] },
    { title: '电机状态', rows: [
      { label: '搅拌', value: data.motors?.stir_motor ? '运行' : '停止', quality: data.quality?.motors?.stir_motor },
      { label: '风扇', value: data.motors?.fan_motor ? '运行' : '停止', quality: data.quality?.motors?.fan_motor }
    ] },
    { title: '机构状态', rows: [
      { label: '推链', value: data.mechanisms?.push_chain_forward ? '向前推入' : '默认位置', quality: data.quality?.mechanisms?.push_chain_forward },
      { label: '前门', value: data.doors?.front_door_open ? '已开启' : '关闭中', quality: data.quality?.doors?.front_door_open }
    ] }
  ]
})

function updateTime() {
  const now = new Date()
  currentTime.value = now.toLocaleTimeString()
  currentDate.value = now.toLocaleDateString()
}

function handleWorkshopSelected(e) {
  currentWorkshop.value = e.detail
  currentLine.value = -1
  currentLevel.value = 1
}

function handleLineSelected(e) {
  currentLine.value = e.detail
  currentLevel.value = 2
}

function handleFactorySelected() {
  currentWorkshop.value = -1
  currentLine.value = -1
  currentLevel.value = 0
}

function getGlobalLineIdx(wIdx, lIdx) {
  let count = 0
  for (let i = 0; i < wIdx; i++) count += (allWorkshops.value[i].lines || []).length
  return count + lIdx
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
}

function selectGlobal() {
  currentWorkshop.value = -1
  currentLine.value = -1
  sceneRuntime?.flyToFactory()
}

function selectWorkshop(idx) {
  currentWorkshop.value = idx
  currentLine.value = -1
  sceneRuntime?.flyToWorkshop(idx)
}

function selectLine(idx) {
  currentLine.value = idx
  sceneRuntime?.flyToLine(idx)
}

function goBack() {
  sceneRuntime?.goUp()
  isDrawerOpen.value = true
}

function controlCamera(action) {
  sceneRuntime?.controlCamera(action)
}

function getWidgetGridStyle(widget) {
  const columns = platform.value.activeScene?.layout?.grid?.columns || 24
  const rows = platform.value.activeScene?.layout?.grid?.rows || 12
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

onMounted(async () => {
  updateTime()
  clockTimer = setInterval(updateTime, 1000)
  await loadConfig()

  const sceneCamera = getSceneCamera(platform.value)
  dataStore.setStaleMs(getSetting('realtime_stale_ms', sceneCamera.staleMs || 6000))

  sceneRuntime = new SceneRuntime(threeContainer.value, {
    workshops: getWorkshops(),
    models: factoryConfig.models || [],
    cameraMode: getSetting('camera_mode', sceneCamera.mode || 'auto'),
    onLevelChange: level => { currentLevel.value = level },
    onDeviceSelect: deviceId => dataStore.selectDevice(deviceId),
    onDeviceRegistered: deviceCfg => dataStore.registerDevice(deviceCfg)
  })

  await sceneRuntime.start()
  topLevel.value = sceneRuntime.sceneManager?.topLevel ?? 0
  if (topLevel.value === 1) {
    selectWorkshop(0)
  } else {
    selectGlobal()
  }
  dataStore.setDeviceDataHandler(data => sceneRuntime.applyDeviceData(data))
  dataStore.connect()
  dataStore.refreshEvents(true)
  dataStore.refreshMetrics(true)

  window.addEventListener('workshop-selected', handleWorkshopSelected)
  window.addEventListener('line-selected', handleLineSelected)
  window.addEventListener('factory-selected', handleFactorySelected)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
  dataStore.dispose()
  sceneRuntime?.dispose()
  sceneRuntime = null
  window.removeEventListener('workshop-selected', handleWorkshopSelected)
  window.removeEventListener('line-selected', handleLineSelected)
  window.removeEventListener('factory-selected', handleFactorySelected)
})
</script>

<template>
  <div class="dashboard-container">
    <div ref="threeContainer" class="three-layer"></div>

    <div class="ui-layer" :class="'level-' + currentLevel">
      <header class="header">
        <div class="header-left">
          <div class="connection-pill" :class="{ online: dataStore.wsConnected.value }">
            <span></span>{{ dataStore.plcStatusText.value }}
          </div>
        </div>
        <div class="header-center">
          <h1>{{ getFactoryName() }}</h1>
          <p>{{ platform.activeProject?.name || '热处理车间大屏项目' }} / {{ platform.activeScene?.name || '工厂总览' }}</p>
        </div>
        <div class="header-right">
          <div class="time"><span>{{ currentDate }}</span>{{ currentTime }}</div>
          <button class="icon-btn" @click="toggleFullscreen" title="全屏切换">⛶</button>
        </div>
      </header>

      <transition name="fade-slide-left">
        <div class="side-panel left-panel" v-if="currentLevel < 3">
          <div class="navigation-panel industrial-panel">
            <div v-if="topLevel === 0" class="menu-item" :class="{ active: currentLevel === 0 }" @click="selectGlobal">
              <span class="menu-icon">▦</span> 全局总览
            </div>
            <template v-for="(ws, wIdx) in allWorkshops" :key="ws.id">
              <div class="menu-item workshop-item" :class="{ active: currentLevel === 1 && currentWorkshop === wIdx }" @click="selectWorkshop(wIdx)">
                <span class="menu-icon">厂</span>{{ ws.name }}
              </div>
              <div
                v-for="(line, lIdx) in ws.lines"
                :key="line.id"
                class="menu-item line-item"
                :class="{ active: currentLevel === 2 && currentLine === getGlobalLineIdx(wIdx, lIdx) }"
                @click="selectLine(getGlobalLineIdx(wIdx, lIdx))"
              >
                <span class="menu-icon">→</span>{{ line.name }}
              </div>
            </template>
          </div>

          <WidgetRenderer
            :widget="metricWidget"
            :metrics="dataStore.metrics"
            :events="dataStore.events.value"
            :trend-points="dataStore.trendPoints.value"
          />
        </div>
      </transition>

      <transition name="fade-slide-right">
        <div class="side-panel right-panel" v-if="currentLevel < 2">
          <WidgetRenderer
            :widget="trendWidget"
            :metrics="dataStore.metrics"
            :events="dataStore.events.value"
            :trend-points="dataStore.trendPoints.value"
          />
          <WidgetRenderer
            :widget="alarmWidget"
            :metrics="dataStore.metrics"
            :events="dataStore.events.value"
            :trend-points="dataStore.trendPoints.value"
          />
        </div>
      </transition>

      <transition name="slide-up">
        <div class="bottom-drawer-panel industrial-panel" v-if="currentLevel === 3" :class="{ 'drawer-closed': !isDrawerOpen }">
          <div class="drawer-handle" @click="isDrawerOpen = !isDrawerOpen">
            {{ isDrawerOpen ? '收起诊断面板' : '展开诊断面板' }}
          </div>
          <div class="drawer-content">
            <h2>{{ dataStore.selectedDeviceData.furnace_name || '设备' }} 详细诊断</h2>
            <div class="diagnostic-grid">
              <div class="diag-card" v-for="group in diagnosticGroups" :key="group.title">
                <h3>{{ group.title }}</h3>
                <div class="diag-row" v-for="row in group.rows" :key="row.label">
                  <span>{{ row.label }}</span>
                  <strong :class="'quality-' + (row.quality || 'good')">{{ row.value }} <em>{{ row.unit }}</em></strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <div class="config-widget-layer" v-if="overlayWidgets.length">
        <div
          v-for="widget in overlayWidgets"
          :key="widget.id"
          class="config-widget-slot"
          :style="getWidgetGridStyle(widget)"
        >
          <WidgetRenderer
            :widget="widget"
            :metrics="dataStore.metrics"
            :events="dataStore.events.value"
            :trend-points="dataStore.trendPoints.value"
          />
        </div>
      </div>

      <div class="camera-controls" v-if="currentLevel === 3">
        <button class="tool-btn" @click="controlCamera('rotateLeft')" title="向左旋转">↺</button>
        <button class="tool-btn" @click="controlCamera('rotateRight')" title="向右旋转">↻</button>
        <button class="tool-btn" @click="controlCamera('zoomIn')" title="拉近放大">＋</button>
        <button class="tool-btn" @click="controlCamera('zoomOut')" title="拉远缩小">－</button>
      </div>

      <button class="back-btn" v-if="currentLevel > 0 && !(currentLevel === 1 && topLevel === 1)" @click="goBack">
        返回上一级
      </button>

      <transition name="fade-up">
        <div class="device-overview-bar" v-if="currentLevel === 2 && currentLineDevices.length > 0">
          <div
            v-for="deviceCfg in currentLineDevices"
            :key="deviceCfg.id"
            class="device-mini-card industrial-panel"
            :class="[
              'quality-' + (dataStore.deviceStatusMap[deviceCfg.id]?.quality || 'bad'),
              { 'alarm-flash': dataStore.deviceStatusMap[deviceCfg.id]?.alarm }
            ]"
          >
            <div class="card-header">
              <span class="dot" :class="dataStore.deviceStatusMap[deviceCfg.id]?.quality || 'bad'"></span>
              {{ dataStore.deviceStatusMap[deviceCfg.id]?.name || deviceCfg.name }}
            </div>
            <div class="card-body">
              <span>{{ dataStore.deviceStatusMap[deviceCfg.id]?.temp || '--' }} °C</span>
              <span>{{ dataStore.deviceStatusMap[deviceCfg.id]?.carbon || '--' }} %</span>
            </div>
          </div>
        </div>
      </transition>

      <div class="bottom-marquee-bar" v-if="currentLevel < 2">
        <WidgetRenderer
          :widget="marqueeWidget"
          :metrics="dataStore.metrics"
          :events="dataStore.events.value"
          :trend-points="dataStore.trendPoints.value"
        />
      </div>
    </div>
  </div>
</template>

<style>
html, body { margin: 0; padding: 0; }

.dashboard-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
  color: #eef2f4;
  background: #20262b;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}

.three-layer { position: absolute; inset: 0; z-index: 1; }
.ui-layer { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
.ui-layer > * { pointer-events: auto; }

.header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 82px;
  display: grid;
  grid-template-columns: 360px 1fr 360px;
  align-items: center;
  padding: 0 28px;
  background: linear-gradient(180deg, rgba(23, 29, 34, 0.94), rgba(23, 29, 34, 0.58), transparent);
}

.header-center { text-align: center; }
.header-center h1 { margin: 0; font-size: 30px; letter-spacing: 3px; color: #f4f7f8; }
.header-center p { margin: 6px 0 0; font-size: 13px; color: #aeb7bf; }
.header-right { justify-self: end; display: flex; align-items: center; gap: 16px; }
.time { font-family: Consolas, monospace; color: #f0b35a; font-size: 20px; }
.time span { margin-right: 12px; color: #aeb7bf; font-size: 14px; }
.icon-btn { width: 34px; height: 34px; border: 1px solid #59636c; background: rgba(31, 37, 42, .8); color: #e8ecef; cursor: pointer; }

.connection-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid #59636c;
  background: rgba(30, 36, 40, .82);
  color: #aeb7bf;
  font-size: 13px;
}
.connection-pill span { width: 8px; height: 8px; border-radius: 50%; background: #d96060; }
.connection-pill.online span { background: #4fc08d; box-shadow: 0 0 10px rgba(79, 192, 141, .8); }

.industrial-panel {
  background: rgba(30, 36, 40, .84);
  border: 1px solid rgba(148, 160, 170, .28);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .28);
  backdrop-filter: blur(6px);
}

.side-panel { position: absolute; top: 98px; bottom: 64px; width: 420px; display: flex; flex-direction: column; gap: 16px; }
.left-panel { left: 28px; }
.right-panel { right: 28px; }

.navigation-panel { padding: 12px; max-height: 40vh; overflow-y: auto; }
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  margin-bottom: 6px;
  color: #d2d8dc;
  cursor: pointer;
  border-left: 3px solid transparent;
  background: rgba(255, 255, 255, .035);
}
.line-item { margin-left: 18px; color: #aeb7bf; }
.menu-item.active { border-left-color: #f0b35a; background: rgba(240, 179, 90, .14); color: #fff; }
.menu-icon { width: 22px; color: #f0b35a; text-align: center; }

.widget-shell { padding: 16px; min-height: 170px; }
.widget-title { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-weight: 600; color: #f4f7f8; }
.widget-title i { width: 4px; height: 18px; background: #f0b35a; display: inline-block; }
.metrics-layout { display: grid; grid-template-columns: 150px 1fr; gap: 14px; align-items: center; }
.widget-chart { width: 100%; height: 160px; }
.trend-chart { height: 250px; }
.metric-list { display: grid; gap: 8px; }
.metric-row { display: flex; justify-content: space-between; padding: 8px 10px; background: rgba(255,255,255,.035); color: #aeb7bf; }
.metric-row strong { color: #f4f7f8; }
.text-widget-body { height: calc(100% - 30px); display: flex; flex-direction: column; justify-content: center; gap: 6px; color: #d2d8dc; font-size: 16px; line-height: 1.45; }
.text-widget-body p { margin: 0; }
.text-widget-body.tone-warning { color: #ffd180; }
.text-widget-body.tone-critical { color: #ff8a80; }
.text-widget-body.tone-success { color: #9be7be; }
.alarm-list { padding: 0; margin: 0; list-style: none; }
.alarm-list li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
.rank { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; background: #454d55; color: #fff; font-size: 12px; }
.rank.critical, .tag.critical { background: #9f3333; }
.rank.warning, .tag.warning { background: #a6762d; }
.rank.info, .tag.info { background: #3f6f8a; }
.alarm-txt { flex: 1; color: #d2d8dc; font-size: 13px; }
.tag { padding: 3px 6px; color: #fff; font-size: 11px; }

.config-widget-layer {
  position: absolute;
  inset: 98px 28px 72px;
  pointer-events: none;
}
.config-widget-slot {
  position: absolute;
  min-width: 180px;
  min-height: 74px;
  padding: 0 8px 8px 0;
  pointer-events: auto;
}
.config-widget-slot .widget-shell { width: 100%; height: 100%; min-height: 0; overflow: hidden; }

.bottom-drawer-panel { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); width: 940px; transition: transform .35s; }
.bottom-drawer-panel.drawer-closed { transform: translateX(-50%) translateY(calc(100% - 30px)); }
.drawer-handle { height: 30px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.1); color: #f0b35a; font-size: 13px; }
.drawer-content { padding: 18px 28px 26px; }
.drawer-content h2 { text-align: center; margin: 0 0 18px; font-size: 19px; }
.diagnostic-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.diag-card { padding: 14px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.diag-card h3 { margin: 0 0 12px; font-size: 14px; color: #f0b35a; }
.diag-row { display: flex; justify-content: space-between; align-items: center; margin: 8px 0; font-size: 13px; color: #aeb7bf; }
.diag-row strong { color: #f4f7f8; }
.diag-row em { color: #aeb7bf; font-style: normal; font-size: 12px; }

.camera-controls { position: absolute; right: 32px; top: 50%; transform: translateY(-50%); display: grid; gap: 12px; }
.tool-btn { width: 40px; height: 40px; border: 1px solid #59636c; background: rgba(30,36,40,.9); color: #f0b35a; cursor: pointer; }
.back-btn { position: absolute; top: 100px; left: 28px; padding: 9px 18px; border: 1px solid #59636c; background: rgba(30,36,40,.9); color: #f4f7f8; cursor: pointer; }

.device-overview-bar { position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; width: min(1200px, 92vw); }
.device-mini-card { width: 142px; padding: 10px 12px; }
.card-header { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #d96060; }
.dot.good { background: #4fc08d; }
.dot.stale { background: #f0b35a; }
.dot.bad { background: #d96060; }
.card-body { display: flex; justify-content: space-between; color: #f0b35a; font-size: 13px; }
.quality-stale { border-color: rgba(240, 179, 90, .55); }
.quality-bad { border-color: rgba(217, 96, 96, .72); opacity: .72; }
.diag-row strong.quality-stale { color: #f0b35a; }
.diag-row strong.quality-bad { color: #d96060; }

.bottom-marquee-bar { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(1200px, 82vw); height: 42px; overflow: hidden; pointer-events: auto; }
.bottom-marquee-bar .widget-shell { min-height: 0; height: 42px; padding: 0; background: rgba(30,36,40,.88); }
.bottom-marquee-bar .widget-title { display: none; }
.marquee-content-wrap { height: 100%; overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent); }
.marquee-content { display: flex; height: 100%; align-items: center; white-space: nowrap; animation: marqueeRoll 30s linear infinite; }
.marquee-item { margin-right: 42px; color: #d2d8dc; font-size: 13px; }
.marquee-item.critical { color: #ff8a80; }
.marquee-item.warning { color: #ffd180; }
.marquee-item.info { color: #9ad4f5; }

@keyframes marqueeRoll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@keyframes flashAlarm { 0%, 100% { box-shadow: 0 0 0 rgba(217,96,96,.0); } 50% { box-shadow: 0 0 18px rgba(217,96,96,.75); } }
.alarm-flash { animation: flashAlarm 1.2s infinite; }
.fade-slide-left-enter-active, .fade-slide-left-leave-active,
.fade-slide-right-enter-active, .fade-slide-right-leave-active,
.fade-up-enter-active, .fade-up-leave-active { transition: all .45s ease; }
.fade-slide-left-enter-from, .fade-slide-left-leave-to { opacity: 0; transform: translateX(-60px); }
.fade-slide-right-enter-from, .fade-slide-right-leave-to { opacity: 0; transform: translateX(60px); }
.fade-up-enter-from, .fade-up-leave-to { opacity: 0; transform: translate(-50%, 40px); }
</style>
