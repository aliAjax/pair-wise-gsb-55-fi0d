<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useExportMutation } from '@/api/queries'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const { data } = storeToRefs(store)
const exportMutation = useExportMutation()
const keyword = ref('')
const action = ref('')
const preview = ref('')

const actions = computed(() => [...new Set(data.value.audit.map((item) => item.action))])
const filtered = computed(() =>
  data.value.audit.filter((item) => {
    const matchesKeyword =
      !keyword.value ||
      `${item.action}${item.target}${item.detail}`.toLowerCase().includes(keyword.value.toLowerCase())
    return matchesKeyword && (!action.value || item.action === action.value)
  }),
)

async function exportList() {
  const content = await exportMutation.mutateAsync()
  preview.value = content
  const blob = new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `保护定值清单-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
  await store.recordExport('CSV', data.value.settings.length)
  ElMessage.success('定值清单已导出并写入审计')
}

async function resetData() {
  await ElMessageBox.confirm('将清除当前浏览器内的修改并恢复演示数据。', '恢复演示数据', {
    confirmButtonText: '确认恢复',
    cancelButtonText: '取消',
    type: 'warning',
  })
  await store.reset()
  preview.value = ''
  ElMessage.success('演示数据已恢复')
}
</script>

<template>
  <div>
    <PageHeader
      title="审计与导出"
      description="追踪设备、定值、问题、场景、基线和导出操作，生成可核对的定值清单。"
    >
      <template #actions>
        <el-button @click="resetData">恢复演示数据</el-button>
        <el-button type="primary" :loading="exportMutation.isPending.value" @click="exportList">
          导出定值清单
        </el-button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索操作、对象或说明" clearable style="width: 280px" />
      <el-select v-model="action" placeholder="操作类型" clearable style="width: 180px">
        <el-option v-for="item in actions" :key="item" :label="item" :value="item" />
      </el-select>
      <span class="grow" />
      <span class="muted">共 {{ filtered.length }} 条审计记录</span>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>操作审计日志</h3></div>
        <el-table :data="filtered" max-height="620">
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column prop="action" label="操作" width="130" />
          <el-table-column prop="target" label="对象" min-width="180" />
          <el-table-column prop="operator" label="操作人" width="95" />
          <el-table-column prop="detail" label="说明" min-width="260" />
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>导出预览</h3>
          <el-tag effect="plain">{{ data.settings.length }} 条定值</el-tag>
        </div>
        <el-input
          v-if="preview"
          v-model="preview"
          type="textarea"
          :rows="24"
          readonly
          class="mono"
        />
        <el-empty v-else description="点击右上角导出后在此预览 CSV 内容" />
        <el-alert
          title="导出内容来自当前浏览器持久化数据，不会上传到后端。"
          type="info"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        />
      </section>
    </div>
  </div>
</template>
