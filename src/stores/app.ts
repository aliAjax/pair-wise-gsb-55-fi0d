import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  PendingReviewReceipt,
  ProtectionSetting,
  ReceiptChannel,
  RecoveryNotice,
  ReviewComment,
  ReviewStatus,
  SettingChangeItem,
  SettingChangeOrder,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState, MODE_PENDING } from '@/data/mock'
import {
  buildReconsideration,
  createId,
  describePayloadDiff,
  effectiveSettings,
  isScenarioUnapproved,
  makePendingReceipt,
  now,
  projectSettings,
  revalidateEffective,
} from '@/services/changeOrder'
import { armSaveFailure, persistState, recoverFromCheckpoint } from '@/api/client'

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

export interface NewChangeOrderInput {
  title: string
  reason: string
  season: string
  modeBefore: string
  modeAfter: string
  affectedDeviceIds: string[]
  entries: { settingId: string; after: ProtectionSetting }[]
}

export interface ReceiptInput {
  receiptNo?: string
  channel: ReceiptChannel
  payload?: Partial<ProtectionSetting>
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')
  const recoveryNotice = ref<RecoveryNotice>()

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const changeOrders = computed(() => data.value.changeOrders)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )
  /** 叠加所有在途变更临时定值后的审校视图 */
  const effectiveSettingList = computed(() => effectiveSettings(data.value))
  const pendingCount = computed(() =>
    data.value.changeOrders.reduce((sum, order) => sum + order.pendingReceipts.length, 0),
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

  const findOrder = (id: string) => data.value.changeOrders.find((order) => order.id === id)

  // ---------- 设备与基线定值 ----------

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
      detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s（基线定值维护）。`,
    })
    await commit('定值已保存')
  }

  // ---------- 校验问题 ----------

  async function runValidation() {
    // 审校台始终看叠加临时定值的结果，避免“方式变了仍拿旧定值签字”
    revalidateEffective(data.value)
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `按在途临时定值重算，生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index >= 0) data.value.issues[index] = issue
    const order = issue.changeOrderId ? findOrder(issue.changeOrderId) : undefined
    if (order?.revalidation) {
      const at = order.revalidation.issues.findIndex((item) => item.id === issue.id)
      if (at >= 0) order.revalidation.issues[at] = issue
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

  // ---------- 故障场景 ----------

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    scenario.status = status
    if (['approved', 'locked'].includes(status)) scenario.needsRecheck = false
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
    // 新场景立即纳入所有在途变更的重算范围
    revalidateEffective(data.value)
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: '当前用户',
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
    })
    await commit('故障场景已创建')
    return item
  }

  // ---------- 定值变更单（主线） ----------

  async function createChangeOrder(input: NewChangeOrderInput) {
    const order: SettingChangeOrder = {
      id: createId('order'),
      code: `QJ-${new Date().getFullYear()}-D${String(data.value.changeOrders.length + 1).padStart(3, '0')}`,
      title: input.title.trim(),
      reason: input.reason.trim(),
      createdAt: now(),
      issuedAt: now(),
      status: 'issued',
      season: input.season || `${new Date().getFullYear()} 秋检`,
      modeBefore: input.modeBefore,
      modeAfter: input.modeAfter,
      affectedDeviceIds: [...input.affectedDeviceIds],
      items: input.entries.map((entry) => {
        const before = data.value.settings.find((setting) => setting.id === entry.settingId)
        if (!before) throw new Error(`未找到基线定值 ${entry.settingId}`)
        return {
          id: createId('item'),
          relayId: before.relayId,
          protectedDeviceId: before.protectedDeviceId,
          stage: before.stage,
          before: { ...before },
          after: { ...entry.after, id: before.id, updatedAt: now() },
          confirmed: false,
        } satisfies SettingChangeItem
      }),
      originalBasis: JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[],
      pendingReceipts: [],
      reconsideration: [],
    }
    data.value.changeOrders.unshift(order)
    revalidateEffective(data.value)
    appendAudit({
      action: '下发定值变更单',
      target: order.code,
      operator: '当前用户',
      detail: `${order.modeBefore} → ${order.modeAfter}，${order.items.length} 份临时定值已下发并立即重算。`,
    })
    await commit('变更单已下发，未批准场景与问题已重算')
    return order
  }

  /** 方式一变：立即重算未批准场景和问题 */
  async function changeOrderMode(orderId: string, modeAfter: string) {
    const order = findOrder(orderId)
    if (!order || order.status === 'completed') return
    order.modeAfter = modeAfter
    revalidateEffective(data.value)
    appendAudit({
      action: '变更运行方式',
      target: order.code,
      operator: '当前用户',
      detail: `方式调整为「${modeAfter}」，未批准场景与问题已立即重算。`,
    })
    await commit('运行方式已变更，校核结果已刷新')
  }

  /**
   * 现场回执提交：同一变更条目先到先得。
   * 后到重复、内容不符的回执不覆盖有效版本，直接进待核区。
   */
  async function submitReceipt(orderId: string, itemId: string, input: ReceiptInput) {
    const order = findOrder(orderId)
    const item = order?.items.find((entry) => entry.id === itemId)
    if (!order || !item) throw new Error('变更条目不存在')
    if (order.status === 'completed') throw new Error('变更单已完成，回执请走复议流程')

    const submittedAt = now()
    if (item.confirmed) {
      const diff = input.payload ? describePayloadDiff(input.payload, item.after) : ''
      const reason = diff ? 'content-mismatch' : 'duplicate-late'
      order.pendingReceipts.unshift(
        makePendingReceipt({
          item,
          receiptNo: input.receiptNo ?? '未填编号',
          channel: input.channel,
          submittedAt,
          payload: input.payload ?? {},
          reason,
          detail:
            reason === 'duplicate-late'
              ? `重复回执晚到：有效版本来自 ${item.confirmedBy === 'terminal-a' ? '终端 A' : '终端 B'}（${item.receiptNo}）。`
              : `回执内容与已确认定值不符：${diff}。`,
        }),
      )
      appendAudit({
        action: '回执进入待核区',
        target: `${order.code} ${item.stage} 段`,
        operator: input.channel === 'terminal-a' ? '终端 A' : '终端 B',
        detail: reason === 'duplicate-late' ? '两台终端提交同一回执，后到版本留待核。' : '回执内容与有效版本不一致。',
      })
      await commit('后到回执已进入待核区，有效版本不变')
      return { accepted: false as const, reason }
    }

    item.confirmed = true
    item.confirmedBy = input.channel
    item.confirmedAt = submittedAt
    item.receiptNo = input.receiptNo?.trim() || `RC-${Date.now().toString(36).toUpperCase()}`
    appendAudit({
      action: '确认现场回执',
      target: `${order.code} ${item.stage} 段`,
      operator: input.channel === 'terminal-a' ? '终端 A' : '终端 B',
      detail: `回执编号 ${item.receiptNo}，先到版本有效。`,
    })
    await commit('回执已确认')
    return { accepted: true as const }
  }

  /** 待核区条目核入：重复回执按其内容再确认（复议入口），旧数据核入前必须已回填方式 */
  async function admitPending(orderId: string, pendingId: string, receiptNo: string) {
    const order = findOrder(orderId)
    const pending = order?.pendingReceipts.find((item) => item.id === pendingId)
    const item = order?.items.find((entry) => entry.id === pending?.changeItemId)
    if (!order || !pending || !item) throw new Error('待核条目不存在')
    if (pending.reason.startsWith('legacy') && !pending.modeBackfilled) {
      throw new Error('旧数据请先回填运行方式，再核入回执')
    }
    item.confirmed = true
    item.confirmedBy = pending.channel
    item.confirmedAt = now()
    item.receiptNo = receiptNo.trim() || pending.receiptNo || `RC-LEGACY-${Date.now().toString(36).toUpperCase()}`
    order.pendingReceipts = order.pendingReceipts.filter((entry) => entry.id !== pendingId)
    appendAudit({
      action: '待核回执核入',
      target: `${order.code} ${item.stage} 段`,
      operator: '当前用户',
      detail: `回执编号 ${item.receiptNo}，待核条目已人工确认。`,
    })
    await commit('待核回执已核入')
  }

  async function discardPending(orderId: string, pendingId: string) {
    const order = findOrder(orderId)
    if (!order) return
    const pending = order.pendingReceipts.find((item) => item.id === pendingId)
    order.pendingReceipts = order.pendingReceipts.filter((item) => item.id !== pendingId)
    appendAudit({
      action: '驳回待核回执',
      target: order.code,
      operator: '当前用户',
      detail: pending ? `${pending.relayId} ${pending.stage} 段待核回执已驳回。` : '待核回执已驳回。',
    })
    await commit('待核回执已驳回')
  }

  /** 旧数据缺回执编号：先回填运行方式再待核 */
  async function backfillLegacyMode(orderId: string, modeAfter: string) {
    const order = findOrder(orderId)
    if (!order || !order.legacyImport) return
    order.modeAfter = modeAfter
    order.pendingReceipts = order.pendingReceipts.map((pending) =>
      pending.reason === 'legacy-no-receipt' ? { ...pending, reason: 'legacy-mode-pending', modeBackfilled: true } : pending,
    )
    // 方式回填后，该单进入重算范围
    revalidateEffective(data.value)
    appendAudit({
      action: '回填运行方式',
      target: order.code,
      operator: '当前用户',
      detail: `旧单补录方式「${modeAfter}」，问题与场景已重算，回执仍待核。`,
    })
    await commit('运行方式已回填，待核条目可核入')
  }

  // ---------- 基线锁定：保留原依据并另列复议项 ----------

  /**
   * 完成变更单并锁定基线：
   * - 已确认条目的临时定值固化进新基线；
   * - 未确认条目保留原依据定值，并另列复议项；
   * - 与未确认条目相关的高风险问题随复议项保留，不阻塞锁定。
   */
  async function completeChangeOrder(orderId: string, note: string) {
    const order = findOrder(orderId)
    if (!order) throw new Error('变更单不存在')
    if (order.status === 'completed') throw new Error('变更单已完成')
    if (order.modeAfter === MODE_PENDING) throw new Error('运行方式未回填，不能锁定基线')

    const confirmed = order.items.filter((item) => item.confirmed)
    const unconfirmed = order.items.filter((item) => !item.confirmed)

    const blocking = data.value.issues.filter(
      (issue) =>
        issue.changeOrderId === order.id &&
        issue.level === 'high' &&
        issue.status !== 'closed' &&
        !unconfirmed.some((item) => issue.settingIds.includes(item.after.id)),
    )
    if (blocking.length) {
      throw new Error(`仍有 ${blocking.length} 条本单范围内、与未确认条目无关的高风险问题未关闭`)
    }

    const snapshot = projectSettings(
      { ...order, items: confirmed },
      data.value.settings,
    )
    const reconsideration = buildReconsideration(order)
    const nextNumber = data.value.baselines.length + 1
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'locked',
      createdAt: now(),
      lockedAt: now(),
      createdBy: '当前用户',
      note: note || `${order.title}（${order.code}）`,
      snapshot: JSON.parse(JSON.stringify(snapshot)) as ProtectionSetting[],
      checksum: checksum(snapshot),
      changeOrderId: order.id,
      originalBasis: JSON.parse(JSON.stringify(order.originalBasis)) as ProtectionSetting[],
      reconsideration,
    }
    data.value.baselines.unshift(baseline)
    data.value.activeBaselineId = baseline.id
    data.value.settings = snapshot
    order.status = 'completed'
    order.completedAt = now()
    order.baselineId = baseline.id
    order.reconsideration = reconsideration

    data.value.issues = data.value.issues.map((issue) => {
      const stillOpen = unconfirmed.some((item) => issue.settingIds.includes(item.after.id))
      if (issue.changeOrderId === order.id && !stillOpen && issue.status !== 'closed') {
        return { ...issue, resolved: true, status: 'closed' as const }
      }
      return issue
    })
    data.value.scenarios.forEach((scenario) => {
      if (scenario.changeOrderId === order.id) {
        scenario.needsRecheck = false
        if (isScenarioUnapproved(scenario)) scenario.status = 'returned'
      }
    })

    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `依据变更单 ${order.code} 锁定；${confirmed.length} 份定值固化，${unconfirmed.length} 份未确认保留原依据并列复议项。`,
    })
    await commit('变更单已完成，基线已锁定')
    return baseline
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

  // ---------- 保存失败：从最近一次完整变更恢复，只补未确认设备 ----------

  /** 演练：制造下一次保存失败（不落盘） */
  function armFailure() {
    armSaveFailure()
  }

  /**
   * 恢复流程：
   * 1. 从最近一次完整保存（检查点）恢复状态；
   * 2. 只对在途变更单中未确认的设备补推临时定值；
   * 3. 已确认设备不重复下发。
   */
  async function recoverAfterFailure() {
    const recovered = await recoverFromCheckpoint()
    hydrate(recovered)

    const orders = recovered.changeOrders.filter(
      (order) => order.status === 'issued' && order.modeAfter !== MODE_PENDING,
    )
    const reissuedItemIds: string[] = []
    orders.forEach((order) => {
      order.items.forEach((item) => {
        if (item.confirmed) return
        item.reissuedAfterFailure = true
        reissuedItemIds.push(item.id)
      })
    })
    const confirmedItemIds = orders.flatMap((order) =>
      order.items.filter((item) => item.confirmed).map((item) => item.id),
    )

    const checkpointOrder = orders[0]
    recoveryNotice.value = {
      recoveredAt: now(),
      checkpointCode: checkpointOrder?.code ?? '初始基线',
      reappliedItemIds: confirmedItemIds,
      reissuedItemIds,
      detail: `已从最近一次完整保存恢复，${reissuedItemIds.length} 台未确认设备已补推临时定值，${confirmedItemIds.length} 台已确认设备不重复下发。`,
    }
    data.value.lastRecovery = recoveryNotice.value
    appendAudit({
      action: '故障恢复',
      target: checkpointOrder?.code ?? '检查点',
      operator: '当前用户',
      detail: recoveryNotice.value.detail,
    })
    await commit('已从检查点恢复并补推未确认设备')
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
    recoveryNotice.value = undefined
    await commit('已恢复演示数据')
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    recoveryNotice,
    devices,
    settings,
    issues,
    scenarios,
    changeOrders,
    activeBaseline,
    effectiveSettingList,
    pendingCount,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    createChangeOrder,
    changeOrderMode,
    submitReceipt,
    admitPending,
    discardPending,
    backfillLegacyMode,
    completeChangeOrder,
    createBaseline,
    approveBaseline,
    armFailure,
    recoverAfterFailure,
    recordExport,
    reset,
  }
})

export type { PendingReviewReceipt }
