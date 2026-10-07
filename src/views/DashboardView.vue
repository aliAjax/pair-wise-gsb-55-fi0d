<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import PageHeader from '@/components/PageHeader.vue'
import IssueTable from '@/components/IssueTable.vue'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const store = useAppStore()
const { data, issues, devices, activeBaseline, changeOrders, pendingCount } = storeToRefs(store)

const highIssues = computed(() => issues.value.filter((issue) => issue.level === 'high'))
const issuedOrders = computed(() => changeOrders.value.filter((order) => order.status === 'issued'))
const pendingReceipts = computed(() =>
  issuedOrders.value.reduce((sum, order) => sum + order.items.filter((item) => !item.confirmed).length, 0),
)
</script>

<template>
  <div>
    <PageHeader
      title="运行总览"
      description="聚焦保护配合异常、场景验证和当前可执行基线。全部数据保存在当前浏览器。"
    >
      <template #actions>
        <el-button @click="router.push('/change-orders')">定值变更单</el-button>
        <el-button type="primary" @click="router.push('/scenarios')">验证故障场景</el-button>
      </template>
    </PageHeader>

    <section class="metric-grid">
      <div class="metric danger">
        <span>高风险问题</span>
        <strong>{{ highIssues.length }}</strong>
        <small>按在途临时定值重算</small>
      </div>
      <div class="metric warning">
        <span>在途变更单</span>
        <strong>{{ issuedOrders.length }}</strong>
        <small>{{ pendingReceipts }} 份回执未确认</small>
      </div>
      <div class="metric info">
        <span>待核区</span>
        <strong>{{ pendingCount }}</strong>
        <small>迟到/录错/旧数据回执</small>
      </div>
      <div class="metric">
        <span>当前基线</span>
        <strong>{{ activeBaseline?.version ?? 'V1.0' }}</strong>
        <small>{{ activeBaseline?.checksum ?? 'A5F1-927C' }}</small>
      </div>
    </section>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>待处理校验问题</h3>
          <el-button text type="primary" @click="router.push('/coordination')">查看全部</el-button>
        </div>
        <IssueTable
          :issues="issues.slice(0, 6)"
          :devices="devices"
          compact
          @select="router.push('/coordination')"
        />
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>在途定值变更单</h3>
          <el-button text type="primary" @click="router.push('/change-orders')">进入处理</el-button>
        </div>
        <el-table :data="issuedOrders" max-height="320" @row-click="router.push('/change-orders')">
          <el-table-column prop="code" label="单号" width="130" />
          <el-table-column prop="title" label="变更单" min-width="180" />
          <el-table-column label="方式" width="150">
            <template #default="{ row }">
              <span class="muted">{{ row.modeBefore }} →</span>
              <el-tag size="small" effect="plain">{{ row.modeAfter }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="待核" width="70">
            <template #default="{ row }">
              <el-tag size="small" :type="row.pendingReceipts.length ? 'danger' : 'success'" effect="plain">
                {{ row.pendingReceipts.length }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!issuedOrders.length" description="无在途变更单" :image-size="60" />
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
