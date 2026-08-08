<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useFactoryConfig } from '../config/factoryConfig.js'
import { createDashboardDataStore } from '../runtime/DataStore.js'
import { API_BASE } from '../runtime/backendEndpoint.js'
import WidgetRenderer from '../runtime/WidgetRenderer.vue'
import { applyVisibilityAction, widgetRuntimeVisible } from '../runtime/dashboardRules.js'

const rootRef = ref(null)
const selectedWidgetId = ref('')
const hostConnected = ref(false)
const lineReturnBusy = ref(false)
const databaseValues = reactive({})
const runtimeContext = reactive({ viewId: 'factory_overview', viewMode: 'factory', sceneReady: false, sceneId: '', workshopId: '', lineId: '', deviceId: '' })
const groupVisibility = reactive({})
const widgetVisibility = reactive({})

const dataStore = createDashboardDataStore({
    metricsRefreshIntervalMs: 5000,
    eventsRefreshIntervalMs: 5000,
    trendUpdateIntervalMs: 3000
})

const {
    loadConfig,
    getPlatform,
    getWorkshops
} = useFactoryConfig()

const CONFIG_ONLY_WIDGET_TYPES = new Set([
    'device_label',
    'diagnostics',
    'line_overview_cards',
    'navigation'
])

const platform = computed(() => getPlatform() || {})
const dashboardViews = computed(() => {
    const views = platform.value.document?.scene?.views || platform.value.activeScene?.views || []
    return Array.isArray(views) && views.length
        ? views
        : [{ id: 'factory_overview', name: '全厂总览', mode: 'factory', targetType: 'factory', returnViewId: '' }]
})
const currentView = computed(() => dashboardViews.value.find(view => view.id === runtimeContext.viewId)
    || dashboardViews.value.find(view => view.mode === runtimeContext.viewMode)
    || dashboardViews.value[0])
const parentViewName = computed(() => {
    const parentId = currentView.value?.returnViewId || currentView.value?.parentViewId
    return dashboardViews.value.find(view => view.id === parentId)?.name || '上一级视角'
})
function viewComponentVisible(type, id = `widget_${type}`) {
    const state = currentView.value?.componentState || {}
    const candidates = [id, type, `system:${type}`].filter(Boolean)
    if (candidates.some(candidate => state.hide?.includes(candidate))) return false
    if (state.show?.length && !candidates.some(candidate => state.show.includes(candidate))) return false
    return true
}
const dashboardCanvas = computed(() => platform.value.document?.canvas || platform.value.canvas || {
    width: 1920,
    height: 1080,
    legacyGrid: { columns: 24, rows: 12 }
})
const grid = computed(() => ({
    columns: Math.max(1, Number(platform.value.activeScene?.layout?.grid?.columns) || 24),
    rows: Math.max(1, Number(platform.value.activeScene?.layout?.grid?.rows) || 12)
}))
const configuredWidgets = computed(() => {
    const configured = Array.isArray(platform.value.document?.widgets)
        ? platform.value.document.widgets
        : (Array.isArray(platform.value.widgets) ? platform.value.widgets : [])
    return configured
        .filter(widget => widget.visible !== 0 && widget.visible !== false)
        .filter(widget => !CONFIG_ONLY_WIDGET_TYPES.has(widget.type || widget.widget_type))
        .filter(widget => widget.runtimeTarget !== 'unity')
        .sort((left, right) => Number(left.zIndex ?? left.sort_order ?? 0) - Number(right.zIndex ?? right.sort_order ?? 0))
})
const widgets = computed(() => {
    if (runtimeContext.sceneReady === false) return []
    return configuredWidgets.value.filter(widget => {
    const state = currentView.value?.componentState || {}
    const groupId = widget.groupId ? `group:${widget.groupId}` : ''
    if (state.hide?.includes(widget.id) || (groupId && state.hide?.includes(groupId))) return false
    if (state.show?.length && !state.show.includes(widget.id) && (!groupId || !state.show.includes(groupId))) return false
    return true
    }).filter(widget => widgetRuntimeVisible(widget, {
    context: runtimeContext,
    dataValue: runtimeValueForWidget(widget),
    dataRecord: widget.data?.mode === 'database' ? databaseValues[widget.id] : null,
    groupVisibility,
    widgetVisibility
    }))
})

