export const DASHBOARD_SCHEMA_VERSION = 1

export const DEFAULT_DASHBOARD_CANVAS = Object.freeze({
  width: 1920,
  height: 1080,
  gridSize: 10,
  background: 'transparent',
  safeArea: 24,
  legacyGrid: { columns: 24, rows: 12 }
})

export const SYSTEM_WIDGET_TYPES = new Set(['navigation', 'device_label', 'diagnostics', 'line_overview_cards'])

export const DASHBOARD_WIDGET_LIBRARY = [
  { type: 'text', label: '文本', icon: 'T', group: '基础', description: '标题、说明和动态文本' },
  { type: 'value', label: '数值', icon: '12', group: '基础', description: 'PLC 数值、单位和格式' },
  { type: 'status', label: '状态灯', icon: '●', group: '基础', description: '布尔状态、在线和报警' },
  { type: 'image', label: '图片', icon: '▧', group: '基础', description: '现场图片、Logo 和图标' },
  { type: 'container', label: '容器', icon: '□', group: '布局', description: '透明卡片和区域分组' },
  { type: 'metrics', label: '指标组', icon: '▦', group: '数据', description: '多指标与环形图' },
  { type: 'trend', label: '趋势图', icon: '⌁', group: '数据', description: '实时/历史数据曲线' },
  { type: 'alarm_list', label: '报警表', icon: '!', group: '数据', description: '只读报警与事件履历' },
  { type: 'device_list', label: '设备列表', icon: '☷', group: '数据', description: '设备在线、运行和报警状态' },
  { type: 'marquee', label: '滚动消息', icon: '↔', group: '数据', description: '实时日志和报警滚动条' }
]

