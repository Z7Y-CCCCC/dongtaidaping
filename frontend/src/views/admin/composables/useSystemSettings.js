// 系统设置模块:连接设置、渲染档位、桌面运行/局域网投屏、引擎与 PLC 状态、数据库连接、数据库备份与整站灾备。
// loadSettings 是本模块的加载编排中心(顺带拉取运行配置、数据库配置与引擎状态)。
// 数据库/灾备的恢复与切换需要重载全站数据,这些跨模块的 load 函数通过参数惰性注入。

import { ref, reactive, computed, watch, nextTick } from 'vue'
import QRCode from 'qrcode'
import { adminApi } from '../../../config/factoryConfig.js'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { RENDER_PROFILE_OPTIONS, normalizeRenderSettings } from '../../../runtime/renderConfig.js'

export function useSystemSettings({
    alert,
    confirm,
    loadWorkshops,
    loadLines,
    loadDevices,
    loadModels,
    loadPlatform,
    ensureComposerSelection,
    syncComposerDraftFromSelection,
    scheduleComposerPreview
}) {
    // ============ 连接设置 ============
    const defaultSettings = {
        factory_name: '',
        data_mode: 'integrated_plc',
        realtime_stale_ms: '6000',
        display_mode: 'industrial_twin',
        // 视角模式
        camera_mode: 'auto',
        native_quality_profile: 'auto',
        render_profile: 'balanced',
        render_target_fps: 45,
        render_scale: 1,
        render_antialias: false,
        render_label_fps: 12
    }
    const settings = reactive({ ...defaultSettings })

    const renderProfileOptions = RENDER_PROFILE_OPTIONS
    const resolvedRenderSettings = computed(() => normalizeRenderSettings(settings))
    const selectedRenderProfile = computed(() => (
        renderProfileOptions.find(item => item.value === settings.render_profile)
        || renderProfileOptions.find(item => item.value === 'balanced')
    ))

    // ============ 桌面运行与局域网投屏 ============
    const runtimeSettings = reactive({
        auto_start_enabled: true,
        auto_start_supported: false,
        packaged: false,
        lan_display_enabled: false,
        lan_display_port: 8787,
        lan_display_pin: ''
    })
    const runtimeStatus = reactive({
        enabled: false,
        running: false,
        port: 8787,
        pin: '',
        urls: [],
        pairingUrls: [],
        clients: 0,
        error: '',
        note: ''
    })
    const runtimeSaving = ref(false)
    const runtimeMessage = ref('')
    const runtimeQrDataUrl = ref('')
    let runtimeRefreshTimer = null
    const firstCastPairingUrl = computed(() => runtimeStatus.pairingUrls?.[0] || '')

    async function refreshRuntimeQr() {
        if (!firstCastPairingUrl.value) {
            runtimeQrDataUrl.value = ''
            return
        }
        try {
            runtimeQrDataUrl.value = await QRCode.toDataURL(firstCastPairingUrl.value, {
                width: 240,
                margin: 1,
                errorCorrectionLevel: 'M'
            })
        } catch (error) {
            runtimeQrDataUrl.value = ''
            runtimeMessage.value = `二维码生成失败：${error.message || error}`
        }
    }

    async function loadRuntimeSettings({ silent = false } = {}) {
        try {
            const result = await adminApi.getRuntimeSettings()
            if (result?.error) throw new Error(result.error)
            Object.assign(runtimeSettings, {
                auto_start_enabled: result.auto_start_enabled !== false,
                auto_start_supported: result.auto_start_supported === true,
                packaged: result.packaged === true,
                lan_display_enabled: result.lan_display_enabled === true,
                lan_display_port: Number(result.lan_display_port || result.lan_display?.port || 8787),
                lan_display_pin: String(result.lan_display_pin || result.lan_display?.pin || '')
            })
            Object.assign(runtimeStatus, result.lan_display || {}, {
                urls: result.lan_display?.urls || [],
                pairingUrls: result.lan_display?.pairingUrls || []
            })
            await refreshRuntimeQr()
            return result
        } catch (error) {
            if (!silent) runtimeMessage.value = `运行配置读取失败：${error.message || error}`
            return null
        }
    }

    async function saveRuntimeSettings() {
        runtimeSaving.value = true
        runtimeMessage.value = '正在保存运行配置...'
        try {
            const result = await adminApi.saveRuntimeSettings({
                auto_start_enabled: runtimeSettings.auto_start_enabled,
                lan_display_enabled: runtimeSettings.lan_display_enabled,
                lan_display_port: runtimeSettings.lan_display_port,
                lan_display_pin: runtimeSettings.lan_display_pin
            })
            if (result?.error) throw new Error(result.error)
            Object.assign(runtimeSettings, {
                auto_start_enabled: result.auto_start_enabled !== false,
                auto_start_supported: result.auto_start_supported === true,
                packaged: result.packaged === true,
                lan_display_enabled: result.lan_display_enabled === true,
                lan_display_port: Number(result.lan_display_port || 8787),
                lan_display_pin: String(result.lan_display_pin || '')
            })
            Object.assign(runtimeStatus, result.lan_display || {})
            await refreshRuntimeQr()
            runtimeMessage.value = runtimeSettings.lan_display_enabled
                ? '运行配置已保存，投屏服务已按新配置启动。'
                : '运行配置已保存，局域网投屏当前已关闭。'
        } catch (error) {
            runtimeMessage.value = `运行配置保存失败：${error.message || error}`
        } finally {
            runtimeSaving.value = false
        }
    }

    async function rotateCastPin() {
        if (!(await confirm('重新生成后，之前分享的投屏二维码和地址会立即失效，确定继续吗？'))) return
        runtimeSaving.value = true
        runtimeMessage.value = '正在生成新的投屏码...'
        try {
            const result = await adminApi.rotateCastPin()
            if (result?.error) throw new Error(result.error)
            runtimeSettings.lan_display_pin = String(result.lan_display_pin || result.lan_display?.pin || '')
            Object.assign(runtimeStatus, result.lan_display || {})
            await refreshRuntimeQr()
            runtimeMessage.value = '投屏码已更新，旧设备会被要求重新授权。'
        } catch (error) {
            runtimeMessage.value = `投屏码更新失败：${error.message || error}`
        } finally {
            runtimeSaving.value = false
        }
    }

    async function copyCastUrl(url) {
        if (!url) return
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(url)
            } else {
                const input = document.createElement('textarea')
                input.value = url
                input.style.position = 'fixed'
                input.style.opacity = '0'
                document.body.appendChild(input)
                input.select()
                document.execCommand('copy')
                input.remove()
            }
            runtimeMessage.value = '投屏地址已复制。'
        } catch (error) {
            runtimeMessage.value = `复制失败，请手动选择地址：${url}`
        }
    }

    function startRuntimeRefresh() {
        if (runtimeRefreshTimer) clearInterval(runtimeRefreshTimer)
        runtimeRefreshTimer = setInterval(() => loadRuntimeSettings({ silent: true }), 5000)
        runtimeRefreshTimer.unref?.()
    }

    function stopRuntimeRefresh() {
        if (runtimeRefreshTimer) clearInterval(runtimeRefreshTimer)
        runtimeRefreshTimer = null
    }

    async function loadSettings() {
        const s = await adminApi.getSettings()
        if (s.data_mode !== 'simulation') s.data_mode = 'integrated_plc'
        for (const key of Object.keys(settings)) delete settings[key]
        Object.assign(settings, defaultSettings, s)
        settings.render_target_fps = Number(settings.render_target_fps || 45)
        settings.render_scale = Number(settings.render_scale || 1)
        settings.render_label_fps = Number(settings.render_label_fps || 12)
        settings.render_antialias = ['1', 'true', 'yes', 'on'].includes(String(settings.render_antialias).toLowerCase())
        await loadRuntimeSettings({ silent: true })
        await loadDatabaseConfig()
        // 同时获取引擎状态
        loadEngineStatus()
    }

    const engineStatus = reactive({
        mode: null,
        plcStatus: { status: 'unknown', message: '未知' },
        collectorStatus: { status: 'unknown', message: '未知' }
    })
    const plcStatusLabels = {
        connected: '已连接',
        connecting: '连接中',
        retrying: '重连中',
        error: '异常',
        disabled: '未启用',
        no_points: '无点位',
        unconfigured: '未配置',
        unsupported: '暂不支持',
        stopped: '已停止',
        idle: '等待'
    }
    const plcStatusByDevice = computed(() => {
        const map = {}
        const statuses = engineStatus.plcStatus?.devices || []
        statuses.forEach(status => {
            map[status.deviceId] = status
        })
        return map
    })

    function formatPlcDeviceStatus(device) {
        if (!Number(device.plc_enabled || 0)) return '未启用'
        const status = plcStatusByDevice.value[device.id]
        if (!status) return device.plc_ip ? '等待采集' : '未配置'
        if (status.status === 'unconfigured' && device.plc_ip && !status.plc_ip) return '配置已更新'
        return plcStatusLabels[status.status] || status.status || '未知'
    }

    function formatPlcEndpoint(device) {
        if (!Number(device.plc_enabled || 0)) return '未启用'
        const status = plcStatusByDevice.value[device.id]
        if (status?.endpoint) return status.endpoint
        if (!device.plc_ip) return '未填写 IP'
        return `${device.plc_protocol || 'S7'} ${device.plc_ip}:${device.plc_port || 102} (Rack=${device.plc_rack ?? 0}, Slot=${device.plc_slot ?? 1})`
    }

    function formatPlcIntervals(status) {
        const intervals = status?.intervals || []
        return intervals.length ? intervals.map(ms => `${ms}ms`).join(' / ') : '-'
    }

    function formatPlcTime(value) {
        const timestamp = Number(value)
        if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
        return new Date(timestamp).toLocaleTimeString()
    }

    const databaseConfig = reactive({
        type: 'mysql',
        host: '127.0.0.1',
        port: 3307,
        user: 'root',
        password: '******',
        database: 'dongtai_daping',
        filename: '',
        encrypt: false,
        trustServerCertificate: true
    })
    const databaseTestStatus = ref('')
    const databaseSaving = ref(false)
    const databaseBackupBusy = ref(false)
    const databaseBackupMessage = ref('')
    const databaseBackupStatus = reactive({
        supported: false,
        automatic: false,
        intervalMs: 0,
        retention: 0,
        directory: '',
        lastBackup: null,
        lastRecovery: null,
        backups: []
    })
    const siteBackupFileInput = ref(null)
    const siteBackupBusy = ref(false)
    const siteBackupMessage = ref('')
    const siteBackupStatus = reactive({
        supported: false,
        retention: 0,
        externalCopyRequired: true,
        backups: []
    })
    const databaseDefaultPorts = {
        mysql: 3307,
        postgres: 5432,
        sqlserver: 1433
    }

    async function loadDatabaseConfig() {
        try {
            const config = await adminApi.getDatabaseConfig()
            Object.assign(databaseConfig, config)
            await Promise.all([loadDatabaseBackups(), loadSiteBackups()])
        } catch (e) {
            databaseTestStatus.value = '数据库配置读取失败'
        }
    }

    async function loadSiteBackups() {
        try {
            const status = await adminApi.getSiteBackups()
            if (status?.error) throw new Error(status.error)
            Object.assign(siteBackupStatus, status, { backups: status.backups || [] })
        } catch (e) {
            siteBackupMessage.value = `整站灾备状态读取失败：${e.message || e}`
        }
    }

    function downloadSiteBackup(backup) {
        const link = document.createElement('a')
        link.href = adminApi.siteBackupDownloadUrl(backup.filename)
        link.download = backup.filename
        document.body.appendChild(link)
        link.click()
        link.remove()
    }

    async function exportSiteBackup() {
        siteBackupBusy.value = true
        siteBackupMessage.value = '正在生成整站灾备包并校验文件，请稍候...'
        try {
            const result = await adminApi.createSiteBackup()
            if (result?.error || !result?.success || !result.backup?.filename) {
                throw new Error(result?.error || '后端没有返回灾备文件')
            }
            Object.assign(siteBackupStatus, result.status || {}, { backups: result.status?.backups || [] })
            siteBackupMessage.value = `灾备包已生成：${result.backup.filename}。请选择 U 盘、移动硬盘或 NAS 保存。`
            downloadSiteBackup(result.backup)
        } catch (e) {
            siteBackupMessage.value = `整站灾备导出失败：${e.message || e}`
        } finally {
            siteBackupBusy.value = false
        }
    }

    function chooseSiteBackupFile() {
        if (!siteBackupFileInput.value) return
        siteBackupFileInput.value.value = ''
        siteBackupFileInput.value.click()
    }

    async function restoreSiteBackupFromFile(event) {
        const file = event.target.files?.[0]
        if (!file) return
        if (!(await confirm(
            `确定从“${file.name}”恢复整套现场？\n\n当前数据库和上传模型会先创建回滚副本，恢复后将以灾备包中的配置为准。`,
            { title: '恢复整站灾备', type: 'warning', confirmText: '校验并恢复' }
        ))) return

        siteBackupBusy.value = true
        siteBackupMessage.value = '正在校验灾备包并恢复数据库、现场配置和上传模型...'
        try {
            const result = await adminApi.restoreSiteBackup(file)
            if (result?.error || !result?.success) throw new Error(result?.error || '后端没有返回成功状态')
            Object.assign(siteBackupStatus, result.status || {}, { backups: result.status?.backups || [] })
            Object.assign(databaseBackupStatus, result.databaseStatus || {}, { backups: result.databaseStatus?.backups || [] })
            await loadWorkshops()
            await Promise.all([loadLines(), loadDevices(), loadSettings(), loadModels(), loadPlatform()])
            ensureComposerSelection()
            syncComposerDraftFromSelection()
            await nextTick()
            scheduleComposerPreview()
            siteBackupMessage.value = `整站恢复完成：灾备时间 ${new Date(result.manifestCreatedAt).toLocaleString()}，上传模型 ${result.uploadedFileCount || 0} 个。`
            await alert('现场配置、数据库和上传模型已恢复完成。', { title: '整站恢复成功', type: 'success' })
        } catch (e) {
            siteBackupMessage.value = `整站恢复失败：${e.message || e}`
            await alert(siteBackupMessage.value, { title: '整站恢复失败', type: 'danger' })
        } finally {
            siteBackupBusy.value = false
            event.target.value = ''
        }
    }

    async function loadDatabaseBackups() {
        try {
            const status = await adminApi.getDatabaseBackups()
            Object.assign(databaseBackupStatus, status, { backups: status.backups || [] })
        } catch (e) {
            databaseBackupMessage.value = `备份状态读取失败：${e.message || e}`
        }
    }

    async function createDatabaseBackup() {
        databaseBackupBusy.value = true
        databaseBackupMessage.value = '正在创建一致性备份...'
        try {
            const result = await adminApi.createDatabaseBackup()
            Object.assign(databaseBackupStatus, result.status || {})
            databaseBackupMessage.value = `备份完成：${result.backup?.filename || ''}`
        } catch (e) {
            databaseBackupMessage.value = `备份失败：${e.message || e}`
        } finally {
            databaseBackupBusy.value = false
        }
    }

    async function restoreDatabaseBackup(backup) {
        if (!(await confirm(`恢复备份 ${backup.filename}？当前数据库会先自动备份，然后数据引擎将重新启动。`))) return
        databaseBackupBusy.value = true
        databaseBackupMessage.value = '正在校验并恢复备份...'
        try {
            const result = await adminApi.restoreDatabaseBackup(backup.filename)
            Object.assign(databaseBackupStatus, result.status || {})
            databaseBackupMessage.value = `已恢复：${backup.filename}`
            await Promise.all([loadSettings(), loadWorkshops(), loadLines(), loadDevices(), loadModels(), loadPlatform()])
        } catch (e) {
            databaseBackupMessage.value = `恢复失败：${e.message || e}`
        } finally {
            databaseBackupBusy.value = false
        }
    }

    function downloadDatabaseBackup(backup) {
        const link = document.createElement('a')
        link.href = adminApi.databaseBackupDownloadUrl(backup.filename)
        link.download = backup.filename
        document.body.appendChild(link)
        link.click()
        link.remove()
    }

    function formatBackupSize(bytes) {
        const value = Number(bytes || 0)
        if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
        return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function formatBackupInterval(milliseconds) {
        const hours = Number(milliseconds || 0) / 3600000
        return hours >= 1 ? `${Number(hours.toFixed(1))} 小时` : `${Math.round(milliseconds / 60000)} 分钟`
    }

    async function testDatabaseConnection() {
        databaseTestStatus.value = '正在测试连接...'
        try {
            const result = await adminApi.testDatabaseConfig({ ...databaseConfig })
            databaseTestStatus.value = result.success ? '连接成功' : `连接失败：${result.error || '未知错误'}`
        } catch (e) {
            databaseTestStatus.value = `连接失败：${e.message || '后端服务不可用'}`
        }
    }

    async function saveDatabaseConnection() {
        if (!(await confirm('保存数据库连接后，后端会重新初始化数据库并重启数据引擎，确定继续吗？'))) return
        databaseSaving.value = true
        databaseTestStatus.value = '正在保存并重新连接...'
        try {
            const result = await adminApi.saveDatabaseConfig({ ...databaseConfig })
            if (!result.success) {
                databaseTestStatus.value = `保存失败：${result.error || '未知错误'}`
                return
            }
            Object.assign(databaseConfig, result.config || databaseConfig)
            databaseTestStatus.value = '保存成功，数据库已重新连接'
            await loadDatabaseBackups()
            await Promise.all([loadSettings(), loadWorkshops(), loadLines(), loadDevices(), loadModels(), loadPlatform()])
        } catch (e) {
            databaseTestStatus.value = `保存失败：${e.message || e}`
        } finally {
            databaseSaving.value = false
        }
    }

    watch(() => databaseConfig.type, (type, oldType) => {
        if (type === oldType) return
        if (type === 'sqlite') {
            databaseConfig.filename ||= 'backend/data/factory.db'
            return
        }
        if (!databaseConfig.port || databaseConfig.port === databaseDefaultPorts[oldType]) {
            databaseConfig.port = databaseDefaultPorts[type] || databaseConfig.port
        }
        databaseConfig.database ||= 'dongtai_daping'
    })

    async function loadEngineStatus() {
        try {
            const res = await fetch(`${API_BASE}/engine/status`)
            const data = await res.json()
            Object.assign(engineStatus, data)
        } catch (e) {
            engineStatus.mode = null
            engineStatus.plcStatus = { status: 'error', message: '无法连接后端' }
        }
    }

    function formatEngineMode(mode) {
        const labels = {
            integrated_plc: '内置低延迟采集模式',
            simulation: '模拟模式'
        }
        return labels[mode] || '未启动'
    }

    async function saveSettings() {
        const result = await adminApi.saveSettings({
            factory_name: settings.factory_name,
            data_mode: settings.data_mode,
            realtime_stale_ms: settings.realtime_stale_ms,
            display_mode: settings.display_mode,
            camera_mode: settings.camera_mode,
            native_quality_profile: settings.native_quality_profile,
            render_profile: settings.render_profile,
            render_target_fps: settings.render_target_fps,
            render_scale: settings.render_scale,
            render_antialias: settings.render_antialias,
            render_label_fps: settings.render_label_fps
        })
        if (result?.error) return alert(result.error, { title: '设置保存失败', type: 'danger' })
        if (!result?.success) return alert('设置保存失败：后端没有返回成功状态', { title: '设置保存失败', type: 'danger' })
        // 保存后自动重启数据引擎
        try {
            await fetch(`${API_BASE}/engine/restart`, { method: 'POST' })
            alert('设置已保存。数据引擎正在重启；Unity 原生客户端按 F5 重载配置或重启后生效。', { title: '保存成功', type: 'success' })
        } catch (e) {
            alert('设置已保存，但数据引擎重启失败，请手动重启后端服务', { title: '保存成功', type: 'warning' })
        }
        // 刷新引擎状态
        setTimeout(() => loadEngineStatus(), 2000)
    }

    return {
        defaultSettings,
        settings,
        renderProfileOptions,
        resolvedRenderSettings,
        selectedRenderProfile,
        runtimeSettings,
        runtimeStatus,
        runtimeSaving,
        runtimeMessage,
        runtimeQrDataUrl,
        firstCastPairingUrl,
        refreshRuntimeQr,
        loadRuntimeSettings,
        saveRuntimeSettings,
        rotateCastPin,
        copyCastUrl,
        startRuntimeRefresh,
        stopRuntimeRefresh,
        loadSettings,
        engineStatus,
        plcStatusLabels,
        plcStatusByDevice,
        formatPlcDeviceStatus,
        formatPlcEndpoint,
        formatPlcIntervals,
        formatPlcTime,
        databaseConfig,
        databaseTestStatus,
        databaseSaving,
        databaseBackupBusy,
        databaseBackupMessage,
        databaseBackupStatus,
        siteBackupFileInput,
        siteBackupBusy,
        siteBackupMessage,
        siteBackupStatus,
        loadDatabaseConfig,
        loadSiteBackups,
        downloadSiteBackup,
        exportSiteBackup,
        chooseSiteBackupFile,
        restoreSiteBackupFromFile,
        loadDatabaseBackups,
        createDatabaseBackup,
        restoreDatabaseBackup,
        downloadDatabaseBackup,
        formatBackupSize,
        formatBackupInterval,
        testDatabaseConnection,
        saveDatabaseConnection,
        loadEngineStatus,
        formatEngineMode,
        saveSettings
    }
}