function getByPath(source, path) {
    if (!path) return undefined
    return String(path).split('.').reduce((current, key) => current?.[key], source)
}

const pointValues = computed(() => {
    const result = {}
    for (const workshop of getWorkshops() || []) {
        for (const line of workshop.lines || []) {
            for (const device of line.devices || []) {
                const frame = dataStore.deviceDataMap[device.id] || {}
                for (const point of device.dataPoints || []) {
                    const category = point.category || 'analog'
                    const field = point.value_role || point.name
                    const value = getByPath(frame, `${category}.${field}`)
                    const quality = getByPath(frame, `quality.${category}.${field}`) || dataStore.deviceStatusMap[device.id]?.quality || 'bad'
                    const record = { ...point, value, quality, device_id: device.id }
                    result[String(point.id)] = record
                    result[`${device.id}:${point.id}`] = record
                }
            }
        }
    }
    return result
})

function runtimeValueForWidget(widget) {
    const binding = widget?.data || widget?.binding || {}
    if (binding.mode === 'database') return databaseValues[widget.id]?.value
    if (binding.mode === 'plc' || binding.pointId || binding.point_id) {
        const pointId = String(binding.pointId || binding.point_id || '')
        const deviceId = String(binding.deviceId || binding.device_id || '')
        return pointValues.value[`${deviceId}:${pointId}`]?.value ?? pointValues.value[pointId]?.value
    }
    if (binding.mode === 'runtime') {
        const context = {
            metrics: dataStore.metrics,
            events: dataStore.events.value,
            trendPoints: dataStore.trendPoints.value,
            deviceStatusMap: dataStore.deviceStatusMap,
            deviceDataMap: dataStore.deviceDataMap
        }
        return getByPath(context, binding.path || binding.source)
    }
    return widget?.content?.value
}

const projectName = computed(() => platform.value.activeProject?.name || '热处理数字孪生')
const sceneName = computed(() => platform.value.activeScene?.name || '工厂总览')

let resizeObserver = null
let mutationObserver = null
let regionFrame = 0
let refreshTimer = 0
let selectionTimer = 0

function postHostMessage(message) {
    if (!window.chrome?.webview) return
    window.chrome.webview.postMessage(message)
}

function widgetStyle(widget) {
    if (widget.frame) {
        const canvasWidth = Math.max(1, Number(dashboardCanvas.value.width) || 1920)
        const canvasHeight = Math.max(1, Number(dashboardCanvas.value.height) || 1080)
        return {
            left: `${Number(widget.frame.x || 0) / canvasWidth * 100}%`,
            top: `${Number(widget.frame.y || 0) / canvasHeight * 100}%`,
            width: `${Number(widget.frame.width || 320) / canvasWidth * 100}%`,
            height: `${Number(widget.frame.height || 180) / canvasHeight * 100}%`,
            zIndex: Number(widget.zIndex || 0),
            transform: `rotate(${Number(widget.frame.rotation || 0)}deg)`
        }
    }
    const columns = grid.value.columns
    const rows = grid.value.rows
    const x = Math.max(0, Math.min(columns, Number(widget.x) || 0))
    const y = Math.max(0, Math.min(rows, Number(widget.y) || 0))
    const width = Math.max(1, Math.min(columns - x || 1, Number(widget.w) || 4))
    const height = Math.max(1, Math.min(rows - y || 1, Number(widget.h) || 2))
    return {
        left: `${x / columns * 100}%`,
        top: `${y / rows * 100}%`,
        width: `${width / columns * 100}%`,
        height: `${height / rows * 100}%`
    }
}

function scheduleRegionReport() {
    if (regionFrame) return
    regionFrame = window.requestAnimationFrame(() => {
        regionFrame = 0
        reportInteractionRegions()
    })
}

