<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import WidgetRenderer from '../../../runtime/WidgetRenderer.vue'
import { applyVisibilityAction, widgetRuntimeVisible } from '../../../runtime/dashboardRules.js'
import {
  DASHBOARD_WIDGET_LIBRARY,
  SYSTEM_WIDGET_TYPES,
  createDashboardWidget,
  deepClone,
  normalizeDashboardDocument,
  widgetTypeLabel
} from '../../../runtime/dashboardSchema.js'

const emit = defineEmits(['reload'])

const viewportRef = ref(null)
const documentModel = ref(normalizeDashboardDocument())
const revision = ref(0)
const releases = ref([])
const currentRelease = ref(null)
const loading = ref(true)
const saving = ref(false)
const publishing = ref(false)
const status = reactive({ tone: 'info', text: '正在读取设计器...' })
const zoom = ref(0.58)
const previewMode = ref(false)
const inspectorTab = ref('content')
const selectedIds = ref([])
const guides = reactive({ x: [], y: [] })
const devices = ref([])
const points = ref([])
const workshops = ref([])
const lines = ref([])
const dataSources = ref([])
const databaseTables = ref([])
const databaseColumns = ref([])
const databaseMetadataLoading = ref(false)
const databasePreviewValues = reactive({})
const previewContext = reactive({ viewMode: 'factory', workshopId: '', lineId: '', deviceId: '' })
const previewGroupVisibility = reactive({})
const previewWidgetVisibility = reactive({})
const pointValues = ref({})
const history = ref([])
const historyIndex = ref(-1)
const lastSavedSnapshot = ref('')
const publishDialogOpen = ref(false)
const publishForm = reactive({ version: '', notes: '' })
const releaseDialog = ref(null)
const layersCollapsed = ref(false)
const canvasPreset = ref('1920x1080')
let pointerOperation = null
let realtimeTimer = 0
let localPersistTimer = 0
let viewportObserver = null
let viewportFitFrame = 0
let manualZoom = false

const runtimePaths = [
  { value: 'metrics.current_output', label: '今日产出' },
  { value: 'metrics.progress_percent', label: '完成进度' },
  { value: 'metrics.overall_oee', label: 'OEE' },
  { value: 'metrics.energy_consumption', label: '能耗估算' },
  { value: 'metrics.online_devices', label: '在线设备数' },
  { value: 'events', label: '报警/事件列表' },
  { value: 'trendPoints', label: '实时趋势序列' }
]

const mockMetrics = reactive({
  current_output: 1260,
  daily_target: 1800,
  overall_oee: 86.5,
  energy_consumption: 4280,
  running_devices: 7,
  alarm_devices: 1,
  online_devices: 11,
  total_devices: 12
})
const mockEvents = ref([
  { id: 1, time: '10:26:18', title: '2# 多用炉温度到达设定值', level: 'info' },
  { id: 2, time: '10:24:03', title: '清洗机液位偏低', level: 'warning' },
  { id: 3, time: '10:21:42', title: '1# 多用炉通讯恢复', level: 'info' }
])
const mockTrend = ref([
  { time: '10:00', value: 782 }, { time: '10:05', value: 806 },
  { time: '10:10', value: 824 }, { time: '10:15', value: 836 },
  { time: '10:20', value: 842 }, { time: '10:25', value: 838 }
])
const mockDeviceStatus = reactive({
  Furnace_01: { name: '1# 多用炉', temp: 836, running: true, alarm: false, online: true, quality: 'good' },
  Furnace_02: { name: '2# 多用炉', temp: 821, running: true, alarm: false, online: true, quality: 'good' },
  Furnace_03: { name: '3# 多用炉', temp: '--', running: false, alarm: true, online: false, quality: 'bad' }
})

const canvas = computed(() => documentModel.value.canvas)
const overlayWidgets = computed(() => documentModel.value.widgets
  .filter(widget => !SYSTEM_WIDGET_TYPES.has(widget.type) && widget.runtimeTarget !== 'unity')
  .sort((left, right) => Number(left.zIndex || 0) - Number(right.zIndex || 0)))
const systemWidgets = computed(() => documentModel.value.widgets.filter(widget => SYSTEM_WIDGET_TYPES.has(widget.type) || widget.runtimeTarget === 'unity'))
const selectedWidgets = computed(() => documentModel.value.widgets.filter(widget => selectedIds.value.includes(widget.id)))
const selectedWidget = computed(() => selectedWidgets.value[selectedWidgets.value.length - 1] || null)
const canUndo = computed(() => historyIndex.value > 0)
const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)
const isDirty = computed(() => JSON.stringify(documentModel.value) !== lastSavedSnapshot.value)
const currentReleaseId = computed(() => currentRelease.value?.id || releases.value.find(item => item.is_current)?.id || '')
const selectedDevicePoints = computed(() => points.value.filter(point =>
  String(point.device_id) === String(selectedWidget.value?.data?.deviceId || '')
  && String(point.access_type || 'READ').toUpperCase() === 'READ'
))
const selectedDataSource = computed(() => dataSources.value.find(item => item.id === selectedWidget.value?.data?.connectionId) || null)
const groupOptions = computed(() => {
  const groups = new Map()
  documentModel.value.widgets.forEach(widget => {
    if (widget.groupId && !groups.has(widget.groupId)) groups.set(widget.groupId, widget.title || widget.groupId)
  })
  return [...groups.entries()].map(([id, label]) => ({ id, label }))
})
const eventWidgetOptions = computed(() => documentModel.value.widgets.map(widget => ({ id: widget.id, label: widget.title || widgetTypeLabel(widget.type) })))
const libraryGroups = computed(() => {
  const groups = new Map()
  DASHBOARD_WIDGET_LIBRARY.forEach(item => {
    if (!groups.has(item.group)) groups.set(item.group, [])
    groups.get(item.group).push(item)
  })
  return [...groups.entries()].map(([name, items]) => ({ name, items }))
})
const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)
const canvasWidgets = computed(() => previewMode.value
  ? overlayWidgets.value.filter(widget => widgetRuntimeVisible(widget, {
      context: previewContext,
      dataValue: previewValueForWidget(widget),
      dataRecord: databasePreviewValues[widget.id] || null,
      groupVisibility: previewGroupVisibility,
      widgetVisibility: previewWidgetVisibility
    }))
  : overlayWidgets.value)
const canvasTransformStyle = computed(() => ({
  width: `${canvas.value.width}px`,
  height: `${canvas.value.height}px`,
  transform: `scale(${zoom.value})`,
  background: canvas.value.background === 'transparent'
    ? 'radial-gradient(circle at 50% 35%, rgba(43,89,121,.22), transparent 48%), #07111c'
    : canvas.value.background
}))
const canvasOuterStyle = computed(() => ({
  width: `${canvas.value.width * zoom.value}px`,
  height: `${canvas.value.height * zoom.value}px`
}))

function setStatus(text, tone = 'info') {
  status.text = text
  status.tone = tone
}

function snapshot(value = documentModel.value) {
  return JSON.stringify(value)
}

function resetHistory() {
  history.value = [{ document: deepClone(documentModel.value), label: '加载草稿' }]
  historyIndex.value = 0
}

function commitHistory(label = '编辑组件') {
  const serialized = snapshot()
  if (historyIndex.value >= 0 && JSON.stringify(history.value[historyIndex.value]?.document) === serialized) return
  history.value = history.value.slice(0, historyIndex.value + 1)
  history.value.push({ document: deepClone(documentModel.value), label })
  if (history.value.length > 80) history.value.shift()
  historyIndex.value = history.value.length - 1
  scheduleLocalPersist()
}

function applyHistory(index) {
  if (index < 0 || index >= history.value.length) return
  historyIndex.value = index
  documentModel.value = normalizeDashboardDocument(deepClone(history.value[index].document))
  selectedIds.value = selectedIds.value.filter(id => documentModel.value.widgets.some(widget => widget.id === id))
  scheduleLocalPersist()
}

function undo() { if (canUndo.value) applyHistory(historyIndex.value - 1) }
function redo() { if (canRedo.value) applyHistory(historyIndex.value + 1) }

function localDraftKey(sceneId = documentModel.value.sceneId) {
  return `dashboard-designer-draft:${sceneId}`
}

function readLocalDraft(sceneId, serverRevision) {
  try {
    const value = JSON.parse(localStorage.getItem(localDraftKey(sceneId)) || 'null')
    if (!value || Number(value.serverRevision) !== Number(serverRevision) || !value.document) return null
    return normalizeDashboardDocument(value.document)
  } catch {
    return null
  }
}

function persistLocalDraft() {
  window.clearTimeout(localPersistTimer)
  if (!documentModel.value?.sceneId || !isDirty.value) return
  try {
    localStorage.setItem(localDraftKey(), JSON.stringify({
      serverRevision: revision.value,
      savedAt: new Date().toISOString(),
      document: documentModel.value
    }))
  } catch {
    // 浏览器存储不可用时不影响服务端草稿。
  }
}

function scheduleLocalPersist() {
  window.clearTimeout(localPersistTimer)
  localPersistTimer = window.setTimeout(persistLocalDraft, 350)
}

function clearLocalDraft() {
  try { localStorage.removeItem(localDraftKey()) } catch { /* ignore */ }
}

async function loadDesigner({ allowLocal = true } = {}) {
  loading.value = true
  try {
    const [designer, deviceRows, pointRows, dataSourceResult, workshopRows, lineRows] = await Promise.all([
      adminApi.getDashboardDesigner(),
      adminApi.getDevices(),
      adminApi.getDataPoints('all'),
      adminApi.getDataSources().catch(() => ({ connections: [] })),
      adminApi.getWorkshops().catch(() => []),
      adminApi.getLines().catch(() => [])
    ])
    if (designer?.error) throw new Error(designer.error)
    revision.value = Number(designer.revision || 0)
    const serverDocument = normalizeDashboardDocument(designer.document || {})
    const localDocument = allowLocal ? readLocalDraft(serverDocument.sceneId, revision.value) : null
    documentModel.value = localDocument || serverDocument
    releases.value = designer.releases || []
    currentRelease.value = designer.currentRelease || null
    devices.value = Array.isArray(deviceRows) ? deviceRows : []
    points.value = (Array.isArray(pointRows) ? pointRows : []).filter(point => String(point.access_type || 'READ').toUpperCase() === 'READ')
    dataSources.value = Array.isArray(dataSourceResult?.connections) ? dataSourceResult.connections : []
    workshops.value = Array.isArray(workshopRows) ? workshopRows : []
    lines.value = Array.isArray(lineRows) ? lineRows : []
    lastSavedSnapshot.value = snapshot(serverDocument)
    resetHistory()
    selectedIds.value = overlayWidgets.value[0]?.id ? [overlayWidgets.value[0].id] : []
    setStatus(localDocument ? '已恢复本机未保存的编辑内容' : `草稿修订 ${revision.value}，运行中版本 ${designer.currentRelease?.version || '未发布'}`, localDocument ? 'warning' : 'success')
    await nextTick()
    fitCanvas('comfortable')
    await refreshRealtimePoints()
  } catch (error) {
    setStatus(error.message || '设计器加载失败', 'danger')
  } finally {
    loading.value = false
  }
}

async function refreshRealtimePoints() {
  try {
    const result = await adminApi.getRealtimePointValues('all')
    if (result?.error || !Array.isArray(result?.points)) return
    const next = {}
    result.points.forEach(point => {
      next[String(point.id)] = point
      next[`${point.device_id}:${point.id}`] = point
    })
    pointValues.value = next
  } catch {
    // PLC 离线时设计器继续使用组件占位值。
  }
}

