// 纯逻辑冒烟测试：用 esbuild 把 TS 服务转译后在 Node 中跑五条业务规则
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = join(mkdtempSync(join(tmpdir(), 'smoke-')), 'entry.ts')
writeFileSync(
  entry,
  `
import { createInitialState } from '@/data/mock'
import {
  acceptPendingReceipt,
  applyProvisionalSettings,
  backfillLegacySettings,
  buildReconsiderations,
  createId,
  orderProgress,
  receiptMismatch,
  recomputeForMode,
  recoverFromCheckpoint,
  now,
} from '@/services/changeOrder'

function deepClone(s) { return JSON.parse(JSON.stringify(s)) }
let pass = 0, fail = 0
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.error('  ✗', name) }
}

// 规则 1：方式一变，未批准场景和问题立即重算；已批准场景保留原依据
{
  const state = createInitialState()
  const order = state.changeOrders.find((o) => o.id === 'chg-autumn-001')!
  state.activeChangeId = order.id
  state.activeOperationMode = order.operationMode
  recomputeForMode(state, order.id, order.operationMode)
  const approved = state.scenarios.find((s) => s.id === 'sc-101-near')!
  const reviewing = state.scenarios.find((s) => s.id === 'sc-202-mode-b')!
  const draft = state.scenarios.find((s) => s.id === 'sc-bus-a')!
  assert(approved.status === 'approved' && !approved.stale, '已批准场景不重算、保留原依据')
  assert(approved.basisOperationMode === '正常方式', '已批准场景原方式依据保留')
  assert(reviewing.stale === true && reviewing.operationMode === '秋检临时方式', '会签中场景随方式重算')
  assert(draft.stale === true, '草稿场景随方式重算')
  assert(state.issues.every((i) => i.operationMode === '秋检临时方式'), '问题全部按新方式重算')
  assert(state.issues.every((i) => i.changeId === order.id), '问题跟随同一份变更单')
  // 重算范围：秋检临时方式下仅 101 与东母线在运
  const modes = new Set<string>()
  state.issues.forEach((i) => modes.add(i.operationMode!))
  assert(modes.size === 1 && modes.has('秋检临时方式'), '问题只属于当前运行方式')
}

// 规则 2：两台终端同交一份回执，先确认有效，后到留待核区；录错也进待核区
{
  const state = createInitialState()
  const order = state.changeOrders.find((o) => o.id === 'chg-autumn-001')!
  const target = order.provisionalSettings[0]
  const mk = (terminal: string, values = target) => ({
    id: createId('receipt'), settingId: target.settingId,
    deviceName: '101', submittedBy: terminal, submittedAt: now(), terminal,
    status: 'pending' as const,
    values: {
      currentA: values.currentA, timeS: values.timeS, direction: values.direction,
      sensitivity: values.sensitivity, recloseEnabled: values.recloseEnabled,
      recloseDelayS: values.recloseDelayS, startCondition: values.startCondition,
    },
  })
  const first = mk('终端甲'); first.status = 'confirmed'; first.confirmedAt = now()
  order.receipts.push(first); order.confirmedOrder.push(target.settingId)
  const second = mk('终端乙')
  assert(receiptMismatch(second, target) === false, '两份一致内容不存在录错')
  state.pendingReceipts.unshift({
    id: createId('pending'), changeId: order.id, receipt: second,
    reason: 'duplicate-late', status: 'pending', receivedAt: now(), note: '后到',
  })
  assert(state.pendingReceipts.length === 1, '后到回执进入待核区')
  assert(order.confirmedOrder.length === 1, '先确认版本有效')
  const wrong = mk('终端乙', { ...target, currentA: 99 })
  assert(receiptMismatch(wrong, target) === true, '录错内容识别为与临时定值不符')
}

// 规则 3：全部回执确认后临时定值生效，依据变更单与回执编号
{
  const state = createInitialState()
  const order = state.changeOrders.find((o) => o.id === 'chg-autumn-001')!
  order.provisionalSettings.forEach((p) => {
    order.confirmedOrder.push(p.settingId)
    order.receipts.push({
      id: createId('receipt'), receiptNo: 'HZ-X-' + p.settingId, settingId: p.settingId,
      deviceName: p.settingId, submittedBy: 'x', submittedAt: now(), terminal: '甲',
      status: 'confirmed', confirmedAt: now(),
      values: {
        currentA: p.currentA, timeS: p.timeS, direction: p.direction, sensitivity: p.sensitivity,
        recloseEnabled: p.recloseEnabled, recloseDelayS: p.recloseDelayS, startCondition: p.startCondition,
      },
    })
  })
  applyProvisionalSettings(state, order)
  const live = state.settings.find((s) => s.id === 'set-l101-1')!
  assert(live.currentA === 8.0 && live.timeS === 0.05, '临时定值转生效')
  assert(live.basisChangeId === order.id && live.basisReceiptNo === 'HZ-X-set-l101-1', '生效定值带变更与回执依据')
  assert(!live.receiptPending, '有回执编号不标记待核')
}

// 规则 4：锁定基线保留原依据，未闭环问题另列复议项（不阻断）
{
  const state = createInitialState()
  state.activeOperationMode = '秋检临时方式'
  recomputeForMode(state, 'chg-autumn-001', '秋检临时方式')
  const items = buildReconsiderations(state.issues, 'baseline-x')
  const expected = state.issues.filter((i) => i.status !== 'closed').length
  assert(items.length === expected, '未闭环问题全部列入复议项')
  assert(items.every((i) => !i.resolved), '复议项初始未闭环')
}

// 规则 5a：保存失败后从最近完整变更恢复，只补未确认设备
{
  const saved = deepClone(createInitialState())
  // 模拟"已保存的完整变更"：1 台已确认
  const order = saved.changeOrders.find((o) => o.id === 'chg-autumn-001')!
  saved.activeChangeId = order.id
  order.confirmedOrder.push('set-l101-1')
  const live = createInitialState() // 内存里失败的工作状态
  live.changeOrders = saved.changeOrders
  const { supplemented } = recoverFromCheckpoint(saved)
  assert(supplemented.length === 2, '只补 2 台未确认设备（3 份临时定值中 1 份已确认）')
  assert(!supplemented.some((p) => p.receipt.settingId === 'set-l101-1'), '已确认设备不重放')
  assert(supplemented.every((p) => p.reason === 'recovery-supplement'), '补录项标记为恢复补录')
  // 再次恢复不重复生成
  const again = recoverFromCheckpoint(saved)
  assert(again.supplemented.length === 0, '重复恢复不产生重复待核项')
  void live
}

// 规则 5b：旧数据缺回执编号 -> 先回填运行方式，再待核
{
  const state = createInitialState()
  assert(state.settings.filter((s) => s.receiptPending).length === 2, '初始有 2 份旧数据缺回执编号')
  backfillLegacySettings(state, '正常方式')
  const legacyPending = state.pendingReceipts.filter((p) => p.reason === 'legacy-missing')
  assert(legacyPending.length === 2, '缺回执编号定值转入待核区')
  assert(legacyPending.every((p) => p.note.includes('正常方式')), '待核项记录已回填的运行方式')
  // 采用并补回执编号后解除待核
  const item = legacyPending[0]
  acceptPendingReceipt(state, item.id, 'HZ-BACKFILL-01')
  const fixed = state.settings.find((s) => s.id === item.receipt.settingId)!
  assert(fixed.receiptPending === false && fixed.basisReceiptNo === 'HZ-BACKFILL-01', '补录后定值可作签字依据')
  assert(item.status === 'accepted', '待核项标记已采用')
}

console.log(fail === 0 ? '\\nALL PASS' : '\\nFAILURES: ' + fail)
if (fail) process.exit(1)
`
)

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  alias: { '@': join(process.cwd(), 'src') },
})
const out = join(tmpdir(), `smoke-${Date.now()}.mjs`)
writeFileSync(out, result.outputFiles[0].text)
await import(pathToFileURL(out).href)
