<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { diffSettings } from '@/services/validation'

const store = useAppStore()
const { data, settings, activeOperationMode } = storeToRefs(store)
const selectedId = ref(data.value.activeBaselineId ?? data.value.baselines[0]?.id ?? '')
const createDialog = ref(false)
const baselineNote = ref('')
const comment = ref('')

const selected = computed(() => data.value.baselines.find((item) => item.id === selectedId.value))
const openReconsiderations = computed(
  () => selected.value?.reconsiderations.filter((item) => !item.resolved) ?? [],
)
const diffs = computed(() => {
  if (!selected.value) return []
  return diffSettings(settings.value, selected.value.snapshot)
})
const baselineComments = computed(() =>
  data.value.comments.filter(
    (item) => item.targetType === 'baseline' && item.targetId === selectedId.value,
  ),
)

watch(
  () => data.value.baselines,
  (list) => {
    if (!list.some((item) => item.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
  },
)

const fieldLabels: Record<string, string> = {
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
}

async function createBaseline() {
  if (!baselineNote.value.trim()) {
    ElMessage.warning('请填写本次基线说明')
    return
  }
  const created = await store.createBaseline(baselineNote.value.trim())
  selectedId.value = created.id
  baselineNote.value = ''
  createDialog.value = false
  ElMessage.success('基线已提交会签')
}

async function lockBaseline() {
  if (!selected.value) return
  await store.approveBaseline(selected.value.id)
  ElMessage.success('基线已锁定：原依据保留，未闭环问题另列复议项')
}

async function resolveRecon(itemId: string) {
  if (!selected.value) return
  await store.resolveReconsideration(selected.value.id, itemId)
  ElMessage.success('复议项已闭环并转回校核台')
}

async function submitComment() {
  if (!selected.value || !comment.value.trim()) return
  await store.addComment({
    targetType: 'baseline',
    targetId: selected.value.id,
    author: '当前用户',
    content: comment.value.trim(),
    status: 'open',
  })
  comment.value = ''
  ElMessage.success('会签意见已记录')
}
</script>

<template>
  <div>
    <PageHeader
      title="会签与基线"
      description="锁定基线保留原依据快照；未闭环问题不阻断锁定，自动另列复议项随基线追踪。"
    >
      <template #actions>
        <el-tag effect="plain" type="info">锁定方式：{{ activeOperationMode }}</el-tag>
        <el-button @click="createDialog = true">创建基线上会签</el-button>
        <el-button
          type="primary"
          :disabled="!selected || selected.status === 'locked'"
          :loading="store.saving"
          @click="lockBaseline"
        >
          批准并锁定
        </el-button>
      </template>
    </PageHeader>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>版本清单</h3>
          <span class="muted">锁定后作为后续差异比较基线</span>
        </div>
        <el-table :data="data.baselines" highlight-current-row @current-change="selectedId = $event?.id ?? selectedId">
          <el-table-column prop="version" label="版本" width="90" />
          <el-table-column prop="note" label="说明" min-width="220" />
          <el-table-column prop="createdBy" label="创建人" width="95" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag
                :type="row.status === 'locked' ? 'success' : row.status === 'reviewing' ? 'warning' : 'info'"
                effect="plain"
              >
                {{ row.status === 'locked' ? '已锁定' : row.status === 'reviewing' ? '会签中' : '草稿' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="checksum" label="校验码" width="115" />
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>{{ selected?.version ?? '未选择版本' }}</h3>
          <el-tag v-if="selected" :type="selected.status === 'locked' ? 'success' : 'warning'" effect="plain">
            {{ selected.status === 'locked' ? '基线已冻结' : '会签进行中' }}
          </el-tag>
        </div>
        <template v-if="selected">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="基线说明">{{ selected.note }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">
              {{ new Date(selected.createdAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
            <el-descriptions-item label="锁定时间">
              {{ selected.lockedAt ? new Date(selected.lockedAt).toLocaleString('zh-CN') : '尚未锁定' }}
            </el-descriptions-item>
            <el-descriptions-item label="快照定值">{{ selected.snapshot.length }} 条</el-descriptions-item>
            <el-descriptions-item label="校验码">
              <span class="mono">{{ selected.checksum }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="锁定运行方式">{{ selected.operationMode ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="原依据保留说明">
              {{ selected.originalBasisNote ?? '锁定后将自动生成原依据说明。' }}
            </el-descriptions-item>
          </el-descriptions>

          <div class="panel-title" style="margin-top: 18px">
            <h3>与当前定值差异</h3>
            <el-tag :type="diffs.length ? 'warning' : 'success'" effect="plain">
              {{ diffs.length }} 项变化
            </el-tag>
          </div>
          <el-table :data="diffs" max-height="260">
            <el-table-column label="保护装置" width="115">
              <template #default="{ row }">
                {{ data.devices.find((device) => device.id === row.relayName)?.name ?? row.relayName }}
              </template>
            </el-table-column>
            <el-table-column label="字段" width="110">
              <template #default="{ row }">{{ fieldLabels[row.field] ?? row.field }}</template>
            </el-table-column>
            <el-table-column label="基线值" width="120">
              <template #default="{ row }"><span class="diff-before">{{ row.before }}</span></template>
            </el-table-column>
            <el-table-column label="当前值" min-width="130">
              <template #default="{ row }"><span class="diff-after">{{ row.after }}</span></template>
            </el-table-column>
          </el-table>
        </template>
      </section>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>会签意见</h3></div>
        <div v-for="item in baselineComments" :key="item.id" class="comment-item">
          <div class="comment-meta">
            <strong>{{ item.author }}</strong>
            <span>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</span>
          </div>
          <div>{{ item.content }}</div>
        </div>
        <el-empty v-if="!baselineComments.length" description="该版本暂无会签意见" :image-size="70" />
        <el-input
          v-model="comment"
          type="textarea"
          :rows="3"
          placeholder="填写对定值基线、差异或锁定条件的意见"
        />
        <el-button type="primary" style="margin-top: 10px" :disabled="!comment.trim()" @click="submitComment">
          记录意见
        </el-button>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>复议项（保留原依据）</h3>
          <el-tag :type="openReconsiderations.length ? 'warning' : 'success'" effect="plain">
            {{ openReconsiderations.length }} 项待复议
          </el-tag>
        </div>
        <el-alert
          title="锁定基线不改变定值快照与原依据；锁定时仍未闭环的问题自动列入复议项，结论形成后转回校核台。"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 10px"
        />
        <el-table :data="selected?.reconsiderations ?? []" max-height="300">
          <el-table-column label="等级" width="70">
            <template #default="{ row }">
              <el-tag :type="row.level === 'high' ? 'danger' : 'warning'" effect="plain">
                {{ row.level === 'high' ? '高' : row.level === 'medium' ? '中' : '低' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="pairLabel" label="保护对" min-width="180" />
          <el-table-column prop="reason" label="复议原因" min-width="240" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.resolved ? 'success' : 'warning'" effect="plain">
                {{ row.resolved ? '已闭环' : '待复议' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" :disabled="row.resolved" @click="resolveRecon(row.id)">
                形成结论
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!selected?.reconsiderations.length" description="该基线暂无复议项" :image-size="70" />
      </section>
    </div>

    <el-dialog v-model="createDialog" title="创建基线上会签" width="520px">
      <el-form label-width="90px">
        <el-form-item label="基线说明" required>
          <el-input v-model="baselineNote" type="textarea" :rows="4" placeholder="说明变更范围、计算依据和会签要求" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!baselineNote.trim()" @click="createBaseline">
          提交会签
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