function centerCanvas() {
  nextTick(() => {
    const scroll = viewportRef.value?.querySelector?.('.designer-canvas-scroll')
    if (!scroll) return
    scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2)
    scroll.scrollTop = Math.max(0, Math.min((scroll.scrollHeight - scroll.clientHeight) / 2, 80))
  })
}

function fitCanvas(mode = 'comfortable') {
  const viewport = viewportRef.value
  if (!viewport) return
  const availableWidth = Math.max(360, viewport.clientWidth - 48)
  const availableHeight = Math.max(260, viewport.clientHeight - 56)
  const fitted = Math.min(availableWidth / canvas.value.width, availableHeight / canvas.value.height)
  zoom.value = Math.max(0.25, Math.min(1, mode === 'comfortable' ? Math.max(fitted, 0.58) : fitted))
  manualZoom = false
  centerCanvas()
}

function setZoom(value) {
  zoom.value = Math.max(0.25, Math.min(1.5, Number(value)))
  manualZoom = true
}

function getByPath(source, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => current?.[key], source)
}

function previewValueForWidget(widget) {
  const binding = widget.data || {}
  if (binding.mode === 'database') return databasePreviewValues[widget.id]?.value
  if (binding.mode === 'plc') return pointValues.value[binding.pointId]?.value
  if (binding.mode === 'runtime') {
    return getByPath({ metrics: mockMetrics, events: mockEvents.value, trendPoints: mockTrend.value, deviceStatusMap: mockDeviceStatus }, binding.path || binding.source)
  }
  return widget.content?.value
}

function canvasPoint(event) {
  const viewport = event.currentTarget?.closest?.('.designer-canvas') || event.currentTarget
  const rect = viewport.querySelector?.('.designer-canvas-stage')?.getBoundingClientRect?.()
  if (!rect) return { x: 120, y: 120 }
  return {
    x: (event.clientX - rect.left) / zoom.value,
    y: (event.clientY - rect.top) / zoom.value
  }
}

function snap(value) {
  const grid = Math.max(1, Number(canvas.value.gridSize || 10))
  return Math.round(value / grid) * grid
}

function widgetFrameStyle(widget) {
  return {
    left: `${widget.frame.x}px`,
    top: `${widget.frame.y}px`,
    width: `${widget.frame.width}px`,
    height: `${widget.frame.height}px`,
    zIndex: widget.zIndex,
    transform: `rotate(${widget.frame.rotation || 0}deg)`,
    opacity: widget.visible ? 1 : 0.32
  }
}

function selectWidget(widget, event = {}) {
  const groupIds = widget.groupId
    ? documentModel.value.widgets.filter(item => item.groupId === widget.groupId).map(item => item.id)
    : [widget.id]
  if (event.ctrlKey || event.metaKey) {
    const next = new Set(selectedIds.value)
    groupIds.forEach(id => next.has(id) ? next.delete(id) : next.add(id))
    selectedIds.value = [...next]
  } else if (!selectedIds.value.includes(widget.id) || groupIds.some(id => !selectedIds.value.includes(id))) {
    selectedIds.value = groupIds
  }
}

function clearSelection(event) {
  if (event.target === event.currentTarget || event.target.classList.contains('designer-canvas-stage')) selectedIds.value = []
}

function addWidget(type, position = {}) {
  const widget = createDashboardWidget(type, documentModel.value.widgets.length, position)
  widget.frame.x = snap(Math.max(0, Math.min(canvas.value.width - widget.frame.width, widget.frame.x)))
  widget.frame.y = snap(Math.max(0, Math.min(canvas.value.height - widget.frame.height, widget.frame.y)))
  widget.zIndex = Math.max(0, ...documentModel.value.widgets.map(item => Number(item.zIndex || 0))) + 1
  documentModel.value.widgets.push(widget)
  selectedIds.value = [widget.id]
  inspectorTab.value = 'content'
  commitHistory(`添加${widgetTypeLabel(type)}`)
}

function handleLibraryDragStart(event, type) {
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-dashboard-widget', type)
}

function handleCanvasDrop(event) {
  const type = event.dataTransfer.getData('application/x-dashboard-widget')
  if (!type) return
  const point = canvasPoint(event)
  addWidget(type, { x: point.x - 120, y: point.y - 60 })
}

function movableSelection(widget, event) {
  selectWidget(widget, event)
  const selected = documentModel.value.widgets.filter(item => selectedIds.value.includes(item.id) && !item.locked)
  return selected.length ? selected : (!widget.locked ? [widget] : [])
}

function beginMove(event, widget) {
  if (previewMode.value || event.button !== 0 || widget.locked) return
  const moving = movableSelection(widget, event)
  if (!moving.length) return
  event.preventDefault()
  const frames = new Map(moving.map(item => [item.id, deepClone(item.frame)]))
  pointerOperation = {
    kind: 'move',
    startX: event.clientX,
    startY: event.clientY,
    primaryId: widget.id,
    frames,
    before: snapshot()
  }
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', endPointerOperation, { once: true })
}

function beginResize(event, widget, direction) {
  if (previewMode.value || widget.locked) return
  selectWidget(widget)
  event.preventDefault()
  pointerOperation = {
    kind: 'resize',
    direction,
    startX: event.clientX,
    startY: event.clientY,
    primaryId: widget.id,
    frames: new Map([[widget.id, deepClone(widget.frame)]]),
    before: snapshot()
  }
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', endPointerOperation, { once: true })
}

function findWidget(id) {
  return documentModel.value.widgets.find(widget => widget.id === id)
}

function alignedPosition(frame, excludedIds) {
  const threshold = 7 / zoom.value
  const xCandidates = []
  const yCandidates = []
  const ownX = [frame.x, frame.x + frame.width / 2, frame.x + frame.width]
  const ownY = [frame.y, frame.y + frame.height / 2, frame.y + frame.height]
  documentModel.value.widgets.forEach(other => {
    if (excludedIds.has(other.id) || !other.visible || other.runtimeTarget === 'unity') return
    const targetX = [other.frame.x, other.frame.x + other.frame.width / 2, other.frame.x + other.frame.width]
    const targetY = [other.frame.y, other.frame.y + other.frame.height / 2, other.frame.y + other.frame.height]
    ownX.forEach((value, ownIndex) => targetX.forEach(target => {
      const diff = target - value
      if (Math.abs(diff) <= threshold) xCandidates.push({ diff, guide: target, score: Math.abs(diff), ownIndex })
    }))
    ownY.forEach((value, ownIndex) => targetY.forEach(target => {
      const diff = target - value
      if (Math.abs(diff) <= threshold) yCandidates.push({ diff, guide: target, score: Math.abs(diff), ownIndex })
    }))
  })
  xCandidates.sort((a, b) => a.score - b.score)
  yCandidates.sort((a, b) => a.score - b.score)
  guides.x = xCandidates[0] ? [xCandidates[0].guide] : []
  guides.y = yCandidates[0] ? [yCandidates[0].guide] : []
  return {
    x: snap(frame.x + (xCandidates[0]?.diff || 0)),
    y: snap(frame.y + (yCandidates[0]?.diff || 0))
  }
}

function handlePointerMove(event) {
  if (!pointerOperation) return
  const dx = (event.clientX - pointerOperation.startX) / zoom.value
  const dy = (event.clientY - pointerOperation.startY) / zoom.value
  if (pointerOperation.kind === 'move') {
    const primaryStart = pointerOperation.frames.get(pointerOperation.primaryId)
    if (!primaryStart) return
    const primaryWidget = findWidget(pointerOperation.primaryId)
    const raw = {
      ...primaryStart,
      x: Math.max(0, Math.min(canvas.value.width - primaryStart.width, primaryStart.x + dx)),
      y: Math.max(0, Math.min(canvas.value.height - primaryStart.height, primaryStart.y + dy))
    }
    const aligned = alignedPosition(raw, new Set(pointerOperation.frames.keys()))
    const alignedDx = aligned.x - primaryStart.x
    const alignedDy = aligned.y - primaryStart.y
    pointerOperation.frames.forEach((start, id) => {
      const target = findWidget(id)
      if (!target) return
      target.frame.x = Math.max(0, Math.min(canvas.value.width - start.width, start.x + alignedDx))
      target.frame.y = Math.max(0, Math.min(canvas.value.height - start.height, start.y + alignedDy))
    })
    if (primaryWidget) primaryWidget.frame = { ...primaryWidget.frame }
    return
  }

  const widget = findWidget(pointerOperation.primaryId)
  const start = pointerOperation.frames.get(pointerOperation.primaryId)
  if (!widget || !start) return
  const direction = pointerOperation.direction
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (direction.includes('e')) right = Math.min(canvas.value.width, snap(right + dx))
  if (direction.includes('s')) bottom = Math.min(canvas.value.height, snap(bottom + dy))
  if (direction.includes('w')) left = Math.max(0, snap(left + dx))
  if (direction.includes('n')) top = Math.max(0, snap(top + dy))
  if (right - left < 60) direction.includes('w') ? left = right - 60 : right = left + 60
  if (bottom - top < 40) direction.includes('n') ? top = bottom - 40 : bottom = top + 40
  widget.frame = { ...widget.frame, x: left, y: top, width: right - left, height: bottom - top }
}

function endPointerOperation() {
  window.removeEventListener('pointermove', handlePointerMove)
  guides.x = []
  guides.y = []
  if (pointerOperation && pointerOperation.before !== snapshot()) commitHistory(pointerOperation.kind === 'move' ? '移动组件' : '缩放组件')
  pointerOperation = null
}

function deleteSelected() {
  if (!selectedIds.value.length) return
  const removable = new Set(selectedIds.value.filter(id => !findWidget(id)?.locked))
  if (!removable.size) return setStatus('锁定组件不能删除', 'warning')
  documentModel.value.widgets = documentModel.value.widgets.filter(widget => !removable.has(widget.id))
  selectedIds.value = []
  commitHistory('删除组件')
}

function copySelected() {
  const copies = selectedWidgets.value.filter(widget => !SYSTEM_WIDGET_TYPES.has(widget.type)).map((widget, index) => {
    const copy = deepClone(widget)
    copy.id = `${widget.id}_copy_${Date.now()}_${index}`
    copy.title = `${widget.title || widgetTypeLabel(widget.type)} 副本`
    copy.frame.x = Math.min(canvas.value.width - copy.frame.width, copy.frame.x + 24)
    copy.frame.y = Math.min(canvas.value.height - copy.frame.height, copy.frame.y + 24)
    copy.zIndex = Math.max(0, ...documentModel.value.widgets.map(item => Number(item.zIndex || 0))) + index + 1
    copy.groupId = ''
    return copy
  })
  if (!copies.length) return
  documentModel.value.widgets.push(...copies)
  selectedIds.value = copies.map(widget => widget.id)
  commitHistory('复制组件')
}

function toggleSelectedLock() {
  if (!selectedWidgets.value.length) return
  const next = !selectedWidgets.value.every(widget => widget.locked)
  selectedWidgets.value.forEach(widget => { widget.locked = next })
  commitHistory(next ? '锁定组件' : '解锁组件')
}

function groupSelected() {
  if (selectedWidgets.value.length < 2) return setStatus('至少选择两个组件才能组合', 'warning')
  const groupId = `group_${Date.now()}`
  selectedWidgets.value.forEach(widget => { widget.groupId = groupId })
  commitHistory('组合组件')
}

