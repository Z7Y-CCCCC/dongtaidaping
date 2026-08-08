export const PLC_PROTOCOL_OPTIONS = Object.freeze([
    {
        value: 'S7',
        label: '西门子 S7',
        defaultPort: 102,
        addressPlaceholder: 'DB1.DBW0 / DB1.DBX6.0',
        addressHint: '支持 DB、I、Q、M 地址，例如 DB1.DBW0、DB1.DBD4、DB1.DBX6.0。',
        defaultOptions: {}
    },
    {
        value: 'MODBUS_TCP',
        label: 'Modbus TCP',
        defaultPort: 502,
        addressPlaceholder: 'HR40001 / IR30001 / C00001',
        addressHint: 'HR=保持寄存器，IR=输入寄存器，C=线圈，DI=离散输入；例如 HR40001、HR40003.2、IR30001。',
        defaultOptions: { unitId: 1, addressBase: 1, byteOrder: 'BE', wordOrder: 'BE', stringLength: 16 }
    },
    {
        value: 'OPC_UA',
        label: 'OPC UA',
        defaultPort: 4840,
        addressPlaceholder: 'ns=2;s=Channel1.Device1.Tag1',
        addressHint: '填写 OPC UA NodeId，例如 ns=2;s=Channel1.Device1.Tag1 或 ns=3;i=1001。',
        defaultOptions: {
            endpointPath: '',
            securityMode: 'None',
            securityPolicy: 'None',
            username: '',
            password: '',
            trustServerCertificate: false
        }
    }
])

export const PLC_PROTOCOL_MAP = Object.freeze(Object.fromEntries(PLC_PROTOCOL_OPTIONS.map(item => [item.value, item])))

export function normalizePlcProtocol(value) {
    const raw = String(value || 'S7').trim().toUpperCase().replace(/\s+/g, '_')
    if (['SIEMENS', 'SIEMENS_S7'].includes(raw)) return 'S7'
    if (['MODBUS', 'MODBUS-TCP', 'MODBUSTCP'].includes(raw)) return 'MODBUS_TCP'
    if (['OPC-UA', 'OPCUA'].includes(raw)) return 'OPC_UA'
    return raw
}

export function getPlcProtocolDefinition(value) {
    return PLC_PROTOCOL_MAP[normalizePlcProtocol(value)] || PLC_PROTOCOL_MAP.S7
}

export function normalizePlcOptions(protocolValue, value = {}) {
    const protocol = normalizePlcProtocol(protocolValue)
    const defaults = getPlcProtocolDefinition(protocol).defaultOptions || {}
    let source = value
    if (typeof source === 'string') {
        try { source = JSON.parse(source) } catch (error) { source = {} }
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) source = {}
    if (protocol === 'MODBUS_TCP') {
        return {
            ...defaults,
            ...source,
            unitId: Math.max(1, Math.min(247, Math.round(Number(source.unitId ?? defaults.unitId)))),
            addressBase: Number(source.addressBase) === 0 ? 0 : 1,
            byteOrder: String(source.byteOrder || defaults.byteOrder).toUpperCase() === 'LE' ? 'LE' : 'BE',
            wordOrder: String(source.wordOrder || defaults.wordOrder).toUpperCase() === 'LE' ? 'LE' : 'BE',
            stringLength: Math.max(1, Math.min(240, Math.round(Number(source.stringLength ?? defaults.stringLength))))
        }
    }
    if (protocol === 'OPC_UA') {
        const securityMode = ['None', 'Sign', 'SignAndEncrypt'].includes(source.securityMode) ? source.securityMode : 'None'
        const policies = ['None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss']
        return {
            ...defaults,
            ...source,
            endpointPath: String(source.endpointPath || '').trim().replace(/^([^/])/, '/$1'),
            securityMode,
            securityPolicy: securityMode === 'None'
                ? 'None'
                : (policies.includes(source.securityPolicy) && source.securityPolicy !== 'None' ? source.securityPolicy : 'Basic256Sha256'),
            username: String(source.username || '').trim(),
            password: String(source.password || ''),
            trustServerCertificate: Boolean(source.trustServerCertificate)
        }
    }
    return {}
}

