/**
 * integration.test.mjs — dsh-plugin-nlbi 集成测试套件
 *
 * 覆盖所有模块的端到端集成测试，模拟真实使用场景。
 * 测试范围：metrics → chart → dashboard → export → text2sql → sqlsafe
 *
 * 运行方式：node test/integration.test.mjs
 *
 * @module test/integration
 */

import { tmpdir } from 'node:os'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import * as metrics from '../lib/metrics.js'
import * as chart from '../lib/chart.js'
import * as dashboard from '../lib/dashboard.js'
import * as ext from '../lib/export.js'
import * as sqlsafe from '../lib/sqlsafe.js'
import { parseLlmResult, buildPrompt } from '../lib/text2sql.js'
import { classifyStatement, extractTableRefs, jsonSafe, MAX_ROWS } from '../lib/shared.js'

// ── 测试报告基础设施 ──────────────────────────────────────────────────────

const TEST_SUITE = {
  name: 'dsh-plugin-nlbi v0.2.0 集成测试套件',
  timestamp: new Date().toISOString(),
  modules: [],
  summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
}

let currentModule = ''
const testQueue = []
const moduleTestCount = {} // { moduleName: { total: 0, passed: 0 } }

function startModule(name) {
  currentModule = name
  TEST_SUITE.modules.push({ name, tests: [] })
  moduleTestCount[name] = { total: 0, passed: 0 }
  console.log(`\n═══ ${name} ═══`)
}

/** 注册测试（同步入队，不立即执行） */
function test(name, fn) {
  testQueue.push({ name, fn, module: currentModule })
}

