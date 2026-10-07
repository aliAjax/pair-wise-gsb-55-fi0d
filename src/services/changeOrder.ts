import type {
  AppState,
  ChangeRevalidation,
  Device,
  FaultScenario,
  PendingReceiptReason,
  PendingReviewReceipt,
  ProtectionSetting,
  RecheckScenario,
  ReconsiderationItem,
  SettingChangeItem,
  SettingChangeOrder,
  ValidationIssue,
} from '@/types/domain'
import { validateSettings } from '@/services/validation'

/** 旧单待补录时的占位运行方式，回填前不参与重算、有效视图与锁定 */
export const MODE_PENDING = '待回填运行方式'

export const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

export const now = () => new Date().toISOString()

/** 可重算的场景：未批准（草稿/会签中/退回）才随方式变化立即重算 */
export function isScenarioUnapproved(scenario: FaultScenario): boolean {
  return scenario.status !== 'approved' && scenario.status !== 'locked'
}

function settingKey(setting: ProtectionSetting): string {
  return `${setting.relayId}:${setting.stage}`
}

/** 应用变更单条目得到预测定值：回执未到也按下发的临时定值参与审校 */
export function projectSettings(order: SettingChangeOrder, base: ProtectionSetting[]): ProtectionSetting[] {
  const afterByKey = new Map(order.items.map((item) => [settingKey(item.after), item.after]))
  return base.map((setting) => afterByKey.get(settingKey(setting)) ?? setting)
}

/** 当前所有未完成变更叠加后的预测定值（同一装置以最近一单为准）；旧单方式未回填不生效 */
export function effectiveSettings(state: AppState): ProtectionSetting[] {
  return state.changeOrders
    .filter((order) => order.status !== 'completed' && order.modeAfter !== MODE_PENDING)
    .reduce((acc, order) => projectSettings(order, acc), state.settings)
}

function devicesInMode(devices: Device[], mode: string, affectedIds: string[]): Device[] {
  // 方式切换后受影响设备按运行对待，保证其临时定值进入校核范围
  return devices.map((device) =>
    affectedIds.includes(device.id) && device.status === 'maintenance'
      ? { ...device, status: 'running' as const, operationModes: [...device.operationModes, mode] }
      : device,
  )
}

function summarizeScenario(
  scenario: FaultScenario,
  order: SettingChangeOrder,
  projected: ProtectionSetting[],
  devices: Device[],
): RecheckScenario {
  const stepRelayIds = scenario.steps.map((step) => step.relayId)
  const affectedByOutage = scenario.outageDevices.some((id) => order.affectedDeviceIds.includes(id))
  const affectedByStep = stepRelayIds.some((relayId) => {
    const relay = devices.find((device) => device.id === relayId)
    return relay && order.affectedDeviceIds.includes(relay.parentId ?? relay.id)
  })
  const sameMode = scenario.operationMode === order.modeAfter
  const affected = (sameMode || affectedByOutage || affectedByStep) && isScenarioUnapproved(scenario)

  const changedSteps = scenario.steps
    .map((step) => {
      const match = projected.find(
        (setting) =>
          setting.relayId === step.relayId &&
          order.items.some((item) => item.relayId === step.relayId),
      )
      return match
    })
    .filter((setting): setting is ProtectionSetting => Boolean(setting))

  let summary: string
  if (!isScenarioUnapproved(scenario)) {
    summary = '该场景已批准，方式变化不触发重算，结论维持原批准。'
  } else if (!affected) {
    summary = `与方式「${order.modeAfter}」无交集，动作序列与停电范围不变。`
  } else {
    const parts: string[] = []
    if (sameMode) parts.push(`运行方式切换为「${order.modeAfter}」`)
    if (affectedByStep) parts.push(`${changedSteps.length || '部分'} 个动作步骤涉及本次临时定值`)
    if (affectedByOutage) parts.push('停电范围覆盖受影响设备')
    parts.push('已按变更后定值立即重算，请重新核对动作时序。')
    summary = parts.join('，') + '。'
  }

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    operationMode: scenario.operationMode,
    affected,
    summary,
    recomputedAt: now(),
  }
}

/**
 * 方式一变：未批准场景和问题立即重算。
 * 已关闭/回复中的问题状态按问题 id 延续，不丢处置痕迹。
 */
export function recomputeOrder(
  order: SettingChangeOrder,
  state: AppState,
  options: { modeChanged?: boolean } = {},
): ChangeRevalidation {
  const projected = projectSettings(order, state.settings)
  const devices = devicesInMode(state.devices, order.modeAfter, order.affectedDeviceIds)

  const raw = validateSettings(projected, devices)
  const previous = new Map<ValidationIssue['id'], ValidationIssue>()
  order.revalidation?.issues.forEach((issue) => previous.set(issue.id, issue))
  state.issues.forEach((issue) => previous.set(issue.id, issue))

  const touchedSettingIds = new Set(order.items.map((item) => item.after.id))
  const issues = raw.map((issue) => {
    const prior = previous.get(issue.id)
    const inScope = issue.settingIds.some((id) => touchedSettingIds.has(id))
    return {
      ...issue,
      status: prior?.status ?? issue.status,
      changeOrderId: inScope ? order.id : issue.changeOrderId,
      basis: inScope ? ('projected' as const) : ('baseline' as const),
      recomputedAt: options.modeChanged || inScope ? now() : issue.recomputedAt,
    }
  })

  const scenarios = state.scenarios.map((scenario) =>
    summarizeScenario(scenario, order, projected, devices),
  )

  return { issues, scenarios, recomputedAt: now() }
}

