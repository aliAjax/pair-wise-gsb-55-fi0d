<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { MODE_PENDING, operationModes } from '@/data/mock'
import type {
  PendingReceiptReason,
  ProtectionSetting,
  ReceiptChannel,
  SettingChangeOrder,
} from '@/types/domain'

const store = useAppStore()
const { data, devices, changeOrders } = storeToRefs(store)

const selectedId = ref(changeOrders.value[0]?.id ?? '')
const createDialog = ref(false)
const legacyMode = ref(operationModes[1])
const submitting = ref<string>('')

const selected = computed(
  () => changeOrders.value.find((order) => order.id === selectedId.value) ?? changeOrders.value[0],
)

const relayName = (relayId: string) =>
  devices.value.find((device) => device.id === relayId)?.name ?? relayId
const deviceName = (id: string) => devices.value.find((device) => device.id === id)?.name ?? id

const statusLabel = (status: SettingChangeOrder['status']) =>
  ({ draft: '草拟', issued: '已下发待回执', completed: '已完成锁定' })[status]
const statusType = (status: SettingChangeOrder['status']) =>
  status === 'completed' ? 'success' : status === 'issued' ? 'warning' : 'info'

const channelLabel = (channel: ReceiptChannel) => (channel === 'terminal-a' ? '终端 A' : '终端 B')
const confirmedOf = (order: SettingChangeOrder) => order.items.filter((item) => item.confirmed).length
const reasonLabel: Record<PendingReceiptReason, string> = {
  'duplicate-late': '重复回执晚到',
  'content-mismatch': '回执录错',
  'legacy-no-receipt': '旧数据缺回执编号',
  'legacy-mode-pending': '已回填方式待核',
}
const reasonType: Record<PendingReceiptReason, 'warning' | 'danger' | 'info'> = {
  'duplicate-late': 'warning',
  'content-mismatch': 'danger',
  'legacy-no-receipt': 'info',
  'legacy-mode-pending': 'warning',
}

const recheckScenarios = computed(() => selected.value?.revalidation?.scenarios ?? [])
const scopedIssues = computed(() =>
  data.value.issues.filter((issue) => issue.changeOrderId === selected.value?.id),
)
const confirmedCount = computed(
  () => selected.value?.items.filter((item) => item.confirmed).length ?? 0,
)

// ---------- 新建变更单 ----------
const selectableSettings = computed(() =>
  data.value.settings.map((setting) => ({
    setting,
    label: `${relayName(setting.relayId)} ${setting.stage} 段（${deviceName(setting.protectedDeviceId)}）`,
  })),
)

const form = reactive({
  title: '',
  reason: '',
  season: `${new Date().getFullYear()} 秋检`,
  modeBefore: operationModes[0],
  modeAfter: operationModes[1],
  affectedDeviceIds: [] as string[],
  settingIds: [] as string[],
  overrides: {} as Record<string, { currentA: number; timeS: number }>,
})

const entrySettings = computed(() =>
  form.settingIds
    .map((id) => data.value.settings.find((setting) => setting.id === id))
    .filter((setting): setting is ProtectionSetting => Boolean(setting)),
)

function openCreate() {
  Object.assign(form, {
    title: '',
    reason: '',
    season: `${new Date().getFullYear()} 秋检`,
    modeBefore: operationModes[0],
    modeAfter: operationModes[1],
    affectedDeviceIds: [],
    settingIds: [],
    overrides: {},
  })
  createDialog.value = true
}

async function submitCreate() {
  if (!form.title.trim()) return ElMessage.warning('请填写变更单标题')
  if (form.modeBefore === form.modeAfter) return ElMessage.warning('变更前后运行方式不能相同')
  if (!form.settingIds.length) return ElMessage.warning('至少选择一份临时定值')
  const entries = entrySettings.value.map((setting) => {
    const override = form.overrides[setting.id]
    return {
      settingId: setting.id,
      after: {
        ...setting,
        currentA: override?.currentA ?? setting.currentA,
        timeS: override?.timeS ?? setting.timeS,
      },
    }
  })
  const order = await store.createChangeOrder({
    title: form.title,
    reason: form.reason,
    season: form.season,
    modeBefore: form.modeBefore,
    modeAfter: form.modeAfter,
    affectedDeviceIds: [...form.affectedDeviceIds],
    entries,
  })
  selectedId.value = order.id
  createDialog.value = false
  ElMessage.success('变更单已下发：未批准场景和问题已立即重算')
}