function reportInteractionRegions() {
    const root = rootRef.value
    if (!root) return
    const regions = [...root.querySelectorAll('[data-overlay-hit="true"]')]
        .map(element => {
            const style = window.getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0) return null
            // The outer slot intentionally keeps a small layout gutter. Only
            // the rendered shell needs a native hit-test region; including the
            // gutter makes transparent WebView2 margins visible on scaled
            // displays.
            const target = element.querySelector('.widget-shell') || element
            const targetStyle = window.getComputedStyle(target)
            const rect = target.getBoundingClientRect()
            if (rect.width < 1 || rect.height < 1) return null
            return {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                radius: Math.max(
                    Number.parseFloat(targetStyle.borderTopLeftRadius) || 0,
                    Number.parseFloat(targetStyle.borderTopRightRadius) || 0,
                    Number.parseFloat(targetStyle.borderBottomRightRadius) || 0,
                    Number.parseFloat(targetStyle.borderBottomLeftRadius) || 0
                )
            }
        })
        .filter(Boolean)

    postHostMessage({
        type: 'overlay_regions',
        viewport: {
            width: Math.max(1, window.innerWidth),
            height: Math.max(1, window.innerHeight),
            devicePixelRatio: window.devicePixelRatio || 1
        },
        regions
    })
}

function selectWidget(widgetId) {
    selectedWidgetId.value = widgetId
    window.clearTimeout(selectionTimer)
    selectionTimer = window.setTimeout(() => {
        selectedWidgetId.value = ''
        scheduleRegionReport()
    }, 900)
}

function registerConfiguredDevices() {
    for (const workshop of getWorkshops() || []) {
        for (const line of workshop.lines || []) {
            for (const device of line.devices || []) dataStore.registerDevice(device)
        }
    }
}

function eventQueryConfig() {
    const marqueeWidget = widgets.value.find(widget => (widget.type || widget.widget_type) === 'marquee')
    const alarmWidget = widgets.value.find(widget => (widget.type || widget.widget_type) === 'alarm_list')
    const marquee = marqueeWidget?.content || marqueeWidget?.config || {}
    const alarms = alarmWidget?.content || alarmWidget?.config || {}
    return {
        limit: marquee.limit || alarms.limit || 20,
        eventWindowHours: marquee.eventWindowHours ?? marquee.windowHours ?? 24,
        eventType: marquee.eventType || marquee.event_type || ''
    }
}

