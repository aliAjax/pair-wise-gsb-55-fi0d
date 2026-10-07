<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore, type ReceiptSubmission } from '@/stores/app'
import { changeStatusLabels, pendingReasonLabels } from '@/services/changeOrder'
import type { ChangeSettingValue, SettingChangeOrder } from '@/types/domain'

const store = useAppStore()
const {
  data,
  devices,
  changeOrders,
  pendingReceipts,
  resolvedPendingReceipts,
  activeChange,
  activeOperationMode,
  failedSession,
  checkpoints,
  legacySettings,
} = storeToRefs(store)

const selectedId = ref(activeChange.value?.id ?? changeOrders.value[0]?.id ?? '')
const selected = computed(
  () => changeOrders.value.find((order) => order.id === selectedId.value) ?? activeChange.value,
)

watch(
  changeOrders,
  (list) => {
    if (!list.some((order) => order.id === selectedId.value)) {
      selectedId.value = list[0]?.id ?? ''
    }
  },
  { immediate: true },
)

const confirmedSet = computed(() => new Set(selected.value?.confirmedOrder ?? []))
const unconfirmed = computed(
  () => selected.value?.provisionalSettings.filter((item) => !confirmedSet.value.has(item.settingId)) ?? [],
)
const progressText = (order: SettingChangeOrder) =>
  `${order.confirmedOrder.length} / ${order.provisionalSettings.length}`

const relayName = (relayId: string) => devices.value.find((item) => item.id === relayId)?.name ?? relayId
const orderOf = (changeId: string) =>
  changeOrders.value.find((order) => order.id === changeId)

const changeStatusType = (status: keyof typeof changeStatusLabels) =>
  ({ issued: 'warning', applied: 'success', archived: 'info', draft: 'info' })[status]

function provisionalTarget(order: SettingChangeOrder | undefined, settingId: string) {
  return order?.provisionalSettings.find((item) => item.settingId === settingId)
}

// ---------- 临时定值微调 ----------
async function patchProvisional(setting: ChangeSettingValue, field: keyof ChangeSettingValue, value: number) {
  if (!selected.value) return
  await store.updateProvisionalSetting(selected.value.id, setting.settingId, { [field]: value })
}

// ---------- 回执模拟 ----------
const receiptTargetId = ref('')
const firstTerminal = ref<'A' | 'B'>('A')
const receiptForm = reactive({
  currentA: 0,
  timeS: 0,
  sensitivity: 0,
  recloseEnabled: true,
  recloseDelayS: 0,
  direction: 'forward' as ChangeSettingValue['direction'],
  startCondition: '',
  receiptNo: '',
})

watch(
  [unconfirmed, receiptTargetId],
  () => {
    const target =
      unconfirmed.value.find((item) => item.settingId === receiptTargetId.value) ?? unconfirmed.value[0]
    receiptTargetId.value = target?.settingId ?? ''
    if (target) {
      receiptForm.currentA = target.currentA
      receiptForm.timeS = target.timeS
      receiptForm.sensitivity = target.sensitivity
      receiptForm.recloseEnabled = target.recloseEnabled
      receiptForm.recloseDelayS = target.recloseDelayS
      receiptForm.direction = target.direction
      receiptForm.startCondition = target.startCondition
      if (!receiptForm.receiptNo) {
        receiptForm.receiptNo = `HZ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 90 + 10)}`
      }
    }
  },
  { immediate: true },
)

const receiptTarget = computed(() =>
  selected.value?.provisionalSettings.find((item) => item.settingId === receiptTargetId.value),
)

function buildSubmission(terminal: string, useFormValues: boolean): ReceiptSubmission | undefined {
  if (!selected.value || !receiptTarget.value) return undefined
  const target = receiptTarget.value
  const values = useFormValues
    ? {
        currentA: receiptForm.currentA,
        timeS: receiptForm.timeS,
        sensitivity: receiptForm.sensitivity,
        recloseEnabled: receiptForm.recloseEnabled,
        recloseDelayS: receiptForm.recloseDelayS,
        direction: receiptForm.direction,
        startCondition: receiptForm.startCondition,
      }
    : {
        currentA: target.currentA,
        timeS: target.timeS,
        sensitivity: target.sensitivity,
        recloseEnabled: target.recloseEnabled,
        recloseDelayS: target.recloseDelayS,
        direction: target.direction,
        startCondition: target.startCondition,
      }
  return {
    settingId: target.settingId,
    submittedBy: terminal === 'A' ? '现场值长(甲终端)' : '巡检员(乙终端)',
    terminal: terminal === 'A' ? '终端甲' : '终端乙',
    receiptNo: receiptForm.receiptNo.trim() || undefined,
    values,
  }
}

