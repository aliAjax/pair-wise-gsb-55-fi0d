<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { operationModes } from '@/data/mock'
import type { ReviewStatus } from '@/types/domain'

const store = useAppStore()
const { devices, scenarios } = storeToRefs(store)
const selectedId = ref(scenarios.value[0]?.id ?? '')
const compareId = ref(scenarios.value[1]?.id ?? '')
const playbackIndex = ref(-1)
const playing = ref(false)
const createDialog = ref(false)
let playbackTimer: number | undefined

const form = reactive({
  name: '',
  operationMode: operationModes[0],
  faultDeviceId: '',
  faultType: '单相接地',
  outageDevices: [] as string[],
  notes: '',
})

const selected = computed(() => scenarios.value.find((item) => item.id === selectedId.value))
const compared = computed(() => scenarios.value.find((item) => item.id === compareId.value))

const statusText = (status: ReviewStatus) =>
  ({
    draft: '草稿',
    reviewing: '会签中',
    approved: '已批准',
    locked: '已锁定',
    returned: '已退回',
  })[status]

const statusType = (status: ReviewStatus) =>
  status === 'approved' || status === 'locked'
    ? 'success'
    : status === 'reviewing'
      ? 'warning'
      : status === 'returned'
        ? 'danger'
        : 'info'

const outageDiff = computed(() => {
  if (!selected.value || !compared.value) return { leftOnly: [], rightOnly: [] }
  return {
    leftOnly: selected.value.outageDevices.filter(
      (id) => !compared.value?.outageDevices.includes(id),
    ),
    rightOnly: compared.value.outageDevices.filter(
      (id) => !selected.value?.outageDevices.includes(id),
    ),
  }
})

