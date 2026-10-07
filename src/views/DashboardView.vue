<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const store = useAppStore()
const {
  data,
  issues,
  devices,
  scenarios,
  activeBaseline,
  activeOperationMode,
  activeChange,
  pendingReceipts,
  legacySettings,
  failedSession,
} = storeToRefs(store)

const highIssues = computed(() => issues.value.filter((issue) => issue.level === 'high'))
const staleIssues = computed(() => issues.value.filter((issue) => issue.stale))
const staleScenarios = computed(() => scenarios.value.filter((scenario) => scenario.stale))
const runningDevices = computed(() => devices.value.filter((device) => device.status === 'running').length)

const statusType = (status: string) =>
  status === 'approved' || status === 'locked'
    ? 'success'
    : status === 'reviewing'
      ? 'warning'
      : status === 'returned'
        ? 'danger'
        : 'info'

const statusText = (status: string) =>
  ({
    draft: '草稿',
    reviewing: '会签中',
    approved: '已批准',
    locked: '已锁定',
    returned: '已退回',
  })[status] ?? status

async function recover() {
  try {
    const count = await store.recoverAfterFailure()
    ElMessage.success(`已从最近完整变更恢复，${count} 台未确认设备补入待核区`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复失败')
  }
}
</script>

<template>
  <div>
    <PageHeader
      title="运行总览"
      description="运行方式、保护定值、校验问题、故障场景与基线跟随同一份定值变更单联动。"
    >
      <template #actions>
        <el-button @click="router.push('/changes')">定值变更与回执</el-button>
        <el-button @click="router.push('/coordination')">进入配合校核</el-button>
        <el-button type="primary" @click="router.push('/scenarios')">验证故障场景</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="failedSession"
      :title="`最近一次保存失败：${failedSession.detail}`"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 12px"
    >
      <template #default>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>可从最近一次完整变更恢复，只补未确认设备。</span>
          <el-button type="danger" size="small" @click="recover">立即恢复</el-button>
        </div>
      </template>
    </el-alert>
    <el-alert
      v-else-if="staleIssues.length || staleScenarios.length"
      :title="`运行方式「${activeOperationMode}」已切换：${staleIssues.length} 条问题、${staleScenarios.length} 个未批准场景已立即重算待确认；已批准场景与锁定基线保留原依据。`"
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
    />

    <section class="metric-grid">
      <div class="metric danger">
        <span>高风险问题</span>
        <strong>{{ highIssues.length }}</strong>
        <small>{{ staleIssues.length }} 条方式重算待确认</small>
      </div>
      <div class="metric warning">
        <span>待核区回执</span>
        <strong>{{ pendingReceipts.length }}</strong>
        <small>{{ legacySettings.length }} 份旧数据缺回执编号</small>
      </div>
      <div class="metric info">
        <span>运行设备</span>
        <strong>{{ runningDevices }} / {{ devices.length }}</strong>
        <small>当前方式：{{ activeOperationMode }}</small>
      </div>
      <div class="metric">
        <span>当前基线</span>
        <strong>{{ activeBaseline?.version ?? 'V1.0' }}</strong>
        <small>
          {{ activeBaseline?.reconsiderations.filter((item) => !item.resolved).length ?? 0 }} 项复议中
        </small>
      </div>
    </section>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>当前定值变更单</h3>
          <el-button text type="primary" @click="router.push('/changes')">处理回执</el-button>
        </div>
        <el-empty v-if="!activeChange" description="暂无进行中的定值变更单" :image-size="70" />
        <el-descriptions v-else :column="1" border>
          <el-descriptions-item label="单号">{{ activeChange.code }}</el-descriptions-item>
          <el-descriptions-item label="名称">{{ activeChange.title }}</el-descriptions-item>
          <el-descriptions-item label="运行方式">
            {{ activeChange.previousOperationMode }} → {{ activeChange.operationMode }}
          </el-descriptions-item>
          <el-descriptions-item label="回执确认">
            {{ activeChange.confirmedOrder.length }} / {{ activeChange.provisionalSettings.length }}
          </el-descriptions-item>
          <el-descriptions-item label="待核区">
            <el-tag :type="pendingReceipts.length ? 'warning' : 'success'" effect="plain">
              {{ pendingReceipts.length }} 条待处理
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>场景审校进度</h3>
          <el-tag effect="plain">{{ scenarios.length }} 个场景</el-tag>
        </div>
        <el-table :data="scenarios" max-height="320">
          <el-table-column prop="name" label="场景" min-width="190" />
          <el-table-column prop="operationMode" label="运行方式" width="110" />
          <el-table-column label="状态" width="150">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status)" effect="plain">
                {{ statusText(row.status) }}
              </el-tag>
              <el-tag v-if="row.stale" type="warning" effect="dark" size="small" style="margin-left: 4px">
                重算待核
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>近期审计轨迹</h3>
        <el-tag effect="plain">只读时间线</el-tag>
      </div>
      <el-timeline>
        <el-timeline-item
          v-for="entry in data.audit.slice(0, 5)"
          :key="entry.id"
          :timestamp="new Date(entry.createdAt).toLocaleString('zh-CN')"
          placement="top"
        >
          <strong>{{ entry.action }}</strong>
          <span class="muted"> · {{ entry.target }} · {{ entry.operator }}</span>
          <p>{{ entry.detail }}</p>
        </el-timeline-item>
      </el-timeline>
    </section>
  </div>
</template>