async function issue() {
  if (!selected.value) return
  try {
    await store.issueChangeOrder(selected.value.id)
    ElMessage.success(`已切换运行方式，未批准场景与问题立即重算`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '下发失败')
  }
}

async function submitPair() {
  if (!selected.value || !receiptTarget.value) return
  const first = buildSubmission(firstTerminal.value, false)
  const second = buildSubmission(firstTerminal.value === 'A' ? 'B' : 'A', false)
  if (!first || !second) return
  try {
    const result = await store.submitReceipts(selected.value.id, [first, second])
    ElMessage.success(`先到终端确认 ${result.confirmed} 份，后到 ${result.pending} 份已留待核区`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function submitSingle() {
  if (!selected.value) return
  const submission = buildSubmission(firstTerminal.value, false)
  if (!submission) return
  try {
    const result = await store.submitReceipts(selected.value.id, [submission])
    ElMessage.success(`回执已确认 ${result.confirmed} 份${result.completed ? '，变更单闭环' : ''}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function submitMismatch() {
  if (!selected.value) return
  const submission = buildSubmission(firstTerminal.value, true)
  if (!submission) return
  try {
    const result = await store.submitReceipts(selected.value.id, [submission])
    if (result.pending) ElMessage.warning('回执内容与临时定值不符，已进入待核区')
    else ElMessage.success('回执内容一致，已确认')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

// ---------- 待核区 ----------
const acceptDialog = ref(false)
const acceptTargetId = ref('')
const acceptReceiptNo = ref('')

function openAccept(id: string) {
  acceptTargetId.value = id
  acceptReceiptNo.value = ''
  acceptDialog.value = true
}

async function confirmAccept() {
  await store.acceptPending(acceptTargetId.value, acceptReceiptNo.value)
  acceptDialog.value = false
  ElMessage.success('待核回执已采用，定值依据已更新')
}

async function discard(id: string) {
  await store.discardPending(id)
  ElMessage.success('已作废，以先确认版本为准')
}

function mismatchFields(pendingId: string) {
  const pending = data.value.pendingReceipts.find((item) => item.id === pendingId)
  const target = provisionalTarget(orderOf(pending?.changeId ?? ''), pending?.receipt.settingId ?? '')
  if (!pending || !target) return []
  const fields: [string, unknown, unknown][] = [
    ['电流(A)', pending.receipt.values.currentA, target.currentA],
    ['时限(s)', pending.receipt.values.timeS, target.timeS],
    ['灵敏度', pending.receipt.values.sensitivity, target.sensitivity],
    ['重合延迟', pending.receipt.values.recloseDelayS, target.recloseDelayS],
    ['启动条件', pending.receipt.values.startCondition, target.startCondition],
  ]
  return fields.filter(([, received, expected]) => received !== expected)
}

// ---------- 旧数据回填 ----------
async function backfill() {
  await store.backfillLegacy(activeOperationMode.value)
  ElMessage.success('已先回填运行方式，缺回执编号定值转入待核区')
}

// ---------- 保存失败与恢复 ----------
function armFailure() {
  store.armSaveFailure()
  ElMessage.warning('已模拟：下一次保存将失败（可再执行一次回执确认触发）')
}

async function recover() {
  try {
    const count = await store.recoverAfterFailure()
    ElMessage.success(`已从最近一次完整变更恢复，${count} 台未确认设备补入待核区`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复失败')
  }
}
</script>

<template>
  <div>
    <PageHeader
      title="定值变更与现场回执"
      description="运行方式、临时定值、校验问题、故障场景与基线跟随同一份变更单：方式一变立即重算，先确认回执有效，后到内容进待核区。"
    >
      <template #actions>
        <el-tag type="warning" effect="plain">当前运行方式：{{ activeOperationMode }}</el-tag>
        <el-tag v-if="activeChange" type="primary" effect="plain">{{ activeChange.code }}</el-tag>
      </template>
    </PageHeader>

    <el-alert
      v-if="failedSession"
      :title="`保存失败（${new Date(failedSession.at).toLocaleString('zh-CN')}）：${failedSession.detail}`"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
    >
      <template #default>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>现场数据未完整写入，可从最近一次完整变更恢复，只补未确认设备。</span>
          <el-button type="danger" size="small" @click="recover">从最近完整变更恢复</el-button>
        </div>
      </template>
    </el-alert>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>定值变更单</h3>
          <el-tag effect="round">{{ changeOrders.length }} 份</el-tag>
        </div>
        <el-table :data="changeOrders" highlight-current-row @current-change="selectedId = $event?.id ?? selectedId">
          <el-table-column prop="code" label="单号" width="170" />
          <el-table-column prop="title" label="变更单" min-width="180" />
          <el-table-column label="运行方式" width="120">
            <template #default="{ row }">
              <span>{{ row.previousOperationMode }} → </span><strong>{{ row.operationMode }}</strong>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="130">
            <template #default="{ row }">
              <el-tag
                :type="changeStatusType(row.status)"
                effect="plain"
              >
                {{ changeStatusLabels[row.status as keyof typeof changeStatusLabels] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="回执" width="80">
            <template #default="{ row }">{{ progressText(row) }}</template>
          </el-table-column>
        </el-table>
      </section>

      <section v-if="selected" class="panel">
        <div class="panel-title">
          <div>
            <h3>{{ selected.title }}</h3>
            <span class="muted">{{ selected.code }} · {{ selected.reason }}</span>
          </div>
          <div>
            <el-button
              v-if="selected.status === 'draft'"
              type="primary"
              @click="issue"
            >
              按方式下发并立即重算
            </el-button>
            <el-tag v-else :type="selected.status === 'issued' ? 'warning' : 'success'" effect="plain">
              {{ changeStatusLabels[selected.status] }}
            </el-tag>
          </div>
        </div>

        <el-progress
          :percentage="selected.provisionalSettings.length
            ? Math.round((selected.confirmedOrder.length / selected.provisionalSettings.length) * 100)
            : 0"
          :status="selected.status === 'applied' || selected.status === 'archived' ? 'success' : undefined"
          style="margin: 6px 0 14px"
        />

        <el-table :data="selected.provisionalSettings" max-height="300">
          <el-table-column label="保护装置" min-width="150">
            <template #default="{ row }">{{ relayName(row.relayId) }}（{{ row.stage }} 段）</template>
          </el-table-column>
          <el-table-column label="临时电流(A)" width="120">
            <template #default="{ row }">
              <el-input-number
                v-if="selected.status === 'draft'"
                :model-value="row.currentA"
                :min="0.1"
                :step="0.1"
                size="small"
                @change="(v: number) => patchProvisional(row, 'currentA', v)"
              />
              <span v-else>{{ row.currentA }}</span>
            </template>
          </el-table-column>
          <el-table-column label="临时时限(s)" width="120">
            <template #default="{ row }">
              <el-input-number
                v-if="selected.status === 'draft'"
                :model-value="row.timeS"
                :min="0"
                :step="0.05"
                size="small"
                @change="(v: number) => patchProvisional(row, 'timeS', v)"
              />
              <span v-else>{{ row.timeS }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="sensitivity" label="灵敏度" width="90" />
          <el-table-column label="回执状态" width="150">
            <template #default="{ row }">
              <el-tag v-if="confirmedSet.has(row.settingId)" type="success" effect="plain">
                已确认 {{ selected.receipts.find((r) => r.settingId === row.settingId)?.receiptNo ?? '' }}
              </el-tag>
              <el-tag v-else type="info" effect="plain">等待回执</el-tag>
            </template>
          </el-table-column>
        </el-table>
        <p class="muted" style="margin-top: 10px">{{ selected.notes }}</p>
      </section>
    </div>

    <section v-if="selected && selected.status === 'issued'" class="panel">
      <div class="panel-title">
        <h3>现场回执提交（双终端并发模拟）</h3>
        <span class="muted">同一设备两台终端同时提交时，先确认版本有效，后到内容留待核区</span>
      </div>
      <div class="toolbar">
        <el-select v-model="receiptTargetId" placeholder="选择待确认设备" style="width: 260px">
          <el-option
            v-for="item in unconfirmed"
            :key="item.settingId"
            :label="`${relayName(item.relayId)}（${item.stage} 段）`"
            :value="item.settingId"
          />
        </el-select>
        <span class="muted">先到终端</span>
        <el-radio-group v-model="firstTerminal">
          <el-radio-button value="A">终端甲先到</el-radio-button>
          <el-radio-button value="B">终端乙先到</el-radio-button>
        </el-radio-group>
        <el-input v-model="receiptForm.receiptNo" placeholder="回执编号（可选）" style="width: 200px" />
        <span class="grow" />
        <el-button type="primary" @click="submitSingle">单台正常确认</el-button>
        <el-button type="warning" @click="submitPair">两台终端同时提交（一致内容）</el-button>
      </div>
      <div class="toolbar" style="margin-top: 4px">
        <span class="muted" style="margin-right: 8px">录错演练（改动下列值后提交，与临时定值不符即进待核区）：</span>
        <el-input-number v-model="receiptForm.currentA" :step="0.1" size="small" />
        <el-input-number v-model="receiptForm.timeS" :step="0.05" size="small" />
        <el-input-number v-model="receiptForm.sensitivity" :step="0.01" size="small" />
        <el-button type="danger" plain @click="submitMismatch">按当前抄录值提交</el-button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h3>待核区</h3>
        <el-tag type="warning" effect="plain">{{ pendingReceipts.length }} 条待处理</el-tag>
      </div>
      <el-table :data="pendingReceipts" max-height="320">
        <el-table-column label="类型" width="150">
          <template #default="{ row }">
            <el-tag
              :type="row.reason === 'mismatch' ? 'danger' : row.reason === 'legacy-missing' ? 'info' : 'warning'"
              effect="plain"
            >
              {{ pendingReasonLabels[row.reason as keyof typeof pendingReasonLabels] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="设备/段位" min-width="170">
          <template #default="{ row }">{{ row.receipt.deviceName }}</template>
        </el-table-column>
        <el-table-column label="来源" width="170">
          <template #default="{ row }">
            {{ row.receipt.terminal }} · {{ row.receipt.submittedBy }}
          </template>
        </el-table-column>
        <el-table-column label="回执编号" width="150">
          <template #default="{ row }">{{ row.receipt.receiptNo ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="差异/说明" min-width="280">
          <template #default="{ row }">
            <div v-for="field in mismatchFields(row.id)" :key="field[0]" class="diff-line">
              {{ field[0] }}：抄录 <span class="diff-after">{{ field[1] }}</span> / 下发
              <span class="diff-before">{{ field[2] }}</span>
            </div>
            <span v-if="!mismatchFields(row.id).length" class="muted">{{ row.note }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openAccept(row.id)">采用并补编号</el-button>
            <el-button link type="danger" @click="discard(row.id)">作废</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!pendingReceipts.length" description="待核区为空" :image-size="70" />
      <el-collapse v-if="resolvedPendingReceipts.length" style="margin-top: 8px">
        <el-collapse-item :title="`已处理记录（${resolvedPendingReceipts.length}）`" name="resolved">
          <el-table :data="resolvedPendingReceipts" max-height="200">
            <el-table-column label="类型" width="150">
              <template #default="{ row }">
                {{ pendingReasonLabels[row.reason as keyof typeof pendingReasonLabels] }}
              </template>
            </el-table-column>
            <el-table-column prop="receipt.deviceName" label="设备" min-width="160" />
            <el-table-column label="处理结果" width="110">
              <template #default="{ row }">
                <el-tag :type="row.status === 'accepted' ? 'success' : 'info'" effect="plain">
                  {{ row.status === 'accepted' ? '已采用' : '已作废' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="260" />
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </section>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>旧数据缺回执编号</h3>
          <el-button type="primary" :disabled="!legacySettings.length" @click="backfill">
            先回填运行方式再转待核
          </el-button>
        </div>
        <el-alert
          title="旧数据缺少回执编号时，审校台不得按其签字；先回填运行方式，再在待核区补录回执编号。"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 10px"
        />
        <el-table :data="legacySettings" max-height="240">
          <el-table-column label="保护装置" min-width="170">
            <template #default="{ row }">{{ relayName(row.relayId) }}（{{ row.stage }} 段）</template>
          </el-table-column>
          <el-table-column prop="currentA" label="电流(A)" width="100" />
          <el-table-column prop="timeS" label="时限(s)" width="100" />
          <el-table-column label="签字依据" width="130">
            <template #default>
              <el-tag type="danger" effect="plain">缺回执·待核</el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!legacySettings.length" description="旧数据均已带回执编号" :image-size="60" />
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>保存失败与完整变更恢复</h3>
          <el-button type="danger" plain @click="armFailure">模拟下一次保存失败</el-button>
        </div>
        <el-alert
          title="恢复规则：从最近一次完整变更检查点恢复，仅把未确认设备补入待核区；已确认设备不重放。"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 10px"
        />
        <el-timeline>
          <el-timeline-item
            v-for="item in checkpoints.slice(0, 5)"
            :key="item.id"
            :timestamp="new Date(item.createdAt).toLocaleString('zh-CN')"
            placement="top"
          >
            <strong>{{ item.label }}</strong>
            <span class="muted"> · {{ item.state.settings.length }} 条定值 · {{ item.state.issues.length }} 条问题</span>
          </el-timeline-item>
        </el-timeline>
      </section>
    </div>

    <el-dialog v-model="acceptDialog" title="采用待核回执并补录回执编号" width="460px">
      <el-form label-width="100px">
        <el-form-item label="回执编号" required>
          <el-input v-model="acceptReceiptNo" placeholder="例如 HZ-20261007-31" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="acceptDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!acceptReceiptNo.trim()" @click="confirmAccept">
          确认采用
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.diff-line {
  font-size: 12px;
  line-height: 1.8;
}
</style>
