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

export interface AppState {
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}
