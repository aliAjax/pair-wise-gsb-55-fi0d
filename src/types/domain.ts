export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

export interface Device {
  id: string
  code: string
  name: string
  kind: DeviceKind
  station: string
  voltage: number
  parentId?: string
  status: DeviceStatus
  operationModes: string[]
}

export interface ProtectionSetting {
  id: string
  relayId: string
  protectedDeviceId: string
  stage: 'I' | 'II' | 'III'
  currentA: number
  timeS: number
  direction: 'forward' | 'reverse' | 'non-directional'
  sensitivity: number
  recloseEnabled: boolean
  recloseDelayS: number
  startCondition: string
  updatedAt: string
}

export interface ValidationIssue {
  id: string
  type: IssueType
  level: IssueLevel
  deviceIds: string[]
  settingIds: string[]
  message: string
  suggestion: string
  pairLabel: string
  status: 'open' | 'replying' | 'closed'
  createdAt: string
  /** 归属变更单：在某条变更重算范围内的问题随该变更走 */
  changeOrderId?: string
  /** 依据：当前基线定值 / 变更后预测定值 */
  basis?: 'baseline' | 'projected'
  /** 最近一次重算时间，方式一变即刷新 */
  recomputedAt?: string
  /** 变更批准应用后已消解 */
  resolved?: boolean
}

export interface ScenarioStep {
  sequence: number
  relayId: string
  action: string
  delayMs: number
  status: 'executed' | 'pending' | 'skipped'
}

export interface FaultScenario {
  id: string
  name: string
  operationMode: string
  faultDeviceId: string
  faultType: string
  status: ReviewStatus
  steps: ScenarioStep[]
  outageDevices: string[]
  createdAt: string
  notes: string
  /** 最近一次要求重算该场景的变更单 */
  changeOrderId?: string
  /** 方式变更后是否需要重算动作序列与停电范围 */
  needsRecheck?: boolean
  /** 重算结论（设备/步骤/停电范围是否受影响） */
  recheckSummary?: string
  recomputedAt?: string
}

export interface BaselineVersion {
  id: string
  version: string
  status: ReviewStatus
  createdAt: string
  lockedAt?: string
  createdBy: string
  note: string
  snapshot: ProtectionSetting[]
  checksum: string
  /** 由哪条变更单锁定 */
  changeOrderId?: string
  /** 锁定时保留的原依据（变更前基线快照） */
  originalBasis?: ProtectionSetting[]
  /** 另列的复议项（保留定值，不阻塞锁定） */
  reconsideration?: ReconsiderationItem[]
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario'
  targetId: string
  author: string
  content: string
  createdAt: string
  status: 'open' | 'resolved'
}

export interface AuditEntry {
  id: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

/** 定值变更单状态：草拟 → 已下发（等待现场回执） → 已完成（基线锁定） */
export type ChangeOrderStatus = 'draft' | 'issued' | 'completed'

export type ReceiptChannel = 'terminal-a' | 'terminal-b'

/** 待核区条目：迟到、重复、内容不符或旧数据缺编号的回执一律先进待核区 */
export type PendingReceiptReason =
  | 'duplicate-late'
  | 'content-mismatch'
  | 'legacy-no-receipt'
  | 'legacy-mode-pending'

/** 变更单内单装置定值条目（确认粒度为设备/保护） */
export interface SettingChangeItem {
  id: string
  relayId: string
  protectedDeviceId: string
  stage: ProtectionSetting['stage']
  before: ProtectionSetting
  after: ProtectionSetting
  /** 旧数据无回执编号，先回填运行方式再待核 */
  legacy?: boolean
  confirmed: boolean
  confirmedBy?: ReceiptChannel
  confirmedAt?: string
  /** 有效回执编号；未到回执前为空 */
  receiptNo?: string
  /** 下发但尚未收到回执的装置，故障恢复后只需补这些 */
  reissuedAfterFailure?: boolean
}

export interface PendingReviewReceipt {
  id: string
  changeItemId: string
  relayId: string
  stage: ProtectionSetting['stage']
  receiptNo: string
  channel: ReceiptChannel
  submittedAt: string
  payload: Partial<ProtectionSetting>
  reason: PendingReceiptReason
  detail: string
  /** 旧数据是否已回填运行方式（回填后才允许核入） */
  modeBackfilled?: boolean
}

export interface RecheckScenario {
  scenarioId: string
  name: string
  operationMode: string
  affected: boolean
  summary: string
  recomputedAt: string
}

export interface ChangeRevalidation {
  issues: ValidationIssue[]
  scenarios: RecheckScenario[]
  recomputedAt: string
}

export interface ReconsiderationItem {
  id: string
  changeItemId: string
  relayId: string
  stage: ProtectionSetting['stage']
  reason: string
  keptValue: ProtectionSetting
  createdAt: string
}

export interface SettingChangeOrder {
  id: string
  code: string
  title: string
  reason: string
  createdAt: string
  issuedAt?: string
  completedAt?: string
  status: ChangeOrderStatus
  season: string
  modeBefore: string
  modeAfter: string
  /** 受方式变化影响的设备 id */
  affectedDeviceIds: string[]
  items: SettingChangeItem[]
  /** 下发时保留的原依据（变更前定值），锁定基线时沿用 */
  originalBasis: ProtectionSetting[]
  /** 重算结果：方式一变，未批准场景和问题立即重算 */
  revalidation?: ChangeRevalidation
  pendingReceipts: PendingReviewReceipt[]
  reconsideration: ReconsiderationItem[]
  /** 已锁定基线 id */
  baselineId?: string
  /** 旧数据缺回执编号，先回填运行方式再待核 */
  legacyImport?: boolean
}

/** 保存失败后的恢复提示 */
export interface RecoveryNotice {
  recoveredAt: string
  checkpointCode: string
  reappliedItemIds: string[]
  reissuedItemIds: string[]
  detail: string
}

export interface AppState {
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
  changeOrders: SettingChangeOrder[]
  /** 最近一次保存失败恢复提示，只读展示 */
  lastRecovery?: RecoveryNotice
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting | 'id'
  before: string | number | boolean
  after: string | number | boolean
}