// ---------- 方式变化 ----------
async function changeMode(mode: string) {
  if (!selected.value || mode === selected.value.modeAfter) return
  await store.changeOrderMode(selected.value.id, mode)
  ElMessage.success(`方式已切换为「${mode}」，校核已重算`)
}

async function backfillMode() {
  if (!selected.value) return
  await store.backfillLegacyMode(selected.value.id, legacyMode.value)
  ElMessage.success('运行方式已回填，旧回执进入待核区可核入')
}

// ---------- 现场回执（两台终端竞争） ----------
async function sendReceipt(itemId: string, channel: ReceiptChannel, mistyped = false) {
  if (!selected.value) return
  submitting.value = itemId + channel
  try {
    const item = selected.value.items.find((entry) => entry.id === itemId)
    const payload =
      item && mistyped
        ? { currentA: Number((item.after.currentA + 0.5).toFixed(2)), timeS: item.after.timeS }
        : undefined
    const result = await store.submitReceipt(selected.value.id, itemId, { channel, payload })
    if (result.accepted) {
      ElMessage.success(`${channelLabel(channel)}回执先到，版本有效`)
    } else {
      ElMessage.warning('后到回执已留在待核区，先确认版本保持有效')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '回执提交失败')
  } finally {
    submitting.value = ''
  }
}

// ---------- 待核区 ----------
async function admitPending(pendingId: string) {
  if (!selected.value) return
  const pending = selected.value.pendingReceipts.find((item) => item.id === pendingId)
  if (!pending) return
  try {
    const { value } = await ElMessageBox.prompt('请确认或补录回执编号（旧数据可补录后核入）', '待核回执核入', {
      confirmButtonText: '核入',
      cancelButtonText: '取消',
      inputValue: pending.receiptNo,
    })
    await store.admitPending(selected.value.id, pendingId, value)
    ElMessage.success('待核回执已核入')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error instanceof Error ? error.message : '核入失败')
  }
}

async function discardPending(pendingId: string) {
  if (!selected.value) return
  await store.discardPending(selected.value.id, pendingId)
  ElMessage.success('待核回执已驳回')
}

// ---------- 锁定基线 ----------
async function completeOrder() {
  if (!selected.value) return
  try {
    const { value } = await ElMessageBox.prompt(
      '未确认设备将保留原依据定值并另列复议项，确认锁定新基线？',
      `完成变更单 ${selected.value.code}`,
      { confirmButtonText: '锁定基线', cancelButtonText: '取消', inputType: 'textarea', inputValue: `${selected.value.title}回执闭环` },
    )
    await store.completeChangeOrder(selected.value.id, value || `${selected.value.title}回执闭环`)
    ElMessage.success('基线已锁定，原依据保留，复议项已另列')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error instanceof Error ? error.message : '锁定失败')
  }
}

// ---------- 保存失败演练 ----------
function armFailure() {
  store.armFailure()
  ElMessage.warning('已预置：下一次保存将失败（不落盘，检查点保持完整）')
}

async function recover() {
  await store.recoverAfterFailure()
  ElMessage.success('已从最近一次完整变更恢复，仅补推未确认设备')
}

const recovery = computed(() => store.recoveryNotice ?? data.value.lastRecovery)
</script>

