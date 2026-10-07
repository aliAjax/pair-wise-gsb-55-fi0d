# 电网继电保护定值配合与故障场景审校平台

面向电网继电保护工程师的本地审校工作台。项目使用 Vue 3、Element Plus、Pinia、Vue Router、TanStack Query、Axios 和 Vite 构建，并用原生 Canvas 绘制保护配合曲线。

## 功能

- 维护线路、变压器、母线、断路器和保护装置，编辑各段定值、方向、灵敏度、重合闸和启动条件。
- 批量检查越级跳闸、时限倒挂、灵敏度不足和重合逻辑冲突，问题定位到保护对，支持意见回复和关闭。
- Canvas 配合曲线支持滚轮时间轴缩放和 Shift + 滚轮电流轴缩放，装置依赖图展示上下级关系。
- 建立运行方式和故障场景，对比动作序列与停电范围，执行异常场景逐步回放。
- 创建基线快照、比较当前定值与基线差异、记录会签意见，并在高风险问题闭环后锁定基线。
- 审计设备、定值、校验、场景、基线和导出操作，导出 UTF-8 CSV 定值清单。

所有业务数据由本地模拟服务提供并通过 `localStorage` 持久化，不依赖后端。

## 运行

```bash
npm install
npm run dev
```

开发服务地址：`http://localhost:18455`

## 构建

```bash
npm run build
npm run preview
```

## 目录

```text
src/
  api/         Axios 本地适配器与 TanStack Query 查询
  components/  页面头、问题表、Canvas 曲线、装置依赖图
  data/        领域模拟数据
  router/      多页面路由
  services/    校验规则、差异计算、本地存储和导出
  stores/      Pinia 业务状态与状态流转
  types/       领域类型
  views/       总览、台账、编辑、校核、场景、基线、审计
```