function ungroupSelected() {
  if (!selectedWidgets.value.some(widget => widget.groupId)) return
  selectedWidgets.value.forEach(widget => { widget.groupId = '' })
  commitHistory('取消组合')
}

function moveLayer(widget, mode) {
  const values = documentModel.value.widgets.map(item => Number(item.zIndex || 0))
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (mode === 'top') widget.zIndex = max + 1
  if (mode === 'bottom') widget.zIndex = min - 1
  if (mode === 'up') widget.zIndex = Number(widget.zIndex || 0) + 1
  if (mode === 'down') widget.zIndex = Number(widget.zIndex || 0) - 1
  commitHistory('调整图层')
}

function toggleLayerVisibility(widget) {
  widget.visible = !widget.visible
  commitHistory(widget.visible ? '显示组件' : '隐藏组件')
}

function toggleLayerLock(widget) {
  widget.locked = !widget.locked
  commitHistory(widget.locked ? '锁定组件' : '解锁组件')
}

function bindSelectedPoint() {
  const widget = selectedWidget.value
  if (!widget) return
  const point = points.value.find(item => String(item.id) === String(widget.data.pointId))
  if (!point) return
  if (String(point.access_type || 'READ').toUpperCase() !== 'READ') {
    widget.data.pointId = ''
    return setStatus('设计器只允许绑定 READ 点位', 'danger')
  }
  widget.data.mode = 'plc'
  widget.data.deviceId = String(point.device_id)
  widget.data.path = `${point.category || point.category_resolved || 'analog'}.${point.value_role || point.field_name || point.name}`
  widget.data.unit = point.unit || ''
  widget.data.readOnly = true
  commitHistory('绑定 PLC 只读点位')
}

async function loadDatabaseTables(connectionId = selectedWidget.value?.data?.connectionId) {
  databaseTables.value = []
  databaseColumns.value = []
  if (!connectionId) return
  databaseMetadataLoading.value = true
  try {
    const result = await adminApi.getDataSourceTables(connectionId)
    databaseTables.value = result.tables || []
  } catch (error) {
    setStatus(`读取数据库表失败：${error.message || error}`, 'danger')
  } finally {
    databaseMetadataLoading.value = false
  }
}

async function loadDatabaseColumns(connectionId = selectedWidget.value?.data?.connectionId, schema = selectedWidget.value?.data?.schema, table = selectedWidget.value?.data?.table) {
  databaseColumns.value = []
  if (!connectionId || !table) return
  databaseMetadataLoading.value = true
  try {
    const result = await adminApi.getDataSourceColumns(connectionId, schema || '', table)
    databaseColumns.value = result.columns || []
  } catch (error) {
    setStatus(`读取数据库字段失败：${error.message || error}`, 'danger')
  } finally {
    databaseMetadataLoading.value = false
  }
}

async function changeDatabaseConnection() {
  const widget = selectedWidget.value
  if (!widget) return
  Object.assign(widget.data, { schema: '', table: '', field: '', timeField: '', orderBy: '' })
  delete databasePreviewValues[widget.id]
  await loadDatabaseTables(widget.data.connectionId)
  recordProperty('选择数据库连接')
}

async function changeDatabaseTable(value) {
  const widget = selectedWidget.value
  if (!widget) return
  const [schema = '', table = ''] = String(value || '').split('\u0001')
  Object.assign(widget.data, { schema, table, field: '', timeField: '', orderBy: '' })
  delete databasePreviewValues[widget.id]
  await loadDatabaseColumns(widget.data.connectionId, schema, table)
  recordProperty('选择数据库表')
}

function databaseTableKey(data = selectedWidget.value?.data) {
  return data?.table ? `${data.schema || ''}\u0001${data.table}` : ''
}

async function previewDatabaseBinding(widget = selectedWidget.value, silent = false) {
  if (!widget || widget.data?.mode !== 'database' || !widget.data.connectionId || !widget.data.table) return
  if (widget.data.valueMode !== 'count' && !widget.data.field) return
  try {
    const result = await adminApi.previewDataSource(widget.data)
    databasePreviewValues[widget.id] = result.result || {}
    if (!silent) setStatus(`数据预览：${result.result?.value ?? '空值'}`, 'success')
  } catch (error) {
    databasePreviewValues[widget.id] = { value: null, rows: [], quality: 'bad', error: error.message }
    if (!silent) setStatus(`数据预览失败：${error.message || error}`, 'danger')
  }
}

function changeBindingMode() {
  const widget = selectedWidget.value
  if (!widget) return
  widget.data.readOnly = true
  if (widget.data.mode !== 'plc') {
    widget.data.deviceId = ''
    widget.data.pointId = ''
  }
  if (widget.data.mode !== 'database') {
    widget.data.connectionId = ''
    widget.data.schema = ''
    widget.data.table = ''
    widget.data.field = ''
    widget.data.timeField = ''
    widget.data.orderBy = ''
  } else {
    widget.data.valueMode = ['trend', 'alarm_list', 'device_list', 'marquee'].includes(widget.type) ? 'list' : 'latest'
    widget.data.rowLimit ||= 50
    widget.data.refreshMs ||= 5000
    if (!widget.data.connectionId) widget.data.connectionId = dataSources.value[0]?.id || ''
    loadDatabaseTables(widget.data.connectionId)
  }
  commitHistory('修改数据源')
}

function addCondition() {
  if (!selectedWidget.value) return
  selectedWidget.value.conditions.push({ operator: '>', value: 0, color: '#ff625f', background: 'rgba(255,98,95,.16)', animation: 'blink' })
  commitHistory('添加条件样式')
}

function toggleViewMode(mode, checked) {
  if (!selectedWidget.value) return
  const modes = new Set(selectedWidget.value.visibility?.viewModes || [])
  checked ? modes.add(mode) : modes.delete(mode)
  selectedWidget.value.visibility.viewModes = [...modes]
  recordProperty('修改显示视角')
}

function addVisibilityRule() {
  if (!selectedWidget.value) return
  selectedWidget.value.visibility.rules.push({ source: 'context', path: 'viewMode', operator: '==', value: 'device' })
  commitHistory('添加显示条件')
}

function removeVisibilityRule(index) {
  selectedWidget.value?.visibility?.rules?.splice(index, 1)
  commitHistory('删除显示条件')
}

function removeCondition(index) {
  selectedWidget.value?.conditions.splice(index, 1)
  commitHistory('删除条件样式')
}

function addEvent() {
  if (!selectedWidget.value) return
  selectedWidget.value.events.push({ trigger: 'click', action: 'enter_device', deviceId: selectedWidget.value.data.deviceId || '' })
  commitHistory('添加点击事件')
}

function normalizeVisibilityEventTarget(event) {
  event.targetId = ''
  recordProperty('修改显隐目标')
}

async function togglePreviewMode() {
  previewMode.value = !previewMode.value
  if (previewMode.value) {
    Object.keys(previewGroupVisibility).forEach(key => delete previewGroupVisibility[key])
    Object.keys(previewWidgetVisibility).forEach(key => delete previewWidgetVisibility[key])
    await Promise.all(overlayWidgets.value.filter(widget => widget.data?.mode === 'database').map(widget => previewDatabaseBinding(widget, true)))
  }
}

function handlePreviewWidgetAction({ event }) {
  if (!previewMode.value || !event) return
  if (['set_visibility', 'toggle_visibility'].includes(event.action)) {
    applyVisibilityAction(event, { groupVisibility: previewGroupVisibility, widgetVisibility: previewWidgetVisibility })
    return
  }
  if (event.action === 'enter_device') Object.assign(previewContext, { viewMode: 'device', deviceId: event.deviceId || '' })
  if (event.action === 'focus_factory') Object.assign(previewContext, { viewMode: 'factory', workshopId: '', lineId: '', deviceId: '' })
  if (event.action === 'focus_line') Object.assign(previewContext, { viewMode: 'line', lineId: event.lineId || '', deviceId: '' })
  if (event.action === 'focus_workshop') Object.assign(previewContext, { viewMode: 'workshop', workshopId: event.workshopId || '', lineId: '', deviceId: '' })
}

function removeEvent(index) {
  selectedWidget.value?.events.splice(index, 1)
  commitHistory('删除点击事件')
}

function applyCanvasPreset() {
  const [width, height] = canvasPreset.value.split('x').map(Number)
  if (!width || !height) return
  const oldWidth = canvas.value.width
  const oldHeight = canvas.value.height
  const scaleX = width / oldWidth
  const scaleY = height / oldHeight
  documentModel.value.widgets.forEach(widget => {
    widget.frame.x *= scaleX
    widget.frame.y *= scaleY
    widget.frame.width *= scaleX
    widget.frame.height *= scaleY
  })
  canvas.value.width = width
  canvas.value.height = height
  commitHistory('切换画布分辨率')
  nextTick(fitCanvas)
}

async function saveDraft() {
  if (saving.value) return
  saving.value = true
  try {
    documentModel.value.widgets.forEach(widget => { widget.data.readOnly = true })
    const result = await adminApi.saveDashboardDraft(documentModel.value.sceneId, documentModel.value, revision.value)
    if (result?.error) throw new Error(result.error)
    documentModel.value = normalizeDashboardDocument(result.document)
    revision.value = Number(result.revision || revision.value + 1)
    lastSavedSnapshot.value = snapshot()
    resetHistory()
    clearLocalDraft()
    setStatus(`草稿已保存，修订 ${revision.value}；现场仍运行已发布版本`, 'success')
    emit('reload')
  } catch (error) {
    setStatus(error.message || '草稿保存失败', 'danger')
    if (/修订|刷新/.test(error.message || '')) await loadDesigner({ allowLocal: true })
  } finally {
    saving.value = false
  }
}

function openPublishDialog() {
  publishForm.version = ''
  publishForm.notes = ''
  publishDialogOpen.value = true
}

async function publishVersion() {
  if (publishing.value) return
  if (isDirty.value) {
    await saveDraft()
    if (isDirty.value) return
  }
  publishing.value = true
  try {
    const result = await adminApi.publishDashboard(documentModel.value.sceneId, publishForm.version, publishForm.notes)
    if (result?.error) throw new Error(result.error)
    publishDialogOpen.value = false
    setStatus(`版本 ${result.release.version} 已发布，Unity/WebView 正在切换`, 'success')
    await loadDesigner({ allowLocal: false })
    emit('reload')
  } catch (error) {
    setStatus(error.message || '发布失败', 'danger')
  } finally {
    publishing.value = false
  }
}

function requestActivateRelease(release) {
  if (release.id === currentReleaseId.value) return
  releaseDialog.value = release
}

async function activateRelease() {
  const release = releaseDialog.value
  if (!release) return
  publishing.value = true
  try {
    const result = await adminApi.activateDashboardRelease(release.id)
    if (result?.error) throw new Error(result.error)
    releaseDialog.value = null
    setStatus(`已恢复发布版本 ${release.version}`, 'success')
    await loadDesigner({ allowLocal: true })
    emit('reload')
  } catch (error) {
    setStatus(error.message || '版本恢复失败', 'danger')
  } finally {
    publishing.value = false
  }
}

function recordProperty(label = '修改属性') {
  if (selectedWidget.value?.data) selectedWidget.value.data.readOnly = true
  commitHistory(label)
}

function nudgeSelected(dx, dy) {
  selectedWidgets.value.filter(widget => !widget.locked).forEach(widget => {
    widget.frame.x = Math.max(0, Math.min(canvas.value.width - widget.frame.width, widget.frame.x + dx))
    widget.frame.y = Math.max(0, Math.min(canvas.value.height - widget.frame.height, widget.frame.y + dy))
  })
  commitHistory('微调组件')
}

