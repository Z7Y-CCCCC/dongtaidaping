<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
    config: { type: Object, required: true }
})

const emit = defineEmits(['change'])
const canvasRef = ref(null)
const selectedId = ref('')
const dragState = reactive({
    active: false,
    id: '',
    pointerId: 0,
    startClientX: 0,
    startClientY: 0,
    startX: 0,
    startZ: 0,
    rect: null
})

const walls = computed(() => Array.isArray(props.config.walls) ? props.config.walls : [])
const selectedWall = computed(() => (
    walls.value.find(wall => wall.id === selectedId.value)
    || walls.value[0]
    || null
))

watch(walls, (next) => {
    if (!next.length) {
        selectedId.value = ''
        return
    }
    if (!next.some(wall => wall.id === selectedId.value)) selectedId.value = next[0].id
}, { immediate: true, deep: true })

function round(value, digits = 1) {
    const factor = 10 ** digits
    return Math.round(Number(value || 0) * factor) / factor
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value))
}

function normalizeAngle(value) {
    let angle = Number(value || 0) % 360
    if (angle > 180) angle -= 360
    if (angle < -180) angle += 360
    return round(angle, 1)
}

function emitChange() {
    props.config.preset = 'custom'
    emit('change')
}

function createWall(index = walls.value.length) {
    const offset = index * 2
    return {
        id: `wall_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: `围墙 ${index + 1}`,
        enabled: true,
        style: 'solid_frame',
        x: round(offset, 1),
        baseY: 0,
        z: round(offset, 1),
        length: 30,
        height: 6,
        thickness: 0.3,
        rotationY: 0,
        color: '',
        frameColor: ''
    }
}

function addWall() {
    if (!Array.isArray(props.config.walls)) props.config.walls = []
    const wall = createWall(props.config.walls.length)
    props.config.walls.push(wall)
    props.config.showWalls = true
    selectedId.value = wall.id
    emitChange()
}

function duplicateWall() {
    if (!selectedWall.value) return
    const wall = {
        ...selectedWall.value,
        id: `wall_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: `${selectedWall.value.name} 副本`,
        x: round(Number(selectedWall.value.x || 0) + 2, 1),
        z: round(Number(selectedWall.value.z || 0) + 2, 1)
    }
    props.config.walls.push(wall)
    selectedId.value = wall.id
    emitChange()
}

function removeWall() {
    if (!selectedWall.value) return
    const index = props.config.walls.findIndex(wall => wall.id === selectedWall.value.id)
    if (index < 0) return
    props.config.walls.splice(index, 1)
    selectedId.value = props.config.walls[Math.min(index, props.config.walls.length - 1)]?.id || ''
    if (!props.config.walls.length) props.config.showWalls = false
    emitChange()
}

function rotateWall() {
    if (!selectedWall.value) return
    selectedWall.value.rotationY = normalizeAngle(Number(selectedWall.value.rotationY || 0) + 90)
    emitChange()
}

function setWallColor(field, value) {
    if (!selectedWall.value) return
    selectedWall.value[field] = String(value || '').toUpperCase()
    emitChange()
}

function wallCss(wall) {
    const editorWidth = Math.max(20, Number(props.config.wallEditorWidth || 100))
    const editorDepth = Math.max(20, Number(props.config.wallEditorDepth || 80))
    return {
        left: `${50 + (Number(wall.x || 0) / editorWidth) * 100}%`,
        top: `${50 - (Number(wall.z || 0) / editorDepth) * 100}%`,
        width: `${clamp((Number(wall.length || 1) / editorWidth) * 100, 1.2, 140)}%`,
        transform: `translate(-50%, -50%) rotate(${Number(wall.rotationY || 0)}deg)`,
        '--wall-angle': `${Number(wall.rotationY || 0)}deg`,
        '--wall-color': wall.color || props.config.wallColor || '#283B59',
        '--frame-color': wall.frameColor || props.config.frameColor || '#526A86'
    }
}

function beginDrag(event, wall) {
    if (!props.config.showWalls || !wall.enabled || !canvasRef.value) return
    selectedId.value = wall.id
    const rect = canvasRef.value.getBoundingClientRect()
    dragState.active = true
    dragState.id = wall.id
    dragState.pointerId = event.pointerId
    dragState.startClientX = event.clientX
    dragState.startClientY = event.clientY
    dragState.startX = Number(wall.x || 0)
    dragState.startZ = Number(wall.z || 0)
    dragState.rect = rect
    event.currentTarget.setPointerCapture?.(event.pointerId)
}

