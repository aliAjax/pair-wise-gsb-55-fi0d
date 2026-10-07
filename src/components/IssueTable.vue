<script setup lang="ts">
import type { Device, ValidationIssue } from '@/types/domain'
import { issueLabels } from '@/data/mock'

const props = defineProps<{
  issues: ValidationIssue[]
  devices: Device[]
  compact?: boolean
}>()

const emit = defineEmits<{
  select: [issue: ValidationIssue]
}>()

const levelType = (level: ValidationIssue['level']) =>
  level === 'high' ? 'danger' : level === 'medium' ? 'warning' : 'info'

const issueTypeType = (type: ValidationIssue['type']) =>
  type === 'overreach' || type === 'time-inversion' ? 'danger' : 'warning'

const statusLabel = (status: ValidationIssue['status']) =>
  ({ open: '待处理', replying: '意见回复中', closed: '已关闭' })[status]
</script>

<template>
  <el-table
    :data="props.issues"
    :max-height="props.compact ? 320 : undefined"
    row-key="id"
    @row-click="emit('select', $event)"
  >
    <el-table-column label="等级" width="82">
      <template #default="{ row }">
        <el-tag :type="levelType(row.level)" effect="plain">
          {{ row.level === 'high' ? '高' : row.level === 'medium' ? '中' : '低' }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="问题类型" width="116">
      <template #default="{ row }">
        <el-tag :type="issueTypeType(row.type)" effect="light">
          {{ issueLabels[row.type as keyof typeof issueLabels] }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="pairLabel" label="定位保护对" min-width="190" />
    <el-table-column label="校验结论" min-width="350">
      <template #default="{ row }">
        <div class="issue-message">{{ row.message }}</div>
        <div class="issue-suggestion">{{ row.suggestion }}</div>
      </template>
    </el-table-column>
    <el-table-column label="状态" width="110">
      <template #default="{ row }">{{ statusLabel(row.status) }}</template>
    </el-table-column>
  </el-table>
</template>