/** 串行执行所有已注册测试 */
async function runAllTests() {
  while (testQueue.length > 0) {
    const { name, fn, module: modName } = testQueue.shift()
    TEST_SUITE.summary.total++
    if (moduleTestCount[modName]) moduleTestCount[modName].total++
    try {
      await Promise.resolve(fn())
      TEST_SUITE.summary.passed++
      if (moduleTestCount[modName]) moduleTestCount[modName].passed++
      const mod = TEST_SUITE.modules.find(m => m.name === modName)
      if (mod) mod.tests.push({ name, status: 'passed' })
      console.log(`  ✓ ${name}`)
    } catch (err) {
      TEST_SUITE.summary.failed++
      if (moduleTestCount[modName]) moduleTestCount[modName].failed = (moduleTestCount[modName].failed || 0) + 1
      const mod = TEST_SUITE.modules.find(m => m.name === modName)
      if (mod) mod.tests.push({ name, status: 'failed', error: err.message })
      console.error(`  ✗ ${name}`)
      console.error(`    ${err.message}`)
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败')
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    throw new Error(`${message || '对象不相等'}: 期望 ${e}，实际 ${a}`)
  }
}

// ── 临时存储目录 ──────────────────────────────────────────────────────────

const tmpDir = path.join(tmpdir(), 'dsh-plugin-nlbi-integration-test-' + Date.now())
process.env.DSH_HOME = tmpDir

// ── 测试用例 ──────────────────────────────────────────────────────────────

function testMetricsModule() {
  startModule('1. 指标/维度/数据集管理 (metrics.js)')

  test('空列表初始状态', async () => {
    const m = await metrics.listMetrics()
    assert(m.ok, 'listMetrics 返回 ok')
    assert(m.metrics.length === 0, '指标列表初始为空')
    const d = await metrics.listDimensions()
    assert(d.dimensions.length === 0, '维度列表初始为空')
    const ds = await metrics.listDatasets()
    assert(ds.datasets.length === 0, '数据集列表初始为空')
  })

  test('完整指标 CRUD 生命周期', async () => {
    // Create
    const gmv = await metrics.saveMetric({
      name: 'GMV',
      expression: 'SUM(order_amount)',
      sourceTable: 'orders',
      sourceColumn: 'order_amount',
      type: 'sum',
      format: 'currency',
      description: '总成交金额（GMV）',
    })
    assert(gmv.ok, '创建 GMV 指标成功')
    assert(gmv.metric.name === 'GMV', '指标名称正确')
    assert(gmv.metric.id.startsWith('m-'), '指标 ID 格式正确')
    assert(gmv.metric.createdAt, '有创建时间')

    // 创建第二个
    const orderCount = await metrics.saveMetric({
      name: '订单数',
      expression: 'COUNT(DISTINCT order_id)',
      type: 'count',
      format: 'integer',
    })
    assert(orderCount.ok, '创建订单数指标成功')

    // Read (list)
    const list = await metrics.listMetrics()
    assert(list.metrics.length === 2, '列表有 2 个指标')

    // Read (single)
    const get = await metrics.getMetricById(gmv.metric.id)
    assert(get.ok, '按 ID 查询成功')
    assert(get.metric.name === 'GMV', '查询结果名称正确')

    // Update
    const updated = await metrics.saveMetric({
      id: gmv.metric.id,
      name: 'GMV',
      expression: 'SUM(order_amount) + SUM(shipping_fee)',
      type: 'sum',
      format: 'currency',
      description: '总成交金额（含运费）',
    })
    assert(updated.ok, '更新指标成功')
    assert(updated.metric.expression.includes('shipping_fee'), '表达式已更新')

    // Delete
    const del = await metrics.deleteMetric(orderCount.metric.id)
    assert(del.ok, '删除指标成功')
    const list2 = await metrics.listMetrics()
    assert(list2.metrics.length === 1, '删除后剩 1 个')
  })

  test('维度管理完整流程', async () => {
    const region = await metrics.saveDimension({
      name: '地区',
      sourceTable: 'orders',
      sourceColumn: 'region',
      type: 'string',
      hierarchy: ['province', 'city', 'district'],
      description: '销售地区（省/市/区）',
    })
    assert(region.ok, '创建地区维度成功')
    assert(region.dimension.hierarchy.length === 3, '层级定义正确')

    const time = await metrics.saveDimension({
      name: '时间',
      sourceTable: 'orders',
      sourceColumn: 'created_at',
      type: 'date',
    })
    assert(time.ok, '创建时间维度成功')

    const list = await metrics.listDimensions()
    assert(list.dimensions.length === 2, '列表有 2 个维度')

    await metrics.deleteDimension(region.dimension.id)
    const list2 = await metrics.listDimensions()
    assert(list2.dimensions.length === 1, '删除后剩 1 个')
  })

  test('数据集管理', async () => {
    const ds = await metrics.saveDataset({
      name: '销售分析数据集',
      connectionId: 'c-prod',
      tables: ['orders', 'users', 'products'],
      joins: [
        { from: 'orders.user_id', to: 'users.id', type: 'LEFT JOIN' },
        { from: 'orders.product_id', to: 'products.id', type: 'LEFT JOIN' },
      ],
      metrics: ['m-gmv'],
      dimensions: ['d-region'],
    })
    assert(ds.ok, '创建数据集成功')
    assert(ds.dataset.tables.length === 3, '3 张表')
    assert(ds.dataset.joins.length === 2, '2 个 Join')

    // 复制数据集（通过新建）
    const ds2 = await metrics.saveDataset({
      name: '销售分析数据集（副本）',
      connectionId: 'c-prod',
      tables: ['orders', 'users'],
      joins: [],
      metrics: [],
      dimensions: [],
    })
    assert(ds2.ok, '复制数据集成功')

    const list = await metrics.listDatasets()
    assert(list.datasets.length === 2, '列表有 2 个数据集')
  })

  test('SQL 片段构建', () => {
    const metric = { name: 'GMV', expression: 'SUM(order_amount)' }
    const expr = metrics.buildMetricExpression(metric)
    assertEqual(expr, 'SUM(order_amount) AS `GMV`', '指标表达式')

    const dim = { name: '地区', sourceColumn: 'region' }
    const sql = metrics.buildDimensionSql(dim)
    assert(sql.select.includes('`region` AS `地区`'), '维度 SELECT')
    assert(sql.groupBy.includes('`region`'), '维度 GROUP BY')

    const dataset = {
      tables: ['orders', 'users'],
      joins: [{ from: 'orders.user_id', to: 'users.id', type: 'LEFT JOIN' }],
    }
    const fromClause = metrics.buildDatasetFromClause(dataset)
    assert(fromClause.includes('`orders`'), 'FROM 主表')
    assert(fromClause.includes('LEFT JOIN'), 'JOIN 子句')
  })

  test('智能推断', () => {
    const columns = ['city', 'amount', 'created_at', 'count']
    const rows = [
      { city: '北京', amount: 100, created_at: '2026-01-01', count: 1 },
      { city: '上海', amount: 200, created_at: '2026-01-02', count: 2 },
      { city: '北京', amount: 150, created_at: '2026-01-03', count: 3 },
    ]

    const dims = metrics.inferDimensions(columns, rows)
    assert(dims.length > 0, '推断出维度')
    const cityDim = dims.find(d => d.name === 'city')
    assert(cityDim, 'city 被识别为维度')
    assert(cityDim.cardinality === 2, 'city 基数为 2')

    const mets = metrics.inferMetrics(columns, rows)
    assert(mets.length > 0, '推断出指标')
    const amountMet = mets.find(m => m.name === 'amount')
    assert(amountMet, 'amount 被识别为指标')
    assertEqual(amountMet.stats.sum, 450, 'amount 求和 450')
    assertEqual(amountMet.stats.avg, 150, 'amount 平均 150')
    assertEqual(amountMet.stats.max, 200, 'amount 最大 200')
    assertEqual(amountMet.stats.min, 100, 'amount 最小 100')
  })
}

function testChartModule() {
  startModule('2. 图表引擎 (chart.js)')

  test('列类型推断', () => {
    assertEqual(chart.inferColumnKind('datetime'), 'date', 'date 类型')
    assertEqual(chart.inferColumnKind('int(11)'), 'number', 'int 类型')
    assertEqual(chart.inferColumnKind('decimal(10,2)'), 'number', 'decimal 类型')
    assertEqual(chart.inferColumnKind('varchar(255)'), 'string', 'varchar 类型')
    assertEqual(chart.inferColumnKind('tinyint(1)'), 'bool', 'tinyint(1) bool 类型')
  })

  test('基础图表类型 - 统计卡', () => {
    const r = chart.suggestChartSpec({ columns: ['sales'], rows: [{ sales: 100 }, { sales: 200 }] })
    assert(r.ok, '统计卡生成成功')
    assert(r.spec.type === 'stat', '类型为 stat')
    assert(r.spec.stats.sum === 300, 'SUM 正确')
    assert(r.spec.stats.avg === 150, 'AVG 正确')
  })

  test('基础图表类型 - 折线图', () => {
    const r = chart.suggestChartSpec({
      columns: ['date', 'sales'],
      rows: [
        { date: '2026-01-01', sales: 100 },
        { date: '2026-01-02', sales: 120 },
      ],
    })
    assert(r.ok, '折线图生成成功')
    assert(r.spec.type === 'line', '类型为 line')
    assert(r.spec.xField === 'date', 'x 轴为 date')
    assert(r.spec.yFields.includes('sales'), 'y 轴包含 sales')
  })

  test('基础图表类型 - 饼图', () => {
    const r = chart.suggestChartSpec({
      columns: ['category', 'count'],
      rows: [
        { category: 'A', count: 30 },
        { category: 'B', count: 20 },
        { category: 'C', count: 10 },
      ],
    })
    assert(r.ok, '饼图生成成功')
    assert(r.spec.type === 'pie', '类型为 pie')
  })

  test('新增图表类型 - 漏斗图', () => {
    const r = chart.suggestChartSpec({
      columns: ['step', 'users'],
      rows: [
        { step: '展示', users: 1000 },
        { step: '点击', users: 800 },
        { step: '访问', users: 600 },
        { step: '咨询', users: 400 },
        { step: '成交', users: 200 },
      ],
      chartType: 'funnel',
    })
    assert(r.ok, '漏斗图生成成功')
    assert(r.spec.type === 'funnel', '类型为 funnel')
    assert(r.spec.data.length === 5, '5 个阶段')
    // 验证降序排列
    assert(r.spec.data[0].value >= r.spec.data[1].value, '数据降序排列')
  })

  test('新增图表类型 - 散点图', () => {
    const r = chart.suggestChartSpec({
      columns: ['price', 'sales'],
      rows: [
        { price: 10, sales: 100 },
        { price: 20, sales: 80 },
        { price: 30, sales: 60 },
      ],
      chartType: 'scatter',
    })
    assert(r.ok, '散点图生成成功')
    assert(r.spec.type === 'scatter', '类型为 scatter')
  })

  test('新增图表类型 - 热力图', () => {
    const r = chart.suggestChartSpec({
      columns: ['weekday', 'hour', 'visits'],
      rows: [
        { weekday: 'Mon', hour: 'Morning', visits: 5 },
        { weekday: 'Mon', hour: 'Afternoon', visits: 8 },
        { weekday: 'Tue', hour: 'Morning', visits: 7 },
      ],
      chartType: 'heatmap',
    })
    assert(r.ok, '热力图生成成功')
    assert(r.spec.type === 'heatmap', '类型为 heatmap')
    assert(r.spec.xValues.length > 0, '有 x 轴标签')
    assert(r.spec.yValues.length > 0, '有 y 轴标签')
  })

  test('新增图表类型 - 雷达图', () => {
    const r = chart.suggestChartSpec({
      columns: ['product', 'quality', 'price', 'service'],
      rows: [
        { product: '产品A', quality: 90, price: 80, service: 70 },
        { product: '产品B', quality: 70, price: 90, service: 85 },
      ],
      chartType: 'radar',
    })
    assert(r.ok, '雷达图生成成功')
    assert(r.spec.type === 'radar', '类型为 radar')
    assert(r.spec.indicators.length > 0, '有指标')
  })

  test('新增图表类型 - 仪表盘', () => {
    const r = chart.suggestChartSpec({
      columns: ['rate'],
      rows: [{ rate: 85 }],
      chartType: 'gauge',
    })
    assert(r.ok, '仪表盘生成成功')
    assert(r.spec.type === 'gauge', '类型为 gauge')
    assert(r.spec.value === 85, '值正确')
  })

  test('新增图表类型 - 矩形树图', () => {
    const r = chart.suggestChartSpec({
      columns: ['category', 'sales'],
      rows: [
        { category: 'A', sales: 100 },
        { category: 'B', sales: 80 },
        { category: 'C', sales: 60 },
      ],
      chartType: 'treemap',
    })
    assert(r.ok, '矩形树图生成成功')
    assert(r.spec.type === 'treemap', '类型为 treemap')
    assert(r.spec.data.length === 3, '3 个数据点')
  })

  test('新增图表类型 - 堆叠柱状图', () => {
    const r = chart.suggestChartSpec({
      columns: ['month', 'revenue', 'cost'],
      rows: [
        { month: '1月', revenue: 100, cost: 60 },
        { month: '2月', revenue: 120, cost: 70 },
      ],
      chartType: 'stackedBar',
    })
    assert(r.ok, '堆叠柱状图生成成功')
    assert(r.spec.type === 'bar', '基础类型为 bar')
    assert(r.spec.stack === true, '有 stack 标记')
  })

  test('新增图表类型 - 瀑布图', () => {
    const r = chart.suggestChartSpec({
      columns: ['item', 'amount'],
      rows: [
        { item: '收入', amount: 1000 },
        { item: '成本', amount: -300 },
        { item: '利润', amount: 700 },
      ],
      chartType: 'waterfall',
    })
    assert(r.ok, '瀑布图生成成功')
    assert(r.spec.type === 'waterfall', '类型为 waterfall')
    assert(r.spec.data.length === 3, '3 个数据点')
  })

  test('新增图表类型 - 进度条', () => {
    const r = chart.suggestChartSpec({
      columns: ['progress'],
      rows: [{ progress: 72 }],
      chartType: 'progress',
    })
    assert(r.ok, '进度条生成成功')
    assert(r.spec.type === 'progress', '类型为 progress')
  })

  test('用户强制指定图表类型覆盖自动推断', () => {
    const columns = ['date', 'sales']
    const rows = [{ date: '2026-01', sales: 100 }, { date: '2026-02', sales: 120 }]
    // 不指定：自动推断
    const auto = chart.suggestChartSpec({ columns, rows })
    assert(auto.ok, '自动推断成功')
    // 强制指定 bar
    const forced = chart.suggestChartSpec({ columns, rows, chartType: 'bar' })
    assert(forced.ok, '强制 bar 成功')
    assert(forced.spec.type === 'bar', '强制 bar 类型正确')
    assert(forced.spec.xField !== null, 'bar 有 xField')
  })

  test('空数据/空列容错', () => {
    const r1 = chart.suggestChartSpec({ columns: [], rows: [] })
    assert(!r1.ok, '空列返回错误')

    const r2 = chart.suggestChartSpec({ columns: ['x'], rows: [] })
    assert(r2.ok, '只有空数据时仍可生成')

    const r3 = chart.suggestChartForResult(null, 'test')
    assert(!r3.ok, 'null result 返回错误')
  })

  test('多维分析函数', () => {
    // 同比
    assertEqual(chart.computeYoYGrowth(120, 100), 20, '同比增长 20%')
    assertEqual(chart.computeYoYGrowth(90, 100), -10, '同比下降 10%')
    assertEqual(chart.computeYoYGrowth(100, 0), null, '分母为 0 返回 null')

    // 环比
    assertEqual(chart.computeMoMGrowth(120, 100), 20, '环比增长 20%')

    // 累计
    const cum = chart.computeCumulative([{ v: 10 }, { v: 20 }, { v: 30 }], 'v')
    assertEqual(cum[2].cumulative, 60, '累计值 60')

    // 移动平均
    const ma = chart.computeMovingAverage([{ v: 10 }, { v: 20 }, { v: 30 }], 'v', 2)
    assertEqual(ma[2].ma2, 25, '移动平均 ma2=25')

    // Top N
    const top = chart.computeTopN([{ v: 10 }, { v: 30 }, { v: 20 }], 'v', 2)
    assertEqual(top.length, 2, 'Top2 返回 2 条')
    assertEqual(top[0].v, 30, 'Top1 为 30')

    // 排名
    const ranked = chart.computeRanking([{ v: 10 }, { v: 30 }, { v: 20 }], 'v')
    assertEqual(ranked[0].rank, 1, '最高值排名第 1')
    assertEqual(ranked[2].rank, 3, '最低值排名第 3')
  })
}

function testDashboardModule() {
  startModule('3. Dashboard 仪表盘 (dashboard.js)')

  test('Dashboard CRUD 全生命周期', async () => {
    // Create
    const d = await dashboard.saveDashboard({
      name: '销售驾驶舱',
      description: '实时销售数据监控',
      connectionId: 'c-prod',
      widgets: [],
      filters: [],
      theme: 'default',
    })
    assert(d.ok, '创建 Dashboard 成功')
    const dashId = d.dashboard.id

    // Read
    const get = await dashboard.getDashboard(dashId)
    assert(get.ok, '查询 Dashboard 成功')
    assert(get.dashboard.name === '销售驾驶舱', '名称正确')

    // Update
    const updated = await dashboard.saveDashboard({ id: dashId, name: '销售驾驶舱 v2', connectionId: 'c-prod' })
    assert(updated.dashboard.name === '销售驾驶舱 v2', '更新名称成功')

    // Duplicate
    const dup = await dashboard.duplicateDashboard(dashId)
    assert(dup.ok, '复制 Dashboard 成功')
    assert(dup.dashboard.name.includes('副本'), '副本名称包含"副本"')
    assert(dup.dashboard.id !== dashId, '副本 ID 不同')

    // List
    const list = await dashboard.listDashboards()
    assert(list.dashboards.length >= 2, '列表有多个 Dashboard')

    // Delete
    await dashboard.deleteDashboard(dashId)
    const get2 = await dashboard.getDashboard(dashId)
    assert(!get2.ok, '删除后查询失败')
  })

  test('Widget 管理', async () => {
    const d = await dashboard.saveDashboard({ name: 'Widget 测试', connectionId: 'c-prod' })
    const dashId = d.dashboard.id

    // Add
    const w1 = await dashboard.addWidget(dashId, {
      type: 'chart',
      title: '销售趋势',
      query: 'SELECT * FROM sales',
      chartType: 'line',
      position: { x: 0, y: 0, w: 6, h: 3 },
    })
    assert(w1.ok, '添加 widget 成功')
    assert(w1.widget.title === '销售趋势', 'widget 标题正确')

    // Add second
    await dashboard.addWidget(dashId, {
      type: 'kpi',
      title: '今日 GMV',
      query: 'SELECT SUM(amount) FROM orders',
      chartType: 'stat',
      position: { x: 6, y: 0, w: 3, h: 2 },
    })

    const get = await dashboard.getDashboard(dashId)
    assert(get.dashboard.widgets.length === 2, '有 2 个 widget')

    // Update
    const updated = await dashboard.updateWidget(dashId, w1.widget.id, { title: '销售趋势（更新）' })
    assert(updated.widget.title === '销售趋势（更新）', 'widget 标题更新成功')

    // Move
    const moved = await dashboard.moveWidget(dashId, w1.widget.id, { x: 3, y: 0, w: 8, h: 4 })
    assert(moved.widget.position.x === 3, 'x 位置更新')

    // Remove
    await dashboard.removeWidget(dashId, w1.widget.id)
    const get2 = await dashboard.getDashboard(dashId)
    assert(get2.dashboard.widgets.length === 1, '删除后剩 1 个 widget')
  })

  test('筛选器管理', async () => {
    const d = await dashboard.saveDashboard({ name: '筛选器测试', connectionId: 'c-prod' })
    const filters = [
      { id: 'f-region', type: 'select', label: '地区', dimension: 'region', options: 'SELECT DISTINCT region FROM orders' },
      { id: 'f-date', type: 'dateRange', label: '日期', dimension: 'created_at' },
    ]
    const result = await dashboard.updateFilters(d.dashboard.id, filters)
    assert(result.ok, '更新筛选器成功')
    assert(result.filters.length === 2, '2 个筛选器')
  })

  test('筛选条件注入 SQL', () => {
    const filters = [
      { id: 'f1', type: 'select', dimension: 'region' },
      { id: 'f2', type: 'dateRange', dimension: 'created_at' },
    ]

    // 基本注入
    const sql1 = dashboard.injectFilterConditions('SELECT * FROM orders', filters, { f1: '华东' })
    assert(sql1.includes("`region` = '华东'"), '注入 WHERE 条件')
    assert(sql1.includes('WHERE'), '包含 WHERE 关键字')

    // 追加到已有 WHERE
    const sql2 = dashboard.injectFilterConditions('SELECT * FROM orders WHERE status = 1', filters, { f1: '华东' })
    assert(sql2.includes('AND'), '追加 AND 条件')
    assert(sql2.includes('status = 1'), '已有条件保留')
    assert(sql2.includes("`region` = '华东'"), '新条件追加')

    // 日期范围
    const sql3 = dashboard.injectFilterConditions('SELECT * FROM orders', filters, { f2: { start: '2026-01-01', end: '2026-12-31' } })
    assert(sql3.includes("created_at` >= '2026-01-01'"), '日期起始')
    assert(sql3.includes("created_at` <= '2026-12-31'"), '日期结束')

    // 无筛选条件
    const sql4 = dashboard.injectFilterConditions('SELECT * FROM orders', filters, {})
    assert(sql4 === 'SELECT * FROM orders', '无筛选时 SQL 不变')
  })

  test('下钻查询构建', () => {
    const sql = dashboard.buildDrillDownQuery('SELECT * FROM orders', 'region', '华东')
    assert(sql.includes("WHERE `region` = '华东'"), '下钻 WHERE 条件')

    const sql2 = dashboard.buildDrillDownQuery('SELECT * FROM orders WHERE status = 1', 'region', '华东')
    assert(sql2.includes('AND'), '下钻追加 AND')
  })
}

function testExportModule() {
  startModule('4. 数据导出 (export.js)')

  const columns = ['city', 'sales', 'year']
  const rows = [
    { city: '北京', sales: 100, year: 2026 },
    { city: '上海', sales: 200, year: 2026 },
    { city: '广州', sales: 150, year: 2026 },
  ]

  test('CSV 导出', () => {
    const csv = ext.toCSV(columns, rows)
    assert(csv.includes('city,sales,year'), 'CSV 表头')
    assert(csv.includes('北京,100,2026'), 'CSV 数据行')
    assert(csv.includes('上海,200,2026'), 'CSV 多行数据')
    assert(!csv.includes('undefined'), 'CSV 无 undefined')

    // 空数据
    const empty = ext.toCSV(columns, [])
    assert(empty === 'city,sales,year', '空数据仅表头')

    // 最大行数限制
    const limited = ext.toCSV(columns, rows, { maxRows: 1 })
    const lines = limited.split('\n')
    assert(lines.length === 2, 'maxRows=1 时只有 2 行')
  })

  test('CSV 注入防护', () => {
    const cols = ['name']
    const rows = [
      { name: '=SUM(A1:A10)' },
      { name: '+cmd|' },
      { name: '@echo' },
      { name: '-script' },
    ]
    const csv = ext.toCSV(cols, rows)
    const lines = csv.split('\n')
    assert(lines[1].startsWith("'"), '= 开头的值被转义')
    assert(lines[2].startsWith("'"), '+ 开头的值被转义')
    assert(lines[3].startsWith("'"), '@ 开头的值被转义')
    assert(lines[4].startsWith("'"), '- 开头的值被转义')
  })

  test('TSV 导出', () => {
    const tsv = ext.toTSV(columns, rows)
    assert(tsv.includes('city\tsales\tyear'), 'TSV 表头')
    assert(tsv.includes('北京\t100\t2026'), 'TSV 数据行')
  })

  test('Markdown 表格导出', () => {
    const md = ext.toMarkdownTable(columns, rows)
    assert(md.includes('| city | sales | year |'), 'MD 表头')
    assert(md.includes('| ---- |'), 'MD 分隔线')
    assert(md.includes('北京'), 'MD 数据行')

    // 空数据
    const empty = ext.toMarkdownTable(columns, [])
    assert(empty.includes('| city | sales | year |'), '空数据有表头')
    assert(empty.includes('| ---- |'), '空数据有分隔线')

    // 行数限制
    const limited = ext.toMarkdownTable(columns, rows, { maxRows: 1 })
    const lines = limited.split('\n').filter(l => l.startsWith('|'))
    // 表头 + 分隔线 + 1 行数据 = 3 行
    assert(lines.length === 3, 'maxRows=1 时只有 1 行数据')
  })

  test('Excel (HTML) 导出', () => {
    const html = ext.toExcel(columns, rows)
    assert(html.includes('<table'), '包含 table 标签')
    assert(html.includes('北京'), '包含数据')
    assert(html.includes('utf-8'), 'UTF-8 编码')
    assert(html.includes('</html>'), '完整 HTML')
  })

  test('统一导出入口', () => {
    const r1 = ext.exportResult('csv', columns, rows)
    assert(r1.extension === 'csv', 'csv 扩展名')
    assert(r1.mimeType.includes('csv'), 'csv MIME 类型')
    assert(r1.content.length > 0, '有内容')

    const r2 = ext.exportResult('markdown', columns, rows)
    assert(r2.extension === 'md', 'md 扩展名')

    const r3 = ext.exportResult('excel', columns, rows)
    assert(r3.extension === 'html', 'excel 扩展名')

    const r4 = ext.exportResult('unknown', columns, rows)
    assert(r4.extension === 'csv', '未知格式默认 csv')

    // 空列
    const r5 = ext.exportResult('csv', [], [])
    assert(r5.content === '', '空列返回空')
  })
}

function testText2SqlModule() {
  startModule('5. Text2SQL (text2sql.js)')

  test('LLM 解析 - 纯 JSON', () => {
    const r = parseLlmResult('{"sql": "SELECT * FROM users", "explain": "查询所有用户", "chartType": "stat", "analysisType": "none"}')
    assert(r.ok, '纯 JSON 解析成功')
    assert(r.sql === 'SELECT * FROM users', 'SQL 正确')
    assert(r.explain === '查询所有用户', 'explain 正确')
    assert(r.chartType === 'stat', 'chartType 正确')
    assert(r.analysisType === 'none', 'analysisType 正确')
  })

  test('LLM 解析 - 代码块中的 JSON', () => {
    const r = parseLlmResult('```json\n{"sql": "SELECT COUNT(*) FROM users", "explain": "统计用户数"}\n```')
    assert(r.ok, '代码块 JSON 解析成功')
    assert(r.sql === 'SELECT COUNT(*) FROM users', 'SQL 正确')
  })

  test('LLM 解析 - 宽松 JSON（包含额外文本）', () => {
    const r = parseLlmResult('根据您的需求，生成以下 SQL：\n{"sql": "SELECT * FROM orders LIMIT 10", "explain": "查看最近订单"}\n如果需要其他查询请告诉我。')
    assert(r.ok, '宽松 JSON 解析成功')
    assert(r.sql === 'SELECT * FROM orders LIMIT 10', 'SQL 正确')
  })

  test('LLM 解析 - 错误处理', () => {
    const r1 = parseLlmResult('')
    assert(!r1.ok, '空字符串返回错误')

    const r2 = parseLlmResult('这是一个普通的文本回答')
    assert(!r2.ok, '无 JSON 返回错误')

    const r3 = parseLlmResult('{"sql": ""}')
    assert(!r3.ok, '空 SQL 返回错误')
  })

  test('Prompt 构建', () => {
    const prompt = buildPrompt({
      question: '上个月每天的订单量',
      schema: [
        {
          name: 'orders',
          columns: [
            { column: 'id', type: 'int(11)', comment: '主键', key: 'PRI' },
            { column: 'amount', type: 'decimal(10,2)', comment: '金额' },
            { column: 'created_at', type: 'datetime', comment: '创建时间' },
          ],
          comment: '订单表',
        },
      ],
      connectionName: '生产库',
      databaseName: 'yd_wechat_rpa',
    })
    assert(prompt.systemPrompt.includes('数据分析助手'), 'system prompt 包含角色定义')
    assert(prompt.systemPrompt.includes('chartType'), 'system prompt 包含 chartType 指令')
    assert(prompt.systemPrompt.includes('analysisType'), 'system prompt 包含 analysisType 指令')
    assert(prompt.systemPrompt.includes('同比分析'), 'system prompt 包含分析能力指引')
    assert(prompt.userPrompt.includes('上个月每天的订单量'), 'user prompt 包含问题')
    assert(prompt.userPrompt.includes('orders'), 'user prompt 包含表结构')
    assert(prompt.userPrompt.includes('生产库'), 'user prompt 包含连接信息')
  })
}

function testSqlSafeModule() {
  startModule('6. SQL 安全 (sqlsafe.js + shared.js)')

  test('AST 语句分类', () => {
    const r1 = sqlsafe.classifyStatementAst('SELECT * FROM users')
    assert(r1.type === 'read', 'SELECT 归为 read')

    const r2 = sqlsafe.classifyStatementAst('INSERT INTO users VALUES(1)')
    assert(r2.type === 'write-dml', 'INSERT 归为 write-dml')

    const r3 = sqlsafe.classifyStatementAst('DROP TABLE users')
    assert(r3.type === 'ddl', 'DROP 归为 ddl')

    const r4 = sqlsafe.classifyStatementAst('')
    assert(r4.type === 'empty', '空 SQL 归为 empty')
  })

  test('只读校验', () => {
    const r1 = sqlsafe.checkReadOnly('SELECT * FROM users')
    assert(r1.ok, 'SELECT 通过只读校验')

    const r2 = sqlsafe.checkReadOnly('UPDATE users SET name = "test"')
    assert(!r2.ok, 'UPDATE 拒绝只读校验')

    const r3 = sqlsafe.checkReadOnly('DROP TABLE users')
    assert(!r3.ok, 'DROP 拒绝只读校验')
  })

  test('表名提取', () => {
    const tables = sqlsafe.extractTableNamesFromAst(
      sqlsafe.classifyStatementAst('SELECT * FROM orders o JOIN users u ON o.user_id = u.id').ast
    )
    assert(tables.includes('orders'), '提取 orders 表')
    assert(tables.includes('users'), '提取 users 表')
  })

  test('LIMIT 注入', () => {
    const r1 = sqlsafe.injectLimit('SELECT * FROM users', 100)
    assert(r1.modified, '无 LIMIT 时自动注入')
    assert(r1.sql.includes('LIMIT'), 'SQL 包含 LIMIT')

    const r2 = sqlsafe.injectLimit('SELECT * FROM users LIMIT 50', 100)
    assert(!r2.modified, '已有合理 LIMIT 不修改')

    const r3 = sqlsafe.injectLimit('SELECT * FROM users LIMIT 5000', 100)
    assert(r3.modified, '超 LIMIT 被改写')
    assert(r3.sql.includes('LIMIT 100'), '改写为 100')
  })

  test('validateAndPrepare 一站式校验', () => {
    const r1 = sqlsafe.validateAndPrepare('SELECT * FROM users', { maxRows: 100 })
    assert(r1.ok, '合法 SQL 通过校验')
    assert(r1.safeSql, '生成 safeSql')
    assert(r1.tables.includes('users'), '提取表名')

    const r2 = sqlsafe.validateAndPrepare('INSERT INTO users VALUES(1)')
    assert(!r2.ok, '写操作被拒绝')

    const r3 = sqlsafe.validateAndPrepare('')
    assert(!r3.ok, '空 SQL 被拒绝')

    const r4 = sqlsafe.validateAndPrepare('SELECT * FROM users; SELECT * FROM orders')
    assert(!r4.ok, '多语句被拒绝')
  })

  test('shared.js 正则分类', () => {
    assertEqual(classifyStatement('SELECT * FROM users'), 'read', 'SELECT 归为 read')
    assertEqual(classifyStatement('SHOW TABLES'), 'read', 'SHOW 归为 read')
    assertEqual(classifyStatement('INSERT INTO users VALUES(1)'), 'write-dml', 'INSERT 归为 write-dml')
    assertEqual(classifyStatement('DROP TABLE users'), 'forbidden', 'DROP 归为 forbidden')
    assertEqual(classifyStatement(''), 'empty', '空 SQL 归为 empty')
  })

  test('shared.js 表名提取', () => {
    // 检查有限范围内包含表名
    const refs = extractTableRefs('SELECT * FROM orders JOIN users ON ...')
    const hasOrder = refs.some(r => r.includes('order'))
    assert(hasOrder, '提取到 orders 表')
  })

  test('jsonSafe 安全转换', () => {
    assertEqual(jsonSafe(null), null, 'null 保持不变')
    assertEqual(jsonSafe(42), 42, '数字保持不变')
    assertEqual(jsonSafe('hello'), 'hello', '字符串保持不变')

    const date = new Date('2026-01-01T00:00:00Z')
    const safe = jsonSafe(date)
    assert(typeof safe === 'string', 'Date 转为字符串')

    const bigint = BigInt(12345678901234567890n)
    const safeBig = jsonSafe(bigint)
    assert(typeof safeBig === 'string', 'BigInt 转为字符串')
  })
}

function testEndToEndScenario() {
  startModule('7. 端到端场景模拟')

  test('场景 1: 完整数据分析流程（定义指标→生成图表→导出）', async () => {
    // 1. 定义指标
    const gmv = await metrics.saveMetric({
      name: 'GMV',
      expression: 'SUM(order_amount)',
      type: 'sum',
      format: 'currency',
    })
    assert(gmv.ok, '步骤 1: 定义 GMV 指标')

    // 2. 定义维度
    const region = await metrics.saveDimension({
      name: '地区',
      sourceColumn: 'region',
      type: 'string',
      hierarchy: ['province', 'city'],
    })
    assert(region.ok, '步骤 2: 定义地区维度')

    // 3. 定义数据集
    const ds = await metrics.saveDataset({
      name: '销售分析',
      connectionId: 'c-test',
      tables: ['orders', 'users'],
      metrics: [gmv.metric.id],
      dimensions: [region.dimension.id],
    })
    assert(ds.ok, '步骤 3: 定义数据集')

    // 4. 生成图表
    const chartResult = chart.suggestChartSpec({
      columns: ['region', 'gmv'],
      rows: [
        { region: '华东', gmv: 1000 },
        { region: '华南', gmv: 800 },
        { region: '华北', gmv: 600 },
      ],
    })
    assert(chartResult.ok, '步骤 4: 生成图表')
    assert(chartResult.spec.type === 'pie', '低基数类目使用饼图')

    // 5. 导出为 Markdown
    const md = ext.toMarkdownTable(['region', 'gmv'], [
      { region: '华东', gmv: 1000 },
      { region: '华南', gmv: 800 },
      { region: '华北', gmv: 600 },
    ])
    assert(md.includes('region'), '步骤 5: Markdown 导出包含表头')
    assert(md.includes('华东'), '步骤 5: Markdown 导出包含数据')

    // 6. 导出为 CSV
    const csv = ext.toCSV(['region', 'gmv'], [
      { region: '华东', gmv: 1000 },
      { region: '华南', gmv: 800 },
    ])
    assert(csv.includes('region,gmv'), '步骤 6: CSV 导出包含表头')
    assert(csv.includes('华东,1000'), '步骤 6: CSV 导出包含数据')
  })

  test('场景 2: Dashboard 全生命周期（创建→添加组件→复制→删除）', async () => {
    // 1. 创建 Dashboard
    const d = await dashboard.saveDashboard({
      name: '经营驾驶舱',
      description: '管理看板',
      connectionId: 'c-prod',
    })
    assert(d.ok, '步骤 1: 创建 Dashboard')

    // 2. 添加 KPI 组件
    const kpi = await dashboard.addWidget(d.dashboard.id, {
      type: 'kpi',
      title: '今日收入',
      query: 'SELECT SUM(amount) FROM orders WHERE DATE(created_at) = CURDATE()',
      position: { x: 0, y: 0, w: 3, h: 2 },
    })
    assert(kpi.ok, '步骤 2: 添加 KPI 组件')

    // 3. 添加图表组件
    const chartW = await dashboard.addWidget(d.dashboard.id, {
      type: 'chart',
      title: '销售趋势',
      query: 'SELECT DATE(created_at) AS day, SUM(amount) AS gmv FROM orders GROUP BY day',
      chartType: 'line',
      position: { x: 0, y: 2, w: 8, h: 4 },
    })
    assert(chartW.ok, '步骤 3: 添加图表组件')

    // 4. 添加筛选器
    const filters = await dashboard.updateFilters(d.dashboard.id, [
      { id: 'f-region', type: 'select', label: '地区', dimension: 'region' },
    ])
    assert(filters.ok, '步骤 4: 添加筛选器')

    // 5. 复制 Dashboard
    const dup = await dashboard.duplicateDashboard(d.dashboard.id)
    assert(dup.ok, '步骤 5: 复制 Dashboard')
    assert(dup.dashboard.widgets.length === 2, '副本包含 2 个组件')

    // 6. 删除 Dashboard
    const del = await dashboard.deleteDashboard(d.dashboard.id)
    assert(del.ok, '步骤 6: 删除 Dashboard')
  })

  test('场景 3: SQL 安全防护验证', () => {
    // 1. 合法查询通过
    const r1 = sqlsafe.validateAndPrepare('SELECT * FROM users WHERE id = 1', { maxRows: 2000 })
    assert(r1.ok, '合法 SELECT 通过')

    // 2. 写操作被拒绝
    const r2 = sqlsafe.validateAndPrepare('DELETE FROM users')
    assert(!r2.ok, 'DELETE 被拒绝')

    // 3. DDL 被拒绝
    const r3 = sqlsafe.validateAndPrepare('DROP TABLE users')
    assert(!r3.ok, 'DROP 被拒绝')

    // 4. 多语句被拒绝
    const r4 = sqlsafe.validateAndPrepare('SELECT * FROM users; SELECT * FROM orders')
    assert(!r4.ok, '多语句被拒绝')

    // 5. LIMIT 自动注入
    const r5 = sqlsafe.validateAndPrepare('SELECT * FROM users', { maxRows: 100 })
    assert(r5.ok, 'LIMIT 注入通过')
    assert(r5.safeSql.includes('LIMIT'), 'SQL 包含 LIMIT')

    // 6. 查询超时提示注入
    const r6 = sqlsafe.validateAndPrepare('SELECT * FROM users', { maxRows: 100 })
    assert(r6.safeSql.includes('MAX_EXECUTION_TIME'), '包含超时提示')
  })

  test('场景 4: 多维分析计算', () => {
    // 模拟销售额数据
    const salesData = [
      { month: '1月', sales: 100 },
      { month: '2月', sales: 120 },
      { month: '3月', sales: 110 },
      { month: '4月', sales: 130 },
      { month: '5月', sales: 140 },
      { month: '6月', sales: 125 },
    ]

    // 累计
    const cum = chart.computeCumulative(salesData, 'sales', 'month')
    assertEqual(cum[cum.length - 1].cumulative, 725, '累计值 725')

    // 移动平均（3 个月）
    const ma = chart.computeMovingAverage(salesData, 'sales', 3, 'month')
    assert(ma.length === 6, '移动平均返回 6 条')
    // 第 3 个月的 ma3 = (100+120+110)/3 ≈ 110
    assertEqual(ma[2].ma3, 110, 'ma3 正确')

    // Top 3
    const top3 = chart.computeTopN(salesData, 'sales', 3)
    assertEqual(top3.length, 3, 'Top3 返回 3 条')
    assertEqual(top3[0].sales, 140, 'Top1 为 140（5月）')

    // 排名
    const ranked = chart.computeRanking(salesData, 'sales')
    const mayRank = ranked.find(r => r.month === '5月')
    assertEqual(mayRank.rank, 1, '5月排名第 1')
  })

  test('场景 5: 错误处理与边界条件', () => {
    // metrics 边界
    assert(!metrics.saveMetric({}).ok, '空指标拒绝')
    assert(!metrics.saveDimension({}).ok, '空维度拒绝')
    assert(!metrics.saveDataset({ name: 'x', tables: [] }).ok, '空表数据集拒绝')

    // chart 边界
    assert(!chart.suggestChartSpec({ columns: [], rows: [] }).ok, '空列返回错误')
    assert(!chart.suggestChartForResult(null, 'test').ok, 'null result 返回错误')

    // dashboard 边界
    assert(!dashboard.saveDashboard({ name: '' }).ok, '空名称 Dashboard 拒绝')
    assert(!dashboard.getDashboard('nonexistent').ok, '不存在的 Dashboard 返回错误')

    // export 边界
    assertEqual(ext.toCSV([], []), '', '空列 CSV 返回空字符串')
    assertEqual(ext.toMarkdownTable([], []), '', '空列 Markdown 返回空字符串')

    // sqlsafe 边界
    assert(!sqlsafe.validateAndPrepare('').ok, '空 SQL 拒绝')
    assert(!sqlsafe.validateAndPrepare('SELECT * FROM users', { allowlist: ['orders'] }).ok, '白名单外表拒绝')
  })
}

// ── 生成测试报告 ──────────────────────────────────────────────────────────

function generateReport() {
  const { total, passed, failed, skipped } = TEST_SUITE.summary
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0'

  const report = [
    '═══════════════════════════════════════════════════════════════',
    `  dsh-plugin-nlbi v0.2.0 集成测试报告`,
    `  生成时间: ${new Date(TEST_SUITE.timestamp).toLocaleString()}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  总测试数: ${total}`,
    `  通过:     ${passed}  ✅`,
    `  失败:     ${failed}  ${failed > 0 ? '❌' : '✅'}`,
    `  跳过:     ${skipped}`,
    `  通过率:   ${passRate}%`,
    '',
    '───────────────────────────────────────────────────────────────',
    '  模块详情:',
    '',
  ]

  for (const mod of TEST_SUITE.modules) {
    const modTotal = moduleTestCount[mod.name] ? moduleTestCount[mod.name].total : mod.tests.length
    const modPassed = mod.tests.filter(t => t.status === 'passed').length
    const modFailed = mod.tests.filter(t => t.status === 'failed').length
    const icon = modFailed === 0 ? '✅' : '❌'
    report.push(`  ${icon} ${mod.name}: ${modPassed}/${modTotal} 通过`)
    for (const t of mod.tests) {
      if (t.status === 'failed') {
        report.push(`     ✗ ${t.name}`)
        report.push(`       ${t.error}`)
      }
    }
    report.push('')
  }

  report.push('───────────────────────────────────────────────────────────────')
  report.push('')
  report.push(failed === 0
    ? '  🎉 所有测试通过！'
    : `  ⚠️ ${failed} 个测试失败，请检查`
  )
  report.push('')
  report.push('═══════════════════════════════════════════════════════════════')

  return report.join('\n')
}

// ── 主入口 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('')
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║     dsh-plugin-nlbi v0.2.0 集成测试套件                    ║')
  console.log('╚════════════════════════════════════════════════════════════╝')
  console.log('')

  try {
    testMetricsModule()
    testChartModule()
    testDashboardModule()
    testExportModule()
    testText2SqlModule()
    testSqlSafeModule()
    testEndToEndScenario()
    // 所有测试已入队，串行执行
    await runAllTests()
  } catch (err) {
    console.error('\n测试执行异常:', err.message)
  } finally {
    // 清理临时目录
    try { await fsp.rm(tmpDir, { recursive: true, force: true }) } catch (e) {}
  }

  // 输出报告
  console.log('\n' + generateReport())

  // 退出码
  process.exit(TEST_SUITE.summary.failed > 0 ? 1 : 0)
}

main()