function handleKeydown(event) {
  const target = event.target
  if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return
  const ctrl = event.ctrlKey || event.metaKey
  if (ctrl && event.key.toLowerCase() === 's') { event.preventDefault(); saveDraft(); return }
  if (ctrl && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
  if (ctrl && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
  if (ctrl && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected(); return }
  if (ctrl && event.key.toLowerCase() === 'g') { event.preventDefault(); event.shiftKey ? ungroupSelected() : groupSelected(); return }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); return }
  const step = event.shiftKey ? 10 : 1
  if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeSelected(-step, 0) }
  if (event.key === 'ArrowRight') { event.preventDefault(); nudgeSelected(step, 0) }
  if (event.key === 'ArrowUp') { event.preventDefault(); nudgeSelected(0, -step) }
  if (event.key === 'ArrowDown') { event.preventDefault(); nudgeSelected(0, step) }
}

watch(documentModel, scheduleLocalPersist, { deep: true })
watch(() => [selectedWidget.value?.id, selectedWidget.value?.data?.mode, selectedWidget.value?.data?.connectionId, selectedWidget.value?.data?.schema, selectedWidget.value?.data?.table], async ([id, mode, connectionId, schema, table]) => {
  if (!id || mode !== 'database') return
  if (connectionId) await loadDatabaseTables(connectionId)
  if (connectionId && table) await loadDatabaseColumns(connectionId, schema, table)
  await previewDatabaseBinding(selectedWidget.value, true)
})

onMounted(() => {
  loadDesigner()
  window.addEventListener('keydown', handleKeydown)
  realtimeTimer = window.setInterval(refreshRealtimePoints, 3000)
  viewportObserver = new ResizeObserver(() => {
    window.cancelAnimationFrame(viewportFitFrame)
    viewportFitFrame = window.requestAnimationFrame(() => {
      if (!manualZoom) fitCanvas('comfortable')
    })
  })
  if (viewportRef.value) viewportObserver.observe(viewportRef.value)
})

onBeforeUnmount(() => {
  persistLocalDraft()
  endPointerOperation()
  window.removeEventListener('keydown', handleKeydown)
  window.clearInterval(realtimeTimer)
  window.clearTimeout(localPersistTimer)
  window.cancelAnimationFrame(viewportFitFrame)
  viewportObserver?.disconnect()
})
</script>

