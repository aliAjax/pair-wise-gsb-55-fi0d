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
    // 越级类按装置+段位排序生成 id，保证同一保护对正反方向只产生一条问题
    const idPair =
      type === 'overreach'
        ? [...pair].sort((a, b) => a.id.localeCompare(b.id))
        : pair
    issues.push({
      id: `${type}-${idPair.map((item) => item.id).join('-')}`,
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

  // 沿设备树（含断路器等中间节点）找出相邻保护装置，只校核相邻上下级配合
  const childrenOf = (deviceId: string) => devices.filter((device) => device.parentId === deviceId)
  const nearestRelaysDown = (deviceId: string): Device[] => {
    const relays: Device[] = []
    const walk = (id: string) => {
      childrenOf(id).forEach((child) => {
        if (child.kind === 'relay') relays.push(child)
        else walk(child.id)
      })
    }
    walk(deviceId)
    return relays
  }

  settings.forEach((upstream) => {
    const protectedDevice = devices.find((device) => device.id === upstream.protectedDeviceId)
    if (!protectedDevice) return
    const downstreamRelayIds = new Set(nearestRelaysDown(upstream.protectedDeviceId).map((d) => d.id))
    const downstreamSettings = settings.filter(
      (candidate) =>
        downstreamRelayIds.has(candidate.relayId) &&
        // 同串保护按段位对应校核（I 对 I、II 对 II，避免不同段误报）
        candidate.stage === upstream.stage,
    )
    downstreamSettings.forEach((downstream) => {
      if (downstream.id === upstream.id) return
      // 级差不足 0.3s 即不满足配合：上游慢于下游为越级风险，快于下游为误动/失配风险
      const margin = upstream.timeS - downstream.timeS
      if (Math.abs(margin) < 0.3) {
        addIssue(
          'overreach',
          margin >= 0 ? [upstream, downstream] : [downstream, upstream],
          `${deviceName(devices, upstream.relayId)} 与 ${deviceName(devices, downstream.relayId)} ${upstream.stage} 段配合级差仅 ${Math.abs(margin).toFixed(2)}s${margin < 0 ? '，上级快于下级存在越级误动风险' : ''}。`,
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