const TYPE_DEFAULTS = {
  text: {
    size: [360, 120],
    title: '文本',
    content: { text: '双击右侧属性修改文本', tone: 'normal', align: 'left' },
    style: { background: 'rgba(14, 28, 43, .72)', color: '#eef7ff', fontSize: 24, borderColor: 'rgba(89, 178, 238, .25)', borderRadius: 12 }
  },
  value: {
    size: [300, 170],
    title: '设备参数',
    content: { label: '实时数值', fallback: '--', shape: 'card' },
    style: { background: 'rgba(14, 28, 43, .78)', color: '#ffffff', valueColor: '#68d5ff', fontSize: 42, borderColor: 'rgba(89, 178, 238, .32)', borderRadius: 14 }
  },
  status: {
    size: [260, 130],
    title: '设备状态',
    content: { onText: '正常', offText: '停止', unknownText: '离线', shape: 'lamp' },
    style: { background: 'rgba(14, 28, 43, .78)', color: '#eef7ff', onColor: '#45df9b', offColor: '#8394a5', alarmColor: '#ff625f', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  trend: {
    size: [520, 300],
    title: '实时趋势',
    content: { seriesName: '实时值', lineColor: '#55c7ff', areaColor: 'rgba(85,199,255,.18)', historyLength: 60 },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  alarm_list: {
    size: [520, 300],
    title: '报警履历',
    content: { limit: 6, showLevel: true, showTime: true },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(255, 131, 94, .24)', borderRadius: 14 }
  },
  device_list: {
    size: [420, 320],
    title: '设备列表',
    content: { limit: 12, layout: 'list', showTemperature: true },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  image: {
    size: [360, 220],
    title: '',
    content: { url: '', fit: 'contain', alt: '图片' },
    style: { background: 'rgba(10, 24, 38, .35)', borderColor: 'rgba(89, 178, 238, .18)', borderRadius: 12 }
  },
  container: {
    size: [640, 360],
    title: '分组容器',
    content: { showTitle: true },
    style: { background: 'rgba(8, 22, 36, .42)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .26)', borderRadius: 16 }
  },
  metrics: {
    size: [500, 300],
    title: '生产指标',
    content: { compact: true },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  marquee: {
    size: [1080, 76],
    title: '实时消息',
    content: { speed: 30, limit: 20, eventWindowHours: 24 },
    style: { background: 'rgba(9, 22, 35, .8)', color: '#dbeeff', borderColor: 'rgba(89, 178, 238, .22)', borderRadius: 12 }
  }
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function numberValue(value, fallback, min = -Infinity, max = Infinity) {
  const next = Number(value)
  return Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : fallback
}

function objectValue(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

export function normalizeDashboardWidget(source = {}, canvas = DEFAULT_DASHBOARD_CANVAS, index = 0) {
  const type = source.type || source.widget_type || 'text'
  const defaults = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.text
  const config = objectValue(source.content, objectValue(source.config, {}))
  const frame = objectValue(source.frame, {})
  const legacyColumns = canvas.legacyGrid?.columns || 24
  const legacyRows = canvas.legacyGrid?.rows || 12
  const hasCanonicalFrame = frame.width !== undefined || frame.height !== undefined
  const data = objectValue(source.data, objectValue(source.binding, {}))
  return {
    id: String(source.id || `widget_${type}_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_'),
    type,
    title: String(source.title ?? defaults.title ?? ''),
    visible: source.visible !== false && source.visible !== 0,
    locked: !!source.locked,
    zIndex: Math.round(numberValue(source.zIndex ?? source.sort_order, index, -1000, 10000)),
    runtimeTarget: source.runtimeTarget || (SYSTEM_WIDGET_TYPES.has(type) ? 'unity' : 'overlay'),
    groupId: String(source.groupId || source.config?.__designer?.groupId || ''),
    frame: {
      x: hasCanonicalFrame ? numberValue(frame.x, 0) : numberValue(source.x, 0) / legacyColumns * canvas.width,
      y: hasCanonicalFrame ? numberValue(frame.y, 0) : numberValue(source.y, 0) / legacyRows * canvas.height,
      width: hasCanonicalFrame ? numberValue(frame.width, defaults.size[0], 20) : numberValue(source.w, defaults.size[0] / canvas.width * legacyColumns) / legacyColumns * canvas.width,
      height: hasCanonicalFrame ? numberValue(frame.height, defaults.size[1], 20) : numberValue(source.h, defaults.size[1] / canvas.height * legacyRows) / legacyRows * canvas.height,
      rotation: numberValue(frame.rotation, 0, -360, 360)
    },
    content: { ...deepClone(defaults.content || {}), ...deepClone(config) },
    style: { ...deepClone(defaults.style || {}), ...deepClone(source.style || source.config?.style || {}) },
    data: {
      mode: ['static', 'runtime', 'plc'].includes(data.mode) ? data.mode : (data.pointId || data.point_id ? 'plc' : (data.path || data.source ? 'runtime' : 'static')),
      deviceId: String(data.deviceId || data.device_id || ''),
      pointId: String(data.pointId || data.point_id || ''),
      path: String(data.path || ''),
      source: String(data.source || ''),
      unit: String(data.unit || ''),
      decimals: Math.round(numberValue(data.decimals, 1, 0, 8)),
      readOnly: true
    },
    conditions: Array.isArray(source.conditions) ? deepClone(source.conditions) : deepClone(source.config?.conditions || []),
    animation: { type: 'none', duration: 1.2, delay: 0, iteration: 'infinite', ...deepClone(source.animation || source.config?.animation || {}) },
    events: Array.isArray(source.events) ? deepClone(source.events) : deepClone(source.config?.events || [])
  }
}

export function normalizeDashboardDocument(source = {}) {
  const canvas = {
    ...DEFAULT_DASHBOARD_CANVAS,
    ...objectValue(source.canvas, {}),
    legacyGrid: { ...DEFAULT_DASHBOARD_CANVAS.legacyGrid, ...objectValue(source.canvas?.legacyGrid, {}) }
  }
  canvas.width = Math.round(numberValue(canvas.width, 1920, 320, 7680))
  canvas.height = Math.round(numberValue(canvas.height, 1080, 180, 4320))
  canvas.gridSize = Math.round(numberValue(canvas.gridSize, 10, 1, 200))
  canvas.safeArea = Math.round(numberValue(canvas.safeArea, 24, 0, 400))
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    projectId: String(source.projectId || 'project_default'),
    sceneId: String(source.sceneId || 'scene_factory_overview'),
    name: String(source.name || source.scene?.name || '工厂总览'),
    canvas,
    theme: {
      preset: 'industrial_twin',
      fontFamily: 'Microsoft YaHei UI',
      accentColor: '#42a5f5',
      ...deepClone(source.theme || {})
    },
    scene: deepClone(source.scene || {}),
    widgets: (source.widgets || []).map((widget, index) => normalizeDashboardWidget(widget, canvas, index)),
    metadata: deepClone(source.metadata || {})
  }
}

export function createDashboardWidget(type, index = 0, position = {}) {
  const defaults = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.text
  return normalizeDashboardWidget({
    id: `widget_${type}_${Date.now()}_${index}`,
    type,
    title: defaults.title,
    frame: {
      x: position.x ?? 120 + (index % 5) * 30,
      y: position.y ?? 120 + (index % 5) * 30,
      width: defaults.size[0],
      height: defaults.size[1],
      rotation: 0
    },
    content: defaults.content,
    style: defaults.style,
    zIndex: index,
    runtimeTarget: 'overlay'
  }, DEFAULT_DASHBOARD_CANVAS, index)
}

export function widgetTypeLabel(type) {
  return DASHBOARD_WIDGET_LIBRARY.find(item => item.type === type)?.label || type
}