async function focusNativeScene(mode, event = {}) {
    const configuredView = viewFor(mode, event.viewId)
    Object.assign(runtimeContext, {
        viewId: configuredView?.id || event.viewId || runtimeContext.viewId,
        viewMode: mode,
        deviceId: mode === 'device' ? (event.deviceId || '') : '',
        lineId: mode === 'line' ? (event.lineId || runtimeContext.lineId || '') : (mode === 'device' ? runtimeContext.lineId : ''),
        workshopId: mode === 'workshop' ? (event.workshopId || '') : (['line', 'device'].includes(mode) ? runtimeContext.workshopId : '')
    })
    try {
        const response = await fetch(`${API_BASE}/native-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'view',
                source: 'dashboard_overlay',
                viewId: configuredView?.id || event.viewId || '',
                focus: {
                    mode,
                    deviceId: event.deviceId || '',
                    lineId: event.lineId || '',
                    workshopId: event.workshopId || ''
                }
            })
        })
        return response.ok
    } catch {
        // Unity 不在线时不影响数据组件本身。
        return false
    }
}

function viewFor(mode, viewId = '') {
    return dashboardViews.value.find(view => view.id === viewId)
        || dashboardViews.value.find(view => view.mode === mode)
        || dashboardViews.value[0]
}

async function focusNativeView(viewId, event = {}) {
    const view = viewFor(event.mode || 'factory', viewId)
    const mode = view?.mode === 'custom' ? (view.targetType || 'factory') : (view?.mode || event.mode || 'factory')
    Object.assign(runtimeContext, {
        viewId: view?.id || viewId || runtimeContext.viewId,
        viewMode: mode,
        deviceId: mode === 'device' ? (event.deviceId || view?.targetId || '') : '',
        lineId: mode === 'line' ? (event.lineId || view?.targetId || runtimeContext.lineId || '') : (mode === 'device' ? runtimeContext.lineId : ''),
        workshopId: mode === 'workshop' ? (event.workshopId || view?.targetId || '') : (['line', 'device'].includes(mode) ? runtimeContext.workshopId : '')
    })
    try {
        const response = await fetch(API_BASE + '/native-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'view',
                source: 'dashboard_overlay',
                viewId: view?.id || viewId || '',
                focus: {
                    mode,
                    deviceId: event.deviceId || (view?.targetType === 'device' ? view.targetId : '') || '',
                    lineId: event.lineId || (view?.targetType === 'line' ? view.targetId : '') || '',
                    workshopId: event.workshopId || (view?.targetType === 'workshop' ? view.targetId : '') || ''
                }
            })
        })
        return response.ok
    } catch {
        return false
    }
}

async function returnToLineView() {
    if (lineReturnBusy.value) return
    lineReturnBusy.value = true
    try {
        const parentId = currentView.value?.returnViewId || currentView.value?.parentViewId
        if (parentId) await focusNativeView(parentId, { mode: 'factory' })
        else await focusNativeScene('line')
    } finally {
        lineReturnBusy.value = false
    }
}

function playVoice(event) {
    if (event.audioUrl) {
        const audio = new Audio(event.audioUrl)
        audio.play().catch(() => {})
        return
    }
    if (event.text && window.speechSynthesis) {
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(event.text))
    }
}

function handleWidgetAction({ event }) {
    if (!event) return
    if (['set_visibility', 'toggle_visibility'].includes(event.action)) {
        applyVisibilityAction(event, { groupVisibility, widgetVisibility })
        scheduleRegionReport()
        return
    }
    if (event.action === 'enter_device') return focusNativeScene('device', event)
    if (event.action === 'focus_factory') return focusNativeScene('factory', event)
    if (event.action === 'focus_line') return focusNativeScene('line', event)
    if (event.action === 'focus_workshop') return focusNativeScene('workshop', event)
    if (event.action === 'switch_view' && event.viewId) return focusNativeView(event.viewId, event)
    if (event.action === 'play_voice') return playVoice(event)
    if (event.action === 'open_link' && /^https?:\/\//i.test(event.url || '')) {
        if (window.chrome?.webview) postHostMessage({ type: 'dashboard_action', action: 'open_link', url: event.url })
        else window.open(event.url, '_blank', 'noopener,noreferrer')
    }
    if (event.action === 'switch_scene' && event.sceneId) {
        fetch(`${API_BASE}/platform/scenes/${encodeURIComponent(event.sceneId)}/activate-latest-release`, { method: 'POST' }).catch(() => {})
    }
}

async function handleRuntimeMessage(message) {
    if (message?.type === 'dashboard_context_changed') {
        const payload = message.payload || {}
        Object.assign(runtimeContext, payload)
        if (!Object.prototype.hasOwnProperty.call(payload, 'sceneReady')) runtimeContext.sceneReady = true
        scheduleRegionReport()
        return
    }
    if (message?.type === 'dashboard_release_changed') {
        await loadConfig()
        runtimeContext.sceneId = platform.value.activeScene?.id || runtimeContext.sceneId
        runtimeContext.viewId = platform.value.document?.scene?.defaultViewId || platform.value.activeScene?.defaultViewId || runtimeContext.viewId
        runtimeContext.viewMode = dashboardViews.value.find(view => view.id === runtimeContext.viewId)?.mode || 'factory'
        dataStore.setEventQueryOptions(eventQueryConfig())
        await refreshDatabaseValues(true)
        await nextTick()
        scheduleRegionReport()
    }
}

function handleHostMessage(event) {
    if (event.data?.type !== 'overlay_host_state') return
    hostConnected.value = event.data.visible !== false
    if (event.data.context) {
        Object.assign(runtimeContext, event.data.context)
        if (!Object.prototype.hasOwnProperty.call(event.data.context, 'sceneReady')) runtimeContext.sceneReady = true
    }
    scheduleRegionReport()
}

async function refreshDatabaseValues(force = false) {
    if (!force && !configuredWidgets.value.some(widget => widget.data?.mode === 'database')) return
    try {
        const response = await fetch(`${API_BASE}/data-sources/runtime-values`)
        if (!response.ok) return
        const payload = await response.json()
        const next = payload.values || {}
        Object.keys(databaseValues).forEach(key => { if (!(key in next)) delete databaseValues[key] })
        Object.assign(databaseValues, next)
    } catch {
        // 外部数据库短暂离线时保留上一次画面，质量状态由后端结果更新。
    }
}

onMounted(async () => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    window.chrome?.webview?.addEventListener('message', handleHostMessage)

    await loadConfig()
    runtimeContext.sceneId = platform.value.activeScene?.id || ''
    runtimeContext.viewId = platform.value.document?.scene?.defaultViewId || platform.value.activeScene?.defaultViewId || 'factory_overview'
    runtimeContext.viewMode = dashboardViews.value.find(view => view.id === runtimeContext.viewId)?.mode || 'factory'
    if (!window.chrome?.webview) runtimeContext.sceneReady = true
    registerConfiguredDevices()
    dataStore.setEventQueryOptions(eventQueryConfig())
    dataStore.setMessageHandler(handleRuntimeMessage)
    dataStore.connect()
    await Promise.all([
        dataStore.refreshEvents(true),
        dataStore.refreshMetrics(true),
        refreshDatabaseValues(true)
    ])

    await nextTick()
    resizeObserver = new ResizeObserver(scheduleRegionReport)
    resizeObserver.observe(rootRef.value)
    for (const element of rootRef.value.querySelectorAll('[data-overlay-hit="true"]')) {
        resizeObserver.observe(element)
    }
    mutationObserver = new MutationObserver(scheduleRegionReport)
    mutationObserver.observe(rootRef.value, { childList: true, subtree: true, attributes: true })
    window.addEventListener('resize', scheduleRegionReport)
    refreshTimer = window.setInterval(() => {
        dataStore.refreshEvents()
        dataStore.refreshMetrics()
        refreshDatabaseValues()
    }, 5000)

    hostConnected.value = true
    postHostMessage({ type: 'overlay_ready' })
    scheduleRegionReport()
})

onUnmounted(() => {
    if (regionFrame) window.cancelAnimationFrame(regionFrame)
    window.clearInterval(refreshTimer)
    window.clearTimeout(selectionTimer)
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    window.removeEventListener('resize', scheduleRegionReport)
    window.chrome?.webview?.removeEventListener('message', handleHostMessage)
    dataStore.dispose()
})
</script>

<template>
    <div ref="rootRef" class="dashboard-overlay-root" :class="{ 'is-scene-ready': runtimeContext.sceneReady !== false }">
        <div class="overlay-canvas">
            <button
                type="button"
                v-if="runtimeContext.viewMode !== 'factory' && viewComponentVisible('navigation')"
                class="overlay-line-return"
                :class="{ 'is-busy': lineReturnBusy }"
                :disabled="lineReturnBusy"
                :aria-label="`返回${parentViewName}`"
                :title="`返回${parentViewName}`"
                data-overlay-hit="true"
                @pointerdown.stop
                @click.stop="returnToLineView"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M15.25 4.75 8 12l7.25 7.25" />
                </svg>
            </button>

            <button
                type="button"
                class="overlay-status"
                :class="{ online: dataStore.wsConnected.value && hostConnected }"
                data-overlay-hit="true"
                @click="selectWidget('overlay-status')"
            >
                <span class="overlay-status-dot"></span>
                <span>{{ projectName }} · {{ sceneName }}</span>
                <strong>{{ dataStore.plcStatusText.value }}</strong>
            </button>

            <div
                v-for="widget in widgets"
                :key="widget.id"
                class="overlay-widget"
                :class="[
                    `widget-type-${widget.type || widget.widget_type}`,
                    { 'is-selected': selectedWidgetId === widget.id }
                ]"
                :style="widgetStyle(widget)"
                data-overlay-hit="true"
                @pointerdown.stop
                @click="selectWidget(widget.id)"
            >
                <WidgetRenderer
                    :widget="widget"
                    :metrics="dataStore.metrics"
                    :events="dataStore.events.value"
                    :trend-points="dataStore.trendPoints.value"
                    :device-status-map="dataStore.deviceStatusMap"
                    :device-data-map="dataStore.deviceDataMap"
                    :point-values="pointValues"
                    :database-values="databaseValues"
                    @action="handleWidgetAction"
                />
            </div>
        </div>
    </div>
</template>

<style>
html,
body,
#app {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: transparent !important;
}

.dashboard-overlay-root,
.dashboard-overlay-root * {
    box-sizing: border-box;
}

.dashboard-overlay-root {
    position: fixed;
    inset: 0;
    overflow: hidden;
    color: #eef7ff;
    background: transparent;
    pointer-events: none;
    user-select: none;
    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
}

.overlay-canvas {
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity 240ms ease;
}
.dashboard-overlay-root.is-scene-ready .overlay-canvas { opacity: 1; }

.overlay-line-return {
    position: absolute;
    top: 20px;
    left: 20px;
    z-index: 35;
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    color: rgba(255, 255, 255, 0.94);
    background: rgba(29, 29, 31, 0.72);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(18px) saturate(140%);
    pointer-events: auto;
    cursor: pointer;
    transition: transform 160ms ease, border-color 160ms ease, background 160ms ease, opacity 160ms ease;
}

.overlay-line-return:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: rgba(255, 255, 255, 0.24);
    background: rgba(58, 58, 60, 0.82);
}

.overlay-line-return:active:not(:disabled) { transform: translateY(0) scale(0.97); }
.overlay-line-return:focus-visible { outline: 2px solid rgba(99, 196, 255, 0.92); outline-offset: 2px; }
.overlay-line-return:disabled { opacity: 0.62; cursor: wait; }
.overlay-line-return svg {
    width: 20px;
    height: 20px;
    overflow: visible;
    fill: none;
    stroke: #ffffff !important;
    stroke-width: 2.15;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 160ms ease;
}
.overlay-line-return svg path { stroke: #ffffff !important; fill: none !important; }
.overlay-line-return:hover:not(:disabled) svg { transform: translateX(-1px); }
.overlay-line-return.is-busy svg { animation: overlayReturnPulse 700ms ease-in-out infinite alternate; }

.overlay-status {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 30;
    min-height: 34px;
    max-width: min(620px, 56vw);
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 14px;
    transform: translateX(-50%);
    border: 1px solid rgba(128, 185, 232, 0.28);
    border-radius: 999px;
    color: #c8d8e6;
    background: linear-gradient(180deg, rgba(18, 35, 53, 0.86), rgba(8, 20, 34, 0.78));
    box-shadow: 0 12px 32px rgba(0, 8, 18, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(12px);
    pointer-events: auto;
    cursor: pointer;
}

.overlay-status span,
.overlay-status strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.overlay-status span { font-size: 12px; font-weight: 600; }
.overlay-status strong { color: #f5b95e; font-size: 11px; font-weight: 600; }
.overlay-status-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 8px;
    border-radius: 50%;
    background: #df6666;
    box-shadow: 0 0 0 4px rgba(223, 102, 102, 0.12);
}
.overlay-status.online .overlay-status-dot {
    background: #4fd29a;
    box-shadow: 0 0 0 4px rgba(79, 210, 154, 0.12), 0 0 14px rgba(79, 210, 154, 0.48);
}

.overlay-widget {
    position: absolute;
    min-width: 0;
    min-height: 0;
    padding: 0;
    overflow: visible;
    pointer-events: auto;
    cursor: default;
    transition: filter 160ms ease, transform 160ms ease;
}

.overlay-widget.is-selected {
    z-index: 20;
    filter: drop-shadow(0 0 12px rgba(88, 184, 255, 0.72));
    transform: translateY(-1px);
}

.overlay-widget .widget-shell {
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 14px;
    color: #edf6fc;
    border: 1px solid rgba(144, 194, 232, 0.24);
    border-radius: 12px;
    background:
        linear-gradient(145deg, rgba(24, 48, 70, 0.88), rgba(7, 22, 37, 0.78)),
        rgba(10, 27, 43, 0.82);
    box-shadow: 0 18px 46px rgba(0, 8, 18, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.055);
    backdrop-filter: blur(12px) saturate(118%);
}

.overlay-widget .widget-title {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 10px;
    color: #f5f9fc;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
}

.overlay-widget .widget-title i {
    width: 3px;
    height: 16px;
    display: inline-block;
    border-radius: 999px;
    background: linear-gradient(#6fc9ff, #308ee5);
    box-shadow: 0 0 10px rgba(79, 173, 245, 0.52);
}

.overlay-widget .metrics-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(94px, 39%) minmax(0, 1fr);
    gap: 12px;
    align-items: center;
}

.overlay-widget .widget-chart {
    width: 100%;
    height: 100%;
    min-height: 110px;
}

.overlay-widget .trend-chart { min-height: 150px; }
.overlay-widget .metric-list { min-width: 0; display: grid; gap: 7px; }
.overlay-widget .metric-row {
    min-width: 0;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 9px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-radius: 7px;
    color: #aebfcd;
    background: rgba(255, 255, 255, 0.045);
    font-size: 12px;
}
.overlay-widget .metric-row span,
.overlay-widget .metric-row strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.overlay-widget .metric-row strong { color: #f3f8fc; }

.overlay-widget .alarm-list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
}
.overlay-widget .alarm-list li {
    min-height: 34px;
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    color: #c7d4de;
    font-size: 12px;
}
.overlay-widget .rank,
.overlay-widget .tag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: #fff;
    background: #4c6273;
}
.overlay-widget .rank { width: 22px; height: 22px; }
.overlay-widget .tag { min-height: 22px; padding: 2px 7px; font-size: 10px; }
.overlay-widget .rank.critical,
.overlay-widget .tag.critical { background: #a43e45; }
.overlay-widget .rank.warning,
.overlay-widget .tag.warning { background: #a6742e; }
.overlay-widget .rank.info,
.overlay-widget .tag.info { background: #36799f; }
.overlay-widget .alarm-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.overlay-widget.widget-type-marquee { padding: 0; }
.overlay-widget.widget-type-marquee .widget-shell {
    min-height: 0;
    padding: 0 14px;
    border-radius: 999px;
}
.overlay-widget.widget-type-marquee .widget-title { display: none; }
.overlay-widget .marquee-content-wrap {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent);
}
.overlay-widget .marquee-content {
    height: 100%;
    display: flex;
    align-items: center;
    white-space: nowrap;
    animation: overlayMarquee 30s linear infinite;
}
.overlay-widget .marquee-item { margin-right: 38px; color: #d5e0e8; font-size: 12px; }
.overlay-widget .marquee-item.critical { color: #ff9696; }
.overlay-widget .marquee-item.warning { color: #ffd27e; }
.overlay-widget .marquee-item.info { color: #8ed4ff; }

.overlay-widget .text-widget-body {
    flex: 1;
    min-height: 0;
    display: grid;
    align-content: center;
    gap: 7px;
    color: #d5e2eb;
}
.overlay-widget .text-widget-body p { margin: 0; }

@keyframes overlayMarquee {
    from { transform: translateX(0); }
    to { transform: translateX(-50%); }
}

@keyframes overlayReturnPulse {
    from { opacity: 0.45; }
    to { opacity: 1; }
}

@media (max-width: 1180px), (max-height: 680px) {
    .overlay-canvas { inset: 12px 16px 16px; }
    .overlay-widget .widget-shell { padding: 10px; border-radius: 10px; }
    .overlay-widget .widget-title { margin-bottom: 7px; font-size: 12px; }
    .overlay-widget .metric-row { padding: 5px 7px; font-size: 11px; }
    .overlay-status { min-height: 30px; padding: 5px 10px; }
    .overlay-line-return { top: 0; left: 0; width: 38px; height: 38px; border-radius: 10px; }
}
</style>
