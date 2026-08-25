/**
 * dashboard.test.mjs — dsh-plugin-nlbi Dashboard 引擎测试
 */

import { tmpdir } from 'node:os'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import * as dashboard from '../lib/dashboard.js'

// 设置临时 DSH_HOME
const tmpDir = path.join(tmpdir(), 'dsh-plugin-nlbi-dash-test-' + Date.now())
process.env.DSH_HOME = tmpDir

let passed = 0
let failed = 0

function assert(ok, msg) {
  if (ok) { passed++; console.log('✓ ' + msg) }
  else { failed++; console.error('✗ ' + msg) }
}

async function cleanup() {
  try { await fsp.rm(tmpDir, { recursive: true, force: true }) } catch (e) {}
}

async function testCRUD() {
  // 1. 初始空列表
  const list1 = await dashboard.listDashboards()
  assert(list1.ok === true, 'listDashboards 初始返回 ok')
  assert(Array.isArray(list1.dashboards) && list1.dashboards.length === 0, 'listDashboards 初始为空')

  // 2. 创建 Dashboard
  const d1 = await dashboard.saveDashboard({
    name: '销售驾驶舱',
    description: '实时销售数据',
    connectionId: 'c-test',
    layout: { columns: 12, rowHeight: 80, gap: 12 },
    widgets: [],
    filters: [],
    theme: 'default',
  })
  assert(d1.ok === true, 'saveDashboard 成功')
  assert(d1.dashboard.name === '销售驾驶舱', 'Dashboard 名称正确')

  const dashId = d1.dashboard.id

  // 3. 获取单个
  const get1 = await dashboard.getDashboard(dashId)
  assert(get1.ok === true, 'getDashboard 成功')
  assert(get1.dashboard.name === '销售驾驶舱', 'getDashboard 名称正确')

  // 4. 创建第二个
  await dashboard.saveDashboard({ name: '运营看板', connectionId: 'c-test' })

  const list2 = await dashboard.listDashboards()
  assert(list2.dashboards.length === 2, 'listDashboards 有 2 个')

  // 5. 更新
  const updated = await dashboard.saveDashboard({ id: dashId, name: '销售驾驶舱 v2', connectionId: 'c-test' })
  assert(updated.ok === true, 'saveDashboard 更新成功')
  assert(updated.dashboard.name === '销售驾驶舱 v2', '更新后名称正确')

  // 6. 复制
  const dup = await dashboard.duplicateDashboard(dashId)
  assert(dup.ok === true, 'duplicateDashboard 成功')
  assert(dup.dashboard.name.includes('副本'), '副本名称包含"副本"')

  const list3 = await dashboard.listDashboards()
  assert(list3.dashboards.length === 3, '复制后有 3 个')

  // 7. 删除
  await dashboard.deleteDashboard(dashId)
  const list4 = await dashboard.listDashboards()
  assert(list4.dashboards.length === 2, '删除后剩 2 个')

  // 8. 空名称验证
  const bad = await dashboard.saveDashboard({ name: '', connectionId: 'c-test' })
  assert(bad.ok === false, 'saveDashboard 空名称拒绝')
}

async function testWidgets() {
  const d = await dashboard.saveDashboard({ name: 'Widget 测试', connectionId: 'c-test' })
  const dashId = d.dashboard.id

  // 1. 添加 widget
  const w1 = await dashboard.addWidget(dashId, {
    type: 'chart',
    title: '销售趋势',
    query: 'SELECT * FROM sales',
    chartType: 'line',
    position: { x: 0, y: 0, w: 6, h: 3 },
  })
  assert(w1.ok === true, 'addWidget 成功')
  assert(w1.widget.title === '销售趋势', 'Widget 标题正确')

  // 2. 添加第二个 widget
  await dashboard.addWidget(dashId, {
    type: 'kpi',
    title: '今日 GMV',
    query: 'SELECT SUM(amount) FROM orders',
    position: { x: 0, y: 3, w: 3, h: 2 },
  })

  const get1 = await dashboard.getDashboard(dashId)
  assert(get1.dashboard.widgets.length === 2, '有 2 个 widget')

  // 3. 更新 widget
  const updated = await dashboard.updateWidget(dashId, w1.widget.id, { title: '销售趋势（更新）' })
  assert(updated.ok === true, 'updateWidget 成功')
  assert(updated.widget.title === '销售趋势（更新）', 'widget 标题更新正确')

  // 4. 移动 widget
  const moved = await dashboard.moveWidget(dashId, w1.widget.id, { x: 3, y: 0, w: 8, h: 4 })
  assert(moved.ok === true, 'moveWidget 成功')
  assert(moved.widget.position.x === 3, 'x 位置更新正确')
  assert(moved.widget.position.w === 8, 'w 宽度更新正确')

  // 5. 删除 widget
  const removed = await dashboard.removeWidget(dashId, w1.widget.id)
  assert(removed.ok === true, 'removeWidget 成功')
  const get2 = await dashboard.getDashboard(dashId)
  assert(get2.dashboard.widgets.length === 1, '删除后剩 1 个 widget')
}