function dragWall(event) {
    if (!dragState.active || event.pointerId !== dragState.pointerId || !dragState.rect) return
    const wall = walls.value.find(item => item.id === dragState.id)
    if (!wall) return
    const editorWidth = Math.max(20, Number(props.config.wallEditorWidth || 100))
    const editorDepth = Math.max(20, Number(props.config.wallEditorDepth || 80))
    const nextX = dragState.startX + ((event.clientX - dragState.startClientX) / dragState.rect.width) * editorWidth
    const nextZ = dragState.startZ - ((event.clientY - dragState.startClientY) / dragState.rect.height) * editorDepth
    wall.x = round(clamp(nextX, -editorWidth * 0.5, editorWidth * 0.5), 1)
    wall.z = round(clamp(nextZ, -editorDepth * 0.5, editorDepth * 0.5), 1)
}

function endDrag(event) {
    if (!dragState.active || event.pointerId !== dragState.pointerId) return
    dragState.active = false
    dragState.id = ''
    dragState.rect = null
    emitChange()
}
</script>

<template>
    <section class="wall-editor-card">
        <div class="wall-editor-heading">
            <div>
                <h4>可拖拽厂房围墙</h4>
                <p>默认不生成围墙。启用后可新增任意墙段，直接在平面图中拖动位置；长度、高度、厚度、角度和样式均可独立配置。</p>
            </div>
            <div class="wall-heading-actions">
                <label class="wall-master-switch">
                    <input v-model="config.showWalls" type="checkbox" @change="emitChange" />
                    <span>{{ config.showWalls ? '围墙已显示' : '围墙已关闭' }}</span>
                </label>
                <button type="button" class="wall-btn primary" @click="addWall">+ 新增围墙</button>
            </div>
        </div>

        <div class="wall-range-row">
            <label>平面编辑范围 X（米）
                <input v-model.number="config.wallEditorWidth" type="number" min="20" max="1000" step="5" @change="emitChange" />
            </label>
            <label>平面编辑范围 Z（米）
                <input v-model.number="config.wallEditorDepth" type="number" min="20" max="1000" step="5" @change="emitChange" />
            </label>
            <span>十字中心为 Unity 世界坐标 X=0、Z=0；拖动墙段后会自动保存并实时同步。</span>
        </div>

        <div class="wall-editor-layout">
            <div
                ref="canvasRef"
                class="wall-plan"
                :class="{ disabled: !config.showWalls }"
                @pointermove="dragWall"
                @pointerup="endDrag"
                @pointercancel="endDrag"
            >
                <div class="axis axis-x"><span>+X</span></div>
                <div class="axis axis-z"><span>+Z</span></div>
                <div class="origin-mark">0</div>
                <button
                    v-for="wall in walls"
                    :key="wall.id"
                    type="button"
                    class="wall-segment"
                    :class="[
                        `style-${wall.style}`,
                        { selected: selectedWall?.id === wall.id, disabled: !wall.enabled }
                    ]"
                    :style="wallCss(wall)"
                    :title="`${wall.name} · X ${wall.x} / Z ${wall.z}`"
                    @click.stop="selectedId = wall.id"
                    @pointerdown.stop.prevent="beginDrag($event, wall)"
                >
                    <span>{{ wall.name }}</span>
                </button>
                <div v-if="!walls.length" class="wall-empty-state">
                    <strong>当前没有围墙</strong>
                    <span>大屏将只显示地面和设备；需要时点击“新增围墙”。</span>
                </div>
            </div>

            <aside class="wall-inspector">
                <template v-if="selectedWall">
                    <div class="wall-list-row">
                        <label>当前墙段
                            <select v-model="selectedId">
                                <option v-for="wall in walls" :key="wall.id" :value="wall.id">{{ wall.name }}</option>
                            </select>
                        </label>
                        <label class="wall-enabled-line"><input v-model="selectedWall.enabled" type="checkbox" @change="emitChange" /> 启用</label>
                    </div>

                    <div class="wall-field-grid">
                        <label class="wide">名称<input v-model.trim="selectedWall.name" type="text" @change="emitChange" /></label>
                        <label>样式
                            <select v-model="selectedWall.style" @change="emitChange">
                                <option value="solid">实体墙</option>
                                <option value="frame">钢结构框架</option>
                                <option value="solid_frame">实体墙 + 钢架</option>
                            </select>
                        </label>
                        <label>旋转角度（°）<input v-model.number="selectedWall.rotationY" type="number" min="-180" max="180" step="1" @change="selectedWall.rotationY = normalizeAngle(selectedWall.rotationY); emitChange()" /></label>
                        <label>X 位置（米）<input v-model.number="selectedWall.x" type="number" step="0.1" @change="emitChange" /></label>
                        <label>Z 位置（米）<input v-model.number="selectedWall.z" type="number" step="0.1" @change="emitChange" /></label>
                        <label>离地高度（米）<input v-model.number="selectedWall.baseY" type="number" min="-10" max="50" step="0.1" @change="emitChange" /></label>
                        <label>墙体长度（米）<input v-model.number="selectedWall.length" type="number" min="1" max="500" step="0.5" @change="emitChange" /></label>
                        <label>墙体高度（米）<input v-model.number="selectedWall.height" type="number" min="0.5" max="100" step="0.5" @change="emitChange" /></label>
                        <label>墙体厚度（米）<input v-model.number="selectedWall.thickness" type="number" min="0.05" max="5" step="0.05" @change="emitChange" /></label>
                    </div>

                    <div class="wall-color-row">
                        <label>墙面颜色
                            <input type="color" :value="selectedWall.color || config.wallColor" @input="setWallColor('color', $event.target.value)" />
                        </label>
                        <label>钢架颜色
                            <input type="color" :value="selectedWall.frameColor || config.frameColor" @input="setWallColor('frameColor', $event.target.value)" />
                        </label>
                    </div>

                    <div class="wall-inspector-actions">
                        <button type="button" class="wall-btn" @click="rotateWall">旋转 90°</button>
                        <button type="button" class="wall-btn" @click="duplicateWall">复制墙段</button>
                        <button type="button" class="wall-btn danger" @click="removeWall">删除墙段</button>
                    </div>
                </template>
                <div v-else class="wall-inspector-empty">
                    新增墙段后，可在这里调整具体参数。
                </div>
            </aside>
        </div>
    </section>
