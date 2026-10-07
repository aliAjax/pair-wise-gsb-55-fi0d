import type {
  Device,
  ProtectionSetting,
  SettingDiff,
  ValidationIssue,
} from '@/types/domain'

const issueMeta: Record<ValidationIssue['type'], Pick<ValidationIssue, 'level' | 'suggestion'>> = {
  overreach: {
    level: 'high',
    suggestion: '延长上级保护动作时限，或核对下级保护的配合级差与方向元件。',
  },
  'time-inversion': {
    level: 'high',
    suggestion: '调整同装置各段时限，确保近区段动作快于远区段。',
  },
  sensitivity: {
    level: 'medium',
    suggestion: '复核最小运行方式下的短路电流，并下调定值或提高灵敏度裕度。',
  },
  reclose: {
    level: 'medium',
    suggestion: '协调相邻装置重合闸延迟，避免非同期并列或重复冲击。',
  },
}

const deviceName = (devices: Device[], id: string) =>
  devices.find((device) => device.id === id)?.name ?? id

export function validateSettings(
  settings: ProtectionSetting[],
  devices: Device[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const now = new Date().toISOString()
  const addIssue = (
    type: ValidationIssue['type'],
    pair: ProtectionSetting[],
    message: string,
    pairLabel: string,
  ) => {
    const meta = issueMeta[type]
    issues.push({
      id: `${type}-${pair.map((item) => item.id).join('-')}`,
      type,
      level: meta.level,
      deviceIds: [...new Set(pair.map((item) => item.protectedDeviceId))],
      settingIds: pair.map((item) => item.id),
      message,
      suggestion: meta.suggestion,
      pairLabel,
      status: 'open',
      createdAt: now,
    })
  }

  settings.forEach((setting) => {
    const stageOrder = { I: 1, II: 2, III: 3 }
    const slowerStage = settings.find(
      (candidate) =>
        candidate.relayId === setting.relayId &&
        stageOrder[candidate.stage] > stageOrder[setting.stage] &&
        candidate.timeS < setting.timeS,
    )
    if (slowerStage) {
      addIssue(
        'time-inversion',
        [setting, slowerStage],
        `${deviceName(devices, setting.relayId)} 的 ${setting.stage} 段时限 ${setting.timeS}s 长于 ${slowerStage.stage} 段 ${slowerStage.timeS}s。`,
        `${setting.stage} 段 / ${slowerStage.stage} 段`,
      )
    }
  })

  settings.forEach((upstream) => {
    const protectedDevice = devices.find((device) => device.id === upstream.protectedDeviceId)
    if (!protectedDevice) return
    const downstreamSettings = settings.filter((candidate) => {
      const candidateDevice = devices.find((device) => device.id === candidate.protectedDeviceId)
      return candidateDevice?.parentId === upstream.protectedDeviceId
    })
    downstreamSettings.forEach((downstream) => {
      if (downstream.timeS <= upstream.timeS && upstream.timeS - downstream.timeS < 0.3) {
        addIssue(
          'overreach',
          [upstream, downstream],
          `${deviceName(devices, upstream.relayId)} 与 ${deviceName(devices, downstream.relayId)} 配合级差仅 ${(upstream.timeS - downstream.timeS).toFixed(2)}s。`,
          `${deviceName(devices, upstream.protectedDeviceId)} / ${deviceName(devices, downstream.protectedDeviceId)}`,
        )
      }
    })
  })

  settings
    .filter((setting) => setting.sensitivity < 1.2)
    .forEach((setting) => {
      addIssue(
        'sensitivity',
        [setting],
        `${deviceName(devices, setting.relayId)} ${setting.stage} 段灵敏度仅 ${setting.sensitivity.toFixed(2)}。`,
        `${deviceName(devices, setting.protectedDeviceId)} 单端校核`,
      )
    })

  const activeReclosers = settings.filter((setting) => setting.recloseEnabled)
  activeReclosers.forEach((setting, index) => {
    activeReclosers.slice(index + 1).forEach((candidate) => {
      if (
        setting.protectedDeviceId !== candidate.protectedDeviceId &&
        Math.abs(setting.recloseDelayS - candidate.recloseDelayS) < 0.5
      ) {
        addIssue(
          'reclose',
          [setting, candidate],
          `${deviceName(devices, setting.relayId)} 与 ${deviceName(devices, candidate.relayId)} 的重合闸延迟差不足 0.5s。`,
          `${deviceName(devices, setting.protectedDeviceId)} / ${deviceName(devices, candidate.protectedDeviceId)}`,
        )
      }
    })
  })

  const unique = new Map<string, ValidationIssue>()
  issues.forEach((issue) => unique.set(issue.id, issue))
  return [...unique.values()]
}

export function diffSettings(
  current: ProtectionSetting[],
  baseline: ProtectionSetting[],
): SettingDiff[] {
  const fields: (keyof ProtectionSetting)[] = [
    'currentA',
    'timeS',
    'direction',
    'sensitivity',
    'recloseEnabled',
    'recloseDelayS',
    'startCondition',
  ]
  const diffs: SettingDiff[] = []
  current.forEach((setting) => {
    const previous = baseline.find((item) => item.id === setting.id)
    if (!previous) {
      diffs.push({
        settingId: setting.id,
        relayName: setting.relayId,
        field: 'id',
        before: '不存在',
        after: setting.id,
      })
      return
    }
    fields.forEach((field) => {
      if (previous[field] !== setting[field]) {
        diffs.push({
          settingId: setting.id,
          relayName: setting.relayId,
          field,
          before: previous[field] as string | number | boolean,
          after: setting[field] as string | number | boolean,
        })
      }
    })
  })
  return diffs
}
