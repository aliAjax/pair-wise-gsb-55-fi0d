export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

/** 定值变更单状态：草稿 → 已下发 → 全部回执确认并应用 → 已归档（基线锁定后封存） */
export type ChangeOrderStatus = 'draft' | 'issued' | 'applied' | 'archived'
export type ReceiptStatus = 'pending' | 'confirmed' | 'applied'
export type PendingReason = 'duplicate-late' | 'mismatch' | 'recovery-supplement' | 'legacy-missing'
export type PendingStatus = 'pending' | 'accepted' | 'discarded'

/** 同一份变更临时保护定值，随变更单下发，回执确认后才转成生效定值 */
export interface ChangeSettingValue {
  settingId: string
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
}

export interface ChangeReceipt {
  id: string
  /** 回执编号：现场回执单的唯一编号，旧数据可能缺失 */
  receiptNo?: string
  settingId: string
  deviceName: string
  submittedBy: string
  submittedAt: string
  /** 回执抄录的定值内容 */
  values: Pick<
    ChangeSettingValue,
    'currentA' | 'timeS' | 'direction' | 'sensitivity' | 'recloseEnabled' | 'recloseDelayS' | 'startCondition'
  >
  /** 录入终端标识，用于演示两台终端同时提交 */
  terminal: string
  status: ReceiptStatus
  confirmedAt?: string
  /** 与变更单临时定值不一致时给出的差异说明 */
  mismatchNote?: string
}

/** 待核区条目：后到 / 录错 / 恢复补录 / 旧数据缺回执编号的回执 */
export interface PendingReceipt {
  id: string
  changeId: string
  receipt: ChangeReceipt
  reason: PendingReason
  status: PendingStatus
  receivedAt: string
  note: string
  resolvedAt?: string
}

/** 复议项：锁定基线时保留原依据，另列的待复议问题 */
export interface ReconsiderationItem {
  id: string
  issueId: string
  pairLabel: string
  message: string
  level: IssueLevel
  reason: string
  createdAt: string
  resolved: boolean
}

export interface SettingChangeOrder {
  id: string
  code: string
  title: string
  operationMode: string
  /** 前一种运行方式，用于恢复场景依据 */
  previousOperationMode: string
  reason: string
  createdAt: string
  issuedAt?: string
  appliedAt?: string
  createdBy: string
  status: ChangeOrderStatus
  /** 随变更下发的临时定值 */
  provisionalSettings: ChangeSettingValue[]
  receipts: ChangeReceipt[]
  /** 回执到达顺序序号，先确认者有效 */
  confirmedOrder: string[]
  notes: string
}

/** 最近一次完整变更：保存失败后从这里恢复 */
export interface ChangeCheckpoint {
  id: string
  createdAt: string
  changeId?: string
  label: string
  state: AppState
}

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
  /** 生效所依据的变更单；历史基线定值可能为空 */
  basisChangeId?: string
  /** 生效所依据的回执编号；旧数据可能缺失 */
  basisReceiptNo?: string
  /** 旧数据尚未回填回执时为 true，审校台不允许按其签字 */
  receiptPending?: boolean
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
  /** 触发重算的运行方式；问题可能已与当前方式不符 */
  operationMode?: string
  changeId?: string
  /** 方式变化后该问题已重算，等待人工复核 */
  stale?: boolean
  closedAt?: string
}

export interface ScenarioStep {
  sequence: number
  relayId: string
  action: string
  delayMs: number
  status: 'executed' | 'pending' | 'skipped'
  note?: string
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
  /** 批准后所依据的变更单与运行方式；方式再变也不重算，保留原依据 */
  basisChangeId?: string
  basisOperationMode?: string
  /** 未批准场景在方式变化后立即重算，标记等待复核 */
  stale?: boolean
  recalculatedAt?: string
  recalcNote?: string
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
  /** 锁定时跟随的定值变更单 */
  changeId?: string
  operationMode?: string
  /** 锁定时保留的原依据说明 */
  originalBasisNote?: string
  reconsiderations: ReconsiderationItem[]
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario' | 'change'
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

export interface AppState {
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
  /** 定值变更单（含回执与待核引用） */
  changeOrders: SettingChangeOrder[]
  /** 待核区 */
  pendingReceipts: PendingReceipt[]
  /** 当前运行方式：随同一份变更切换 */
  activeOperationMode: string
  activeChangeId?: string
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting | 'id'
  before: string | number | boolean
  after: string | number | boolean
}
