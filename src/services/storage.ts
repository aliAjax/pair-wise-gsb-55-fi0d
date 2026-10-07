import type { AppState, ChangeCheckpoint } from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { migrateState } from './changeOrder'

const STORAGE_KEY = 'grid-protection-review-v1'
const CHECKPOINT_KEY = 'grid-protection-checkpoints-v1'
const FAILED_KEY = 'grid-protection-failed-session-v1'
const CHECKPOINT_LIMIT = 5

export interface FailedSession {
  at: string
  action: string
  detail: string
}

export function loadState(): AppState {
  if (typeof window === 'undefined') return createInitialState()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
  try {
    return migrateState(JSON.parse(raw) as Partial<AppState>)
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
}

export function saveState(state: AppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  saveCheckpoints([
    {
      id: 'checkpoint-initial',
      createdAt: new Date().toISOString(),
      label: '秋检初始完整变更',
      state: initial,
    },
  ])
  clearFailedSession()
  return initial
}

export function loadCheckpoints(): ChangeCheckpoint[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(CHECKPOINT_KEY)
    return raw ? (JSON.parse(raw) as ChangeCheckpoint[]) : []
  } catch {
    return []
  }
}

export function saveCheckpoint(checkpoint: ChangeCheckpoint): ChangeCheckpoint[] {
  const list = [checkpoint, ...loadCheckpoints()]
    .filter((item) => item.id !== checkpoint.id)
    .slice(0, CHECKPOINT_LIMIT)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(list))
  }
  return list
}

function saveCheckpoints(list: ChangeCheckpoint[]): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(list.slice(0, CHECKPOINT_LIMIT)))
  }
}

export function latestCheckpoint(): ChangeCheckpoint | undefined {
  return loadCheckpoints()[0]
}

export function saveFailedSession(session: FailedSession): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(FAILED_KEY, JSON.stringify(session))
  }
}

export function loadFailedSession(): FailedSession | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(FAILED_KEY)
    return raw ? (JSON.parse(raw) as FailedSession) : undefined
  } catch {
    return undefined
  }
}

export function clearFailedSession(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(FAILED_KEY)
}

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `运行方式：${state.activeOperationMode}`,
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件,依据变更,回执编号',
  ]
  state.settings.forEach((setting) => {
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    const target =
      state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ??
      setting.protectedDeviceId
    lines.push(
      [
        setting.relayId,
        relay,
        target,
        setting.stage,
        setting.currentA,
        setting.timeS,
        setting.direction,
        setting.sensitivity,
        setting.recloseEnabled ? '投入' : '退出',
        setting.recloseDelayS,
        setting.startCondition,
        setting.basisChangeId ?? '',
        setting.receiptPending ? '待核(缺回执编号)' : (setting.basisReceiptNo ?? ''),
      ].join(','),
    )
  })
  return lines.join('\n')
}
