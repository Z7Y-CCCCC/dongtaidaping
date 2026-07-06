<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  widget: { type: Object, default: () => ({ widget_type: 'metrics', title: '' }) },
  metrics: { type: Object, default: () => ({}) },
  events: { type: Array, default: () => [] },
  trendPoints: { type: Array, default: () => [] }
})

const chartRef = ref(null)
let chart = null

function getByPath(source, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => current?.[key], source)
}

const dataContext = computed(() => ({
  metrics: props.metrics,
  events: props.events,
  trendPoints: props.trendPoints
}))

const progressPercent = computed(() => {
  const target = Number(props.metrics.daily_target || props.metrics.dailyTarget || 1)
  const output = Number(props.metrics.current_output || props.metrics.currentOutput || 0)
  return Math.max(0, Math.min(100, (output / target) * 100)).toFixed(1)
})

const oeeValue = computed(() => Number(props.metrics.overall_oee || props.metrics.overallOEE || 0).toFixed(1))

function getWidgetValue(path) {
  if (path === 'metrics.progress_percent') return progressPercent.value
  return getByPath(dataContext.value, path)
}

function getBoundArray(defaultSource) {
  const source = props.widget.binding?.source || defaultSource
  const value = getByPath(dataContext.value, source)
  return Array.isArray(value) ? value : []
}

function formatMetricValue(item) {
  const value = getWidgetValue(item.path)
  if (item.suffixPath) {
    const suffix = getWidgetValue(item.suffixPath)
    return `${value ?? '--'}${item.separator || ''}${suffix ?? '--'}${item.unit || ''}`
  }
  return `${value ?? '--'}${item.unit || ''}`
}

const metricItems = computed(() => {
  const items = Array.isArray(props.widget.config?.items) ? props.widget.config.items : [
    { label: '今日产出', path: 'metrics.current_output' },
    { label: '完成进度', path: 'metrics.progress_percent', unit: '%' },
    { label: '能耗估算', path: 'metrics.energy_consumption' },
    { label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' }
  ]
  return items.map(item => ({
    label: item.label || item.path || '指标',
    value: formatMetricValue(item)
  }))
})

const trendRows = computed(() => getBoundArray('trendPoints'))
const eventRows = computed(() => getBoundArray('events'))
const boundValue = computed(() => getWidgetValue(props.widget.binding?.path))
const textLines = computed(() => {
  const config = props.widget.config || {}
  const rawText = Array.isArray(config.lines) ? config.lines.join('\n') : (config.text || config.label || '')
  const fallback = rawText || props.widget.title || '文本组件'
  const value = boundValue.value ?? config.value ?? ''
  return String(fallback).replaceAll('{value}', value).split('\n').filter(Boolean)
})
const textTone = computed(() => props.widget.config?.tone || 'normal')

function resizeChart() {
  if (chart) chart.resize()
}

function disposeChart() {
  if (chart) {
    chart.dispose()
    chart = null
  }
}

function renderChart() {
  if (!['trend', 'metrics'].includes(props.widget.widget_type)) {
    disposeChart()
    return
  }
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)

  if (props.widget.widget_type === 'trend') {
    const config = props.widget.config || {}
    const timeField = config.timeField || 'time'
    const valueField = config.valueField || 'value'
    const lineColor = config.lineColor || '#f0b35a'
    chart.setOption({
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(18,24,30,0.92)', textStyle: { color: '#fff' } },
      grid: { left: 42, right: 18, bottom: 28, top: 24 },
      xAxis: { type: 'category', boundaryGap: false, data: trendRows.value.map(p => p[timeField]), axisLabel: { color: '#aeb7bf' } },
      yAxis: { type: 'value', axisLabel: { color: '#aeb7bf' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } } },
      series: [{
        name: config.seriesName || props.widget.title || '趋势',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: lineColor, width: 2 },
        areaStyle: { color: config.areaColor || 'rgba(240,179,90,0.14)' },
        data: trendRows.value.map(p => p[valueField])
      }]
    })
  } else if (props.widget.widget_type === 'metrics') {
    const chartPath = props.widget.config?.chartPath || 'metrics.overall_oee'
    const chartValue = Number(getWidgetValue(chartPath) ?? oeeValue.value)
    const chartLabel = props.widget.config?.chartLabel || 'OEE'
    chart.setOption({
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie',
        radius: ['64%', '82%'],
        avoidLabelOverlap: false,
        label: { show: true, position: 'center', formatter: `${chartValue.toFixed(1)}%\n${chartLabel}`, color: '#e8ecef', fontSize: 15, fontWeight: 600 },
        itemStyle: { borderColor: '#171d22', borderWidth: 2 },
        data: [
          { value: chartValue, name: '有效', itemStyle: { color: props.widget.config?.chartColor || '#4fc08d' } },
          { value: Math.max(0, 100 - chartValue), name: '损耗', itemStyle: { color: '#3b4249' } }
        ]
      }]
    })
  }
}

onMounted(() => {
  nextTick(renderChart)
  window.addEventListener('resize', resizeChart)
})

watch(() => [props.widget, props.metrics, props.trendPoints, props.events], () => nextTick(renderChart), { deep: true })

onUnmounted(() => {
  window.removeEventListener('resize', resizeChart)
  disposeChart()
})
</script>

<template>
  <div class="widget-shell industrial-panel">
    <div class="widget-title"><i></i>{{ widget.title }}</div>

    <template v-if="widget.widget_type === 'metrics'">
      <div class="metrics-layout">
        <div ref="chartRef" class="widget-chart"></div>
        <div class="metric-list">
          <div class="metric-row" v-for="item in metricItems" :key="item.label">
            <span>{{ item.label }}</span><strong>{{ item.value }}</strong>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="widget.widget_type === 'trend'">
      <div ref="chartRef" class="widget-chart trend-chart"></div>
    </template>

    <template v-else-if="widget.widget_type === 'alarm_list'">
      <ul class="alarm-list">
        <li v-for="(event, idx) in eventRows.slice(0, widget.config?.limit || 5)" :key="event.id || idx">
          <span class="rank" :class="event.level">{{ idx + 1 }}</span>
          <span class="alarm-txt">[{{ event.time || event.occurred_at || '--' }}] {{ event.msg || event.title || event.message }}</span>
          <span class="tag" :class="event.level">{{ event.level }}</span>
        </li>
      </ul>
    </template>

    <template v-else-if="widget.widget_type === 'marquee'">
      <div class="marquee-content-wrap">
        <div class="marquee-content" :style="{ animationDuration: (widget.config?.speed || 30) + 's' }">
          <span v-for="(event, idx) in eventRows" :key="event.id || idx" class="marquee-item" :class="event.level">
            [{{ event.time || event.occurred_at || '--' }}] {{ event.msg || event.title || event.message }}
          </span>
          <span v-for="(event, idx) in eventRows" :key="'copy' + (event.id || idx)" class="marquee-item" :class="event.level">
            [{{ event.time || event.occurred_at || '--' }}] {{ event.msg || event.title || event.message }}
          </span>
        </div>
      </div>
    </template>

    <template v-else-if="widget.widget_type === 'text'">
      <div class="text-widget-body" :class="'tone-' + textTone">
        <p v-for="(line, idx) in textLines" :key="idx">{{ line }}</p>
      </div>
    </template>
  </div>
</template>