/** 将重算结果回写到全局问题表与场景表 */
export function applyRevalidation(state: AppState, order: SettingChangeOrder): void {
  const result = order.revalidation
  if (!result) return

  // 重算输出为全量问题集，直接替换；问题处置状态已在 recomputeOrder 中延续
  state.issues = result.issues

  applyScenarioRechecks(state, order)
}

/** 只回写场景重算标记（问题表由调用方统一计算，避免多单互相覆盖） */
export function applyScenarioRechecks(state: AppState, order: SettingChangeOrder): void {
  const result = order.revalidation
  if (!result) return
  result.scenarios.forEach((recheck) => {
    const scenario = state.scenarios.find((item) => item.id === recheck.scenarioId)
    if (!scenario) return
    scenario.changeOrderId = recheck.affected ? order.id : scenario.changeOrderId
    scenario.needsRecheck = recheck.affected
    scenario.recheckSummary = recheck.summary
    scenario.recomputedAt = recheck.recomputedAt
  })
}

/** 按全部在途变更叠加后的预测定值统一重算并归属问题（手动批量校核入口） */
export function revalidateEffective(state: AppState): void {
  const orders = state.changeOrders.filter(
    (order) => order.status !== 'completed' && order.modeAfter !== MODE_PENDING,
  )
  const projected = effectiveSettings(state)
  const raw = validateSettings(projected, state.devices)
  const previous = new Map<ValidationIssue['id'], ValidationIssue>()
  state.issues.forEach((issue) => previous.set(issue.id, issue))
  const stamp = now()

  state.issues = raw.map((issue) => {
    const prior = previous.get(issue.id)
    const owner = orders.find((order) =>
      order.items.some((item) => issue.settingIds.includes(item.after.id)),
    )
    return {
      ...issue,
      status: prior?.status ?? issue.status,
      changeOrderId: owner?.id,
      basis: owner ? ('projected' as const) : ('baseline' as const),
      recomputedAt: owner ? stamp : issue.recomputedAt,
    }
  })

  // 各单独立重算（供单详情展示），场景标记跨单取并集，避免后单覆盖前单的"需重算"
  const affectedByScenario = new Map<string, RecheckScenario>()
  orders.forEach((order) => {
    order.revalidation = recomputeOrder(order, state)
    order.revalidation.scenarios.forEach((recheck) => {
      if (recheck.affected && !affectedByScenario.has(recheck.scenarioId)) {
        affectedByScenario.set(recheck.scenarioId, recheck)
      }
    })
  })
  affectedByScenario.forEach((recheck) => {
    const scenario = state.scenarios.find((item) => item.id === recheck.scenarioId)
    if (!scenario) return
    scenario.changeOrderId = orders.find(
      (order) => order.revalidation?.scenarios.some((r) => r.scenarioId === recheck.scenarioId && r.affected),
    )?.id
    scenario.needsRecheck = true
    scenario.recheckSummary = recheck.summary
    scenario.recomputedAt = recheck.recomputedAt
  })
}

export function buildReconsideration(order: SettingChangeOrder): ReconsiderationItem[] {
  return order.reconsideration.length
    ? order.reconsideration
    : order.items
        .filter((item) => !item.confirmed)
        .map((item) => ({
          id: createId('recon'),
          changeItemId: item.id,
          relayId: item.relayId,
          stage: item.stage,
          reason: item.legacy
            ? '旧数据缺回执编号，锁定时保留原依据，待回执编号补齐后复议。'
            : '现场回执未确认，基线保留原定値依据，另列复议。',
          keptValue: item.before,
          createdAt: now(),
        }))
}

/** 比较回执内容与下发定值 */
export function describePayloadDiff(
  payload: Partial<ProtectionSetting>,
  after: ProtectionSetting,
): string {
  const fields: (keyof ProtectionSetting)[] = [
    'currentA',
    'timeS',
    'direction',
    'sensitivity',
    'recloseEnabled',
    'recloseDelayS',
    'startCondition',
  ]
  return fields
    .filter((field) => payload[field] !== undefined && payload[field] !== after[field])
    .map((field) => `${field}: 回执 ${String(payload[field])} ≠ 下发 ${String(after[field])}`)
    .join('；')
}

export function makePendingReceipt(params: {
  item: SettingChangeItem
  receiptNo: string
  channel: PendingReviewReceipt['channel']
  submittedAt: string
  payload: Partial<ProtectionSetting>
  reason: PendingReceiptReason
  detail: string
  modeBackfilled?: boolean
}): PendingReviewReceipt {
  return {
    id: createId('pending'),
    changeItemId: params.item.id,
    relayId: params.item.relayId,
    stage: params.item.stage,
    receiptNo: params.receiptNo,
    channel: params.channel,
    submittedAt: params.submittedAt,
    payload: params.payload,
    reason: params.reason,
    detail: params.detail,
    modeBackfilled: params.modeBackfilled,
  }
}