<template>
  <div>
    <PageHeader
      title="定值变更单"
      description="运行方式、临时定值、校验问题、故障场景与基线跟随同一份变更：方式一变立即重算；回执先到先得，后到进待核区。"
    >
      <template #actions>
        <el-button @click="openCreate">新建变更单</el-button>
        <el-button type="warning" plain @click="armFailure">演练：预置保存失败</el-button>
        <el-button type="primary" plain @click="recover">从检查点恢复</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="recovery"
      :title="`保存失败恢复：${recovery.detail}`"
      type="success"
      :closable="false"
      show-icon
      style="margin-bottom: 14px"
    />

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>变更单列表</h3>
          <el-tag effect="plain">{{ changeOrders.length }} 单</el-tag>
        </div>
        <el-table :data="changeOrders" highlight-current-row @current-change="selectedId = $event?.id ?? selectedId">
          <el-table-column prop="code" label="单号" width="130" />
          <el-table-column prop="title" label="变更单" min-width="210" />
          <el-table-column label="方式" width="150">
            <template #default="{ row }">
              <span>{{ row.modeBefore }} → </span>
              <el-tag size="small" :type="row.modeAfter === MODE_PENDING ? 'danger' : 'warning'" effect="plain">
                {{ row.modeAfter }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="回执进度" width="90">
            <template #default="{ row }">
              {{ confirmedOf(row) }}/{{ row.items.length }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-if="selected" class="panel">
        <div class="panel-title">
          <div>
            <h3>{{ selected.code }} · {{ selected.title }}</h3>
            <span class="muted">{{ selected.season }} · 下发于 {{ new Date(selected.issuedAt ?? selected.createdAt).toLocaleString('zh-CN') }}</span>
          </div>
          <el-tag :type="statusType(selected.status)" effect="plain">{{ statusLabel(selected.status) }}</el-tag>
        </div>

        <el-alert
          v-if="selected.legacyImport && selected.modeAfter === MODE_PENDING"
          title="旧数据缺回执编号：请先回填运行方式，再对待核回执核入。回填前不参与重算与锁定。"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
        />

        <div class="mode-row">
          <span class="muted">运行方式联动</span>
          <el-tag effect="plain">{{ selected.modeBefore }}</el-tag>
          <span>→</span>
          <el-select
            :model-value="selected.modeAfter"
            :disabled="selected.status === 'completed'"
            style="width: 170px"
            @change="changeMode"
          >
            <el-option v-if="selected.legacyImport" :label="MODE_PENDING" :value="MODE_PENDING" />
            <el-option v-for="mode in operationModes" :key="mode" :label="mode" :value="mode" />
          </el-select>
          <template v-if="selected.legacyImport && selected.modeAfter === MODE_PENDING">
            <el-select v-model="legacyMode" style="width: 150px">
              <el-option v-for="mode in operationModes" :key="mode" :label="mode" :value="mode" />
            </el-select>
            <el-button type="primary" plain @click="backfillMode">先回填方式</el-button>
          </template>
          <el-tag v-if="selected.revalidation" type="success" effect="plain">
            已于 {{ new Date(selected.revalidation.recomputedAt).toLocaleTimeString('zh-CN') }} 重算
          </el-tag>
        </div>

        <el-descriptions :column="2" border size="small" style="margin: 12px 0">
          <el-descriptions-item label="变更事由" :span="2">{{ selected.reason }}</el-descriptions-item>
          <el-descriptions-item label="受影响设备">
            {{ selected.affectedDeviceIds.map(deviceName).join('、') || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="原依据">
            已保留变更前 {{ selected.originalBasis.length }} 条基线定值快照
          </el-descriptions-item>
        </el-descriptions>

        <div class="panel-title">
          <h3>临时定值与现场回执</h3>
          <span class="muted">两台终端提交同一回执，先确认者有效</span>
        </div>
        <el-table :data="selected.items" size="small" border>
          <el-table-column label="保护 / 段位" min-width="170">
            <template #default="{ row }">
              {{ relayName(row.relayId) }}
              <el-tag size="small" effect="plain">{{ row.stage }} 段</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="下发临时定值（原 → 新）" min-width="210">
            <template #default="{ row }">
              <span class="diff-before">{{ row.before.currentA }}A / {{ row.before.timeS }}s</span>
              →
              <span class="diff-after">{{ row.after.currentA }}A / {{ row.after.timeS }}s</span>
            </template>
          </el-table-column>
          <el-table-column label="确认状态" width="220">
            <template #default="{ row }">
              <template v-if="row.confirmed">
                <el-tag type="success" effect="plain">
                  {{ channelLabel(row.confirmedBy) }} · {{ row.receiptNo }}
                </el-tag>
                <el-tag v-if="row.reissuedAfterFailure" size="small" type="warning" effect="plain">
                  故障后补推
                </el-tag>
              </template>
              <template v-else-if="selected.status !== 'completed'">
                <el-button
                  size="small"
                  :loading="submitting === row.id + 'terminal-a'"
                  @click="sendReceipt(row.id, 'terminal-a')"
                >
                  终端 A 回执
                </el-button>
                <el-button
                  size="small"
                  :loading="submitting === row.id + 'terminal-b'"
                  @click="sendReceipt(row.id, 'terminal-b')"
                >
                  终端 B 回执
                </el-button>
                <el-button size="small" type="danger" plain @click="sendReceipt(row.id, 'terminal-b', true)">
                  B 录错回执
                </el-button>
              </template>
              <el-tag v-else type="info" effect="plain">未确认 · 已列复议</el-tag>
            </template>
          </el-table-column>
        </el-table>

        <div class="complete-row">
          <el-button
            type="primary"
            :disabled="selected.status === 'completed' || selected.modeAfter === MODE_PENDING"
            @click="completeOrder"
          >
            完成变更并锁定基线（{{ confirmedCount }}/{{ selected.items.length }} 已确认）
          </el-button>
          <span v-if="selected.items.length - confirmedCount" class="muted">
            未确认 {{ selected.items.length - confirmedCount }} 份：锁定时保留原依据并另列复议项
          </span>
        </div>
      </section>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>方式联动重算 · 校验问题</h3>
          <el-tag :type="scopedIssues.length ? 'danger' : 'success'" effect="plain">
            {{ scopedIssues.length }} 条随本单重算
          </el-tag>
        </div>
        <el-table :data="scopedIssues" size="small" max-height="280">
          <el-table-column label="等级" width="64">
            <template #default="{ row }">
              <el-tag size="small" :type="row.level === 'high' ? 'danger' : 'warning'" effect="plain">
                {{ row.level === 'high' ? '高' : row.level === 'medium' ? '中' : '低' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="pairLabel" label="保护对" width="180" />
          <el-table-column prop="message" label="重算结论（按临时定值）" min-width="240" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.resolved ? 'success' : row.status === 'closed' ? 'success' : 'warning'" effect="plain">
                {{ row.resolved ? '已消解' : row.status === 'closed' ? '已关闭' : row.status === 'replying' ? '回复中' : '待处理' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!scopedIssues.length" description="本单范围内暂无重算问题" :image-size="60" />
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>方式联动重算 · 故障场景</h3>
          <span class="muted">仅未批准场景立即重算</span>
        </div>
        <el-table :data="recheckScenarios" size="small" max-height="280">
          <el-table-column prop="name" label="场景" min-width="170" />
          <el-table-column label="方式" width="100">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.operationMode }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="影响" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.affected ? 'danger' : 'info'" effect="plain">
                {{ row.affected ? '需重算' : '不变' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="summary" label="重算结论" min-width="200" />
        </el-table>
      </section>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>待核区</h3>
          <el-tag :type="selected?.pendingReceipts.length ? 'warning' : 'success'" effect="plain">
            {{ selected?.pendingReceipts.length ?? 0 }} 条
          </el-tag>
        </div>
        <el-table :data="selected?.pendingReceipts ?? []" size="small">
          <el-table-column label="保护 / 段位" width="160">
            <template #default="{ row }">{{ relayName(row.relayId) }} {{ row.stage }} 段</template>
          </el-table-column>
          <el-table-column label="回执编号" width="150">
            <template #default="{ row }">
              <span :class="{ 'diff-before': !row.receiptNo }">{{ row.receiptNo || '缺编号' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="来源 / 原因" width="170">
            <template #default="{ row }">
              <div>{{ channelLabel(row.channel) }} · {{ new Date(row.submittedAt).toLocaleString('zh-CN') }}</div>
              <el-tag size="small" :type="reasonType[row.reason as PendingReceiptReason]" effect="plain">
                {{ reasonLabel[row.reason as PendingReceiptReason] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="detail" label="说明" min-width="220" />
          <el-table-column label="操作" width="150">
            <template #default="{ row }">
              <el-button
                size="small"
                type="primary"
                :disabled="(row.reason as PendingReceiptReason) === 'legacy-no-receipt'"
                @click="admitPending(row.id)"
              >
                核入
              </el-button>
              <el-button size="small" plain @click="discardPending(row.id)">驳回</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!selected?.pendingReceipts.length" description="待核区为空" :image-size="60" />
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>复议项（锁定基线保留原依据）</h3>
          <el-tag :type="selected?.reconsideration.length ? 'warning' : 'info'" effect="plain">
            {{ selected?.reconsideration.length ?? 0 }} 项
          </el-tag>
        </div>
        <div v-for="item in selected?.reconsideration ?? []" :key="item.id" class="recon-item">
          <div class="comment-meta">
            <strong>{{ relayName(item.relayId) }} {{ item.stage }} 段</strong>
            <span>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</span>
          </div>
          <p>{{ item.reason }}</p>
          <span class="muted">
            保留依据定值：{{ item.keptValue.currentA }}A / {{ item.keptValue.timeS }}s
          </span>
        </div>
        <el-empty v-if="!selected?.reconsideration.length" description="锁定基线后，未确认设备在此另列复议" :image-size="60" />
      </section>
    </div>

    <el-dialog v-model="createDialog" title="新建定值变更单" width="760px">
      <el-form :model="form" label-width="105px">
        <el-form-item label="变更单标题" required>
          <el-input v-model="form.title" placeholder="例如 秋检线路 N-1 临时定值单" />
        </el-form-item>
        <el-form-item label="检修季">
          <el-input v-model="form.season" style="width: 200px" />
        </el-form-item>
        <el-form-item label="运行方式" required>
          <el-select v-model="form.modeBefore" style="width: 180px">
            <el-option v-for="mode in operationModes" :key="`b-${mode}`" :label="mode" :value="mode" />
          </el-select>
          <span style="margin: 0 10px">→</span>
          <el-select v-model="form.modeAfter" style="width: 180px">
            <el-option v-for="mode in operationModes" :key="`a-${mode}`" :label="mode" :value="mode" />
          </el-select>
        </el-form-item>
        <el-form-item label="受影响设备">
          <el-select v-model="form.affectedDeviceIds" multiple filterable style="width: 100%">
            <el-option
              v-for="device in devices.filter((item) => item.kind !== 'relay' && item.kind !== 'breaker')"
              :key="device.id"
              :label="device.name"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="临时定值" required>
          <el-select v-model="form.settingIds" multiple filterable style="width: 100%" placeholder="选择本单下发的保护段">
            <el-option v-for="item in selectableSettings" :key="item.setting.id" :label="item.label" :value="item.setting.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-for="setting in entrySettings" :key="setting.id" :label="relayName(setting.relayId) + ' ' + setting.stage + ' 段'">
          <span class="muted" style="margin-right: 10px">
            原 {{ setting.currentA }}A / {{ setting.timeS }}s
          </span>
          <el-input-number
            v-model="(form.overrides[setting.id] ??= { currentA: setting.currentA, timeS: setting.timeS }).currentA"
            :step="0.1" :precision="2" controls-position="right"
          />
          <span style="margin: 0 6px">A</span>
          <el-input-number
            v-model="(form.overrides[setting.id] ??= { currentA: setting.currentA, timeS: setting.timeS }).timeS"
            :step="0.05" :precision="2" controls-position="right"
          />
          <span style="margin-left: 6px">s</span>
        </el-form-item>
        <el-form-item label="变更事由">
          <el-input v-model="form.reason" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">下发并立即重算</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.complete-row {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 14px;
}

.recon-item {
  padding: 10px 0;
  border-bottom: 1px solid #e7ecf0;
}

.recon-item:last-child {
  border-bottom: 0;
}

.recon-item p {
  margin: 6px 0;
  font-size: 13px;
}
</style>