watch(scenarios, (list) => {
  if (!list.some((item) => item.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
  if (!list.some((item) => item.id === compareId.value)) {
    compareId.value = list.find((item) => item.id !== selectedId.value)?.id ?? ''
  }
})

function stopPlayback() {
  if (playbackTimer) window.clearInterval(playbackTimer)
  playbackTimer = undefined
  playing.value = false
}

function replay() {
  stopPlayback()
  if (!selected.value?.steps.length) {
    ElMessage.warning('当前场景尚未配置动作序列')
    return
  }
  playbackIndex.value = -1
  playing.value = true
  playbackTimer = window.setInterval(() => {
    const next = playbackIndex.value + 1
    if (!selected.value || next >= selected.value.steps.length) {
      stopPlayback()
      return
    }
    playbackIndex.value = next
  }, 700)
}

async function changeStatus(status: ReviewStatus) {
  if (!selected.value) return
  await store.updateScenarioStatus(selected.value.id, status)
  ElMessage.success(`场景状态已更新为${statusText(status)}`)
}

async function createScenario() {
  if (!form.name.trim() || !form.faultDeviceId) {
    ElMessage.warning('请填写场景名称并选择故障设备')
    return
  }
  const created = await store.addScenario({
    name: form.name.trim(),
    operationMode: form.operationMode,
    faultDeviceId: form.faultDeviceId,
    faultType: form.faultType,
    outageDevices: [...form.outageDevices],
    notes: form.notes,
  })
  selectedId.value = created.id
  createDialog.value = false
  Object.assign(form, {
    name: '',
    operationMode: operationModes[0],
    faultDeviceId: '',
    faultType: '单相接地',
    outageDevices: [],
    notes: '',
  })
  ElMessage.success('故障场景已创建')
}

onBeforeUnmount(stopPlayback)
</script>

<template>
  <div>
    <PageHeader
      title="运行方式与故障场景"
      description="建立多个运行方式和故障场景，比较保护动作顺序与停电范围，并逐场景完善动作序列。"
    >
      <template #actions>
        <el-button :disabled="!selected || playing" @click="replay">异常场景回放</el-button>
        <el-button type="primary" @click="createDialog = true">新建场景</el-button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <el-select v-model="selectedId" placeholder="选择场景" style="width: 330px">
        <el-option v-for="scenario in scenarios" :key="scenario.id" :label="scenario.name" :value="scenario.id" />
      </el-select>
      <span class="muted">对比场景</span>
      <el-select v-model="compareId" clearable placeholder="选择对比场景" style="width: 300px">
        <el-option
          v-for="scenario in scenarios.filter((item) => item.id !== selectedId)"
          :key="scenario.id"
          :label="scenario.name"
          :value="scenario.id"
        />
      </el-select>
      <span class="grow" />
      <el-tag v-if="selected" :type="statusType(selected.status)" effect="plain">
        {{ statusText(selected.status) }}
      </el-tag>
    </div>

    <div v-if="selected" class="two-column">
      <section class="panel">
        <div class="panel-title">
          <div>
            <h3>{{ selected.name }}</h3>
            <span class="muted">{{ selected.operationMode }} · {{ selected.faultType }}</span>
          </div>
          <div>
            <el-button
              v-if="selected.status === 'draft' || selected.status === 'returned'"
              type="primary"
              @click="changeStatus('reviewing')"
            >
              提交会签
            </el-button>
            <template v-if="selected.status === 'reviewing'">
              <el-button type="success" @click="changeStatus('approved')">批准场景</el-button>
              <el-button type="danger" plain @click="changeStatus('returned')">退回补充</el-button>
            </template>
          </div>
        </div>

        <el-timeline>
          <el-timeline-item
            v-for="(step, index) in selected.steps"
            :key="`${step.sequence}-${step.relayId}`"
            :timestamp="`${step.delayMs} ms`"
            :type="playbackIndex >= index ? 'success' : 'info'"
            :hollow="playbackIndex < index"
          >
            <div :class="{ 'step-active': playbackIndex === index }">
              <strong>{{ step.sequence }}. {{ devices.find((item) => item.id === step.relayId)?.name ?? step.relayId }}</strong>
              <p>{{ step.action }}</p>
              <el-tag size="small" effect="plain">
                {{ step.status === 'executed' ? '已执行' : step.status === 'skipped' ? '跳过' : '待确认' }}
              </el-tag>
            </div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-if="!selected.steps.length" description="新建场景暂无动作序列，请在后续编辑器中补充" />

        <div class="panel-title" style="margin-top: 20px">
          <h3>停电范围</h3>
          <el-tag type="warning" effect="plain">{{ selected.outageDevices.length }} 台设备</el-tag>
        </div>
        <el-space wrap>
          <el-tag v-for="id in selected.outageDevices" :key="id" effect="plain">
            {{ devices.find((item) => item.id === id)?.name ?? id }}
          </el-tag>
        </el-space>
        <p class="muted">{{ selected.notes || '暂无审校备注。' }}</p>
      </section>

      <section class="panel">
        <div class="panel-title"><h3>场景差异</h3></div>
        <template v-if="compared">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="当前动作数">{{ selected.steps.length }}</el-descriptions-item>
            <el-descriptions-item label="对比动作数">{{ compared.steps.length }}</el-descriptions-item>
            <el-descriptions-item label="当前停电数">{{ selected.outageDevices.length }}</el-descriptions-item>
            <el-descriptions-item label="对比停电数">{{ compared.outageDevices.length }}</el-descriptions-item>
          </el-descriptions>
          <h4>仅当前场景停电</h4>
          <el-alert
            v-for="id in outageDiff.leftOnly"
            :key="id"
            :title="devices.find((item) => item.id === id)?.name ?? id"
            type="warning"
            :closable="false"
          />
          <el-empty v-if="!outageDiff.leftOnly.length" description="无差异" :image-size="60" />
          <h4>仅对比场景停电</h4>
          <el-alert
            v-for="id in outageDiff.rightOnly"
            :key="id"
            :title="devices.find((item) => item.id === id)?.name ?? id"
            type="info"
            :closable="false"
          />
          <el-empty v-if="!outageDiff.rightOnly.length" description="无差异" :image-size="60" />
        </template>
        <el-empty v-else description="请选择对比场景" />
      </section>
    </div>

    <el-dialog v-model="createDialog" title="新建故障场景" width="620px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="场景名称" required>
          <el-input v-model="form.name" placeholder="例如 110kV 母线故障且 1 号主变检修" />
        </el-form-item>
        <el-form-item label="运行方式" required>
          <el-select v-model="form.operationMode" style="width: 100%">
            <el-option v-for="mode in operationModes" :key="mode" :label="mode" :value="mode" />
          </el-select>
        </el-form-item>
        <el-form-item label="故障设备" required>
          <el-select v-model="form.faultDeviceId" filterable style="width: 100%">
            <el-option
              v-for="device in devices.filter((item) => ['line', 'transformer', 'bus'].includes(item.kind))"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="故障类型">
          <el-select v-model="form.faultType" style="width: 100%">
            <el-option label="单相接地" value="单相接地" />
            <el-option label="相间短路" value="相间短路" />
            <el-option label="母线短路" value="母线短路" />
            <el-option label="设备拒动" value="设备拒动" />
          </el-select>
        </el-form-item>
        <el-form-item label="停电范围">
          <el-select v-model="form.outageDevices" multiple filterable style="width: 100%">
            <el-option
              v-for="device in devices.filter((item) => item.kind !== 'relay')"
              :key="device.id"
              :label="device.name"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="审校备注">
          <el-input v-model="form.notes" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="createScenario">创建场景</el-button>
      </template>
    </el-dialog>
  </div>
</template>
