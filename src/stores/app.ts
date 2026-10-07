import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  ChangeReceipt,
  Device,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  SettingChangeOrder,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import { persistState } from '@/api/client'
import {
  acceptPendingReceipt,
  applyProvisionalSettings,
  backfillLegacySettings,
  buildReconsiderations,
  checksum,
  createId,
  discardPendingReceipt,
  markScenarioStatus,
  now,
  orderProgress,
  receiptMismatch,
  recomputeForMode,
  recoverFromCheckpoint,
} from '@/services/changeOrder'
import {
  clearFailedSession,
  latestCheckpoint,
  loadCheckpoints,
  loadFailedSession,
  saveCheckpoint,
  saveFailedSession,
  type FailedSession,
} from '@/services/storage'
import type { ChangeCheckpoint } from '@/types/domain'

export interface ReceiptSubmission {
  settingId: string
  submittedBy: string
  terminal: string
  receiptNo?: string
  values: ChangeReceipt['values']
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')
  /** 模拟下一次保存失败（秋检现场弱网/录库失败） */
  const failNextSave = ref(false)
  const failedSession = ref<FailedSession | undefined>(loadFailedSession())
  const checkpoints = ref<ChangeCheckpoint[]>(loadCheckpoints())

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const changeOrders = computed(() => data.value.changeOrders)
  const pendingReceipts = computed(() =>
    data.value.pendingReceipts.filter((item) => item.status === 'pending'),
  )
  const resolvedPendingReceipts = computed(() =>
    data.value.pendingReceipts.filter((item) => item.status !== 'pending'),
  )
  const activeOperationMode = computed(() => data.value.activeOperationMode)
  const activeChange = computed(() =>
    data.value.changeOrders.find((order) => order.id === data.value.activeChangeId),
  )
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => data.value.activeBaselineId === baseline.id),
  )
  const legacySettings = computed(() =>
    data.value.settings.filter((setting) => setting.receiptPending),
  )

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  /** 保存成功后写检查点（最近一次完整变更） */
  async function commit(message: string, action = message): Promise<boolean> {
    if (failNextSave.value) {
      failNextSave.value = false
      const session: FailedSession = {
        at: now(),
        action,
        detail: `${message}写入本地持久化失败，可从最近一次完整变更恢复。`,
      }
      saveFailedSession(session)
      failedSession.value = session
      throw new Error('保存失败：本地持久化未成功，数据尚未写入，请从最近一次完整变更恢复。')
    }
    saving.value = true
    try {
      const snapshot = JSON.parse(JSON.stringify(data.value)) as AppState
      const saved = await persistState(snapshot)
      data.value = saved
      checkpoints.value = saveCheckpoint({
        id: createId('checkpoint'),
        createdAt: now(),
        changeId: data.value.activeChangeId,
        label: message,
        state: JSON.parse(JSON.stringify(saved)) as AppState,
      })
      lastMessage.value = message
      clearFailedSession()
      failedSession.value = undefined
      return true
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

  function armSaveFailure() {
    failNextSave.value = true
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
    data.value.issues = validateSettings(
      data.value.settings,
      data.value.devices,
      data.value.activeOperationMode,
    ).map((issue) => ({ ...issue, changeId: data.value.activeChangeId }))
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `按运行方式「${data.value.activeOperationMode}」生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index >= 0) {
      data.value.issues[index] = {
        ...issue,
        stale: false,
        closedAt: issue.status === 'closed' ? now() : issue.closedAt,
      }
    }
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
    markScenarioStatus(scenario, status)
    if (status === 'approved') scenario.basisChangeId = data.value.activeChangeId
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}，依据方式「${scenario.basisOperationMode ?? scenario.operationMode}」。`,
    })
    await commit('场景状态已更新')
  }

  async function acknowledgeScenarioRecalc(id: string) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    scenario.stale = false
    scenario.recalcNote = '已按当前运行方式完成人工复核。'
    scenario.recalculatedAt = now()
    appendAudit({
      action: '场景重算复核',
      target: scenario.name,
      operator: '当前用户',
      detail: `确认「${data.value.activeOperationMode}」下动作序列与停电范围仍然成立。`,
    })
    await commit('场景重算结果已确认')
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

  // ---------- 定值变更单 ----------

  async function createChangeOrder(input: {
    title: string
    operationMode: string
    reason: string
    settingIds: string[]
  }) {
    const order: SettingChangeOrder = {
      id: createId('chg'),
      code: `SD-${new Date().getFullYear()}-${String(data.value.changeOrders.length + 1).padStart(3, '0')}`,
      title: input.title,
      operationMode: input.operationMode,
      previousOperationMode: data.value.activeOperationMode,
      reason: input.reason,
      createdAt: now(),
      createdBy: '方式组',
      status: 'draft',
      provisionalSettings: data.value.settings
        .filter((setting) => input.settingIds.includes(setting.id))
        .map((setting) => ({
          settingId: setting.id,
          relayId: setting.relayId,
          protectedDeviceId: setting.protectedDeviceId,
          stage: setting.stage,
          currentA: setting.currentA,
          timeS: setting.timeS,
          direction: setting.direction,
          sensitivity: setting.sensitivity,
          recloseEnabled: setting.recloseEnabled,
          recloseDelayS: setting.recloseDelayS,
          startCondition: setting.startCondition,
        })),
      receipts: [],
      confirmedOrder: [],
      notes: '',
    }
    data.value.changeOrders.unshift(order)
    appendAudit({
      action: '编制定值变更单',
      target: order.code,
      operator: '方式组',
      detail: `按运行方式「${input.operationMode}」纳入 ${order.provisionalSettings.length} 份临时定值。`,
    })
    await commit(`变更单 ${order.code} 已编制`)
    return order
  }

  async function updateProvisionalSetting(
    orderId: string,
    settingId: string,
    patch: Partial<SettingChangeOrder['provisionalSettings'][number]>,
  ) {
    const order = data.value.changeOrders.find((item) => item.id === orderId)
    const target = order?.provisionalSettings.find((item) => item.settingId === settingId)
    if (order && target) Object.assign(target, patch)
  }

  /** 方式一变：下发即切换运行方式，未批准场景与问题立即重算 */
  async function issueChangeOrder(orderId: string) {
    const order = data.value.changeOrders.find((item) => item.id === orderId)
    if (!order || order.status !== 'draft') return
    order.status = 'issued'
    order.issuedAt = now()
    data.value.activeChangeId = order.id
    data.value.activeOperationMode = order.operationMode
    recomputeForMode(data.value, order.id, order.operationMode)
    appendAudit({
      action: '下发临时定值',
      target: order.code,
      operator: '方式组',
      detail: `运行方式切换为「${order.operationMode}」，${order.provisionalSettings.length} 份临时定值已下发，未批准场景与问题立即重算。`,
    })
    await commit(`变更单 ${order.code} 已下发`)
  }

  /**
   * 两台终端同时提交同一份回执：
   * 先确认的版本有效；后到内容（无论是否一致）留在待核区；录错内容同样进待核区。
   */
  async function submitReceipts(orderId: string, submissions: ReceiptSubmission[]) {
    const order = data.value.changeOrders.find((item) => item.id === orderId)
    if (!order) return { confirmed: 0 as number, pending: 0 as number, completed: false }
    let confirmedCount = 0
    let pendingCount = 0

    submissions.forEach((submission, arrivalIndex) => {
      const target = order.provisionalSettings.find(
        (item) => item.settingId === submission.settingId,
      )
      const relay = data.value.devices.find((device) => device.id === target?.relayId)
      const receipt: ChangeReceipt = {
        id: createId('receipt'),
        receiptNo: submission.receiptNo,
        settingId: submission.settingId,
        deviceName: relay?.name ?? submission.settingId,
        submittedBy: submission.submittedBy,
        submittedAt: now(),
        terminal: submission.terminal,
        status: 'pending',
        values: { ...submission.values },
      }
      const alreadyConfirmed = order.confirmedOrder.includes(submission.settingId)
      const mismatch = receiptMismatch(receipt, target)

      if (alreadyConfirmed) {
        data.value.pendingReceipts.unshift({
          id: createId('pending'),
          changeId: order.id,
          receipt,
          reason: 'duplicate-late',
          status: 'pending',
          receivedAt: now(),
          note: `${submission.terminal} 终端重复提交（到达序 ${arrivalIndex + 1}），同份回执已由先到终端确认，内容留存待核，不再覆盖生效定值。`,
        })
        pendingCount += 1
        return
      }
      if (mismatch) {
        receipt.mismatchNote = '回执抄录值与下发临时定值不一致，疑似现场录错。'
        data.value.pendingReceipts.unshift({
          id: createId('pending'),
          changeId: order.id,
          receipt,
          reason: 'mismatch',
          status: 'pending',
          receivedAt: now(),
          note: `${submission.terminal} 终端回执内容与临时定值不符，已留待核区，需核对录错项后重新提交。`,
        })
        pendingCount += 1
        appendAudit({
          action: '回执录错待核',
          target: receipt.deviceName,
          operator: submission.submittedBy,
          detail: `变更单 ${order.code}：回执与下发临时定值不一致，进入待核区。`,
        })
        return
      }
      receipt.status = 'confirmed'
      receipt.confirmedAt = now()
      order.receipts.push(receipt)
      order.confirmedOrder.push(submission.settingId)
      confirmedCount += 1
      appendAudit({
        action: '回执确认',
        target: receipt.deviceName,
        operator: submission.submittedBy,
        detail: `变更单 ${order.code}：${submission.terminal} 终端先到，回执${receipt.receiptNo ? ` ${receipt.receiptNo}` : ''}确认有效（到达序 ${arrivalIndex + 1}）。`,
      })
    })

    const progress = orderProgress(order)
    let completed = false
    if (progress.confirmed >= progress.total && progress.total > 0) {
      applyProvisionalSettings(data.value, order)
      order.status = 'applied'
      order.appliedAt = now()
      recomputeForMode(data.value, order.id, order.operationMode)
      completed = true
      appendAudit({
        action: '临时定值生效',
        target: order.code,
        operator: '系统',
        detail: `全部 ${progress.total} 台设备回执确认完毕，临时定值转生效，按「${order.operationMode}」重算问题与未批准场景。`,
      })
    }

    await commit(
      `回执确认 ${confirmedCount} 份，待核 ${pendingCount} 份${completed ? '，变更单已闭环' : ''}`,
      '提交现场回执',
    )
    return { confirmed: confirmedCount, pending: pendingCount, completed }
  }

  // ---------- 待核区 ----------

  async function acceptPending(pendingId: string, receiptNo: string) {
    const item = acceptPendingReceipt(data.value, pendingId, receiptNo.trim())
    if (!item) return
    appendAudit({
      action: '待核回执采用',
      target: item.receipt.deviceName,
      operator: '当前用户',
      detail: `待核项 ${item.id} 内容已采用并补录回执编号，定值依据更新。`,
    })
    await commit('待核回执已采用')
  }

  async function discardPending(pendingId: string) {
    discardPendingReceipt(data.value, pendingId)
    appendAudit({
      action: '待核回执作废',
      target: pendingId,
      operator: '当前用户',
      detail: '以先确认版本为准，后到/录错内容作废。',
    })
    await commit('待核回执已作废')
  }

  /** 旧数据缺回执编号：先回填运行方式，再转待核 */
  async function backfillLegacy(mode: string) {
    const touched = backfillLegacySettings(data.value, mode)
    appendAudit({
      action: '旧数据回填',
      target: '缺回执编号定值',
      operator: '当前用户',
      detail: `已回填运行方式「${mode}」，${touched} 份定值中缺回执编号者转入待核区，补齐前不得作为签字依据。`,
    })
    await commit('旧数据运行方式已回填')
  }

  // ---------- 保存失败恢复 ----------

  /** 从最近一次完整变更恢复，只补未确认设备 */
  async function recoverAfterFailure() {
    const checkpoint = latestCheckpoint()
    if (!checkpoint) throw new Error('没有可恢复的完整变更检查点')
    const restored = JSON.parse(JSON.stringify(checkpoint.state)) as AppState
    const { supplemented, order } = recoverFromCheckpoint(restored)
    data.value = restored
    appendAuditLocal(restored, {
      action: '故障恢复',
      target: order?.code ?? checkpoint.label,
      operator: '当前用户',
      detail: `从检查点 ${checkpoint.label}（${new Date(checkpoint.createdAt).toLocaleString('zh-CN')}）恢复，${supplemented.length} 台未确认设备只补录到待核区，已确认设备不重放。`,
    })
    clearFailedSession()
    failedSession.value = undefined
    await commit('已从最近一次完整变更恢复')
    return supplemented.length
  }

  function appendAuditLocal(state: AppState, entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    state.audit.unshift({ ...entry, id: createId('audit'), createdAt: now() })
  }

  // ---------- 基线 ----------

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
      changeId: data.value.activeChangeId,
      operationMode: data.value.activeOperationMode,
      reconsiderations: [],
    }
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: `${note}；运行方式「${data.value.activeOperationMode}」。`,
    })
    await commit('基线已创建并提交会签')
    return baseline
  }

  /** 锁定基线：保留原依据，未闭环问题不阻断，另列复议项 */
  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return
    const reconsiderations = buildReconsiderations(data.value.issues, baseline.id)
    baseline.status = 'locked'
    baseline.lockedAt = now()
    baseline.changeId = baseline.changeId ?? data.value.activeChangeId
    baseline.operationMode = baseline.operationMode ?? data.value.activeOperationMode
    baseline.originalBasisNote =
      baseline.originalBasisNote ??
      `锁定依据：运行方式「${baseline.operationMode}」，变更单 ${baseline.changeId ?? '无'}；定值快照与校验码 ${baseline.checksum} 保持不变。`
    baseline.reconsiderations = reconsiderations
    data.value.activeBaselineId = baseline.id
    if (baseline.changeId) {
      const order = data.value.changeOrders.find((item) => item.id === baseline.changeId)
      if (order) order.status = 'archived'
    }
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}；${reconsiderations.length} 项未闭环问题保留原依据并另列复议项。`,
    })
    await commit('基线已锁定，复议项已单列')
  }

  async function resolveReconsideration(baselineId: string, itemId: string) {
    const baseline = data.value.baselines.find((item) => item.id === baselineId)
    const recon = baseline?.reconsiderations.find((item) => item.id === itemId)
    if (!baseline || !recon) return
    recon.resolved = true
    data.value.issues = data.value.issues.map((issue) =>
      issue.id === recon.issueId ? { ...issue, stale: true } : issue,
    )
    appendAudit({
      action: '复议项闭环',
      target: recon.pairLabel,
      operator: '当前用户',
      detail: `基线 ${baseline.version} 复议项已形成结论并转回校核台复核。`,
    })
    await commit('复议项已闭环')
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
    failedSession.value = undefined
    await commit('已恢复演示数据')
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    failedSession,
    checkpoints,
    devices,
    settings,
    issues,
    scenarios,
    changeOrders,
    pendingReceipts,
    resolvedPendingReceipts,
    activeOperationMode,
    activeChange,
    activeBaseline,
    legacySettings,
    hydrate,
    armSaveFailure,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    acknowledgeScenarioRecalc,
    addScenario,
    createChangeOrder,
    updateProvisionalSetting,
    issueChangeOrder,
    submitReceipts,
    acceptPending,
    discardPending,
    backfillLegacy,
    recoverAfterFailure,
    createBaseline,
    approveBaseline,
    resolveReconsideration,
    recordExport,
    reset,
  }
})
