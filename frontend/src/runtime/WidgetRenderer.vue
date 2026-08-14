<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  widget: { type: Object, default: () => ({ type: 'metrics', title: '' }) },
  metrics: { type: Object, default: () => ({}) },
  events: { type: Array, default: () => [] },
  trendPoints: { type: Array, default: () => [] },
  deviceStatusMap: { type: Object, default: () => ({}) },
  deviceDataMap: { type: Object, default: () => ({}) },
  pointValues: { type: Object, default: () => ({}) },
  databaseValues: { type: Object, default: () => ({}) },
  preview: { type: Boolean, default: false }
})

const emit = defineEmits(['action'])
const chartRef = ref(null)
const localTrend = ref([])
let chart = null

function getByPath(source, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => current?.[key], source)
}

function objectValue(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

const type = computed(() => props.widget.type || props.widget.widget_type || 'text')
const content = computed(() => objectValue(props.widget.content, objectValue(props.widget.config, {})))
const widgetStyle = computed(() => objectValue(props.widget.style, objectValue(props.widget.config?.style, {})))
const dataBinding = computed(() => objectValue(props.widget.data, objectValue(props.widget.binding, {})))
const conditions = computed(() => Array.isArray(props.widget.conditions) ? props.widget.conditions : (props.widget.config?.conditions || []))
const animation = computed(() => objectValue(props.widget.animation, objectValue(props.widget.config?.animation, { type: 'none' })))
const widgetEvents = computed(() => Array.isArray(props.widget.events) ? props.widget.events : (props.widget.config?.events || []))
const widgetTitle = computed(() => props.widget.title || content.value.title || '')

const progressPercent = computed(() => {
  const target = Number(props.metrics.daily_target || props.metrics.dailyTarget || 1)
  const output = Number(props.metrics.current_output || props.metrics.currentOutput || 0)
  return Math.max(0, Math.min(100, target ? (output / target) * 100 : 0)).toFixed(1)
})

const dataContext = computed(() => ({
  metrics: props.metrics,
  events: props.events,
  trendPoints: props.trendPoints,
  deviceStatusMap: props.deviceStatusMap,
  deviceDataMap: props.deviceDataMap,
  points: props.pointValues
}))

function getWidgetValue(path) {
  if (path === 'metrics.progress_percent') return progressPercent.value
  return getByPath(dataContext.value, path)
}

const pointRecord = computed(() => {
  const pointId = String(dataBinding.value.pointId || dataBinding.value.point_id || '')
  const deviceId = String(dataBinding.value.deviceId || dataBinding.value.device_id || '')
  return props.pointValues[`${deviceId}:${pointId}`] || props.pointValues[pointId] || null
})
const databaseRecord = computed(() => props.databaseValues[String(props.widget.id || '')] || null)

const boundValue = computed(() => {
  const binding = dataBinding.value
  if (binding.mode === 'database') return databaseRecord.value?.value ?? content.value.value
  if (binding.mode === 'plc' || binding.pointId || binding.point_id) {
    if (pointRecord.value && pointRecord.value.value !== undefined) return pointRecord.value.value
    const deviceId = binding.deviceId || binding.device_id
    const deviceData = props.deviceDataMap[deviceId]
    const fromDevice = getByPath(deviceData, binding.path)
    if (fromDevice !== undefined) return fromDevice
    const fromStatus = getByPath(props.deviceStatusMap[deviceId], binding.path)
    if (fromStatus !== undefined) return fromStatus
    return content.value.value
  }
  const path = binding.path || binding.source
  if (path) return getWidgetValue(path)
  return content.value.value
})

const boundQuality = computed(() => {
  if (dataBinding.value.mode === 'database') return databaseRecord.value?.quality || (databaseRecord.value?.error ? 'bad' : 'stale')
  return pointRecord.value?.quality || props.deviceStatusMap[dataBinding.value.deviceId]?.quality || 'good'
})

function numericValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function formatValue(value = boundValue.value) {
  if (value === undefined || value === null || value === '') return content.value.fallback ?? '--'
  if (typeof value === 'boolean') return value ? (content.value.onText || '正常') : (content.value.offText || '停止')
  const number = Number(value)
  if (Number.isFinite(number)) {
    const decimals = Math.max(0, Math.min(8, Number(dataBinding.value.decimals ?? 1)))
    return number.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  }
  return String(value)
}

function conditionMatches(condition, value) {
  const operator = condition?.operator || '=='
  const target = condition?.value
  const number = numericValue(value)
  const targetNumber = numericValue(target)
  if (operator === 'truthy') return !!value
  if (operator === 'falsy') return !value
  if (operator === '==') return String(value) === String(target) || (number !== null && targetNumber !== null && number === targetNumber)
  if (operator === '!=') return !conditionMatches({ ...condition, operator: '==' }, value)
  if (number === null || targetNumber === null) return false
  if (operator === '>') return number > targetNumber
  if (operator === '>=') return number >= targetNumber
  if (operator === '<') return number < targetNumber
  if (operator === '<=') return number <= targetNumber
  return false
}

const activeCondition = computed(() => conditions.value.find(condition => conditionMatches(condition, boundValue.value)) || null)
const conditionAnimation = computed(() => activeCondition.value?.animation || 'none')
const animationType = computed(() => conditionAnimation.value !== 'none' ? conditionAnimation.value : (animation.value.type || 'none'))
const animationClass = computed(() => animationType.value === 'none' ? '' : `widget-animation-${animationType.value}`)

function cssSize(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback
  return typeof value === 'number' ? `${value}px` : String(value)
}

const shellStyle = computed(() => {
  const style = widgetStyle.value
  const condition = activeCondition.value || {}
  const shadows = {
    none: 'none',
    soft: '0 14px 34px rgba(0,8,18,.24)',
    glow: '0 0 28px rgba(67,184,255,.24)',
    strong: '0 18px 48px rgba(0,6,14,.42)'
  }
  return {
    background: condition.background || style.background,
    color: condition.color || style.color,
    borderColor: condition.borderColor || style.borderColor,
    borderRadius: cssSize(style.borderRadius, undefined),
    opacity: style.opacity ?? 1,
    padding: cssSize(style.padding, undefined),
    fontSize: cssSize(style.fontSize, undefined),
    boxShadow: shadows[style.shadow] || style.boxShadow,
    '--widget-value-color': condition.color || style.valueColor || '#67d2ff',
    '--widget-on-color': style.onColor || '#49df9d',
    '--widget-off-color': style.offColor || '#7c8d9d',
    '--widget-alarm-color': style.alarmColor || '#ff625f',
    '--widget-line-color': content.value.lineColor || '#55c7ff',
    animationDuration: `${Number(animation.value.duration || 1.2)}s`,
    animationDelay: `${Number(animation.value.delay || 0)}s`,
    animationIterationCount: animation.value.iteration || 'infinite'
  }
})

const metricItems = computed(() => {
  const items = Array.isArray(content.value.items) ? content.value.items : [
    { label: '今日产出', path: 'metrics.current_output' },
    { label: '完成进度', path: 'metrics.progress_percent', unit: '%' },
    { label: '能耗估算', path: 'metrics.energy_consumption' },
    { label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' }
  ]
  return items.map(item => {
    const value = getWidgetValue(item.path)
    const suffix = item.suffixPath ? getWidgetValue(item.suffixPath) : undefined
    return {
      label: item.label || item.path || '指标',
      value: item.suffixPath
        ? `${value ?? '--'}${item.separator || ''}${suffix ?? '--'}${item.unit || ''}`
        : `${value ?? '--'}${item.unit || ''}`
    }
  })
})

const eventRows = computed(() => {
  if (dataBinding.value.mode === 'database' && Array.isArray(databaseRecord.value?.rows)) return databaseRecord.value.rows
  const source = dataBinding.value.source || dataBinding.value.path
  const bound = source ? getWidgetValue(source) : null
  return Array.isArray(bound) ? bound : props.events
})

const trendRows = computed(() => {
  if (dataBinding.value.mode === 'database' && Array.isArray(databaseRecord.value?.rows)) return databaseRecord.value.rows
  const source = dataBinding.value.source
  const bound = source ? getWidgetValue(source) : null
  if (Array.isArray(bound)) return bound
  if (dataBinding.value.mode === 'plc' || dataBinding.value.pointId) return localTrend.value
  return props.trendPoints
})

const chartSeries = computed(() => {
  const recordSeries = databaseRecord.value?.series
  if (dataBinding.value.mode === 'database' && Array.isArray(recordSeries) && recordSeries.length) {
    return recordSeries.map((series, index) => ({
      id: series.id || `series_${index + 1}`,
      name: series.label || series.id || `数据项 ${index + 1}`,
      color: series.color || ['#55c7ff', '#45df9b', '#ffc45f', '#ff6b78'][index % 4],
      value: series.value,
      rows: Array.isArray(series.rows) ? series.rows : []
    }))
  }
  return [{
    id: 'value',
    name: content.value.seriesName || widgetTitle.value || '趋势',
    color: content.value.lineColor || '#55c7ff',
    value: boundValue.value,
    rows: trendRows.value
  }]
})

const textLines = computed(() => {
  const rawText = Array.isArray(content.value.lines) ? content.value.lines.join('\n') : (content.value.text || content.value.label || '')
  const fallback = rawText || widgetTitle.value || '文本组件'
  return String(fallback).replaceAll('{value}', formatValue()).split('\n').filter(Boolean)
})

const statusState = computed(() => {
  if (boundQuality.value === 'bad') return 'unknown'
  const value = boundValue.value
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (['true', '1', 'on', 'running', 'online', 'normal', '正常', '运行'].includes(normalized)) return 'on'
    if (['false', '0', 'off', 'stopped', 'offline', '停止', '离线'].includes(normalized)) return 'off'
  }
  if (value === undefined || value === null || value === '') return 'unknown'
  return Number(value) !== 0 || value === true ? 'on' : 'off'
})

const statusText = computed(() => {
  if (statusState.value === 'unknown') return content.value.unknownText || '离线'
  return statusState.value === 'on' ? (content.value.onText || '正常') : (content.value.offText || '停止')
})

const deviceRows = computed(() => Object.entries(props.deviceStatusMap)
  .map(([id, value]) => ({ id, ...value }))
  .slice(0, Number(content.value.limit || 12)))

function resizeChart() { chart?.resize() }
function disposeChart() { if (chart) { chart.dispose(); chart = null } }

function renderChart() {
  if (!['trend', 'metrics'].includes(type.value)) { disposeChart(); return }
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)
  if (type.value === 'trend') {
    const timeField = content.value.timeField || 'time'
    const valueField = content.value.valueField || 'value'
    const chartType = content.value.chartType || 'line'
    const sourceSeries = chartSeries.value
    const legendPosition = content.value.legendPosition || 'top'
    const legend = {
      show: content.value.showLegend !== false && sourceSeries.length > 1,
      orient: legendPosition === 'right' ? 'vertical' : 'horizontal',
      top: legendPosition === 'bottom' ? undefined : (legendPosition === 'right' ? 'middle' : 0),
      bottom: legendPosition === 'bottom' ? 0 : undefined,
      right: legendPosition === 'right' ? 0 : undefined,
      textStyle: { color: '#9fb5c6', fontSize: 10 }
    }
    const common = {
      animation: !props.preview,
      color: sourceSeries.map(series => series.color),
      tooltip: { trigger: ['pie', 'donut', 'gauge'].includes(chartType) ? 'item' : 'axis', backgroundColor: 'rgba(8,20,32,.94)', borderColor: 'rgba(86,181,238,.3)', textStyle: { color: '#fff' } },
      legend
    }
    if (chartType === 'pie' || chartType === 'donut') {
      chart.setOption({ ...common, series: [{
        type: 'pie', radius: chartType === 'donut' ? [`${Number(content.value.donutRatio ?? 48)}%`, '76%'] : ['0%', '76%'], center: ['50%', '55%'],
        label: { show: content.value.showDataLabel !== false, color: '#dcebf6', formatter: '{b}\n{c}' },
        itemStyle: { borderColor: 'rgba(8,20,32,.8)', borderWidth: 2 },
        data: sourceSeries.map(series => ({ name: series.name, value: Number(series.value) || 0, itemStyle: { color: series.color } }))
      }] }, true)
      return
    }
    if (chartType === 'gauge') {
      const minimum = Number(content.value.min ?? 0)
      const maximum = Number(content.value.max ?? 100)
      chart.setOption({ ...common, series: [{
        type: 'gauge', min: minimum, max: maximum, radius: '88%', center: ['50%', '58%'],
        progress: { show: true, width: 13 }, axisLine: { lineStyle: { width: 13 } }, axisTick: { show: false }, splitLine: { length: 8 },
        axisLabel: { color: '#829bae', distance: 18, fontSize: 9 }, pointer: { width: 4 },
        detail: { color: '#eef7ff', fontSize: 18, offsetCenter: [0, '64%'], formatter: `{value}${dataBinding.value.unit || ''}` },
        data: [{ value: Number(boundValue.value) || 0, name: content.value.seriesName || widgetTitle.value }]
      }] }, true)
      return
    }
    const rowsForAxis = sourceSeries.find(series => series.rows.length)?.rows || []
    const isBar = ['bar', 'stackedBar'].includes(chartType)
    chart.setOption({
      ...common,
      grid: { left: content.value.showAxis === false ? 12 : 45, right: legendPosition === 'right' && legend.show ? 90 : 18, bottom: legendPosition === 'bottom' && legend.show ? 34 : 28, top: legendPosition === 'top' && legend.show ? 30 : 18 },
      xAxis: { show: content.value.showAxis !== false, type: 'category', boundaryGap: isBar, data: rowsForAxis.map(point => point[timeField]), axisLine: { lineStyle: { color: 'rgba(180,215,238,.18)' } }, axisLabel: { color: '#8fa6b8' } },
      yAxis: { show: content.value.showAxis !== false, type: 'value', axisLabel: { color: '#8fa6b8' }, splitLine: { lineStyle: { color: 'rgba(180,215,238,.08)' } } },
      series: sourceSeries.map(series => ({
        name: series.name,
        type: isBar ? 'bar' : (chartType === 'scatter' ? 'scatter' : 'line'),
        stack: chartType === 'stackedBar' ? 'total' : undefined,
        smooth: !isBar && chartType !== 'scatter' && content.value.smooth !== false,
        showSymbol: chartType === 'scatter' || content.value.showSymbol === true,
        symbolSize: chartType === 'scatter' ? 8 : 5,
        lineStyle: { color: series.color, width: Number(content.value.lineWidth || 2) },
        itemStyle: { color: series.color, borderRadius: isBar ? Number(content.value.barRadius ?? 4) : 0 },
        label: { show: content.value.showDataLabel === true, color: '#dcebf6', position: isBar ? 'top' : 'top' },
        areaStyle: chartType === 'area' ? { color: series.color, opacity: Number(content.value.areaOpacity ?? .2) } : undefined,
        data: series.rows.map(point => point[valueField])
      }))
    }, true)
    return
  }
  const chartPath = content.value.chartPath || 'metrics.overall_oee'
  const chartValue = Number(getWidgetValue(chartPath) || 0)
  chart.setOption({
    animation: !props.preview,
    series: [{
      type: 'pie', radius: ['64%', '82%'], silent: true,
      label: { show: true, position: 'center', formatter: `${chartValue.toFixed(1)}%\n${content.value.chartLabel || 'OEE'}`, color: '#eaf6ff', fontSize: 15, fontWeight: 700 },
      itemStyle: { borderColor: '#12202d', borderWidth: 2 },
      data: [
        { value: chartValue, itemStyle: { color: content.value.chartColor || '#4fd09a' } },
        { value: Math.max(0, 100 - chartValue), itemStyle: { color: 'rgba(122,151,171,.2)' } }
      ]
    }]
  }, true)
}

