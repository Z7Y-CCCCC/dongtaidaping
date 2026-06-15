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

const progressPercent = computed(() => {
  const target = Number(props.metrics.daily_target || props.metrics.dailyTarget || 1)
  const output = Number(props.metrics.current_output || props.metrics.currentOutput || 0)
  return Math.max(0, Math.min(100, (output / target) * 100)).toFixed(1)
})

const oeeValue = computed(() => Number(props.metrics.overall_oee || props.metrics.overallOEE || 0).toFixed(1))
const boundValue = computed(() => getByPath({
  metrics: props.metrics,
  events: props.events,
  trendPoints: props.trendPoints
}, props.widget.binding?.path))
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
    chart.setOption({
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(18,24,30,0.92)', textStyle: { color: '#fff' } },
      grid: { left: 42, right: 18, bottom: 28, top: 24 },
      xAxis: { type: 'category', boundaryGap: false, data: props.trendPoints.map(p => p.time), axisLabel: { color: '#aeb7bf' } },
      yAxis: { type: 'value', axisLabel: { color: '#aeb7bf' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } } },
      series: [{
        name: '平均温度',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: '#f0b35a', width: 2 },
        areaStyle: { color: 'rgba(240,179,90,0.14)' },
        data: props.trendPoints.map(p => p.value)
      }]
    })
  } else if (props.widget.widget_type === 'metrics') {
    chart.setOption({
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie',
        radius: ['64%', '82%'],
        avoidLabelOverlap: false,
        label: { show: true, position: 'center', formatter: `${oeeValue.value}%\nOEE`, color: '#e8ecef', fontSize: 15, fontWeight: 600 },
        itemStyle: { borderColor: '#171d22', borderWidth: 2 },
        data: [
          { value: Number(oeeValue.value), name: '有效', itemStyle: { color: '#4fc08d' } },
          { value: Math.max(0, 100 - Number(oeeValue.value)), name: '损耗', itemStyle: { color: '#3b4249' } }
        ]
      }]
    })
  }
}

onMounted(() => {
  nextTick(renderChart)
  window.addEventListener('resize', resizeChart)
})

watch(() => [props.widget.widget_type, props.metrics, props.trendPoints], () => nextTick(renderChart), { deep: true })

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
          <div class="metric-row"><span>今日产出</span><strong>{{ metrics.current_output || 0 }}</strong></div>
          <div class="metric-row"><span>完成进度</span><strong>{{ progressPercent }}%</strong></div>
          <div class="metric-row"><span>能耗估算</span><strong>{{ metrics.energy_consumption || 0 }}</strong></div>
          <div class="metric-row"><span>在线设备</span><strong>{{ metrics.online_devices || 0 }}/{{ metrics.total_devices || 0 }}</strong></div>
        </div>
      </div>
    </template>

    <template v-else-if="widget.widget_type === 'trend'">
      <div ref="chartRef" class="widget-chart trend-chart"></div>
    </template>

    <template v-else-if="widget.widget_type === 'alarm_list'">
      <ul class="alarm-list">
        <li v-for="(event, idx) in events.slice(0, widget.config?.limit || 5)" :key="event.id || idx">
          <span class="rank" :class="event.level">{{ idx + 1 }}</span>
          <span class="alarm-txt">[{{ event.time }}] {{ event.msg }}</span>
          <span class="tag" :class="event.level">{{ event.level }}</span>
        </li>
      </ul>
    </template>

    <template v-else-if="widget.widget_type === 'marquee'">
      <div class="marquee-content-wrap">
        <div class="marquee-content" :style="{ animationDuration: (widget.config?.speed || 30) + 's' }">
          <span v-for="(event, idx) in events" :key="event.id || idx" class="marquee-item" :class="event.level">
            [{{ event.time }}] {{ event.msg }}
          </span>
          <span v-for="(event, idx) in events" :key="'copy' + (event.id || idx)" class="marquee-item" :class="event.level">
            [{{ event.time }}] {{ event.msg }}
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
