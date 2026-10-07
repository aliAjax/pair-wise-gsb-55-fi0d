<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ProtectionSetting } from '@/types/domain'

const props = defineProps<{
  settings: ProtectionSetting[]
  selectedRelayId?: string
}>()

const canvasRef = ref<HTMLCanvasElement>()
const zoomX = ref(1)
const zoomY = ref(1)
const hovered = ref('')
let observer: ResizeObserver | undefined

const visibleSettings = computed(() =>
  props.selectedRelayId
    ? props.settings.filter((setting) => setting.relayId === props.selectedRelayId)
    : props.settings,
)

const colors = ['#57d0c7', '#f2b74a', '#e66a6a', '#69a9e6', '#b8d96b']

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.floor(rect.width * ratio))
  canvas.height = Math.max(1, Math.floor(rect.height * ratio))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

  const width = rect.width
  const height = rect.height
  const left = 70
  const top = 30
  const right = 26
  const bottom = 52
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const maxTime = Math.max(1.2, ...visibleSettings.value.map((item) => item.timeS)) * 1.15
  const maxCurrent = Math.max(10, ...visibleSettings.value.map((item) => item.currentA)) * 1.2

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#10232e'
  ctx.fillRect(0, 0, width, height)

  ctx.strokeStyle = '#294652'
  ctx.lineWidth = 1
  ctx.font = '12px sans-serif'
  ctx.fillStyle = '#91aab4'

  for (let index = 0; index <= 5; index += 1) {
    const x = left + (plotWidth * index) / 5
    const y = top + (plotHeight * index) / 5
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + plotHeight)
    ctx.stroke()
    ctx.fillText(((maxTime * index) / (5 * zoomX.value)).toFixed(1), x - 10, top + plotHeight + 24)

    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(left + plotWidth, y)
    ctx.stroke()
    ctx.fillText(((maxCurrent * (5 - index)) / (5 * zoomY.value)).toFixed(1), 16, y + 4)
  }

  ctx.strokeStyle = '#78909c'
  ctx.beginPath()
  ctx.moveTo(left, top)
  ctx.lineTo(left, top + plotHeight)
  ctx.lineTo(left + plotWidth, top + plotHeight)
  ctx.stroke()
  ctx.fillStyle = '#b9cbd3'
  ctx.fillText('动作时限 / s', left + plotWidth - 78, top + plotHeight + 43)
  ctx.save()
  ctx.translate(18, top + 18)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('电流定值 / A', 0, 0)
  ctx.restore()

  const sorted = [...visibleSettings.value].sort((a, b) => a.stage.localeCompare(b.stage))
  sorted.forEach((setting, index) => {
    const xEnd =
      left + Math.min(plotWidth, (setting.timeS / maxTime) * plotWidth * zoomX.value)
    const y = top + plotHeight - (setting.currentA / maxCurrent) * plotHeight * zoomY.value
    const yClamped = Math.max(top + 2, Math.min(top + plotHeight - 2, y))
    const startX = left + 10
    const pickX = left + plotWidth * 0.72
    const curveY = Math.min(top + plotHeight - 8, yClamped + 18)

    ctx.strokeStyle = colors[index % colors.length]
    ctx.lineWidth = hovered.value === setting.id ? 4 : 2.5
    ctx.beginPath()
    ctx.moveTo(startX, curveY)
    ctx.bezierCurveTo(
      startX + (pickX - startX) * 0.55,
      curveY,
      xEnd - 30,
      yClamped,
      xEnd,
      yClamped,
    )
    ctx.stroke()
    ctx.fillStyle = colors[index % colors.length]
    ctx.beginPath()
    ctx.arc(xEnd, yClamped, hovered.value === setting.id ? 7 : 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillText(`${setting.stage}段 ${setting.timeS}s`, xEnd + 7, yClamped - 8)
    ctx.fillStyle = '#b9cbd3'
    ctx.fillText(`${setting.currentA}A`, startX, curveY - 8)
  })

  ctx.fillStyle = '#7d98a3'
  ctx.fillText(`缩放 X ${zoomX.value.toFixed(2)} / Y ${zoomY.value.toFixed(2)}`, left, 18)
}

function resetZoom() {
  zoomX.value = 1
  zoomY.value = 1
}

function onWheel(event: WheelEvent) {
  const direction = event.deltaY > 0 ? -0.1 : 0.1
  if (event.shiftKey) {
    zoomY.value = Math.max(0.5, Math.min(2.5, zoomY.value + direction))
  } else {
    zoomX.value = Math.max(0.5, Math.min(2.5, zoomX.value + direction))
  }
}

function onMove(event: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  const left = 70
  const top = 30
  const plotWidth = rect.width - 96
  const plotHeight = rect.height - 82
  const maxTime = Math.max(1.2, ...visibleSettings.value.map((item) => item.timeS)) * 1.15
  const maxCurrent = Math.max(10, ...visibleSettings.value.map((item) => item.currentA)) * 1.2
  const found = visibleSettings.value.find((setting) => {
    const pointX = left + Math.min(plotWidth, (setting.timeS / maxTime) * plotWidth * zoomX.value)
    const pointY =
      top + plotHeight - (setting.currentA / maxCurrent) * plotHeight * zoomY.value
    return Math.hypot(pointX - x, pointY - y) < 12
  })
  hovered.value = found?.id ?? ''
}

watch([visibleSettings, zoomX, zoomY, hovered], () => nextTick(draw), { deep: true })

onMounted(() => {
  if (!canvasRef.value) return
  observer = new ResizeObserver(draw)
  observer.observe(canvasRef.value)
  draw()
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div>
    <div class="canvas-toolbar">
      <span class="muted">滚轮缩放时间轴，Shift + 滚轮缩放电流轴。</span>
      <el-button size="small" @click="resetZoom">复位缩放</el-button>
    </div>
    <div class="canvas-host">
      <canvas
        ref="canvasRef"
        aria-label="保护配合曲线"
        @wheel.prevent="onWheel"
        @mousemove="onMove"
        @mouseleave="hovered = ''"
      />
    </div>
  </div>
</template>
