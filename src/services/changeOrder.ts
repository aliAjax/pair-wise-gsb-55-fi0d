import type {
  AppState,
  ChangeOrderStatus,
  ChangeReceipt,
  ChangeSettingValue,
  Device,
  FaultScenario,
  PendingReason,
  PendingReceipt,
  ProtectionSetting,
  ReconsiderationItem,
  ReviewStatus,
  SettingChangeOrder,
  ValidationIssue,
} from '@/types/domain'
import { validateSettings } from './validation'
import { createInitialState } from '@/data/mock'

export const now = () => new Date().toISOString()

let counter = 0
export const createId = (prefix: string) => {
  counter = (counter + 1) % 1_000_000
  return `${prefix}-${Date.now()}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function checksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map((item) => `${item.id}:${item.currentA}:${item.timeS}:${item.recloseDelayS}`)
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
}

/** 比对回执抄录值与变更单临时定值 */
export function receiptMismatch(receipt: ChangeReceipt, target?: ChangeSettingValue): boolean {
  if (!target) return false
  return (
    receipt.values.currentA !== target.currentA ||
    receipt.values.timeS !== target.timeS ||
    receipt.values.direction !== target.direction ||
    receipt.values.sensitivity !== target.sensitivity ||
    receipt.values.recloseEnabled !== target.recloseEnabled ||
    receipt.values.recloseDelayS !== target.recloseDelayS ||
    receipt.values.startCondition !== target.startCondition
  )
}

/**
 * 方式一变立即重算：
 * - 未批准（draft / reviewing / returned）场景与问题按新方式重新计算并标记 stale；
 * - 已批准 / 已锁定场景保留原依据，只追加复核备注，不重算。
 */
export function recomputeForMode(state: AppState, changeId: string, mode: string): void {
  const fresh = validateSettings(state.settings, state.devices, mode)
  const previousById = new Map(state.issues.map((issue) => [issue.id, issue]))

  state.issues = fresh.map((issue) => {
    const previous = previousById.get(issue.id)
    return {
      ...issue,
      changeId,
      // 保留此前的处理进度，但必须在新方式下重新确认
      status: previous?.status ?? 'open',
      stale: previous ? true : false,
      closedAt: previous?.closedAt,
      createdAt: previous?.createdAt ?? issue.createdAt,
    }
  })

  const stamp = now()
  state.scenarios = state.scenarios.map((scenario) => {
    const approved = scenario.status === 'approved' || scenario.status === 'locked'
    if (approved) {
      // 锁定基线保留原依据：已批准场景不重算
      return {
        ...scenario,
        stale: false,
        recalcNote: `运行方式切换为「${mode}」，本场景已批准，保留原依据（${scenario.basisOperationMode ?? scenario.operationMode}）。`,
      }
    }
    return {
      ...scenario,
      operationMode: mode,
      stale: true,
      recalculatedAt: stamp,
      recalcNote: `运行方式切换为「${mode}」，场景尚未批准，动作序列与停电范围已要求按新方式重新复核。`,
      steps: scenario.steps.map((step) =>
        step.status === 'executed'
          ? { ...step, note: '方式变化后待重新确认' }
          : step,
      ),
    }
  })
}

/** 全部回执确认后，把临时定值转成生效定值 */
export function applyProvisionalSettings(
  state: AppState,
  order: SettingChangeOrder,
): ProtectionSetting[] {
  const receiptBySetting = new Map(order.receipts.map((receipt) => [receipt.settingId, receipt]))
  const stamp = now()
  order.provisionalSettings.forEach((provisional) => {
    const index = state.settings.findIndex((item) => item.id === provisional.settingId)
    const receipt = receiptBySetting.get(provisional.settingId)
    const next: ProtectionSetting = {
      id: provisional.settingId,
      relayId: provisional.relayId,
      protectedDeviceId: provisional.protectedDeviceId,
      stage: provisional.stage,
      currentA: provisional.currentA,
      timeS: provisional.timeS,
      direction: provisional.direction,
      sensitivity: provisional.sensitivity,
      recloseEnabled: provisional.recloseEnabled,
      recloseDelayS: provisional.recloseDelayS,
      startCondition: provisional.startCondition,
      updatedAt: stamp,
      basisChangeId: order.id,
      basisReceiptNo: receipt?.receiptNo,
      receiptPending: !receipt?.receiptNo,
    }
    if (index >= 0) state.settings[index] = next
    else state.settings.push(next)
  })
  return state.settings
}

export function orderProgress(order: SettingChangeOrder): { confirmed: number; total: number } {
  return {
    confirmed: order.confirmedOrder.length,
    total: order.provisionalSettings.length,
  }
}

export const changeStatusLabels: Record<ChangeOrderStatus, string> = {
  draft: '草稿',
  issued: '已下发待回执',
  applied: '回执已全部确认',
  archived: '随基线封存',
}

export const pendingReasonLabels: Record<PendingReason, string> = {
  'duplicate-late': '同回执重复后到',
  mismatch: '录错/与临时定值不符',
  'recovery-supplement': '保存失败恢复补录',
  'legacy-missing': '旧数据缺回执编号',
}

/** 审校台签字依据：旧数据缺回执编号的定值不允许作为签字依据 */
export function settingCanSign(setting: ProtectionSetting): boolean {
  return !setting.receiptPending
}

export function signableSettings(settings: ProtectionSetting[]): ProtectionSetting[] {
  return settings.filter(settingCanSign)
}

/**
 * 锁定基线时保留原依据，未闭环问题另列复议项
 */
export function buildReconsiderations(
  issues: ValidationIssue[],
  baselineId: string,
): ReconsiderationItem[] {
  void baselineId
  const stamp = now()
  return issues
    .filter((issue) => issue.status !== 'closed')
    .map((issue) => ({
      id: createId('recon'),
      issueId: issue.id,
      pairLabel: issue.pairLabel,
      message: issue.message,
      level: issue.level,
      reason: `运行方式「${issue.operationMode ?? '未知'}」下重算后仍未闭环，基线保留原依据并转入复议。`,
      createdAt: stamp,
      resolved: false,
    }))
}

export function reopenIssueForReconsideration(
  issues: ValidationIssue[],
  item: ReconsiderationItem,
): ValidationIssue[] {
  return issues.map((issue) =>
    issue.id === item.issueId ? { ...issue, stale: true, status: 'open' } : issue,
  )
}

/**
 * 保存失败恢复：从最近一次完整变更的检查点恢复，
 * 只把恢复点之后仍未确认的设备回执补进待核区，已确认设备不再重放。
 */
export function recoverFromCheckpoint(state: AppState): {
  state: AppState
  supplemented: PendingReceipt[]
  order?: SettingChangeOrder
} {
  const order = state.changeOrders.find((item) => item.id === state.activeChangeId)
  if (!order) return { state, supplemented: [] }

  const confirmed = new Set(order.confirmedOrder)
  const supplemented: PendingReceipt[] = []
  order.provisionalSettings.forEach((provisional) => {
    if (confirmed.has(provisional.settingId)) return
    // 待核区里已有同一设备的恢复补录时不重复生成
    const exists = state.pendingReceipts.some(
      (item) =>
        item.changeId === order.id &&
        item.receipt.settingId === provisional.settingId &&
        item.reason === 'recovery-supplement' &&
        item.status === 'pending',
    )
    if (exists) return
    const device = state.devices.find((item) => item.id === provisional.relayId)
    supplemented.push({
      id: createId('pending'),
      changeId: order.id,
      reason: 'recovery-supplement',
      status: 'pending',
      receivedAt: now(),
      note: `保存失败恢复：${device?.name ?? provisional.relayId} 的回执未确认，请现场补录确认。`,
      receipt: {
        id: createId('receipt'),
        settingId: provisional.settingId,
        deviceName: device?.name ?? provisional.relayId,
        submittedBy: '恢复补录',
        submittedAt: now(),
        terminal: 'recovery',
        status: 'pending',
        values: {
          currentA: provisional.currentA,
          timeS: provisional.timeS,
          direction: provisional.direction,
          sensitivity: provisional.sensitivity,
          recloseEnabled: provisional.recloseEnabled,
          recloseDelayS: provisional.recloseDelayS,
          startCondition: provisional.startCondition,
        },
      },
    })
  })
  state.pendingReceipts.unshift(...supplemented)
  return { state, supplemented, order }
}

/** 旧数据回填：先回填运行方式，再进待核区等待补回执编号 */
export function backfillLegacySettings(state: AppState, mode: string): number {
  let touched = 0
  state.settings.forEach((setting) => {
    if (!setting.receiptPending) return
    if (setting.basisReceiptNo) {
      setting.receiptPending = false
      touched += 1
      return
    }
    touched += 1
  })
  const legacyOrder = state.changeOrders.find((order) =>
    order.notes.startsWith('LEGACY:'),
  )
  const missing = state.settings.filter(
    (setting) => setting.receiptPending && !setting.basisReceiptNo,
  )
  missing.forEach((setting) => {
    const device = state.devices.find((item) => item.id === setting.relayId)
    const exists = state.pendingReceipts.some(
      (item) =>
        item.receipt.settingId === setting.id &&
        item.reason === 'legacy-missing' &&
        item.status === 'pending',
    )
    if (exists) return
    state.pendingReceipts.unshift({
      id: createId('pending'),
      changeId: legacyOrder?.id ?? 'legacy',
      reason: 'legacy-missing',
      status: 'pending',
      receivedAt: now(),
      note: `旧数据缺少回执编号，已先回填运行方式「${mode}」，回执编号补录前该定值不得作为签字依据。`,
      receipt: {
        id: createId('receipt'),
        settingId: setting.id,
        deviceName: device?.name ?? setting.relayId,
        submittedBy: '旧数据迁移',
        submittedAt: setting.updatedAt,
        terminal: 'legacy',
        status: 'pending',
        values: {
          currentA: setting.currentA,
          timeS: setting.timeS,
          direction: setting.direction,
          sensitivity: setting.sensitivity,
          recloseEnabled: setting.recloseEnabled,
          recloseDelayS: setting.recloseDelayS,
          startCondition: setting.startCondition,
        },
      },
    })
  })
  if (legacyOrder) legacyOrder.operationMode = mode
  return touched
}

/** 采用待核区回执：按其内容更新生效定值与依据 */
export function acceptPendingReceipt(
  state: AppState,
  pendingId: string,
  receiptNo: string,
): PendingReceipt | undefined {
  const item = state.pendingReceipts.find((pending) => pending.id === pendingId)
  if (!item || item.status !== 'pending') return item
  const index = state.settings.findIndex(
    (setting) => setting.id === item.receipt.settingId,
  )
  const base = index >= 0 ? state.settings[index] : undefined
  const next: ProtectionSetting = {
    id: item.receipt.settingId,
    relayId: base?.relayId ?? item.changeId,
    protectedDeviceId: base?.protectedDeviceId ?? '',
    stage: base?.stage ?? 'I',
    ...item.receipt.values,
    updatedAt: now(),
    basisChangeId: item.changeId === 'legacy' ? base?.basisChangeId : item.changeId,
    basisReceiptNo: receiptNo || item.receipt.receiptNo,
    receiptPending: false,
  }
  if (index >= 0) state.settings[index] = next
  else state.settings.push(next)
  item.status = 'accepted'
  item.resolvedAt = now()
  const recordedNo = receiptNo || item.receipt.receiptNo
  item.note = `${item.note} 已采用，回执编号 ${recordedNo ?? '未提供'}。`
  return item
}

export function discardPendingReceipt(state: AppState, pendingId: string): void {
  const item = state.pendingReceipts.find((pending) => pending.id === pendingId)
  if (!item) return
  item.status = 'discarded'
  item.resolvedAt = now()
  item.note = `${item.note} 已作废，以先确认版本为准。`
}

/** 场景状态流转时补记依据 */
export function markScenarioStatus(scenario: FaultScenario, status: ReviewStatus): void {
  scenario.status = status
  if (status === 'approved') {
    scenario.stale = false
    scenario.basisOperationMode = scenario.operationMode
  }
}

/** 兼容旧版本持久化数据，补齐新字段 */
export function migrateState(raw: Partial<AppState>): AppState {
  const initial = createInitialState()
  const hasChangeData = Array.isArray(raw.changeOrders) && raw.changeOrders.length > 0
  return {
    devices: raw.devices ?? initial.devices,
    settings: (raw.settings ?? initial.settings).map((setting) => ({ ...setting })),
    issues: (raw.issues ?? initial.issues).map((issue) => ({ ...issue })),
    scenarios: (raw.scenarios ?? initial.scenarios).map((scenario) => ({ ...scenario })),
    baselines: (raw.baselines ?? initial.baselines).map((baseline) => ({
      ...baseline,
      reconsiderations: baseline.reconsiderations ?? [],
      snapshot: baseline.snapshot.map((setting) => ({ ...setting })),
    })),
    comments: raw.comments ?? initial.comments,
    audit: raw.audit ?? initial.audit,
    activeBaselineId: raw.activeBaselineId ?? initial.activeBaselineId,
    changeOrders: hasChangeData
      ? (raw.changeOrders as SettingChangeOrder[])
      : initial.changeOrders.map((order) => ({
          ...order,
          provisionalSettings: order.provisionalSettings.map((setting) => ({ ...setting })),
          receipts: order.receipts.map((receipt) => ({ ...receipt, values: { ...receipt.values } })),
          confirmedOrder: [...order.confirmedOrder],
        })),
    pendingReceipts: raw.pendingReceipts ?? [],
    activeOperationMode: raw.activeOperationMode ?? '正常方式',
    activeChangeId: raw.activeChangeId,
  }
}

export function deviceNameOf(devices: Device[], id: string): string {
  return devices.find((device) => device.id === id)?.name ?? id
}
