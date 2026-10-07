<script setup lang="ts">
import { computed } from 'vue'
import type { Device } from '@/types/domain'
import { deviceKindLabels } from '@/data/mock'

const props = defineProps<{
  devices: Device[]
}>()

const positions = computed(() => {
  const widths = new Map<string, number>()
  const levels = new Map<string, number>()
  const getLevel = (device: Device, visited = new Set<string>()): number => {
    if (!device.parentId || visited.has(device.id)) return 0
    const parent = props.devices.find((item) => item.id === device.parentId)
    if (!parent) return 0
    visited.add(device.id)
    return getLevel(parent, visited) + 1
  }
  props.devices.forEach((device) => {
    const level = getLevel(device)
    const index = widths.get(`level-${level}`) ?? 0
    widths.set(`level-${level}`, index + 1)
    levels.set(device.id, level)
  })
  return props.devices.map((device) => {
    const level = levels.get(device.id) ?? 0
    const sameLevel = props.devices.filter((item) => (levels.get(item.id) ?? 0) === level)
    const row = sameLevel.findIndex((item) => item.id === device.id)
    return {
      ...device,
      x: 35 + level * 185,
      y: 30 + row * 74,
    }
  })
})

const edges = computed(() =>
  positions.value
    .filter((device) => device.parentId)
    .map((device) => {
      const parent = positions.value.find((item) => item.id === device.parentId)
      return parent
        ? {
            id: `${parent.id}-${device.id}`,
            x1: parent.x + 132,
            y1: parent.y + 22,
            x2: device.x,
            y2: device.y + 22,
          }
        : undefined
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge)),
)

const graphHeight = computed(() =>
  Math.max(320, 70 + positions.value.filter((item) => !item.parentId).length * 76),
)
</script>

<template>
  <div class="dependency-graph">
    <svg :viewBox="`0 0 920 ${graphHeight}`" role="img" aria-label="装置依赖图">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#7a94a2" />
        </marker>
      </defs>
      <line
        v-for="edge in edges"
        :key="edge.id"
        :x1="edge.x1"
        :y1="edge.y1"
        :x2="edge.x2"
        :y2="edge.y2"
        stroke="#8ca1ac"
        stroke-width="1.5"
        marker-end="url(#arrow)"
      />
      <g v-for="node in positions" :key="node.id">
        <rect
          :x="node.x"
          :y="node.y"
          width="132"
          height="44"
          rx="5"
          :fill="node.kind === 'relay' ? '#e3f5f1' : '#f2f5f7'"
          :stroke="node.kind === 'relay' ? '#2b7a78' : '#aab9c2'"
        />
        <text :x="node.x + 10" :y="node.y + 18" font-size="11" fill="#6c7f8c">
          {{ deviceKindLabels[node.kind] }} · {{ node.voltage }}kV
        </text>
        <text :x="node.x + 10" :y="node.y + 34" font-size="12" fill="#1f2f3f">
          {{ node.name }}
        </text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.dependency-graph {
  width: 100%;
  overflow: auto;
  background: #f8fafb;
  border: 1px solid #dce4ea;
  border-radius: 5px;
}

svg {
  display: block;
  width: 100%;
  min-width: 760px;
}
</style>
