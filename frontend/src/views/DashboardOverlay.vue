<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useFactoryConfig } from '../config/factoryConfig.js'
import { createDashboardDataStore } from '../runtime/DataStore.js'
import WidgetRenderer from '../runtime/WidgetRenderer.vue'

const rootRef = ref(null)
const selectedWidgetId = ref('')
const hostConnected = ref(false)

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

const fallbackWidgets = [
    {
        id: 'overlay_metrics',
        widget_type: 'metrics',
        title: '生产指标',
        x: 0,
        y: 0,
        w: 5,
        h: 5,
        visible: 1,
        config: { compact: true },
        binding: {}
    },
    {
        id: 'overlay_trend',
        widget_type: 'trend',
        title: '温度趋势',
        x: 19,
        y: 0,
        w: 5,
        h: 5,
        visible: 1,
        config: { seriesName: '平均温度', lineColor: '#58b8ff', areaColor: 'rgba(88,184,255,0.16)' },
        binding: {}
    },
    {
        id: 'overlay_alarms',
        widget_type: 'alarm_list',
        title: '报警履历',
        x: 19,
        y: 5,
        w: 5,
        h: 5,
        visible: 1,
        config: { limit: 5 },
        binding: {}
    },
    {
        id: 'overlay_marquee',
        widget_type: 'marquee',
        title: '实时日志',
        x: 3,
        y: 11,
        w: 18,
        h: 1,
        visible: 1,
        config: { speed: 30, limit: 20, eventWindowHours: 24 },
        binding: {}
    }
]

const platform = computed(() => getPlatform() || {})
const grid = computed(() => ({
    columns: Math.max(1, Number(platform.value.activeScene?.layout?.grid?.columns) || 24),
    rows: Math.max(1, Number(platform.value.activeScene?.layout?.grid?.rows) || 12)
}))
const widgets = computed(() => {
    const configured = Array.isArray(platform.value.widgets) && platform.value.widgets.length
        ? platform.value.widgets
        : fallbackWidgets
    return configured
        .filter(widget => widget.visible !== 0 && widget.visible !== false)
        .filter(widget => !CONFIG_ONLY_WIDGET_TYPES.has(widget.widget_type))
        .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0))
})

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
    const marquee = widgets.value.find(widget => widget.widget_type === 'marquee')?.config || {}
    const alarms = widgets.value.find(widget => widget.widget_type === 'alarm_list')?.config || {}
    return {
        limit: marquee.limit || alarms.limit || 20,
        eventWindowHours: marquee.eventWindowHours ?? marquee.windowHours ?? 24,
        eventType: marquee.eventType || marquee.event_type || ''
    }
}

function handleHostMessage(event) {
    if (event.data?.type !== 'overlay_host_state') return
    hostConnected.value = event.data.visible !== false
    scheduleRegionReport()
}

onMounted(async () => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    window.chrome?.webview?.addEventListener('message', handleHostMessage)

    await loadConfig()
    registerConfiguredDevices()
    dataStore.setEventQueryOptions(eventQueryConfig())
    dataStore.connect()
    await Promise.all([
        dataStore.refreshEvents(true),
        dataStore.refreshMetrics(true)
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
    <div ref="rootRef" class="dashboard-overlay-root">
        <div class="overlay-canvas">
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
                    `widget-type-${widget.widget_type}`,
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
    inset: 18px 24px 24px;
}

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
    min-width: 150px;
    min-height: 60px;
    padding: 0 9px 9px 0;
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

@media (max-width: 1180px), (max-height: 680px) {
    .overlay-canvas { inset: 12px 16px 16px; }
    .overlay-widget .widget-shell { padding: 10px; border-radius: 10px; }
    .overlay-widget .widget-title { margin-bottom: 7px; font-size: 12px; }
    .overlay-widget .metric-row { padding: 5px 7px; font-size: 11px; }
    .overlay-status { min-height: 30px; padding: 5px 10px; }
}
</style>