</template>

<style scoped>
.wall-editor-card { grid-column: 1 / -1; padding: 18px; background: #fff; border: 1px solid #dce5eb; border-radius: 10px; }
.wall-editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.wall-editor-heading h4 { margin: 0; color: #1d1d1f; font-size: 15px; }
.wall-editor-heading p { max-width: 820px; margin: 7px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.6; }
.wall-heading-actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.wall-master-switch { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 11px; color: #475467; background: #f7f9fb; border: 1px solid #d8e0e7; border-radius: 7px; font-size: 12px; white-space: nowrap; }
.wall-master-switch input { accent-color: #176b8b; }
.wall-btn { min-height: 34px; padding: 6px 12px; color: #344054; background: #fff; border: 1px solid #cfd8df; border-radius: 7px; cursor: pointer; }
.wall-btn:hover { color: #175cd3; border-color: #84adf5; background: #f7faff; }
.wall-btn.primary { color: #fff; background: #176b8b; border-color: #176b8b; }
.wall-btn.danger { color: #b42318; border-color: #f0c4c0; background: #fff8f7; }
.wall-range-row { display: grid; grid-template-columns: 190px 190px minmax(260px, 1fr); align-items: end; gap: 12px; margin-top: 16px; padding: 12px; background: #f7f9fb; border: 1px solid #e2e8ed; border-radius: 8px; }
.wall-range-row label, .wall-field-grid label, .wall-list-row label { display: flex; flex-direction: column; gap: 6px; color: #515154; font-size: 12px; font-weight: 500; }
.wall-range-row input, .wall-field-grid input, .wall-field-grid select, .wall-list-row select { width: 100%; min-height: 35px; padding: 6px 9px; color: #1d2939; background: #fff; border: 1px solid #cfd8df; border-radius: 6px; box-sizing: border-box; }
.wall-range-row > span { align-self: center; color: #667085; font-size: 11px; line-height: 1.5; }
.wall-editor-layout { display: grid; grid-template-columns: minmax(520px, 1.55fr) minmax(330px, .8fr); gap: 14px; margin-top: 14px; }
.wall-plan { position: relative; min-height: 430px; overflow: hidden; touch-action: none; background-color: #edf3f6; background-image: linear-gradient(rgba(62, 102, 124, .12) 1px, transparent 1px), linear-gradient(90deg, rgba(62, 102, 124, .12) 1px, transparent 1px), linear-gradient(rgba(62, 102, 124, .06) 1px, transparent 1px), linear-gradient(90deg, rgba(62, 102, 124, .06) 1px, transparent 1px); background-size: 50px 50px, 50px 50px, 10px 10px, 10px 10px; border: 1px solid #cad7df; border-radius: 9px; }
.wall-plan.disabled { opacity: .58; }
.axis { position: absolute; z-index: 1; pointer-events: none; background: rgba(31, 91, 120, .34); }
.axis-x { left: 0; right: 0; top: 50%; height: 1px; }
.axis-z { top: 0; bottom: 0; left: 50%; width: 1px; }
.axis span { position: absolute; color: #497085; font-size: 10px; font-weight: 700; }
.axis-x span { right: 7px; top: 5px; }
.axis-z span { left: 6px; top: 7px; }
.origin-mark { position: absolute; left: 50%; top: 50%; z-index: 2; width: 20px; height: 20px; transform: translate(-50%, -50%); display: grid; place-items: center; color: #fff; background: #1f5f7e; border-radius: 50%; font-size: 9px; pointer-events: none; }
.wall-segment { position: absolute; z-index: 4; height: 10px; min-width: 14px; padding: 0; border: 1px solid color-mix(in srgb, var(--frame-color) 82%, #182230); border-radius: 3px; background: var(--wall-color); box-shadow: 0 2px 5px rgba(16, 38, 51, .25); cursor: grab; transform-origin: center; touch-action: none; }
.wall-segment::before, .wall-segment::after { content: ''; position: absolute; top: -4px; bottom: -4px; width: 4px; background: var(--frame-color); border-radius: 2px; }
.wall-segment::before { left: -2px; }
.wall-segment::after { right: -2px; }
.wall-segment.style-frame { background: repeating-linear-gradient(90deg, var(--frame-color) 0 4px, transparent 4px 14px); border-color: var(--frame-color); }
.wall-segment.style-solid { border-color: color-mix(in srgb, var(--wall-color) 70%, #101828); }
.wall-segment.selected { z-index: 6; outline: 3px solid rgba(21, 112, 239, .22); border-color: #1570ef; }
.wall-segment.disabled { opacity: .36; filter: grayscale(.7); }
.wall-segment:active { cursor: grabbing; }
.wall-segment > span { position: absolute; left: 50%; top: -25px; max-width: 150px; transform: translateX(-50%) rotate(calc(-1 * var(--wall-angle, 0deg))); padding: 3px 6px; color: #344054; background: rgba(255, 255, 255, .92); border: 1px solid #d5dde4; border-radius: 5px; font-size: 10px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.wall-empty-state { position: absolute; inset: 0; display: grid; place-content: center; gap: 7px; color: #667085; text-align: center; pointer-events: none; }
.wall-empty-state strong { color: #344054; font-size: 14px; }
.wall-empty-state span { font-size: 11px; }
.wall-inspector { min-width: 0; padding: 14px; background: #f8fafb; border: 1px solid #dce4ea; border-radius: 9px; }
.wall-list-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 10px; }
.wall-enabled-line { flex-direction: row !important; align-items: center; min-height: 35px; padding: 0 6px; white-space: nowrap; }
.wall-enabled-line input { width: auto; min-height: auto; accent-color: #176b8b; }
.wall-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.wall-field-grid .wide { grid-column: 1 / -1; }
.wall-color-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.wall-color-row label { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 38px; padding: 6px 9px; color: #515154; background: #fff; border: 1px solid #d8e0e6; border-radius: 6px; font-size: 12px; }
.wall-color-row input { width: 42px; height: 28px; padding: 2px; background: #fff; border: 1px solid #cfd8df; border-radius: 5px; }
.wall-inspector-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.wall-inspector-empty { display: grid; min-height: 360px; place-items: center; color: #667085; font-size: 12px; text-align: center; }

@media (max-width: 1240px) {
    .wall-editor-heading { flex-direction: column; }
    .wall-editor-layout { grid-template-columns: 1fr; }
    .wall-plan { min-height: 380px; }
}

@media (max-width: 760px) {
    .wall-heading-actions, .wall-range-row { grid-template-columns: 1fr; flex-wrap: wrap; }
    .wall-range-row { display: grid; }
    .wall-field-grid { grid-template-columns: 1fr; }
    .wall-field-grid .wide { grid-column: auto; }
}
</style>
