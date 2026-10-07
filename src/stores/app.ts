import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import { persistState } from '@/api/client'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

function checksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map((item) => `${item.id}:${item.currentA}:${item.timeS}:${item.recloseDelayS}`)
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  async function commit(message: string) {
    saving.value = true
    try {
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      lastMessage.value = message
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    data.value.audit.unshift({
      ...entry,
      id: createId('audit'),
      createdAt: now(),
    })
  }

  async function addDevice(device: Omit<Device, 'id'>) {
    const item = { ...device, id: createId('device') }
    data.value.devices.push(item)
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: '当前用户',
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV。`,
    })
    await commit(`已新增 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    data.value.devices[index] = { ...device, operationModes: [...device.operationModes] }
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: '当前用户',
      detail: `运行状态调整为 ${device.status}。`,
    })
    await commit(`已更新 ${device.name}`)
  }

  async function saveSetting(setting: ProtectionSetting) {
    const index = data.value.settings.findIndex((item) => item.id === setting.id)
    const next = { ...setting, updatedAt: now() }
    if (index >= 0) data.value.settings[index] = next
    else data.value.settings.push(next)
    appendAudit({
      action: index >= 0 ? '修改定值' : '新增定值',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: '当前用户',
      detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s。`,
    })
    await commit('定值已保存')
  }

  async function runValidation() {
    data.value.issues = validateSettings(data.value.settings, data.value.devices)
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index >= 0) data.value.issues[index] = issue
    appendAudit({
      action: '更新问题状态',
      target: issue.pairLabel,
      operator: '当前用户',
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新')
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    data.value.comments.unshift({
      ...comment,
      id: createId('comment'),
      createdAt: now(),
    })
    appendAudit({
      action: '提交会签意见',
      target: comment.targetId,
      operator: comment.author,
      detail: comment.content,
    })
    await commit('意见已提交')
  }

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    scenario.status = status
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}。`,
    })
    await commit('场景状态已更新')
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    const item = {
      ...scenario,
      id: createId('scenario'),
      status: 'draft' as const,
      steps: [],
      createdAt: now(),
    }
    data.value.scenarios.unshift(item)
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: '当前用户',
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
    })
    await commit('故障场景已创建')
    return item
  }

  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      snapshot: JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[],
      checksum: checksum(data.value.settings),
    }
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: note,
    })
    await commit('基线已创建并提交会签')
    return baseline
  }

  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return
    if (data.value.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    baseline.status = 'locked'
    baseline.lockedAt = now()
    data.value.activeBaselineId = baseline.id
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}。`,
    })
    await commit('基线已锁定')
  }

  async function recordExport(format: string, count: number) {
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: '当前用户',
      detail: `导出 ${count} 条保护定值。`,
    })
    await commit('导出记录已写入审计')
  }

  async function reset() {
    data.value = createInitialState()
    await commit('已恢复演示数据')
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    devices,
    settings,
    issues,
    scenarios,
    activeBaseline,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    createBaseline,
    approveBaseline,
    recordExport,
    reset,
  }
})
