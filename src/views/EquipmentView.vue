<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { deviceKindLabels } from '@/data/mock'
import type { DeviceKind, DeviceStatus } from '@/types/domain'

const router = useRouter()
const store = useAppStore()
const { devices, settings } = storeToRefs(store)
const keyword = ref('')
const kind = ref<DeviceKind | ''>('')
const status = ref<DeviceStatus | ''>('')

const filtered = computed(() =>
  devices.value.filter((device) => {
    const matchesKeyword =
      !keyword.value ||
      `${device.name}${device.code}${device.station}`.toLowerCase().includes(keyword.value.toLowerCase())
    const matchesKind = !kind.value || device.kind === kind.value
    const matchesStatus = !status.value || device.status === status.value
    return matchesKeyword && matchesKind && matchesStatus
  }),
)

const settingCount = (deviceId: string) =>
  settings.value.filter((setting) => setting.protectedDeviceId === deviceId || setting.relayId === deviceId)
    .length

const statusText = (value: DeviceStatus) =>
  ({ running: '运行', maintenance: '检修', stopped: '停用' })[value]
</script>

<template>
  <div>
    <PageHeader
      title="设备与保护台账"
      description="按站所维护线路、变压器、母线、断路器和保护装置，并进入编辑器维护定值。"
    >
      <template #actions>
        <el-button type="primary" @click="router.push('/devices/new')">新增设备</el-button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索名称、编号或站所" clearable style="width: 260px" />
      <el-select v-model="kind" placeholder="设备类型" clearable style="width: 150px">
        <el-option v-for="(label, value) in deviceKindLabels" :key="value" :label="label" :value="value" />
      </el-select>
      <el-select v-model="status" placeholder="运行状态" clearable style="width: 140px">
        <el-option label="运行" value="running" />
        <el-option label="检修" value="maintenance" />
        <el-option label="停用" value="stopped" />
      </el-select>
      <span class="grow" />
      <span class="muted">共 {{ filtered.length }} 台设备 · {{ settings.length }} 份定值</span>
    </div>

    <section class="panel">
      <el-table :data="filtered" row-key="id">
        <el-table-column prop="code" label="设备编号" width="130" />
        <el-table-column prop="name" label="设备名称" min-width="190" />
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ deviceKindLabels[row.kind as DeviceKind] }}</template>
        </el-table-column>
        <el-table-column prop="station" label="所属站所" width="150" />
        <el-table-column label="电压等级" width="110">
          <template #default="{ row }">{{ row.voltage }} kV</template>
        </el-table-column>
        <el-table-column label="上级设备" min-width="170">
          <template #default="{ row }">
            {{ devices.find((item) => item.id === row.parentId)?.name ?? '无' }}
          </template>
        </el-table-column>
        <el-table-column label="定值数量" width="95">
          <template #default="{ row }">{{ settingCount(row.id) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'running' ? 'success' : 'warning'" effect="plain">
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="router.push(`/devices/${row.id}`)">编辑</el-button>
            <el-button link @click="router.push(`/coordination?device=${row.id}`)">校核</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>
