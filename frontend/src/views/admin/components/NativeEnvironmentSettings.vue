<script setup>
import { computed } from 'vue'
import NativeWallEditor from './NativeWallEditor.vue'

const props = defineProps({
    config: { type: Object, required: true },
    saving: { type: Boolean, default: false },
    message: { type: String, default: '' },
    presetOptions: { type: Array, default: () => [] }
})

const emit = defineEmits(['save', 'apply-preset', 'reset'])

const colorItems = [
    ['skyColor', '天空'],
    ['horizonColor', '地平线'],
    ['fogColor', '雾效'],
    ['keyLightColor', '主光'],
    ['fillLightColor', '补光'],
    ['floorColor', '地面'],
    ['gridColor', '网格'],
    ['wallColor', '厂房墙面'],
    ['frameColor', '钢结构']
]

const presetDescription = computed(() => (
    props.presetOptions.find(option => option.value === props.config.preset)?.description
    || '当前为工程师自定义组合。'
))

function applyPreset() {
    emit('apply-preset', props.config.preset)
}

function saveCustom() {
    props.config.preset = 'custom'
    emit('save', { silent: true, markCustom: true })
}
</script>

<template>
    <section class="environment-settings">
        <div class="environment-heading">
            <div>
                <h3>Unity 场景与光效</h3>
                <p>所有参数作用于当前及以后导入的模型。保存后通过 WebSocket 实时应用，不重载模型、不生成荧光描边。</p>
            </div>
            <div class="environment-actions">
                <button type="button" class="env-btn" @click="emit('reset')">恢复推荐值</button>
                <button type="button" class="env-btn primary" :disabled="saving" @click="emit('save', {})">
                    {{ saving ? '应用中...' : '立即应用到 Unity' }}
                </button>
            </div>
        </div>

        <div class="preset-row">
            <label>视觉预设
                <select v-model="config.preset" class="env-input" @change="applyPreset">
                    <option v-for="option in presetOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                    </option>
                </select>
            </label>
            <p>{{ presetDescription }}</p>
            <label class="check-line"><input v-model="config.showGrid" type="checkbox" @change="saveCustom" /> 显示地面网格</label>
        </div>

        <div class="environment-grid">
            <NativeWallEditor :config="config" @change="saveCustom" />

            <section class="environment-card">
                <h4>总体亮度与照明</h4>
                <div class="control-list">
                    <label>全局亮度 <span>{{ Math.round(config.sceneBrightness * 100) }}%</span>
                        <input v-model.number="config.sceneBrightness" type="range" min="0.8" max="1.6" step="0.05" @change="saveCustom" />
                    </label>
                    <label>环境光强度 <span>{{ Number(config.ambientIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.ambientIntensity" type="range" min="0.2" max="2.5" step="0.05" @change="saveCustom" />
                    </label>
                    <label>主光强度 <span>{{ Number(config.keyLightIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.keyLightIntensity" type="range" min="0" max="3" step="0.05" @change="saveCustom" />
                    </label>
                    <label>补光强度 <span>{{ Number(config.fillLightIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.fillLightIntensity" type="range" min="0" max="2.5" step="0.05" @change="saveCustom" />
                    </label>
                    <label>环境反射 <span>{{ Number(config.reflectionIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.reflectionIntensity" type="range" min="0" max="2" step="0.05" @change="saveCustom" />
                    </label>
                </div>
            </section>

            <section class="environment-card">
                <h4>后处理</h4>
                <div class="control-list">
                    <label>曝光 <span>{{ Number(config.postExposure).toFixed(2) }}</span>
                        <input v-model.number="config.postExposure" type="range" min="-1.5" max="2" step="0.05" @change="saveCustom" />
                    </label>
                    <label>对比度 <span>{{ Math.round(config.contrast) }}</span>
                        <input v-model.number="config.contrast" type="range" min="-30" max="30" step="1" @change="saveCustom" />
                    </label>
                    <label>饱和度 <span>{{ Math.round(config.saturation) }}</span>
                        <input v-model.number="config.saturation" type="range" min="-30" max="30" step="1" @change="saveCustom" />
                    </label>
                    <label>高光柔化（Bloom） <span>{{ Number(config.bloomIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.bloomIntensity" type="range" min="0" max="1" step="0.01" @change="saveCustom" />
                    </label>
                    <label>画面暗角 <span>{{ Number(config.vignetteIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.vignetteIntensity" type="range" min="0" max="0.5" step="0.01" @change="saveCustom" />
                    </label>
                </div>
            </section>

            <section class="environment-card">
                <div class="card-heading">
                    <h4>雾效与空间层次</h4>
                    <label class="switch">
                        <input v-model="config.fogEnabled" type="checkbox" @change="saveCustom" />
                        <span></span>
                    </label>
                </div>
                <div class="number-grid">
                    <label>雾效起始距离<input v-model.number="config.fogStart" class="env-input" type="number" min="0" max="500" @change="saveCustom" /></label>
                    <label>雾效结束距离<input v-model.number="config.fogEnd" class="env-input" type="number" min="10" max="1000" @change="saveCustom" /></label>
                </div>
                <p class="help">关闭雾效可获得最清晰的设备边缘；开启后更接近大型厂房的空间纵深。</p>
            </section>

            <section class="environment-card color-card">
                <h4>颜色与材质环境</h4>
                <div class="color-grid">
                    <label v-for="item in colorItems" :key="item[0]">
                        <span>{{ item[1] }}</span>
                        <input v-model="config[item[0]]" type="color" @change="saveCustom" />
                        <code>{{ config[item[0]] }}</code>
                    </label>
                </div>
            </section>
        </div>

        <p v-if="message" class="environment-message">{{ message }}</p>
    </section>
</template>

<style scoped>
.environment-settings { margin-top: 24px; padding: 24px; background: linear-gradient(180deg, #f5f9fc 0%, #fbfbfd 100%); border: 1px solid #e2e7eb; border-radius: 12px; }
.environment-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.environment-heading h3 { margin: 0 0 8px; color: #1d1d1f; font-size: 17px; }
.environment-heading p { max-width: 760px; margin: 0; color: #6e6e73; font-size: 13px; line-height: 1.6; }
.environment-actions { display: flex; flex: 0 0 auto; gap: 10px; }
.env-btn { min-height: 36px; padding: 7px 15px; color: #343437; background: #fff; border: 1px solid #cfd3d7; border-radius: 7px; cursor: pointer; }
.env-btn.primary { color: #fff; background: #176b8b; border-color: #176b8b; }
.env-btn:disabled { opacity: .55; cursor: wait; }
.env-input { width: 100%; min-height: 38px; padding: 8px 10px; color: #1d1d1f; background: #fff; border: 1px solid #d2d2d7; border-radius: 6px; box-sizing: border-box; }
.preset-row { display: grid; grid-template-columns: minmax(240px, 360px) minmax(260px, 1fr) auto; align-items: end; gap: 16px; margin-top: 20px; padding: 17px; background: #fff; border: 1px solid #dce6ed; border-radius: 10px; }
.preset-row > label:not(.check-line) { display: flex; flex-direction: column; gap: 7px; color: #515154; font-size: 13px; font-weight: 500; }
.preset-row > p { align-self: center; margin: 0; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.check-line { display: flex; align-items: center; gap: 7px; min-height: 38px; color: #515154; font-size: 12px; white-space: nowrap; }
.check-line input { accent-color: #176b8b; }
.environment-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.environment-card { padding: 18px; background: #fff; border: 1px solid #e1e6ea; border-radius: 10px; }
.environment-card h4 { margin: 0; color: #1d1d1f; font-size: 14px; }
.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.control-list { display: grid; gap: 14px; margin-top: 16px; }
.control-list > label { display: grid; grid-template-columns: minmax(120px, 1fr) 58px; align-items: center; gap: 8px 12px; color: #515154; font-size: 12px; font-weight: 500; }
.control-list > label > span { color: #1d1d1f; font-variant-numeric: tabular-nums; text-align: right; }
.control-list input[type="range"] { grid-column: 1 / -1; width: 100%; accent-color: #297ea2; }
.number-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.number-grid > label { display: flex; flex-direction: column; gap: 7px; color: #515154; font-size: 12px; font-weight: 500; }
.help { margin: 13px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.color-card { grid-column: 1 / -1; }
.color-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; margin-top: 16px; }
.color-grid > label { display: grid; grid-template-columns: minmax(56px, 1fr) 42px minmax(72px, auto); align-items: center; gap: 9px; padding: 9px 10px; background: #f8fafb; border: 1px solid #e4eaee; border-radius: 7px; color: #515154; font-size: 12px; }
.color-grid input[type="color"] { width: 42px; height: 30px; padding: 2px; background: #fff; border: 1px solid #cfd6dc; border-radius: 5px; cursor: pointer; }
.color-grid code { color: #3c4852; font-size: 11px; text-align: right; }
.switch { position: relative; display: inline-flex; width: 40px; height: 23px; }
.switch input { position: absolute; opacity: 0; }
.switch span { width: 100%; height: 100%; background: #c7c9cc; border-radius: 999px; transition: .2s ease; }
.switch span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 17px; height: 17px; background: #fff; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: .2s ease; }
.switch input:checked + span { background: #24834f; }
.switch input:checked + span::after { transform: translateX(17px); }
.environment-message { margin: 14px 0 0; color: #176b3a; font-size: 12px; line-height: 1.5; }

@media (max-width: 1180px) {
    .environment-heading { flex-direction: column; }
    .preset-row,
    .environment-grid,
    .color-grid { grid-template-columns: 1fr; }
    .color-card { grid-column: auto; }
}
</style>