function triggerEvents(trigger, domEvent) {
  widgetEvents.value.filter(event => (event.trigger || 'click') === trigger).forEach(event => emit('action', { event, widget: props.widget, domEvent }))
}

watch(boundValue, value => {
  if (!(dataBinding.value.mode === 'plc' || dataBinding.value.pointId)) return
  const number = Number(value)
  if (!Number.isFinite(number)) return
  const now = new Date().toLocaleTimeString().slice(0, 8)
  localTrend.value = [...localTrend.value, { time: now, value: number }].slice(-Math.max(8, Number(content.value.historyLength || 60)))
})

watch(() => [props.widget, props.metrics, props.trendPoints, props.events, props.databaseValues, localTrend.value], () => nextTick(renderChart), { deep: true })

onMounted(() => { nextTick(renderChart); window.addEventListener('resize', resizeChart) })
onUnmounted(() => { window.removeEventListener('resize', resizeChart); disposeChart() })
</script>

<template>
  <div
    class="widget-shell industrial-panel"
    :class="[
      `widget-kind-${type}`,
      animationClass,
      `quality-${boundQuality}`,
      { interactive: widgetEvents.length > 0 }
    ]"
    :style="shellStyle"
    @click="triggerEvents('click', $event)"
    @dblclick="triggerEvents('doubleClick', $event)"
  >
    <div v-if="widgetTitle && content.showTitle !== false && type !== 'image'" class="widget-title"><i></i><span>{{ widgetTitle }}</span></div>

    <template v-if="type === 'metrics'">
      <div class="metrics-layout"><div ref="chartRef" class="widget-chart"></div><div class="metric-list"><div v-for="item in metricItems" :key="item.label" class="metric-row"><span>{{ item.label }}</span><strong>{{ item.value }}</strong></div></div></div>
    </template>

    <template v-else-if="type === 'trend'">
      <div ref="chartRef" class="widget-chart trend-chart"></div>
    </template>

    <template v-else-if="type === 'alarm_list'">
      <ul class="alarm-list"><li v-for="(event, index) in eventRows.slice(0, content.limit || 5)" :key="event.id || index"><span class="rank" :class="event.level">{{ index + 1 }}</span><span class="alarm-txt"><small v-if="content.showTime !== false">{{ event.time || event.occurred_at || '--' }}</small>{{ event.msg || event.title || event.message }}</span><span v-if="content.showLevel !== false" class="tag" :class="event.level">{{ event.level || 'info' }}</span></li></ul>
    </template>

    <template v-else-if="type === 'marquee'">
      <div class="marquee-content-wrap"><div class="marquee-content" :style="{ animationDuration: (content.speed || 30) + 's' }"><template v-for="copy in 2" :key="copy"><span v-for="(event,index) in eventRows" :key="`${copy}-${event.id || index}`" class="marquee-item" :class="event.level">[{{ event.time || event.occurred_at || '--' }}] {{ event.msg || event.title || event.message }}</span></template></div></div>
    </template>

    <template v-else-if="type === 'text'">
      <div class="text-widget-body" :style="{ textAlign: content.align || 'left' }"><p v-for="(line,index) in textLines" :key="index">{{ line }}</p></div>
    </template>

    <template v-else-if="type === 'value'">
      <div class="value-widget-body" :class="`shape-${content.shape || 'card'}`"><span>{{ content.label || widgetTitle }}</span><strong>{{ formatValue() }}<small v-if="dataBinding.unit">{{ dataBinding.unit }}</small></strong><em v-if="boundQuality !== 'good'">{{ boundQuality === 'bad' ? '离线' : '数据延迟' }}</em></div>
    </template>

    <template v-else-if="type === 'status'">
      <div class="status-widget-body" :class="[`state-${statusState}`, `shape-${content.shape || 'lamp'}`]"><span class="status-lamp"><i></i></span><div><small>{{ content.label || widgetTitle }}</small><strong>{{ statusText }}</strong></div></div>
    </template>

    <template v-else-if="type === 'device_list'">
      <div class="device-list"><div v-for="device in deviceRows" :key="device.id" class="device-list-row" :class="[`quality-${device.quality || 'bad'}`, { alarm: device.alarm }]"><i></i><span><strong>{{ device.name || device.id }}</strong><small>{{ device.online ? (device.running ? '运行中' : '在线待机') : '通讯离线' }}</small></span><b v-if="content.showTemperature !== false">{{ device.temp ?? '--' }}<small> °C</small></b></div><p v-if="!deviceRows.length">等待设备实时数据</p></div>
    </template>

    <template v-else-if="type === 'image'">
      <img v-if="content.url" class="image-widget" :src="content.url" :alt="content.alt || widgetTitle" :style="{ objectFit: content.fit || 'contain' }" />
      <div v-else class="image-placeholder"><span>▧</span><strong>选择图片</strong><small>在右侧内容属性填写地址</small></div>
    </template>

    <template v-else-if="type === 'container'">
      <div class="container-placeholder"><span></span><small>容器区域</small></div>
    </template>

    <template v-else>
      <div class="unknown-widget"><strong>{{ widgetTitle || type }}</strong><small>该组件由 {{ widget.runtimeTarget || 'Unity' }} 运行时处理</small></div>
    </template>
  </div>
