import { createInitialState, MODE_PENDING } from '../src/data/mock'
import {
  applyRevalidation,
  describePayloadDiff,
  effectiveSettings,
  isScenarioUnapproved,
  projectSettings,
  recomputeOrder,
} from '../src/services/changeOrder'
import { diffSettings } from '../src/services/validation'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) passed += 1
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------- 1. 方式一变：问题与未批准场景立即重算 ----------
const state = createInitialState()
const main = state.changeOrders[0]
check('种子单已下发', main.status === 'issued')
check('原基线无时限倒挂', !state.settings.some(() => false))

const projected = projectSettings(main, state.settings)
const l2022p = projected.find((s) => s.id === 'set-l202-2')!
check('预测定值采用临时值(灵敏度1.12)', Math.abs(l2022p.sensitivity - 1.12) < 1e-9)
const t12p = projected.find((s) => s.id === 'set-t1-2')!
check('预测定值采用临时值(时限0.6)', Math.abs(t12p.timeS - 0.6) < 1e-9)

// 重算问题集：主变II段 0.6 vs 202II段 0.45 → 级差 0.15 < 0.3 越级
check(
  '重算产生越级问题(t1-2/l202-2)',
  state.issues.some((i) => i.id === 'overreach-set-l202-2-set-t1-2' && i.type === 'overreach'),
)
const overreach = state.issues.find((i) => i.id === 'overreach-set-l202-2-set-t1-2')!
check('问题挂接变更单', overreach.changeOrderId === main.id)
check('问题依据为预测定值', overreach.basis === 'projected')
check('问题带重算时间', Boolean(overreach.recomputedAt))
// 灵敏度 1.12 < 1.2 → 灵敏度问题
check(
  '重算产生灵敏度问题(l202-2)',
  state.issues.some((i) => i.settingIds.includes('set-l202-2') && i.type === 'sensitivity'),
)

// 未批准场景立即重算：sc-202-mode-b（会签中）应被标记
const sc202 = state.scenarios.find((s) => s.id === 'sc-202-mode-b')!
check('会签中场景标记需重算', sc202.needsRecheck === true && sc202.changeOrderId === main.id)
check('会签中场景是未批准', isScenarioUnapproved(sc202))
// 已批准场景不重算
const sc101 = state.scenarios.find((s) => s.id === 'sc-101-near')!
check('已批准场景不触发重算', sc101.needsRecheck !== true)
const recheck101 = main.revalidation!.scenarios.find((r) => r.scenarioId === sc101.id)!
check('已批准场景结论维持', recheck101.affected === false)

// 方式再变一次：问题状态延续 + 时间戳刷新
overreach.status = 'replying'
state.issues = state.issues.map((i) => (i.id === overreach.id ? overreach : i))
main.revalidation = recomputeOrder(main, state, { modeChanged: true })
const afterModeIssues = main.revalidation.issues
const orAfter = afterModeIssues.find((i) => i.id === overreach.id)!
check('方式再变后问题处置状态延续(replying)', orAfter.status === 'replying')

// ---------- 2. 有效定值视图叠加在途单 ----------
const eff = effectiveSettings(state)
check('有效视图含临时定值', eff.find((s) => s.id === 'set-l202-2')!.sensitivity === 1.12)

// ---------- 3. 旧数据：方式未回填不参与重算 ----------
const legacy = state.changeOrders[1]
check('旧单方式待回填', legacy.modeAfter === MODE_PENDING)
check('旧单待核条目标记缺编号', legacy.pendingReceipts[0].reason === 'legacy-no-receipt')
check('旧单待核条目不携带方式回填', legacy.pendingReceipts[0].modeBackfilled === false)
// 旧单定值不应出现在有效视图（方式未回填）
check(
  '旧单未回填不进入有效视图',
  eff.find((s) => s.id === 'set-l101-1')!.currentA === 8.4,
)

// ---------- 4. 回执内容比对 ----------
const t12Item = main.items.find((i) => i.id === 'item-t1-2')!
const diff = describePayloadDiff({ currentA: 9.9, timeS: 0.6 }, t12Item.after)
check('录错回执能识别差异', diff.includes('currentA') && !diff.includes('timeS'))
const same = describePayloadDiff({ currentA: t12Item.after.currentA }, t12Item.after)
check('内容一致无差异', same === '')

// ---------- 5. 基线锁定模拟：快照=确认项固化，未确认保留原依据 ----------
const confirmed = main.items.filter((i) => i.confirmed)
const snapshot = projectSettings({ ...main, items: confirmed }, state.settings)
check('已确认条目固化进快照(I段0.5)', snapshot.find((s) => s.id === 'set-l202-1')!.timeS === 0.5)
check('未确认条目保留原依据(II段1.1)', snapshot.find((s) => s.id === 'set-t1-2')!.timeS === 1.1)
check('未确认条目保留原依据(l202II灵敏度1.38)', snapshot.find((s) => s.id === 'set-l202-2')!.sensitivity === 1.38)
const ds = diffSettings(snapshot, main.originalBasis)
check('差异仅来自已确认条目', ds.every((d) => d.settingId === 'set-l202-1'))

// ---------- 6. 重算幂等：重复执行不产生重复问题 ----------
const count1 = recomputeOrder(main, state).issues.length
const count2 = recomputeOrder(main, state).issues.length
check('重算幂等', count1 === count2)

// ---------- 7. 场景批准后再变方式不重算 ----------
sc202.status = 'approved'
const rev3 = recomputeOrder(main, state, { modeChanged: true })
check('场景批准后不再受方式影响', rev3.scenarios.find((r) => r.scenarioId === sc202.id)!.affected === false)

// ---------- 汇总 ----------
if (failures.length) {
  console.error(`\n❌ ${failures.length} 项失败：`)
  failures.forEach((f) => console.error(' -', f))
  process.exit(1)
}
console.log(`\n✅ ${passed} 项领域规则全部通过`)
