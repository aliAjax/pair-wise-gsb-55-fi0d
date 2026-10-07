// 需在导入业务模块前安装浏览器垫片
const memory = new Map<string, string>()
const localStorageShim = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, String(value))
  },
  removeItem: (key: string) => {
    memory.delete(key)
  },
  clear: () => memory.clear(),
}
;(globalThis as Record<string, unknown>).localStorage = localStorageShim
;(globalThis as Record<string, unknown>).window = {
  localStorage: localStorageShim,
  setTimeout: (fn: () => void) => {
    fn()
    return 0
  },
}

import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../src/stores/app'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) passed += 1
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function freshStore() {
  memory.clear()
  setActivePinia(createPinia())
  return useAppStore()
}

async function main() {
  // ---------- A. 两台终端同一回执：先到有效，后到留待核区 ----------
  {
    const store = freshStore()
    const order = store.data.changeOrders[0]
    const unconfirmedId = order.items.find((i) => !i.confirmed)!.id

    const first = await store.submitReceipt(order.id, unconfirmedId, { channel: 'terminal-a' })
    check('A 终端先到被接受', first.accepted === true)
    const item1 = store.data.changeOrders[0].items.find((i) => i.id === unconfirmedId)!
    check('先到版本标记为终端A', item1.confirmedBy === 'terminal-a' && Boolean(item1.receiptNo))

    const second = await store.submitReceipt(order.id, unconfirmedId, { channel: 'terminal-b' })
    check('B 终端后到不被接受', second.accepted === false && second.reason === 'duplicate-late')
    const order2 = store.data.changeOrders[0]
    check('后到回执进入待核区', order2.pendingReceipts.length === 1)
    check('待核原因=重复晚到', order2.pendingReceipts[0].reason === 'duplicate-late')
    check('有效版本仍是终端A', order2.items.find((i) => i.id === unconfirmedId)!.confirmedBy === 'terminal-a')

    await store.admitPending(order.id, order2.pendingReceipts[0].id, 'RC-MANUAL-1')
    const order3 = store.data.changeOrders[0]
    check('人工核入后待核区清空', order3.pendingReceipts.length === 0)
    check('核入后回执编号更新', order3.items.find((i) => i.id === unconfirmedId)!.receiptNo === 'RC-MANUAL-1')
  }

  // ---------- B. 回执录错：内容不符进待核区 ----------
  {
    const store = freshStore()
    const order = store.data.changeOrders[0]
    const target = order.items.find((i) => i.id === 'item-t1-2')!
    const accepted = await store.submitReceipt(order.id, target.id, { channel: 'terminal-a' })
    check('B 首份正常回执有效', accepted.accepted === true)
    const mismatch = await store.submitReceipt(order.id, target.id, {
      channel: 'terminal-b',
      payload: { currentA: target.after.currentA + 0.5, timeS: target.after.timeS },
    })
    check('录错回执不覆盖有效版本', mismatch.accepted === false && mismatch.reason === 'content-mismatch')
    const pending = store.data.changeOrders[0].pendingReceipts[0]
    check('待核说明包含字段差异', pending.detail.includes('currentA'))
    await store.discardPending(order.id, pending.id)
    check('驳回后待核区清空', store.data.changeOrders[0].pendingReceipts.length === 0)
  }

  // ---------- C. 保存失败：检查点不被破坏，恢复只补未确认设备 ----------
  {
    const store = freshStore()
    const orderId = store.data.changeOrders[0].id
    const t12 = 'item-t1-2'
    const l2022 = 'item-l202-2'
    const seedConfirmed = store.data.changeOrders[0].items.find((i) => i.confirmed)!

    // 先成功确认 l202-2，形成最近一次完整保存（检查点）
    await store.submitReceipt(orderId, l2022, { channel: 'terminal-a' })

    // 预置下一次保存失败：提交 t1-2 回执时落盘中断
    store.armFailure()
    let failed = false
    try {
      await store.submitReceipt(orderId, t12, { channel: 'terminal-a' })
    } catch {
      failed = true
    }
    check('保存失败被上抛', failed)
    const persisted = JSON.parse(memory.get('grid-protection-review-v1')!)
    const persistedOrder = persisted.changeOrders.find((o: { id: string }) => o.id === orderId)
    check('失败后检查点仍是上次完整状态(t1-2未确认)', !persistedOrder.items.find((i: { id: string }) => i.id === t12).confirmed)
    check('检查点中 l202-2 已确认', persistedOrder.items.find((i: { id: string }) => i.id === l2022).confirmed)
    check('检查点保持完整', memory.has('grid-protection-review-checkpoint-v1'))

    // 恢复：只补未确认设备 t1-2
    await store.recoverAfterFailure()
    const recoveredOrder = store.data.changeOrders[0]
    const recoveredT12 = recoveredOrder.items.find((i) => i.id === t12)!
    const recoveredL2022 = recoveredOrder.items.find((i) => i.id === l2022)!
    const recoveredSeed = recoveredOrder.items.find((i) => i.id === seedConfirmed.id)!
    check('恢复后未确认设备标记补推', recoveredT12.reissuedAfterFailure === true && !recoveredT12.confirmed)
    check('已确认设备不重复下发', !recoveredL2022.reissuedAfterFailure && !recoveredSeed.reissuedAfterFailure)
    check('恢复只补 1 台未确认设备', store.data.lastRecovery?.reissuedItemIds.length === 1)
    check('恢复留痕审计', store.data.audit.some((a) => a.action === '故障恢复'))
  }

  // ---------- D. 旧数据缺回执编号：先回填方式，再待核 ----------
  {
    const store = freshStore()
    const legacy = store.data.changeOrders[1]
    const pending = legacy.pendingReceipts[0]
    check('D 旧单初始方式待回填', legacy.modeAfter === '待回填运行方式')

    let blocked = false
    try {
      await store.admitPending(legacy.id, pending.id, 'RC-OLD-1')
    } catch {
      blocked = true
    }
    check('未回填方式不能核入', blocked)

    await store.backfillLegacyMode(legacy.id, '正常方式')
    const legacy2 = store.data.changeOrders.find((o) => o.id === legacy.id)!
    check('回填后方式生效', legacy2.modeAfter === '正常方式')
    const p2 = legacy2.pendingReceipts[0]
    check('回填后待核条目标记可核', p2.modeBackfilled === true && p2.reason === 'legacy-mode-pending')
    await store.admitPending(legacy.id, p2.id, 'RC-OLD-1')
    const legacy3 = store.data.changeOrders.find((o) => o.id === legacy.id)!
    check('旧回执补编号后可核入', legacy3.items[0].confirmed && legacy3.items[0].receiptNo === 'RC-OLD-1')
    check('回填后该单参与重算', legacy3.revalidation !== undefined)
  }

  // ---------- E. 锁定基线：已确认固化、未确认保留原依据并列复议 ----------
  {
    const store = freshStore()
    const orderId = store.data.changeOrders[0].id
    const baselineBefore = store.data.baselines.length
    await store.completeChangeOrder(orderId, '秋检临时定值闭环')
    const order = store.data.changeOrders.find((o) => o.id === orderId)!
    check('E 变更单已完成', order.status === 'completed')
    const baseline = store.data.baselines[0]
    check('生成并激活新基线', baseline.id === store.data.activeBaselineId && store.data.baselines.length === baselineBefore + 1)
    check('基线挂接来源变更单', baseline.changeOrderId === orderId)
    check('原依据已随基线保留', Array.isArray(baseline.originalBasis) && baseline.originalBasis.length > 0)
    check('未确认条目另列复议项(2项)', baseline.reconsideration.length === 2)
    const snapT12 = baseline.snapshot.find((s) => s.id === 'set-t1-2')!
    const snapL2022 = baseline.snapshot.find((s) => s.id === 'set-l202-2')!
    check('未确认 t1-2 保留原依据 1.1s', snapT12.timeS === 1.1)
    check('未确认 l202-2 保留原灵敏度 1.38', snapL2022.sensitivity === 1.38)
    const snapL2021 = baseline.snapshot.find((s) => s.id === 'set-l202-1')!
    check('已确认 l202-1 固化临时定值 0.5s', snapL2021.timeS === 0.5)
    check('基线锁定已审计', store.data.audit.some((a) => a.action === '锁定基线'))
  }

  if (failures.length) {
    console.error(`\n❌ ${failures.length} 项失败：`)
    failures.forEach((f) => console.error(' -', f))
    process.exit(1)
  }
  console.log(`\n✅ ${passed} 项业务流程全部通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