<template>
  <section class="dashboard-designer-shell" :class="{ 'is-preview': previewMode }">
    <header class="designer-toolbar">
      <div class="designer-brand">
        <span class="designer-brand-mark">D</span>
        <div><strong>大屏低代码设计器</strong><small>Schema v2 · 多数据源只读</small></div>
      </div>
      <div class="designer-toolbar-group">
        <button type="button" title="撤销 Ctrl+Z" :disabled="!canUndo" @click="undo">↶</button>
        <button type="button" title="重做 Ctrl+Y" :disabled="!canRedo" @click="redo">↷</button>
        <span class="toolbar-divider"></span>
        <button type="button" title="复制 Ctrl+C" :disabled="!selectedIds.length" @click="copySelected">⧉</button>
        <button type="button" title="删除 Delete" :disabled="!selectedIds.length" @click="deleteSelected">⌫</button>
        <button type="button" title="锁定/解锁" :disabled="!selectedIds.length" @click="toggleSelectedLock">⌁</button>
        <button type="button" title="组合 Ctrl+G" :disabled="selectedIds.length < 2" @click="groupSelected">组合</button>
        <button type="button" title="取消组合 Ctrl+Shift+G" :disabled="!selectedWidgets.some(item => item.groupId)" @click="ungroupSelected">解组</button>
      </div>
      <div class="designer-toolbar-group canvas-tools">
        <select v-model="canvasPreset" title="基准分辨率" @change="applyCanvasPreset">
          <option value="1920x1080">1920 × 1080</option>
          <option value="2560x1440">2560 × 1440</option>
          <option value="3840x2160">3840 × 2160</option>
          <option value="1366x768">1366 × 768</option>
        </select>
        <button type="button" @click="setZoom(zoom - .1)">−</button>
        <button type="button" class="zoom-label" title="完整适应画布" @click="fitCanvas('all')">{{ zoomPercent }}</button>
        <button type="button" @click="setZoom(zoom + .1)">＋</button>
      </div>
      <div class="designer-toolbar-actions">
        <select v-if="previewMode" v-model="previewContext.viewMode" title="模拟 Unity 当前视角">
          <option value="factory">工厂视角</option><option value="workshop">车间视角</option><option value="line">产线视角</option><option value="device">设备视角</option>
        </select>
        <button type="button" :class="{ active: previewMode }" @click="togglePreviewMode">{{ previewMode ? '退出预览' : '实时预览' }}</button>
        <button type="button" class="save-button" :disabled="saving || !isDirty" @click="saveDraft">{{ saving ? '保存中...' : '保存草稿' }}</button>
        <button type="button" class="publish-button" :disabled="publishing" @click="openPublishDialog">发布版本</button>
      </div>
    </header>

    <div class="designer-main">
      <aside class="designer-left-panel">
        <div class="designer-panel-heading"><strong>组件库</strong><small>拖入画布或单击添加</small></div>
        <div class="component-library">
          <section v-for="group in libraryGroups" :key="group.name">
            <h4>{{ group.name }}</h4>
            <div class="component-grid">
              <button
                v-for="item in group.items"
                :key="item.type"
                type="button"
                draggable="true"
                :title="item.description"
                @dragstart="handleLibraryDragStart($event, item.type)"
                @click="addWidget(item.type)"
              >
                <span>{{ item.icon }}</span><strong>{{ item.label }}</strong><small>{{ item.description }}</small>
              </button>
            </div>
          </section>
        </div>

        <div class="layer-heading" @click="layersCollapsed = !layersCollapsed">
          <strong>图层</strong><span>{{ layersCollapsed ? '展开' : '收起' }}</span>
        </div>
        <div v-if="!layersCollapsed" class="layer-list">
          <button
            v-for="widget in [...overlayWidgets].reverse()"
            :key="widget.id"
            type="button"
            :class="{ active: selectedIds.includes(widget.id), hidden: !widget.visible }"
            @click="selectWidget(widget, $event)"
          >
            <span class="layer-type">{{ widgetTypeLabel(widget.type).slice(0, 1) }}</span>
            <span class="layer-name">{{ widget.title || widgetTypeLabel(widget.type) }}</span>
            <i title="显示/隐藏" @click.stop="toggleLayerVisibility(widget)">{{ widget.visible ? '◉' : '○' }}</i>
            <i title="锁定/解锁" @click.stop="toggleLayerLock(widget)">{{ widget.locked ? '◆' : '◇' }}</i>
          </button>
          <p v-if="!overlayWidgets.length">从上方组件库添加第一个组件</p>
        </div>
        <details v-if="systemWidgets.length" class="system-widget-list">
          <summary>Unity 系统组件（{{ systemWidgets.length }}）</summary>
          <div v-for="widget in systemWidgets" :key="widget.id">{{ widget.title || widget.type }}<small>由 Unity 使用，设计器不会删除</small></div>
        </details>
      </aside>

      <main ref="viewportRef" class="designer-canvas" @dragover.prevent @drop.prevent="handleCanvasDrop" @pointerdown="clearSelection">
        <div v-if="loading" class="designer-loading"><span></span>正在加载草稿、点位与数据源...</div>
        <div v-else class="designer-canvas-scroll">
          <div class="designer-canvas-spacer" :style="canvasOuterStyle">
            <div class="designer-canvas-stage" :style="canvasTransformStyle">
              <div class="canvas-safe-area" :style="{ inset: `${canvas.safeArea}px` }"></div>
              <div v-for="x in guides.x" :key="`gx-${x}`" class="alignment-guide vertical" :style="{ left: `${x}px` }"></div>
              <div v-for="y in guides.y" :key="`gy-${y}`" class="alignment-guide horizontal" :style="{ top: `${y}px` }"></div>

              <article
                v-for="widget in canvasWidgets"
                :key="widget.id"
                class="designer-widget"
                :class="{
                  selected: selectedIds.includes(widget.id),
                  locked: widget.locked,
                  hidden: !widget.visible,
                  grouped: !!widget.groupId
                }"
                :style="widgetFrameStyle(widget)"
                @pointerdown.stop="beginMove($event, widget)"
                @click.stop="selectWidget(widget, $event)"
              >
                <WidgetRenderer
                  :widget="widget"
                  :metrics="mockMetrics"
                  :events="mockEvents"
                  :trend-points="mockTrend"
                  :device-status-map="mockDeviceStatus"
                  :point-values="pointValues"
                  :database-values="databasePreviewValues"
                  preview
                  @action="handlePreviewWidgetAction"
                />
                <div v-if="!previewMode && selectedIds.includes(widget.id)" class="widget-selection-label">
                  {{ widget.title || widgetTypeLabel(widget.type) }} · {{ Math.round(widget.frame.width) }}×{{ Math.round(widget.frame.height) }}
                </div>
                <template v-if="!previewMode && selectedIds.includes(widget.id) && !widget.locked && selectedIds.length === 1">
                  <i v-for="direction in ['n','ne','e','se','s','sw','w','nw']" :key="direction" class="resize-handle" :class="direction" @pointerdown.stop="beginResize($event, widget, direction)"></i>
                </template>
              </article>

              <div v-if="!overlayWidgets.length" class="empty-canvas-hint">
                <strong>把组件拖到这里</strong><span>画布为 {{ canvas.width }} × {{ canvas.height }}，运行时按屏幕等比缩放</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      <aside class="designer-right-panel">
        <template v-if="selectedWidget">
          <div class="selected-widget-heading">
            <div><span>{{ widgetTypeLabel(selectedWidget.type) }}</span><strong>{{ selectedWidget.title || selectedWidget.id }}</strong><small>{{ selectedWidget.id }}</small></div>
            <button type="button" @click="toggleLayerLock(selectedWidget)">{{ selectedWidget.locked ? '解锁' : '锁定' }}</button>
          </div>
          <nav class="inspector-tabs">
            <button v-for="tab in [{id:'content',label:'内容'},{id:'style',label:'样式'},{id:'data',label:'数据来源'},{id:'condition',label:'显示条件'},{id:'animation',label:'动画'},{id:'event',label:'事件'}]" :key="tab.id" type="button" :class="{ active: inspectorTab === tab.id }" @click="inspectorTab = tab.id">{{ tab.label }}</button>
          </nav>

          <div class="inspector-body">
            <section v-if="inspectorTab === 'content'" class="inspector-section">
              <label>组件标题<input v-model="selectedWidget.title" @change="recordProperty('修改标题')" /></label>
              <label v-if="selectedWidget.type === 'text'">文本内容<textarea v-model="selectedWidget.content.text" rows="5" @change="recordProperty('修改文本')"></textarea></label>
              <label v-if="selectedWidget.type === 'text'">文字对齐<select v-model="selectedWidget.content.align" @change="recordProperty()"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
              <label v-if="selectedWidget.type === 'value'">字段名称<input v-model="selectedWidget.content.label" @change="recordProperty()" /></label>
              <label v-if="selectedWidget.type === 'value'">空值文字<input v-model="selectedWidget.content.fallback" @change="recordProperty()" /></label>
              <label v-if="selectedWidget.type === 'value'">展示形态<select v-model="selectedWidget.content.shape" @change="recordProperty()"><option value="card">数字卡片</option><option value="tile">数字翻牌</option><option value="gauge">仪表读数</option><option value="plain">纯数值</option></select></label>
              <template v-if="selectedWidget.type === 'status'">
                <label>开启文字<input v-model="selectedWidget.content.onText" @change="recordProperty()" /></label>
                <label>关闭文字<input v-model="selectedWidget.content.offText" @change="recordProperty()" /></label>
                <label>离线文字<input v-model="selectedWidget.content.unknownText" @change="recordProperty()" /></label>
                <label>展示形态<select v-model="selectedWidget.content.shape" @change="recordProperty()"><option value="lamp">状态灯</option><option value="badge">状态标签</option><option value="switch">状态开关</option></select></label>
              </template>
              <template v-if="selectedWidget.type === 'image'">
                <label>图片地址<input v-model="selectedWidget.content.url" placeholder="/uploads/... 或 https://..." @change="recordProperty()" /></label>
                <label>填充方式<select v-model="selectedWidget.content.fit" @change="recordProperty()"><option value="contain">完整显示</option><option value="cover">铺满裁切</option><option value="fill">拉伸填充</option></select></label>
                <label>替代文字<input v-model="selectedWidget.content.alt" @change="recordProperty()" /></label>
              </template>
              <template v-if="['alarm_list','device_list'].includes(selectedWidget.type)">
                <label>最多显示<input v-model.number="selectedWidget.content.limit" type="number" min="1" max="100" @change="recordProperty()" /></label>
              </template>
              <template v-if="selectedWidget.type === 'trend'">
                <label>曲线名称<input v-model="selectedWidget.content.seriesName" @change="recordProperty()" /></label>
                <label>保留数据点<input v-model.number="selectedWidget.content.historyLength" type="number" min="8" max="600" @change="recordProperty()" /></label>
              </template>
              <template v-if="selectedWidget.type === 'marquee'">
                <label>滚动周期（秒）<input v-model.number="selectedWidget.content.speed" type="number" min="5" max="180" @change="recordProperty()" /></label>
                <label>事件条数<input v-model.number="selectedWidget.content.limit" type="number" min="1" max="200" @change="recordProperty()" /></label>
              </template>
              <div class="property-grid two">
                <label>X<input v-model.number="selectedWidget.frame.x" type="number" @change="recordProperty('修改位置')" /></label>
                <label>Y<input v-model.number="selectedWidget.frame.y" type="number" @change="recordProperty('修改位置')" /></label>
                <label>宽度<input v-model.number="selectedWidget.frame.width" type="number" min="20" @change="recordProperty('修改尺寸')" /></label>
                <label>高度<input v-model.number="selectedWidget.frame.height" type="number" min="20" @change="recordProperty('修改尺寸')" /></label>
                <label>旋转<input v-model.number="selectedWidget.frame.rotation" type="number" min="-360" max="360" @change="recordProperty()" /></label>
                <label>层级<input v-model.number="selectedWidget.zIndex" type="number" @change="recordProperty('修改层级')" /></label>
              </div>
              <div class="layer-actions"><button @click="moveLayer(selectedWidget,'top')">置顶</button><button @click="moveLayer(selectedWidget,'up')">上移</button><button @click="moveLayer(selectedWidget,'down')">下移</button><button @click="moveLayer(selectedWidget,'bottom')">置底</button></div>
            </section>

            <section v-else-if="inspectorTab === 'style'" class="inspector-section">
              <label>背景颜色<input v-model="selectedWidget.style.background" placeholder="rgba(...) 或 #RRGGBB" @change="recordProperty('修改样式')" /></label>
              <label>文字颜色<input v-model="selectedWidget.style.color" @change="recordProperty('修改样式')" /></label>
              <label v-if="['value','status'].includes(selectedWidget.type)">数值/开启颜色<input v-model="selectedWidget.style.valueColor" @change="recordProperty('修改样式')" /></label>
              <label>边框颜色<input v-model="selectedWidget.style.borderColor" @change="recordProperty('修改样式')" /></label>
              <div class="property-grid two">
                <label>圆角<input v-model.number="selectedWidget.style.borderRadius" type="number" min="0" max="80" @change="recordProperty('修改样式')" /></label>
                <label>字号<input v-model.number="selectedWidget.style.fontSize" type="number" min="10" max="120" @change="recordProperty('修改样式')" /></label>
                <label>透明度<input v-model.number="selectedWidget.style.opacity" type="number" min="0" max="1" step=".05" @change="recordProperty('修改样式')" /></label>
                <label>内边距<input v-model.number="selectedWidget.style.padding" type="number" min="0" max="100" @change="recordProperty('修改样式')" /></label>
              </div>
              <label>阴影<select v-model="selectedWidget.style.shadow" @change="recordProperty('修改样式')"><option value="none">无</option><option value="soft">柔和</option><option value="glow">发光</option><option value="strong">强调</option></select></label>
            </section>

            <section v-else-if="inspectorTab === 'data'" class="inspector-section">
              <div class="readonly-banner"><span>只读</span>所有外部数据源和 PLC 点位只用于展示，发布校验会拦截任何写入配置。</div>
              <label>数据来源<select v-model="selectedWidget.data.mode" @change="changeBindingMode"><option value="static">静态 / 组件默认数据</option><option value="runtime">系统运行指标</option><option value="plc">PLC 只读点位</option><option value="database">数据库连接</option></select></label>
              <template v-if="selectedWidget.data.mode === 'runtime'">
                <label>运行指标<select v-model="selectedWidget.data.path" @change="recordProperty('绑定运行指标')"><option value="">请选择</option><option v-for="item in runtimePaths" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
              </template>
              <template v-else-if="selectedWidget.data.mode === 'plc'">
                <label>设备<select v-model="selectedWidget.data.deviceId" @change="selectedWidget.data.pointId=''; recordProperty('选择设备')"><option value="">请选择设备</option><option v-for="device in devices" :key="device.id" :value="String(device.id)">{{ device.name }}（{{ device.id }}）</option></select></label>
                <label>READ 点位<select v-model="selectedWidget.data.pointId" :disabled="!selectedWidget.data.deviceId" @change="bindSelectedPoint"><option value="">请选择只读点位</option><option v-for="point in selectedDevicePoints" :key="point.id" :value="String(point.id)">{{ point.label || point.name }} · {{ point.plc_tag || `DB${point.db_number}.${point.db_byte_offset}` }}</option></select></label>
                <div class="binding-summary" v-if="selectedWidget.data.pointId"><span>路径</span><code>{{ selectedWidget.data.path }}</code><span>实时值</span><strong>{{ pointValues[selectedWidget.data.pointId]?.value ?? '--' }} {{ selectedWidget.data.unit }}</strong></div>
              </template>
              <template v-else-if="selectedWidget.data.mode === 'database'">
                <label>数据库连接<select v-model="selectedWidget.data.connectionId" @change="changeDatabaseConnection"><option value="">请选择连接</option><option v-for="source in dataSources" :key="source.id" :value="source.id">{{ source.name }} · {{ source.type }}</option></select></label>
                <label>数据表<select :value="databaseTableKey()" :disabled="!selectedWidget.data.connectionId || databaseMetadataLoading" @change="changeDatabaseTable($event.target.value)"><option value="">{{ databaseMetadataLoading ? '正在读取...' : '请选择表' }}</option><option v-for="table in databaseTables" :key="`${table.schema}.${table.name}`" :value="`${table.schema || ''}\u0001${table.name}`">{{ table.schema ? `${table.schema}.` : '' }}{{ table.name }}</option></select></label>
                <label v-if="selectedWidget.data.valueMode !== 'count'">显示字段<select v-model="selectedWidget.data.field" :disabled="!selectedWidget.data.table" @change="recordProperty('选择数据库字段'); previewDatabaseBinding()"><option value="">请选择字段</option><option v-for="column in databaseColumns" :key="column.name" :value="column.name">{{ column.name }} · {{ column.dataType }}</option></select></label>
                <label>读取方式<select v-model="selectedWidget.data.valueMode" @change="recordProperty('修改数据库读取方式'); previewDatabaseBinding()"><option value="latest">最新一条</option><option value="first">第一条</option><option value="list">列表 / 趋势序列</option><option value="count">记录数量</option><option value="sum">合计</option><option value="avg">平均值</option><option value="min">最小值</option><option value="max">最大值</option></select></label>
                <template v-if="['latest','first','list'].includes(selectedWidget.data.valueMode)">
                  <label>排序 / 时间字段<select v-model="selectedWidget.data.orderBy" @change="selectedWidget.data.timeField = selectedWidget.data.orderBy; recordProperty('修改数据库排序'); previewDatabaseBinding()"><option value="">不指定</option><option v-for="column in databaseColumns" :key="`order-${column.name}`" :value="column.name">{{ column.name }}</option></select></label>
                  <label>排序方向<select v-model="selectedWidget.data.orderDirection" @change="recordProperty('修改数据库排序'); previewDatabaseBinding()"><option value="desc">降序（新到旧）</option><option value="asc">升序（旧到新）</option></select></label>
                </template>
                <div class="property-grid two">
                  <label v-if="selectedWidget.data.valueMode === 'list'">读取行数<input v-model.number="selectedWidget.data.rowLimit" type="number" min="1" max="500" @change="recordProperty('修改读取行数'); previewDatabaseBinding()" /></label>
                  <label>刷新周期（秒）<input :value="Math.round(selectedWidget.data.refreshMs / 1000)" type="number" min="1" max="3600" @change="selectedWidget.data.refreshMs = Math.max(1000, Number($event.target.value || 5) * 1000); recordProperty('修改刷新周期')" /></label>
                </div>
                <button type="button" class="inspector-preview-button" :disabled="databaseMetadataLoading" @click="previewDatabaseBinding()">刷新数据预览</button>
                <div v-if="databasePreviewValues[selectedWidget.id]" class="binding-summary"><span>连接</span><code>{{ selectedDataSource?.name || selectedWidget.data.connectionId }}</code><span>预览值</span><strong>{{ databasePreviewValues[selectedWidget.id]?.value ?? '--' }} {{ selectedWidget.data.unit }}</strong><span>状态</span><strong>{{ databasePreviewValues[selectedWidget.id]?.error || '读取正常' }}</strong></div>
              </template>
              <div class="property-grid two">
                <label>单位<input v-model="selectedWidget.data.unit" @change="recordProperty('修改单位')" /></label>
                <label>小数位<input v-model.number="selectedWidget.data.decimals" type="number" min="0" max="8" @change="recordProperty('修改格式')" /></label>
              </div>
            </section>

            <section v-else-if="inspectorTab === 'condition'" class="inspector-section">
              <div class="section-action-heading"><div><strong>运行时显示范围</strong><small>跟随 Unity 当前工厂 / 车间 / 产线 / 设备视角</small></div></div>
              <div class="visibility-mode-grid">
                <label v-for="mode in [{id:'factory',label:'工厂'},{id:'workshop',label:'车间'},{id:'line',label:'产线'},{id:'device',label:'设备'}]" :key="mode.id" class="visibility-mode-option"><input type="checkbox" :checked="selectedWidget.visibility.viewModes.includes(mode.id)" @change="toggleViewMode(mode.id, $event.target.checked)" />{{ mode.label }}</label>
              </div>
              <p class="visibility-hint">未勾选任何视角表示始终可见；进入实时预览后可在顶部切换视角检查。</p>
              <label v-if="selectedWidget.data.deviceId" class="visibility-bound-device"><input v-model="selectedWidget.visibility.matchBoundDevice" type="checkbox" @change="recordProperty('修改设备上下文')" /> 仅当 Unity 正在查看该绑定设备时显示</label>

              <div class="section-action-heading"><div><strong>显隐规则</strong><small>可按当前对象或数据值决定组件出现 / 消失</small></div><button @click="addVisibilityRule">＋ 添加</button></div>
              <label v-if="selectedWidget.visibility.rules.length">多条规则<select v-model="selectedWidget.visibility.ruleMode" @change="recordProperty('修改显隐规则')"><option value="all">全部满足</option><option value="any">任意满足</option></select></label>
              <div v-for="(rule, index) in selectedWidget.visibility.rules" :key="`visible-${index}`" class="condition-card">
                <div class="property-grid two"><label>来源<select v-model="rule.source" @change="rule.path = rule.source === 'data' ? 'value' : 'viewMode'; recordProperty()"><option value="context">Unity 上下文</option><option value="data">组件数据值</option></select></label><label>字段<select v-if="rule.source === 'context'" v-model="rule.path" @change="recordProperty()"><option value="viewMode">当前视角</option><option value="workshopId">车间 ID</option><option value="lineId">产线 ID</option><option value="deviceId">设备 ID</option></select><input v-else v-model="rule.path" placeholder="value" @change="recordProperty()" /></label></div>
                <div class="property-grid two"><label>判断<select v-model="rule.operator" @change="recordProperty()"><option value="==">等于</option><option value="!=">不等于</option><option value=">">大于</option><option value=">=">大于等于</option><option value="<">小于</option><option value="<=">小于等于</option><option value="truthy">为真</option><option value="falsy">为假</option><option value="contains">包含</option></select></label><label>目标值<input v-model="rule.value" @change="recordProperty()" /></label></div>
                <button class="danger-link" @click="removeVisibilityRule(index)">删除显隐规则</button>
              </div>

              <div class="section-action-heading"><div><strong>条件样式</strong><small>按实时值切换颜色或闪烁</small></div><button @click="addCondition">＋ 添加</button></div>
              <div v-for="(condition, index) in selectedWidget.conditions" :key="index" class="condition-card">
                <div class="property-grid two"><label>判断<select v-model="condition.operator" @change="recordProperty()"><option value=">">大于</option><option value=">=">大于等于</option><option value="<">小于</option><option value="<=">小于等于</option><option value="==">等于</option><option value="!=">不等于</option><option value="truthy">为真</option><option value="falsy">为假</option></select></label><label>阈值<input v-model="condition.value" @change="recordProperty()" /></label></div>
                <label>文字颜色<input v-model="condition.color" @change="recordProperty()" /></label>
                <label>背景颜色<input v-model="condition.background" @change="recordProperty()" /></label>
                <label>效果<select v-model="condition.animation" @change="recordProperty()"><option value="none">无</option><option value="blink">闪烁</option><option value="pulse">脉冲</option></select></label>
                <button class="danger-link" @click="removeCondition(index)">删除条件</button>
              </div>
              <p v-if="!selectedWidget.conditions.length" class="empty-inspector">尚未添加条件。组件会一直使用普通样式。</p>
            </section>

            <section v-else-if="inspectorTab === 'animation'" class="inspector-section">
              <label>进入/循环动画<select v-model="selectedWidget.animation.type" @change="recordProperty('修改动画')"><option value="none">无动画</option><option value="fadeIn">淡入</option><option value="slideUp">上滑进入</option><option value="pulse">轻微脉冲</option><option value="breathe">呼吸光</option><option value="float">上下浮动</option><option value="blink">闪烁</option></select></label>
              <div class="property-grid two"><label>时长（秒）<input v-model.number="selectedWidget.animation.duration" type="number" min=".1" max="60" step=".1" @change="recordProperty('修改动画')" /></label><label>延迟（秒）<input v-model.number="selectedWidget.animation.delay" type="number" min="0" max="60" step=".1" @change="recordProperty('修改动画')" /></label></div>
              <label>循环<select v-model="selectedWidget.animation.iteration" @change="recordProperty('修改动画')"><option value="1">播放一次</option><option value="2">播放两次</option><option value="infinite">持续循环</option></select></label>
            </section>

            <section v-else class="inspector-section">
              <div class="section-action-heading"><div><strong>交互事件</strong><small>导航、语音、链接和组件 / 分组显隐；始终禁止数据写入</small></div><button @click="addEvent">＋ 添加</button></div>
              <div v-for="(event, index) in selectedWidget.events" :key="index" class="condition-card">
                <label>触发<select v-model="event.trigger" @change="recordProperty()"><option value="click">单击</option><option value="doubleClick">双击</option></select></label>
                <label>动作<select v-model="event.action" @change="recordProperty()"><option value="enter_device">进入设备</option><option value="focus_factory">返回工厂总览</option><option value="focus_line">聚焦产线</option><option value="focus_workshop">聚焦车间</option><option value="set_visibility">显示 / 隐藏目标</option><option value="toggle_visibility">切换目标显隐</option><option value="play_voice">播放语音</option><option value="open_link">打开链接</option><option value="switch_scene">切换场景</option></select></label>
                <label v-if="event.action === 'enter_device'">设备<select v-model="event.deviceId" @change="recordProperty()"><option value="">请选择</option><option v-for="device in devices" :key="device.id" :value="String(device.id)">{{ device.name }}</option></select></label>
                <label v-if="event.action === 'focus_line'">产线<select v-model="event.lineId" @change="recordProperty()"><option value="">当前设备所属产线</option><option v-for="line in lines" :key="line.id" :value="String(line.id)">{{ line.name }}</option></select></label>
                <label v-if="event.action === 'focus_workshop'">车间<select v-model="event.workshopId" @change="recordProperty()"><option value="">请选择</option><option v-for="workshop in workshops" :key="workshop.id" :value="String(workshop.id)">{{ workshop.name }}</option></select></label>
                <template v-if="['set_visibility','toggle_visibility'].includes(event.action)">
                  <label>目标类型<select v-model="event.targetType" @change="normalizeVisibilityEventTarget(event)"><option value="group">组件分组</option><option value="widget">单个组件</option></select></label>
                  <label v-if="event.targetType === 'group'">目标分组<select v-model="event.targetId" @change="recordProperty()"><option value="">请选择分组</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ group.label }} · {{ group.id }}</option></select></label>
                  <label v-else>目标组件<select v-model="event.targetId" @change="recordProperty()"><option value="">请选择组件</option><option v-for="item in eventWidgetOptions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
                  <label v-if="event.action === 'set_visibility'">目标状态<select v-model="event.visibility" @change="recordProperty()"><option value="show">显示</option><option value="hide">隐藏</option></select></label>
                </template>
                <label v-if="event.action === 'switch_scene'">场景 ID<input v-model="event.sceneId" @change="recordProperty()" /></label>
                <label v-if="event.action === 'play_voice'">语音文件<input v-model="event.audioUrl" placeholder="/uploads/audio/..." @change="recordProperty()" /></label>
                <label v-if="event.action === 'play_voice'">无文件时播报文字<textarea v-model="event.text" rows="2" @change="recordProperty()"></textarea></label>
                <label v-if="event.action === 'open_link'">链接地址<input v-model="event.url" placeholder="https://..." @change="recordProperty()" /></label>
                <button class="danger-link" @click="removeEvent(index)">删除事件</button>
              </div>
              <p v-if="!selectedWidget.events.length" class="empty-inspector">没有点击事件，组件只负责展示。</p>
            </section>
          </div>
        </template>

        <template v-else>
          <div class="designer-panel-heading"><strong>画布设置</strong><small>未选择组件</small></div>
          <div class="inspector-body inspector-section">
            <label>大屏名称<input v-model="documentModel.name" @change="commitHistory('修改大屏名称')" /></label>
            <div class="property-grid two"><label>宽度<input v-model.number="canvas.width" type="number" min="320" max="7680" @change="commitHistory('修改画布')" /></label><label>高度<input v-model.number="canvas.height" type="number" min="180" max="4320" @change="commitHistory('修改画布')" /></label></div>
            <div class="property-grid two"><label>吸附网格<input v-model.number="canvas.gridSize" type="number" min="1" max="200" @change="commitHistory('修改画布')" /></label><label>安全边距<input v-model.number="canvas.safeArea" type="number" min="0" max="400" @change="commitHistory('修改画布')" /></label></div>
            <label>背景<input v-model="canvas.background" @change="commitHistory('修改画布')" /></label>
            <label>主题色<input v-model="documentModel.theme.accentColor" @change="commitHistory('修改主题')" /></label>
          </div>
        </template>
      </aside>
    </div>

    <footer class="designer-statusbar">
      <span class="designer-status" :class="status.tone"><i></i>{{ status.text }}</span>
      <span>{{ documentModel.widgets.length }} 个组件 · {{ selectedIds.length }} 个已选</span>
      <span :class="{ dirty: isDirty }">{{ isDirty ? '有未保存修改' : '草稿已保存' }}</span>
      <div class="release-strip"><strong>发布记录</strong><button v-for="release in releases.slice(0, 5)" :key="release.id" type="button" :class="{ current: release.id === currentReleaseId }" @click="requestActivateRelease(release)">{{ release.version }}<small>{{ release.id === currentReleaseId ? '运行中' : '可恢复' }}</small></button></div>
    </footer>

    <Transition name="designer-dialog">
      <div v-if="publishDialogOpen" class="designer-dialog-backdrop" @click.self="publishDialogOpen = false">
        <form class="designer-dialog" @submit.prevent="publishVersion">
          <div class="dialog-icon publish">↑</div>
          <h3>发布大屏版本</h3>
          <p>发布后 Unity 和透明数据层只读取这一份快照。</p>
          <label>版本号（留空自动递增）<input v-model="publishForm.version" placeholder="例如 1.2.0" /></label>
          <label>发布说明<textarea v-model="publishForm.notes" rows="3" placeholder="本次调整内容"></textarea></label>
          <div><button type="button" @click="publishDialogOpen = false">取消</button><button class="primary" :disabled="publishing">{{ publishing ? '发布中...' : '确认发布' }}</button></div>
        </form>
      </div>
    </Transition>

    <Transition name="designer-dialog">
      <div v-if="releaseDialog" class="designer-dialog-backdrop" @click.self="releaseDialog = null">
        <div class="designer-dialog compact">
          <div class="dialog-icon restore">↶</div>
          <h3>恢复版本 {{ releaseDialog.version }}</h3>
          <p>现场运行画面会切换到该发布快照，当前草稿不会被覆盖。</p>
          <div><button type="button" @click="releaseDialog = null">取消</button><button class="primary" :disabled="publishing" @click="activateRelease">确认恢复</button></div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.dashboard-designer-shell { --panel:#0d1724; --panel2:#111f2f; --line:rgba(130,184,226,.16); --text:#eaf4ff; --muted:#8fa5ba; --accent:#42a5f5; display:flex; flex-direction:column; height:clamp(720px,calc(100vh - 150px),1080px); min-height:720px; overflow-x:auto; overflow-y:hidden; border:1px solid rgba(53,105,148,.26); border-radius:16px; color:var(--text); background:#08111c; box-shadow:0 22px 52px rgba(9,22,34,.18); scrollbar-color:#29445e #08111b; scrollbar-width:thin; font-family:"Microsoft YaHei UI","Segoe UI",sans-serif; }
.designer-toolbar { flex:0 0 58px; display:flex; align-items:center; gap:14px; min-width:1180px; padding:0 14px; border-bottom:1px solid var(--line); background:linear-gradient(180deg,#142335,#0d1927); }
.designer-brand { display:flex; align-items:center; gap:10px; width:224px; flex:0 0 224px; }
.designer-brand-mark { display:grid; place-items:center; width:34px; height:34px; border:1px solid rgba(87,190,255,.48); border-radius:10px; color:#8ddcff; background:linear-gradient(145deg,rgba(45,159,232,.24),rgba(23,67,105,.22)); box-shadow:inset 0 1px rgba(255,255,255,.08),0 0 24px rgba(66,165,245,.12); font-weight:800; }
.designer-brand strong,.designer-brand small { display:block; white-space:nowrap; }.designer-brand strong{font-size:13px}.designer-brand small{margin-top:2px;color:#7891a8;font-size:10px;letter-spacing:.04em}
.designer-toolbar-group,.designer-toolbar-actions,.canvas-tools { display:flex; align-items:center; gap:5px; }
.designer-toolbar button,.designer-toolbar select { height:32px; padding:0 10px; border:1px solid rgba(126,178,219,.18); border-radius:8px; color:#cfe2f1; background:rgba(12,28,43,.72); font-size:12px; cursor:pointer; transition:.15s ease; }
.designer-toolbar button:hover:not(:disabled),.designer-toolbar button.active { color:#fff; border-color:rgba(84,188,255,.46); background:rgba(43,123,181,.28); }.designer-toolbar button:disabled{opacity:.34;cursor:not-allowed}.designer-toolbar .zoom-label{min-width:58px}.toolbar-divider{width:1px;height:20px;margin:0 3px;background:var(--line)}
.canvas-tools { margin-left:auto; }.designer-toolbar-actions{margin-left:2px}.designer-toolbar .save-button{border-color:rgba(73,187,145,.28);color:#8ce6bf}.designer-toolbar .publish-button{border-color:rgba(66,165,245,.48);color:#fff;background:linear-gradient(135deg,#237abe,#155b91)}
.designer-main { flex:1; min-width:1180px; min-height:0; display:grid; grid-template-columns:236px minmax(680px,1fr) 310px; overflow:hidden; }
.designer-left-panel,.designer-right-panel { min-height:0; overflow:auto; background:linear-gradient(180deg,#0d1927,#0a1420); scrollbar-color:#29445e transparent; }.designer-left-panel{border-right:1px solid var(--line)}.designer-right-panel{border-left:1px solid var(--line)}
.designer-panel-heading,.selected-widget-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:54px; padding:10px 14px; border-bottom:1px solid var(--line); }.designer-panel-heading strong{font-size:13px}.designer-panel-heading small{color:var(--muted);font-size:10px}
.component-library{padding:10px}.component-library section+section{margin-top:13px}.component-library h4{margin:0 0 7px;color:#718aa1;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.component-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.component-grid button{display:grid;grid-template-columns:28px 1fr;grid-template-rows:auto auto;gap:1px 7px;align-items:center;min-height:56px;padding:8px;border:1px solid rgba(112,168,213,.15);border-radius:9px;text-align:left;color:#dbeaf6;background:rgba(20,38,56,.58);cursor:grab;transition:.15s}.component-grid button:hover{border-color:rgba(75,183,255,.48);transform:translateY(-1px);background:rgba(34,79,112,.46)}.component-grid button>span{grid-row:1/3;display:grid;place-items:center;width:28px;height:28px;border-radius:7px;color:#75cdfc;background:rgba(54,155,220,.14);font-weight:800}.component-grid strong{font-size:11px}.component-grid small{overflow:hidden;color:#6f879d;font-size:8px;white-space:nowrap;text-overflow:ellipsis}
.layer-heading{display:flex;justify-content:space-between;padding:10px 13px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:#a9c0d4;font-size:11px;cursor:pointer}.layer-heading span{color:#668198}.layer-list{padding:7px}.layer-list>button{display:grid;grid-template-columns:24px minmax(0,1fr) 20px 20px;align-items:center;width:100%;min-height:34px;padding:3px 6px;border:1px solid transparent;border-radius:7px;color:#b9cada;background:transparent;text-align:left;cursor:pointer}.layer-list>button:hover{background:rgba(50,88,119,.22)}.layer-list>button.active{border-color:rgba(66,165,245,.36);background:rgba(47,128,188,.24);color:#fff}.layer-list>button.hidden{opacity:.52}.layer-type{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;color:#75cdfc;background:#142a3d;font-size:10px;font-weight:800}.layer-name{overflow:hidden;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.layer-list i{font-style:normal;color:#7891a7;text-align:center}.layer-list p{padding:8px;color:#60788e;font-size:10px;text-align:center}.system-widget-list{margin:7px;border:1px solid var(--line);border-radius:8px;color:#8da5b9;font-size:10px}.system-widget-list summary{padding:8px;cursor:pointer}.system-widget-list div{display:grid;gap:2px;padding:7px 9px;border-top:1px solid var(--line)}.system-widget-list small{color:#5e758a}
.designer-canvas{position:relative;min-width:0;min-height:0;overflow:hidden;background:#050b12}.designer-canvas-scroll{position:absolute;inset:0;overflow:auto;padding:42px;scrollbar-color:#28445f #08111b;scrollbar-width:thin}.designer-canvas-spacer{position:relative;margin:auto}.designer-canvas-stage{position:absolute;left:0;top:0;overflow:hidden;transform-origin:0 0;box-shadow:0 0 0 1px rgba(110,185,235,.24),0 24px 90px rgba(0,0,0,.52);background-size:40px 40px!important}.designer-canvas-stage::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(118,174,216,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(118,174,216,.04) 1px,transparent 1px);background-size:var(--grid,10px) var(--grid,10px)}.canvas-safe-area{position:absolute;border:1px dashed rgba(83,194,255,.18);pointer-events:none}.alignment-guide{position:absolute;z-index:9998;background:#ff4dca;box-shadow:0 0 8px rgba(255,77,202,.65);pointer-events:none}.alignment-guide.vertical{top:0;bottom:0;width:1px}.alignment-guide.horizontal{left:0;right:0;height:1px}
.designer-widget{position:absolute;box-sizing:border-box;min-width:20px;min-height:20px;transform-origin:center;cursor:move;user-select:none}.designer-widget::after{content:"";position:absolute;inset:-2px;border:1px solid transparent;pointer-events:none}.designer-widget:hover::after{border-color:rgba(75,188,255,.34)}.designer-widget.selected::after{border:2px solid #43b9ff;box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 16px rgba(53,180,255,.26)}.designer-widget.locked{cursor:not-allowed}.designer-widget.hidden{filter:grayscale(.5)}.designer-widget.grouped.selected::after{border-style:dashed}.designer-widget :deep(.widget-shell){width:100%;height:100%}.widget-selection-label{position:absolute;left:-2px;bottom:calc(100% + 5px);max-width:100%;padding:3px 7px;border-radius:5px;color:#dff4ff;background:#1677ae;font-size:9px;white-space:nowrap;pointer-events:none}.resize-handle{position:absolute;z-index:10000;width:10px;height:10px;border:2px solid #dff6ff;border-radius:2px;background:#168dca;box-shadow:0 1px 4px rgba(0,0,0,.5)}.resize-handle.n{left:50%;top:-6px;cursor:ns-resize}.resize-handle.ne{right:-6px;top:-6px;cursor:nesw-resize}.resize-handle.e{right:-6px;top:50%;cursor:ew-resize}.resize-handle.se{right:-6px;bottom:-6px;cursor:nwse-resize}.resize-handle.s{left:50%;bottom:-6px;cursor:ns-resize}.resize-handle.sw{left:-6px;bottom:-6px;cursor:nesw-resize}.resize-handle.w{left:-6px;top:50%;cursor:ew-resize}.resize-handle.nw{left:-6px;top:-6px;cursor:nwse-resize}.empty-canvas-hint,.designer-loading{position:absolute;inset:0;display:grid;place-content:center;gap:8px;color:#718aa1;text-align:center}.empty-canvas-hint strong{color:#b9d4e8;font-size:24px}.empty-canvas-hint span{font-size:13px}.designer-loading{z-index:5;background:#07111b;font-size:13px}.designer-loading span{justify-self:center;width:28px;height:28px;border:3px solid rgba(91,181,240,.18);border-top-color:#57b8f0;border-radius:50%;animation:designerSpin .8s linear infinite}
.selected-widget-heading{align-items:flex-start}.selected-widget-heading div{min-width:0}.selected-widget-heading span,.selected-widget-heading strong,.selected-widget-heading small{display:block}.selected-widget-heading span{color:#6fbfec;font-size:9px;text-transform:uppercase}.selected-widget-heading strong{margin-top:2px;overflow:hidden;font-size:13px;white-space:nowrap;text-overflow:ellipsis}.selected-widget-heading small{margin-top:2px;color:#617b91;font-size:9px}.selected-widget-heading button{padding:5px 8px;border:1px solid var(--line);border-radius:6px;color:#99b3c8;background:#112235;font-size:9px;cursor:pointer}.inspector-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;padding:7px;border-bottom:1px solid var(--line)}.inspector-tabs button{height:28px;border:0;border-radius:6px;color:#7891a6;background:transparent;font-size:9px;cursor:pointer}.inspector-tabs button.active{color:#dff4ff;background:rgba(50,136,198,.28)}.inspector-body{padding:12px}.inspector-section{display:grid;gap:11px}.inspector-section label{display:grid;gap:5px;color:#8da4b8;font-size:10px}.inspector-section input,.inspector-section select,.inspector-section textarea{box-sizing:border-box;width:100%;min-height:32px;padding:6px 8px;border:1px solid rgba(119,170,210,.18);border-radius:7px;outline:none;color:#e5f1fa;background:#0c1b2a;font:11px/1.35 inherit}.inspector-section textarea{resize:vertical}.inspector-section input:focus,.inspector-section select:focus,.inspector-section textarea:focus{border-color:rgba(66,165,245,.62);box-shadow:0 0 0 2px rgba(66,165,245,.1)}.property-grid{display:grid;gap:8px}.property-grid.two{grid-template-columns:1fr 1fr}.layer-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.layer-actions button,.section-action-heading button{height:29px;border:1px solid var(--line);border-radius:6px;color:#9fc3dc;background:#102235;font-size:9px;cursor:pointer}.readonly-banner{padding:9px;border:1px solid rgba(69,209,158,.22);border-radius:8px;color:#8fc5b2;background:rgba(40,136,101,.1);font-size:9px;line-height:1.5}.readonly-banner span{display:inline-flex;margin-right:5px;padding:1px 5px;border-radius:4px;color:#b9ffe4;background:rgba(51,197,144,.18);font-weight:700}.binding-summary{display:grid;grid-template-columns:44px minmax(0,1fr);gap:5px 8px;padding:9px;border:1px solid var(--line);border-radius:8px;background:rgba(8,19,30,.54);font-size:9px}.binding-summary span{color:#718aa0}.binding-summary code{overflow:hidden;color:#8bcff7;text-overflow:ellipsis}.binding-summary strong{color:#fff}.section-action-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.section-action-heading strong,.section-action-heading small{display:block}.section-action-heading strong{font-size:11px}.section-action-heading small{margin-top:2px;color:#698198;font-size:8px}.condition-card{display:grid;gap:8px;padding:9px;border:1px solid var(--line);border-radius:9px;background:rgba(17,34,51,.55)}.danger-link{justify-self:end;border:0!important;color:#ff8c89!important;background:transparent!important;font-size:9px;cursor:pointer}.empty-inspector{padding:20px 8px;color:#657e93;font-size:10px;line-height:1.6;text-align:center}
.designer-statusbar{flex:0 0 42px;display:flex;align-items:center;gap:18px;min-width:1180px;padding:0 13px;border-top:1px solid var(--line);color:#6f899f;background:#0b1622;font-size:9px}.designer-status{display:flex;align-items:center;min-width:300px;color:#8fa9bd}.designer-status i{width:6px;height:6px;margin-right:6px;border-radius:50%;background:#5f7b91}.designer-status.success i{background:#48d79a;box-shadow:0 0 10px rgba(72,215,154,.5)}.designer-status.warning i{background:#ffc45f}.designer-status.danger i{background:#ff6864}.designer-statusbar .dirty{color:#ffc66e}.release-strip{display:flex;align-items:center;gap:5px;margin-left:auto}.release-strip strong{margin-right:3px;color:#7d96aa}.release-strip button{display:flex;align-items:center;gap:5px;height:27px;padding:0 7px;border:1px solid var(--line);border-radius:6px;color:#9bb3c7;background:#102031;font-size:9px;cursor:pointer}.release-strip button.current{border-color:rgba(68,211,156,.28);color:#9ee8c9}.release-strip small{color:#617b90;font-size:7px}
.designer-dialog-backdrop{position:fixed;inset:0;z-index:12000;display:grid;place-items:center;padding:20px;background:rgba(3,9,15,.68);backdrop-filter:blur(6px)}.designer-dialog{display:grid;gap:12px;width:min(430px,calc(100vw - 40px));padding:22px;border:1px solid rgba(89,171,227,.28);border-radius:16px;color:#eaf5ff;background:linear-gradient(155deg,#14283a,#0c1825);box-shadow:0 26px 90px rgba(0,0,0,.52)}.designer-dialog.compact{width:min(370px,calc(100vw - 40px));text-align:center}.dialog-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;color:#8bd8ff;background:rgba(66,165,245,.16);font-size:20px}.designer-dialog.compact .dialog-icon{justify-self:center}.designer-dialog h3,.designer-dialog p{margin:0}.designer-dialog h3{font-size:17px}.designer-dialog p{color:#8fa8bc;font-size:11px;line-height:1.6}.designer-dialog label{display:grid;gap:6px;color:#9bb2c5;font-size:10px;text-align:left}.designer-dialog input,.designer-dialog textarea{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid rgba(112,172,216,.22);border-radius:8px;color:#eef8ff;background:#091522;outline:none}.designer-dialog textarea{resize:vertical}.designer-dialog>div:last-child{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}.designer-dialog button{min-width:76px;height:32px;border:1px solid var(--line);border-radius:8px;color:#acc3d5;background:#102235;cursor:pointer}.designer-dialog button.primary{border-color:#2c87c9;color:#fff;background:linear-gradient(135deg,#278bd1,#176298)}.designer-dialog-enter-active,.designer-dialog-leave-active{transition:.16s ease}.designer-dialog-enter-from,.designer-dialog-leave-to{opacity:0}.designer-dialog-enter-from .designer-dialog,.designer-dialog-leave-to .designer-dialog{transform:translateY(8px) scale(.98)}
.is-preview .designer-left-panel,.is-preview .designer-right-panel{opacity:.42;pointer-events:none}.is-preview .designer-widget{cursor:default}.is-preview .canvas-safe-area{display:none}
@keyframes designerSpin{to{transform:rotate(360deg)}}
@media(max-width:1400px){.designer-main{grid-template-columns:210px minmax(620px,1fr) 280px}.designer-brand{width:190px;flex-basis:190px}.designer-toolbar{gap:8px}.designer-toolbar button{padding:0 7px}}

/* 与后台管理统一的黑白简约工作台；画布本身仍保持实际发布主题。 */
.dashboard-designer-shell{--panel:#fff;--panel2:#f5f5f7;--line:#dedee3;--text:#1d1d1f;--muted:#6e6e73;--accent:#1d1d1f;height:clamp(820px,calc(100vh - 112px),1120px);min-height:820px;border-color:#d7d7dc;color:#1d1d1f;background:#f0f0f2;box-shadow:0 18px 48px rgba(0,0,0,.08);scrollbar-color:#b8b8bd #ececef;font-size:13px}
.designer-main{grid-template-columns:246px minmax(680px,1fr) 330px}
.designer-toolbar{flex-basis:62px;border-bottom-color:#dedee3;background:rgba(255,255,255,.94);box-shadow:0 1px 0 rgba(0,0,0,.035);backdrop-filter:blur(18px)}
.designer-brand-mark{border-color:#1d1d1f;color:#fff;background:#1d1d1f;box-shadow:none}.designer-brand strong{color:#1d1d1f;font-size:14px}.designer-brand small{color:#8e8e93;font-size:11px}
.designer-toolbar button,.designer-toolbar select{border-color:#d8d8dd;color:#3a3a3c;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.035);font-size:13px}
.designer-toolbar button:hover:not(:disabled),.designer-toolbar button.active{color:#000;border-color:#8e8e93;background:#f2f2f4}.designer-toolbar .save-button{border-color:#b7d8c4;color:#176b3a;background:#f5fbf7}.designer-toolbar .publish-button{border-color:#1d1d1f;color:#fff;background:#1d1d1f}.toolbar-divider{background:#dedee3}
.designer-left-panel,.designer-right-panel{background:#fff;scrollbar-color:#c5c5ca transparent}.designer-left-panel{border-right-color:#dedee3}.designer-right-panel{border-left-color:#dedee3}
.designer-panel-heading,.layer-heading,.selected-widget-heading,.inspector-tabs{border-color:#e5e5e7;background:#fff}.designer-panel-heading strong,.layer-heading strong,.selected-widget-heading strong{color:#1d1d1f}.designer-panel-heading strong{font-size:14px}.designer-panel-heading small,.layer-heading span,.selected-widget-heading span,.selected-widget-heading small{color:#8e8e93;font-size:11px}
.component-library section h4{color:#8e8e93;font-size:11px}.component-grid button{min-height:62px;border-color:#e2e2e5;color:#1d1d1f;background:#f8f8fa}.component-grid button:hover{border-color:#8e8e93;background:#fff;box-shadow:0 7px 20px rgba(0,0,0,.07)}.component-grid button>span{color:#fff;background:#1d1d1f}.component-grid strong{font-size:12px}.component-grid button small{color:#8e8e93;font-size:10px}
.layer-heading{font-size:12px}.layer-list>button{min-height:38px}.layer-list button{color:#515154;background:transparent}.layer-list button:hover{background:#f5f5f7}.layer-list button.active{color:#1d1d1f;background:#ededf0;border-color:#d7d7dc}.layer-type{color:#fff;background:#3a3a3c;font-size:11px}.layer-name{font-size:12px}.layer-list i{color:#6e6e73}.system-widget-list{border-color:#e5e5e7;color:#515154;background:#f8f8fa;font-size:11px}.system-widget-list summary{color:#515154}.system-widget-list small{color:#8e8e93;font-size:10px}
.designer-canvas{background:#e9e9ec}.designer-canvas-scroll{box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:28px;scrollbar-color:#a9a9af #e1e1e4}.designer-canvas-spacer{position:relative;flex:0 0 auto;margin:0 auto;box-shadow:0 18px 46px rgba(0,0,0,.18)}.designer-canvas-stage{transform-origin:top left;border:1px solid rgba(0,0,0,.36)}
.selected-widget-heading strong{font-size:14px}.selected-widget-heading button,.layer-actions button,.section-action-heading button{border-color:#d8d8dd;color:#3a3a3c;background:#fff;font-size:11px}.inspector-tabs button{height:34px;color:#8e8e93;font-size:12px}.inspector-tabs button.active{color:#fff;background:#1d1d1f}
.inspector-body{background:#fff}.inspector-section label{color:#515154;font-size:12px}.inspector-section input,.inspector-section select,.inspector-section textarea{min-height:36px;border-color:#d8d8dd;color:#1d1d1f;background:#fff;font-size:13px}.inspector-section input:focus,.inspector-section select:focus,.inspector-section textarea:focus{border-color:#86868b;box-shadow:0 0 0 3px rgba(0,0,0,.06)}
.readonly-banner{border-color:#d8eadf;color:#176b3a;background:#f3faf6;font-size:11px}.readonly-banner span{color:#176b3a;background:#e1f3e8}.binding-summary{border-color:#e2e2e5;background:#f7f7f8;font-size:11px}.binding-summary span{color:#8e8e93}.binding-summary code{color:#1d1d1f}.binding-summary strong{color:#1d1d1f}.condition-card{border-color:#e2e2e5;background:#f8f8fa}.section-action-heading strong{color:#1d1d1f;font-size:12px}.section-action-heading small,.empty-inspector{color:#8e8e93;font-size:10px}.danger-link{color:#b42318!important;font-size:11px}
.visibility-mode-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.visibility-mode-option{display:flex!important;grid-auto-flow:column;align-items:center;justify-content:center;gap:5px!important;min-height:36px;border:1px solid #dedee3;border-radius:8px;background:#f8f8fa;cursor:pointer}.visibility-mode-option input{width:auto!important;min-height:auto!important;padding:0!important;accent-color:#1d1d1f}.visibility-hint{margin:-3px 0 3px;color:#8e8e93;font-size:11px;line-height:1.5}.visibility-bound-device{display:flex!important;grid-auto-flow:column;align-items:center;justify-content:start;gap:7px!important;padding:9px;border:1px solid #e2e2e5;border-radius:8px;background:#f8f8fa}.visibility-bound-device input{width:auto!important;min-height:auto!important;accent-color:#1d1d1f}.inspector-preview-button{height:36px;border:1px solid #1d1d1f;border-radius:8px;color:#fff;background:#1d1d1f;font-size:12px;cursor:pointer}
.designer-statusbar{flex-basis:46px;border-top-color:#dedee3;color:#6e6e73;background:#fff;font-size:11px}.designer-status{color:#515154}.release-strip strong{color:#6e6e73}.release-strip button{border-color:#dedee3;color:#515154;background:#f8f8fa;font-size:11px}.release-strip button.current{border-color:#9bc9ad;color:#176b3a;background:#f3faf6}.release-strip small{font-size:9px}
.designer-dialog-backdrop{background:rgba(0,0,0,.34)}.designer-dialog{border-color:#dedee3;color:#1d1d1f;background:#fff;box-shadow:0 28px 90px rgba(0,0,0,.24)}.dialog-icon{color:#fff;background:#1d1d1f}.designer-dialog p,.designer-dialog label{color:#6e6e73}.designer-dialog input,.designer-dialog textarea{border-color:#d8d8dd;color:#1d1d1f;background:#fff}.designer-dialog button{border-color:#d8d8dd;color:#3a3a3c;background:#f7f7f8}.designer-dialog button.primary{border-color:#1d1d1f;color:#fff;background:#1d1d1f}
.designer-loading{color:#515154;background:#f2f2f4}.designer-loading span{border-color:#d0d0d5;border-top-color:#1d1d1f}
.is-preview .designer-left-panel,.is-preview .designer-right-panel{opacity:.56}
@media(max-width:1500px){.dashboard-designer-shell{min-height:780px}.designer-main{grid-template-columns:226px minmax(660px,1fr) 310px}.external-data-source-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