</template>

<style scoped>
.widget-shell{box-sizing:border-box;position:relative;width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:14px;border:1px solid rgba(91,169,219,.24);border-radius:14px;color:#edf7ff;background:rgba(10,24,38,.82);box-shadow:0 14px 34px rgba(0,8,18,.22);font-family:"Microsoft YaHei UI","Segoe UI",sans-serif;transition:border-color .18s,filter .18s,transform .18s}.widget-shell.interactive{cursor:pointer}.widget-shell.quality-bad{filter:saturate(.72)}
.widget-title{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:22px;margin-bottom:8px;color:inherit;font-size:13px;font-weight:700;letter-spacing:.02em}.widget-title i{width:3px;height:14px;border-radius:99px;background:var(--widget-line-color,#55c7ff);box-shadow:0 0 12px color-mix(in srgb,var(--widget-line-color,#55c7ff) 55%,transparent)}.widget-title span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.metrics-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(110px,38%) minmax(0,1fr);gap:12px}.widget-chart{width:100%;height:100%;min-height:80px}.trend-chart{flex:1}.metric-list{min-height:0;display:grid;align-content:center;gap:3px;overflow:hidden}.metric-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px;padding:3px 0;border-bottom:1px solid rgba(175,214,239,.07);color:#91a7b9;font-size:11px}.metric-row strong{color:#f1f8fd;font-size:13px}
.alarm-list{flex:1;min-height:0;margin:0;padding:0;overflow:hidden;list-style:none}.alarm-list li{display:grid;grid-template-columns:25px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:31px;border-bottom:1px solid rgba(174,214,240,.07);font-size:10px}.rank,.tag{display:grid;place-items:center;min-height:20px;padding:0 5px;border-radius:6px;color:#91bdd8;background:rgba(74,141,185,.12)}.rank.warning,.tag.warning{color:#ffd080;background:rgba(255,176,52,.12)}.rank.critical,.tag.critical{color:#ff8c88;background:rgba(255,94,89,.12)}.alarm-txt{min-width:0;overflow:hidden;color:#d0dfeb;text-overflow:ellipsis;white-space:nowrap}.alarm-txt small{margin-right:7px;color:#6f899d}.tag{font-size:8px;text-transform:uppercase}
.marquee-content-wrap{flex:1;min-height:0;overflow:hidden}.marquee-content{display:flex;align-items:center;width:max-content;height:100%;white-space:nowrap;animation:widgetMarquee linear infinite}.marquee-item{margin-right:42px;color:inherit;font-size:12px}.marquee-item.warning{color:#ffd080}.marquee-item.critical{color:#ff8c88}
.text-widget-body{flex:1;min-height:0;display:grid;align-content:center;gap:5px;overflow:hidden;color:inherit;line-height:1.5}.text-widget-body p{margin:0;white-space:pre-wrap}
.value-widget-body{flex:1;min-height:0;display:grid;align-content:center;gap:6px}.value-widget-body>span{color:#8ea7ba;font-size:12px}.value-widget-body strong{color:var(--widget-value-color);font-size:clamp(24px,3vw,48px);font-weight:800;line-height:1.05;text-shadow:0 0 20px color-mix(in srgb,var(--widget-value-color) 24%,transparent)}.value-widget-body strong small{margin-left:7px;color:#9fb3c3;font-size:.34em;font-weight:500}.value-widget-body em{color:#ffb05c;font-size:9px;font-style:normal}.value-widget-body.shape-tile strong{letter-spacing:.08em;font-family:Consolas,monospace}.value-widget-body.shape-plain{align-content:center;text-align:center}.value-widget-body.shape-gauge::before{content:"";position:absolute;right:14px;bottom:14px;width:56px;height:56px;border:7px solid rgba(91,184,237,.12);border-top-color:var(--widget-value-color);border-radius:50%}
.status-widget-body{flex:1;min-height:0;display:flex;align-items:center;gap:13px}.status-lamp{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:rgba(116,142,162,.1)}.status-lamp i{width:18px;height:18px;border-radius:50%;background:var(--widget-off-color);box-shadow:0 0 0 6px color-mix(in srgb,var(--widget-off-color) 12%,transparent),0 0 15px color-mix(in srgb,var(--widget-off-color) 30%,transparent)}.state-on .status-lamp i{background:var(--widget-on-color);box-shadow:0 0 0 6px color-mix(in srgb,var(--widget-on-color) 12%,transparent),0 0 18px color-mix(in srgb,var(--widget-on-color) 50%,transparent)}.state-unknown .status-lamp i{background:var(--widget-alarm-color)}.status-widget-body div{display:grid;gap:3px}.status-widget-body small{color:#829bae;font-size:10px}.status-widget-body strong{font-size:20px}.status-widget-body.shape-badge .status-lamp{width:24px;height:24px}.status-widget-body.shape-badge .status-lamp i{width:10px;height:10px}.status-widget-body.shape-switch .status-lamp{width:52px;height:26px;border-radius:99px;justify-content:start;padding:4px}.status-widget-body.shape-switch .status-lamp i{width:18px;height:18px;box-shadow:none;transition:.2s}.status-widget-body.shape-switch.state-on .status-lamp{justify-content:end;background:color-mix(in srgb,var(--widget-on-color) 22%,transparent)}
.device-list{flex:1;min-height:0;overflow:hidden}.device-list-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:9px;align-items:center;min-height:37px;border-bottom:1px solid rgba(174,214,240,.07)}.device-list-row>i{width:7px;height:7px;border-radius:50%;background:#45d797;box-shadow:0 0 9px rgba(69,215,151,.45)}.device-list-row.quality-bad>i{background:#75899a;box-shadow:none}.device-list-row.alarm>i{background:#ff625f;box-shadow:0 0 10px rgba(255,98,95,.55)}.device-list-row span{min-width:0}.device-list-row span strong,.device-list-row span small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.device-list-row span strong{font-size:10px}.device-list-row span small{margin-top:2px;color:#728ca1;font-size:8px}.device-list-row>b{color:#dcebf6;font-size:11px}.device-list-row>b small{color:#728ca1;font-size:8px}.device-list>p{display:grid;place-items:center;height:100%;margin:0;color:#71899d;font-size:10px}
.image-widget{width:100%;height:100%;display:block}.image-placeholder,.unknown-widget,.container-placeholder{flex:1;display:grid;place-content:center;gap:5px;text-align:center;color:#71899d}.image-placeholder>span{font-size:30px;color:#61bce9}.image-placeholder strong,.unknown-widget strong{color:#b8d2e4}.image-placeholder small,.unknown-widget small,.container-placeholder small{font-size:9px}.container-placeholder span{width:58px;height:32px;border:1px dashed rgba(91,184,237,.35);border-radius:7px;justify-self:center}.unknown-widget{border:1px dashed rgba(100,164,207,.24);border-radius:8px}
.widget-animation-fadeIn{animation-name:widgetFadeIn;animation-fill-mode:both}.widget-animation-slideUp{animation-name:widgetSlideUp;animation-fill-mode:both}.widget-animation-pulse{animation-name:widgetPulse;animation-timing-function:ease-in-out}.widget-animation-breathe{animation-name:widgetBreathe;animation-timing-function:ease-in-out}.widget-animation-float{animation-name:widgetFloat;animation-timing-function:ease-in-out}.widget-animation-blink{animation-name:widgetBlink;animation-timing-function:steps(2,end)}
@keyframes widgetMarquee{to{transform:translateX(-50%)}}@keyframes widgetFadeIn{from{opacity:0}to{opacity:1}}@keyframes widgetSlideUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}@keyframes widgetPulse{50%{transform:scale(1.018)}}@keyframes widgetBreathe{50%{filter:brightness(1.14);box-shadow:0 0 30px rgba(63,182,255,.22)}}@keyframes widgetFloat{50%{transform:translateY(-5px)}}@keyframes widgetBlink{50%{opacity:.45}}
</style>
