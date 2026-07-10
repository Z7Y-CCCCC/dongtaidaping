function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function getByPath(source, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => current?.[key], source)
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

function firstByPath(source, path, fallbackPaths = []) {
  const paths = [path, ...(Array.isArray(fallbackPaths) ? fallbackPaths : [])].filter(Boolean)
  for (const item of paths) {
    const value = getByPath(source, item)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function valueOrDash(value, fallback = '--') {
  return value === undefined || value === null || value === '' ? fallback : value
}

function applyValueMap(value, valueMap) {
  if (!isPlainObject(valueMap)) return undefined
  const key = String(value)
  if (Object.prototype.hasOwnProperty.call(valueMap, key)) return valueMap[key]
  if (typeof value === 'boolean') {
    const boolKey = value ? 'true' : 'false'
    if (Object.prototype.hasOwnProperty.call(valueMap, boolKey)) return valueMap[boolKey]
  }
  return undefined
}

export function formatConfiguredValue(row = {}, data = {}) {
  if (row.alarmPath && getByPath(data, row.alarmPath)) {
    return row.alarmText ?? '报警'
  }

  const raw = firstByPath(data, row.path, row.fallbackPaths)
  const mapped = applyValueMap(raw, row.valueMap)
  if (mapped !== undefined) return mapped

  if (typeof raw === 'boolean') {
    return raw ? (row.truthyText ?? '是') : (row.falsyText ?? '否')
  }
  return valueOrDash(raw, row.fallback ?? '--')
}

export function formatConfiguredUnit(row = {}, data = {}) {
  if (row.unitPath) {
    const raw = firstByPath(data, row.unitPath, row.unitFallbackPaths)
    const text = valueOrDash(raw, row.unitFallback ?? '--')
    return `${text}${row.unitSuffix ?? ''}`
  }
  return row.unit ?? ''
}

function normalizeRows(rows, fallbackRows = []) {
  const sourceRows = Array.isArray(rows) && rows.length ? rows : fallbackRows
  return sourceRows
    .filter(row => row && row.visible !== false)
    .map((row, index) => ({
      key: String(row.key || row.path || row.label || `row_${index}`),
      label: String(row.label || row.key || `指标${index + 1}`),
      path: row.path || '',
      fallbackPaths: Array.isArray(row.fallbackPaths) ? row.fallbackPaths : [],
      unit: row.unit ?? '',
      unitPath: row.unitPath || '',
      unitFallbackPaths: Array.isArray(row.unitFallbackPaths) ? row.unitFallbackPaths : [],
      unitSuffix: row.unitSuffix ?? '',
      truthyText: row.truthyText,
      falsyText: row.falsyText,
      alarmPath: row.alarmPath || '',
      alarmText: row.alarmText,
      valueMap: isPlainObject(row.valueMap) ? row.valueMap : undefined,
      qualityPath: row.qualityPath || '',
      fallback: row.fallback ?? '--',
      unitFallback: row.unitFallback ?? '--'
    }))
}

export const DEFAULT_DEVICE_LABEL_CONFIG = {
  enabled: true,
  showTitle: true,
  titleTemplate: '{name}',
  style: {
    minWidth: '132px',
    padding: '8px 10px',
    fontSize: '12px',
    background: 'rgba(18, 22, 24, .84)',
    borderColor: 'rgba(242, 184, 91, .35)',
    titleColor: '#f2b85b',
    textColor: '#d7dedb',
    valueColor: '#ffffff'
  },
  rows: [
    { key: 'temperature', label: '温度', path: 'analog.actual_temp', fallbackPaths: ['analog.rear_temp'], unit: '°C' },
    { key: 'carbon', label: '碳势', path: 'analog.actual_carbon', fallbackPaths: ['analog.carbon'], unit: '%' }
  ],
  transferCartRows: [
    { key: 'speed', label: '速度', path: 'analog.cart_speed', fallbackPaths: ['analog.speed', 'motors.cart_speed', 'motors.speed'] },
    { key: 'state', label: '状态', path: 'status.running', truthyText: '运行', falsyText: '待机', alarmPath: 'status.alarm', alarmText: '报警' }
  ]
}

function defaultGasRows(start, end) {
  const rows = []
  for (let i = start; i <= end; i += 1) {
    rows.push({
      key: `gas_valve_${i}`,
      label: `阀${i}`,
      path: `gas.valve_${i}_on`,
      truthyText: '开',
      falsyText: '关',
      unitPath: `gas.valve_${i}_flow`,
      unitSuffix: ' Nm³/h',
      unitFallback: '--',
      qualityPath: `quality.gas.valve_${i}_flow`
    })
  }
  return rows
}

export const DEFAULT_DIAGNOSTIC_CONFIG = {
  groups: [
    {
      key: 'temperature',
      title: '温度监控',
      rows: [
        { key: 'actual_temp', label: '实际', path: 'analog.actual_temp', unit: '°C', qualityPath: 'quality.analog.actual_temp' },
        { key: 'setpoint_temp', label: '设定', path: 'analog.setpoint_temp', unit: '°C', qualityPath: 'quality.analog.setpoint_temp' }
      ]
    },
    {
      key: 'carbon',
      title: '碳势监控',
      rows: [
        { key: 'actual_carbon', label: '实际', path: 'analog.actual_carbon', unit: '%', qualityPath: 'quality.analog.actual_carbon' },
        { key: 'setpoint_carbon', label: '设定', path: 'analog.setpoint_carbon', unit: '%', qualityPath: 'quality.analog.setpoint_carbon' }
      ]
    },
    {
      key: 'fans',
      title: '循环风扇',
      rows: [
        { key: 'rear_fan', label: '后室', path: 'motors.rear_fan', fallbackPaths: ['motors.fan_motor'], truthyText: '运行', falsyText: '停止', unitPath: 'motors.rear_fan_speed', unitSuffix: ' rpm', qualityPath: 'quality.motors.rear_fan' },
        { key: 'front_fan', label: '前室', path: 'motors.front_fan', fallbackPaths: ['motors.fan_motor'], truthyText: '运行', falsyText: '停止', unitPath: 'motors.front_fan_speed', unitSuffix: ' rpm', qualityPath: 'quality.motors.front_fan' }
      ]
    },
    {
      key: 'oil_stir',
      title: '油槽搅拌',
      rows: [1, 2, 3, 4].map(index => ({
        key: `oil_stir_${index}`,
        label: `搅拌${index}`,
        path: `motors.oil_stir_${index}`,
        fallbackPaths: ['motors.stir_motor'],
        truthyText: '运行',
        falsyText: '停止',
        unitPath: `motors.oil_stir_${index}_speed`,
        unitSuffix: ' rpm',
        qualityPath: `quality.motors.oil_stir_${index}`
      }))
    },
    { key: 'gas_1', title: '气体阀组', rows: defaultGasRows(1, 5) },
    { key: 'gas_2', title: '气体阀组 2', rows: defaultGasRows(6, 10) },
    {
      key: 'doors',
      title: '门与机构',
      rows: [
        { key: 'front_door_open', label: '前门', path: 'doors.front_door_open', truthyText: '已开启', falsyText: '关闭中', qualityPath: 'quality.doors.front_door_open' },
        { key: 'middle_door_open', label: '中门', path: 'doors.middle_door_open', truthyText: '已开启', falsyText: '关闭中', qualityPath: 'quality.doors.middle_door_open' },
        { key: 'push_chain_forward', label: '推链', path: 'mechanisms.push_chain_forward', truthyText: '向前推入', falsyText: '默认位置', qualityPath: 'quality.mechanisms.push_chain_forward' }
      ]
    },
    {
      key: 'status',
      title: '设备状态',
      rows: [
        { key: 'running', label: '运行', path: 'status.running', truthyText: '运行', falsyText: '停止', qualityPath: 'quality.status.running' },
        { key: 'alarm', label: '报警', path: 'status.alarm', truthyText: '报警', falsyText: '正常', qualityPath: 'quality.status.alarm' }
      ]
    }
  ]
}

export const DEFAULT_LINE_OVERVIEW_CONFIG = {
  showTemperature: true,
  showCarbon: true,
  temperatureUnit: '°C',
  carbonUnit: '%',
  maxCards: 0
}

export function normalizeDeviceLabelConfig(config = {}) {
  const style = {
    ...(DEFAULT_DEVICE_LABEL_CONFIG.style || {}),
    ...(isPlainObject(config.style) ? config.style : {})
  }
  return {
    enabled: config.enabled !== false,
    showTitle: config.showTitle !== false,
    titleTemplate: config.titleTemplate ?? config.title ?? DEFAULT_DEVICE_LABEL_CONFIG.titleTemplate,
    style,
    rows: normalizeRows(config.rows, DEFAULT_DEVICE_LABEL_CONFIG.rows),
    transferCartRows: normalizeRows(config.transferCartRows, DEFAULT_DEVICE_LABEL_CONFIG.transferCartRows)
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTemplate(template, data = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => data[key] ?? '')
}

export function applyDeviceLabelStyle(element, config = {}) {
  if (!element) return
  const normalized = normalizeDeviceLabelConfig(config)
  const style = normalized.style || {}
  element.style.minWidth = style.minWidth || ''
  element.style.padding = style.padding || ''
  element.style.fontSize = style.fontSize || ''
  element.style.background = style.background || ''
  element.style.borderColor = style.borderColor || ''
  element.style.setProperty('--device-label-title-color', style.titleColor || DEFAULT_DEVICE_LABEL_CONFIG.style.titleColor)
  element.style.setProperty('--device-label-text-color', style.textColor || DEFAULT_DEVICE_LABEL_CONFIG.style.textColor)
  element.style.setProperty('--device-label-value-color', style.valueColor || DEFAULT_DEVICE_LABEL_CONFIG.style.valueColor)
}

export function buildDeviceLabelRows(data = {}, config = {}, options = {}) {
  const normalized = normalizeDeviceLabelConfig(config)
  const rows = options.isTransferCart ? normalized.transferCartRows : normalized.rows
  return rows.map(row => ({
    ...row,
    value: formatConfiguredValue(row, data),
    unit: formatConfiguredUnit(row, data)
  }))
}

export function buildDeviceLabelMarkup(title, config = {}, options = {}) {
  const normalized = normalizeDeviceLabelConfig(config)
  if (normalized.enabled === false) return ''
  const rows = buildDeviceLabelRows({}, normalized, options)
  const safeTitle = normalized.showTitle
    ? escapeHtml(formatTemplate(normalized.titleTemplate || '{name}', {
      name: title || '设备',
      id: options.deviceId || ''
    }) || title || '设备')
    : ''
  return `
    ${safeTitle ? `<div class="header">${safeTitle}</div>` : ''}
    ${rows.map(row => `<div class="data-row">${escapeHtml(row.label)}: <span data-label-row="${escapeHtml(row.key)}">--</span><span data-label-unit="${escapeHtml(row.key)}">${row.unit ? ` ${escapeHtml(row.unit)}` : ''}</span></div>`).join('')}
  `
}

export function updateDeviceLabelElements(elements = new Map(), data = {}, config = {}, options = {}, lastValues = new Map()) {
  if (normalizeDeviceLabelConfig(config).enabled === false) return
  buildDeviceLabelRows(data, config, options).forEach((row) => {
    const refs = elements.get(row.key)
    if (!refs) return
    const cacheKey = `${row.key}:${row.value}:${row.unit}`
    if (lastValues.get(row.key) === cacheKey) return
    refs.valueEl.innerText = row.value
    if (refs.unitEl) refs.unitEl.textContent = row.unit ? ` ${row.unit}` : ''
    else if (refs.unitText) refs.unitText.nodeValue = row.unit ? ` ${row.unit}` : ''
    lastValues.set(row.key, cacheKey)
  })
}

export function normalizeDiagnosticConfig(config = {}) {
  const sourceGroups = Array.isArray(config.groups) && config.groups.length
    ? config.groups
    : DEFAULT_DIAGNOSTIC_CONFIG.groups
  const fallbackByKey = new Map(DEFAULT_DIAGNOSTIC_CONFIG.groups.map(group => [group.key, group]))

  return {
    groups: sourceGroups
      .filter(group => group && group.visible !== false)
      .map((group, index) => {
        const fallback = fallbackByKey.get(group.key) || DEFAULT_DIAGNOSTIC_CONFIG.groups[index] || {}
        return {
          key: String(group.key || fallback.key || group.title || `group_${index}`),
          title: String(group.title || fallback.title || `诊断组${index + 1}`),
          rows: normalizeRows(group.rows, fallback.rows || [])
        }
      })
  }
}

export function buildDiagnosticGroups(data = {}, config = {}) {
  return normalizeDiagnosticConfig(config).groups.map(group => ({
    title: group.title,
    rows: group.rows.map(row => ({
      label: row.label,
      value: formatConfiguredValue(row, data),
      unit: formatConfiguredUnit(row, data),
      quality: row.qualityPath ? getByPath(data, row.qualityPath) : undefined
    }))
  }))
}