async function testFilters() {
  const d = await dashboard.saveDashboard({ name: '筛选测试', connectionId: 'c-test' })
  const dashId = d.dashboard.id

  const filters = [
    { id: 'f-region', type: 'select', label: '地区', dimension: 'region', defaultValue: 'all', options: 'SELECT DISTINCT region FROM orders' },
    { id: 'f-date', type: 'dateRange', label: '日期', dimension: 'created_at' },
  ]
  const result = await dashboard.updateFilters(dashId, filters)
  assert(result.ok === true, 'updateFilters 成功')
  assert(result.filters.length === 2, '有 2 个筛选器')

  const get = await dashboard.getDashboard(dashId)
  assert(get.dashboard.filters.length === 2, 'Dashboard 有 2 个筛选器')
}

function testInjectFilterConditions() {
  const filters = [
    { id: 'f1', type: 'select', dimension: 'region' },
    { id: 'f2', type: 'dateRange', dimension: 'created_at' },
    { id: 'f3', type: 'text', dimension: 'name' },
  ]

  // 1. 注入 WHERE
  const sql1 = dashboard.injectFilterConditions('SELECT * FROM orders', filters, { f1: '华东' })
  assert(sql1.includes("WHERE `region` = '华东'"), '注入 WHERE 条件正确')

  // 2. 注入到已有 WHERE
  const sql2 = dashboard.injectFilterConditions('SELECT * FROM orders WHERE status = 1', filters, { f1: '华东' })
  assert(sql2.includes("WHERE status = 1 AND `region` = '华东'"), '追加到已有 WHERE 正确')

  // 3. 日期范围
  const sql3 = dashboard.injectFilterConditions('SELECT * FROM orders', filters, { f2: { start: '2026-01-01', end: '2026-12-31' } })
  assert(sql3.includes("created_at` >= '2026-01-01'"), '日期范围 start 正确')
  assert(sql3.includes("created_at` <= '2026-12-31'"), '日期范围 end 正确')

  // 4. 文本模糊匹配
  const sql4 = dashboard.injectFilterConditions('SELECT * FROM orders', filters, { f3: '测试' })
  assert(sql4.includes("name` LIKE '%测试%'"), '文本模糊匹配正确')

  // 5. 无筛选条件
  const sql5 = dashboard.injectFilterConditions('SELECT * FROM orders', filters, {})
  assert(sql5 === 'SELECT * FROM orders', '无筛选条件 SQL 不变')

  // 6. 空过滤器
  const sql6 = dashboard.injectFilterConditions('SELECT * FROM orders', null, {})
  assert(sql6 === 'SELECT * FROM orders', 'null 过滤器 SQL 不变')
}

function testDrillDown() {
  const sql = dashboard.buildDrillDownQuery('SELECT * FROM orders', 'region', '华东')
  assert(sql.includes("WHERE `region` = '华东'"), '下钻 WHERE 正确')

  const sql2 = dashboard.buildDrillDownQuery('SELECT * FROM orders WHERE status = 1', 'region', '华东')
  assert(sql2.includes("WHERE status = 1 AND `region` = '华东'"), '下钻追加到已有 WHERE 正确')
}

// ── 主流程 ──

async function main() {
  console.log('── dashboard.js 测试 ──')
  try {
    await testCRUD()
    await testWidgets()
    await testFilters()
    testInjectFilterConditions()
    testDrillDown()
  } catch (err) {
    console.error('测试异常:', err.message)
    failed++
  } finally {
    await cleanup()
  }
  console.log(`\n${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main()