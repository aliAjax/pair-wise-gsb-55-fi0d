import type { AppState } from '@/types/domain'
import { createInitialState } from '@/data/mock'

const STORAGE_KEY = 'grid-protection-review-v1'
const CHECKPOINT_KEY = 'grid-protection-review-checkpoint-v1'

/** 兼容旧版本数据：补全变更单等新字段 */
export function normalizeState(raw: unknown): AppState {
  const state = (raw ?? {}) as Partial<AppState>
  return {
    devices: state.devices ?? [],
    settings: state.settings ?? [],
    issues: state.issues ?? [],
    scenarios: state.scenarios ?? [],
    baselines: state.baselines ?? [],
    comments: state.comments ?? [],
    audit: state.audit ?? [],
    activeBaselineId: state.activeBaselineId,
    changeOrders: state.changeOrders ?? [],
    lastRecovery: state.lastRecovery,
  }
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
    return normalizeState(JSON.parse(raw))
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
}

/**
 * 保存主状态，并在成功后更新检查点。
 * 检查点始终对应最近一次完整落盘的状态，保存失败时不会被破坏。
 */
export function saveState(state: AppState): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(state))
}

/** 从最近一次完整保存恢复 */
export function loadCheckpoint(): AppState {
  if (typeof window === 'undefined') return createInitialState()
  const raw = window.localStorage.getItem(CHECKPOINT_KEY)
  if (!raw) return loadState()
  try {
    return normalizeState(JSON.parse(raw))
  } catch {
    return loadState()
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  return initial
}

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件',
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
      ].join(','),
    )
  })
  return lines.join('\n')
}