export function getPlcAddressHint(protocolValue) {
    return getPlcProtocolDefinition(protocolValue).addressHint
}

export function getPlcAddressPlaceholder(protocolValue) {
    return getPlcProtocolDefinition(protocolValue).addressPlaceholder
}

function parseModbusAddress(address, dataType, optionsValue = {}) {
    const options = normalizePlcOptions('MODBUS_TCP', optionsValue)
    let compact = String(address || '').trim().toUpperCase().replace(/\s+/g, '')
    if (!compact) return { error: 'Modbus 地址不能为空' }
    let bit = null
    const bitMatch = compact.match(/^(.*)\.(\d{1,2})$/)
    if (bitMatch) {
        compact = bitMatch[1]
        bit = Number(bitMatch[2])
        if (bit > 15) return { error: 'Modbus 寄存器位号必须在 0-15 之间' }
    }
    const tokenMatch = compact.match(/^(HR|HOLDING|4X|IR|INPUT|3X|DI|DISCRETE|1X|C|COIL|0X)[:@]?(\d+)$/)
    let area
    let addressNumber
    if (tokenMatch) {
        const token = tokenMatch[1]
        const reference = Number(tokenMatch[2])
        area = ['HR', 'HOLDING', '4X'].includes(token) ? 'holding'
            : ['IR', 'INPUT', '3X'].includes(token) ? 'input'
                : ['DI', 'DISCRETE', '1X'].includes(token) ? 'discrete' : 'coil'
        const standardBase = area === 'holding' && reference >= 40001 ? 40001
            : area === 'input' && reference >= 30001 ? 30001
                : area === 'discrete' && reference >= 10001 ? 10001
                    : area === 'coil' && reference >= 1 && token === '0X' ? 1 : null
        addressNumber = standardBase === null ? reference - options.addressBase : reference - standardBase
    } else if (/^\d+$/.test(compact)) {
        const reference = Number(compact)
        if (reference >= 40001 && reference <= 49999) { area = 'holding'; addressNumber = reference - 40001 }
        else if (reference >= 30001 && reference <= 39999) { area = 'input'; addressNumber = reference - 30001 }
        else if (reference >= 10001 && reference <= 19999) { area = 'discrete'; addressNumber = reference - 10001 }
        else { area = 'coil'; addressNumber = reference - options.addressBase }
    } else return { error: 'Modbus 地址格式不正确' }
    if (addressNumber < 0 || addressNumber > 65535) return { error: 'Modbus 地址超出 0-65535 范围' }
    if (bit !== null && ['coil', 'discrete'].includes(area)) return { error: '线圈和离散输入不需要填写 .位号' }
    return { area, address: addressNumber, bit, dataType }
}

export function validatePlcAddress(protocolValue, address, dataType, options = {}) {
    const protocol = normalizePlcProtocol(protocolValue)
    const raw = String(address || '').trim()
    if (!raw) return '必须填写 PLC 地址'
    if (protocol === 'MODBUS_TCP') return parseModbusAddress(raw, dataType, options).error || ''
    if (protocol === 'OPC_UA') {
        return /^(?:(?:ns=\d+|nsu=[^;]+);)?[isgb]=.+$/i.test(raw)
            ? ''
            : 'OPC UA NodeId 格式不正确，例如 ns=2;s=Channel1.Device1.Tag1'
    }
    const compact = raw.replace(/\s+/g, '').toUpperCase()
    return compact.includes(',') || /^(?:DB\d+\.(?:DBX|DBB|DBW|DBD)\d+(?:\.\d+)?|[IQM](?:X|B|W|D)?\d+(?:\.\d+)?)$/i.test(compact)
        ? ''
        : 'S7 地址格式不正确，例如 DB1.DBW0 或 DB1.DBX0.0'
}
