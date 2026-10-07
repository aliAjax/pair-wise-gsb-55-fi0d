import { createRouter, createWebHistory } from 'vue-router'
import DashboardView from '@/views/DashboardView.vue'
import EquipmentView from '@/views/EquipmentView.vue'
import DeviceEditorView from '@/views/DeviceEditorView.vue'
import CoordinationView from '@/views/CoordinationView.vue'
import ScenariosView from '@/views/ScenariosView.vue'
import BaselineView from '@/views/BaselineView.vue'
import AuditView from '@/views/AuditView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView, meta: { title: '总览' } },
    { path: '/devices', name: 'devices', component: EquipmentView, meta: { title: '设备台账' } },
    {
      path: '/devices/:id?',
      name: 'device-editor',
      component: DeviceEditorView,
      meta: { title: '设备与定值编辑' },
    },
    {
      path: '/coordination',
      name: 'coordination',
      component: CoordinationView,
      meta: { title: '配合校核' },
    },
    {
      path: '/scenarios',
      name: 'scenarios',
      component: ScenariosView,
      meta: { title: '故障场景' },
    },
    {
      path: '/baseline',
      name: 'baseline',
      component: BaselineView,
      meta: { title: '会签与基线' },
    },
    { path: '/audit', name: 'audit', component: AuditView, meta: { title: '审计与导出' } },
  ],
})
