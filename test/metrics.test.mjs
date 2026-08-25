/**
 * metrics.test.mjs — dsh-plugin-nlbi 指标/维度/数据集管理测试
 *
 * 测试前需替换 $DSH_HOME 环境变量，或在测试目录下创建临时 .dsh 目录。
 * 本测试使用临时目录避免污染用户配置。
 */

import { tmpdir } from 'node:os'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import * as metrics from '../lib/metrics.js'

// 设置临时 DSH_HOME
const tmpDir = path.join(tmpdir(), 'dsh-plugin-nlbi-test-' + Date.now())
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

// ── 测试 ──

async function testMetrics() {
  // 1. 初始空列表
  const list1 = await metrics.listMetrics()
  assert(list1.ok === true, 'listMetrics 初始返回 ok')
  assert(Array.isArray(list1.metrics) && list1.metrics.length === 0, 'listMetrics 初始为空')

  // 2. 创建指标
  const m1 = await metrics.saveMetric({
    name: 'GMV',
    expression: 'SUM(order_amount)',
    sourceTable: 'orders',
    sourceColumn: 'order_amount',
    type: 'sum',
    format: 'currency',
    description: '总成交金额',
  })
  assert(m1.ok === true, 'saveMetric GMV 成功')
  assert(m1.metric.name === 'GMV', 'GMV 名称正确')
  assert(m1.metric.id && m1.metric.id.startsWith('m-'), 'GMV id 格式正确')

  // 3. 创建第二个指标
  const m2 = await metrics.saveMetric({
    name: '订单数',
    expression: 'COUNT(order_id)',
    type: 'count',
  })
  assert(m2.ok === true, 'saveMetric 订单数成功')

  // 4. 列出指标
  const list2 = await metrics.listMetrics()
  assert(list2.ok === true, 'listMetrics 再次返回 ok')
  assert(list2.metrics.length === 2, 'listMetrics 有 2 个指标')

  // 5. 获取单个指标
  const get1 = await metrics.getMetricById(m1.metric.id)
  assert(get1.ok === true, 'getMetricById 成功')
  assert(get1.metric.name === 'GMV', 'getMetricById 名称正确')

  // 6. 更新指标
  const updated = await metrics.saveMetric({ id: m1.metric.id, name: 'GMV（更新）', expression: 'SUM(order_amount)', type: 'sum' })
  assert(updated.ok === true, 'saveMetric 更新成功')
  assert(updated.metric.name === 'GMV（更新）', '更新后名称正确')

  // 7. 删除指标
  const del1 = await metrics.deleteMetric(m2.metric.id)
  assert(del1.ok === true, 'deleteMetric 成功')
  const list3 = await metrics.listMetrics()
  assert(list3.metrics.length === 1, '删除后剩 1 个指标')

  // 8. 删除不存在的指标
  const del2 = await metrics.deleteMetric('nonexistent')
  assert(del2.ok === false, 'deleteMetric 不存在返回错误')

  // 9. 空名称 / 空表达式验证
  const bad1 = await metrics.saveMetric({ name: '', expression: 'SUM(x)' })
  assert(bad1.ok === false, 'saveMetric 空名称拒绝')
  const bad2 = await metrics.saveMetric({ name: 'test', expression: '' })
  assert(bad2.ok === false, 'saveMetric 空表达式拒绝')
}

async function testDimensions() {
  // 1. 初始空列表
  const list1 = await metrics.listDimensions()
  assert(list1.ok === true, 'listDimensions 初始为空')

  // 2. 创建维度
  const d1 = await metrics.saveDimension({
    name: '地区',
    sourceTable: 'orders',
    sourceColumn: 'region',
    type: 'string',
    hierarchy: ['province', 'city', 'district'],
  })
  assert(d1.ok === true, 'saveDimension 地区成功')
  assert(d1.dimension.hierarchy.length === 3, '层级定义正确')

  // 3. 创建第二个维度
  const d2 = await metrics.saveDimension({
    name: '时间',
    sourceTable: 'orders',
    sourceColumn: 'created_at',
    type: 'date',
  })
  assert(d2.ok === true, 'saveDimension 时间成功')

  // 4. 列出维度
  const list2 = await metrics.listDimensions()
  assert(list2.dimensions.length === 2, 'listDimensions 有 2 个维度')

  // 5. 删除
  await metrics.deleteDimension(d1.dimension.id)
  const list3 = await metrics.listDimensions()
  assert(list3.dimensions.length === 1, '删除后剩 1 个维度')

  // 6. 空名称验证
  const bad = await metrics.saveDimension({ name: '', sourceColumn: 'x' })
  assert(bad.ok === false, 'saveDimension 空名称拒绝')
}

async function testDatasets() {
  // 1. 创建数据集
  const ds1 = await metrics.saveDataset({
    name: '销售分析',
    connectionId: 'c-test',
    tables: ['orders', 'users', 'products'],
    joins: [
      { from: 'orders.user_id', to: 'users.id', type: 'LEFT JOIN' },
      { from: 'orders.product_id', to: 'products.id', type: 'LEFT JOIN' },
    ],
    metrics: ['m-gmv'],
    dimensions: ['d-region'],
  })
  assert(ds1.ok === true, 'saveDataset 成功')
  assert(ds1.dataset.tables.length === 3, '数据集有 3 张表')
  assert(ds1.dataset.joins.length === 2, '数据集有 2 个 Join')

  // 2. 空名称验证
  const bad = await metrics.saveDataset({ name: '', tables: ['t'] })
  assert(bad.ok === false, 'saveDataset 空名称拒绝')

  // 3. 空表列表验证
  const bad2 = await metrics.saveDataset({ name: 'test', tables: [] })
  assert(bad2.ok === false, 'saveDataset 空表拒绝')

  // 4. 列出数据集
  const list = await metrics.listDatasets()
  assert(list.datasets.length >= 1, 'listDatasets 有数据集')

  // 5. 删除
  await metrics.deleteDataset(ds1.dataset.id)
  const list2 = await metrics.listDatasets()
  assert(list2.datasets.length === 0, '删除后为空')
}

async function testSqlBuilders() {
  // 1. buildMetricExpression
  const metric = { name: 'GMV', expression: 'SUM(order_amount)' }
  const expr = metrics.buildMetricExpression(metric)
  assert(expr === 'SUM(order_amount) AS `GMV`', 'buildMetricExpression 正确')

  // 2. buildMetricExpression with alias
  const expr2 = metrics.buildMetricExpression(metric, 'total')
  assert(expr2 === 'SUM(order_amount) AS `total`', 'buildMetricExpression 别名正确')

  // 3. buildDimensionSql
  const dim = { name: '地区', sourceColumn: 'region', sourceTable: 'orders' }
  const sql = metrics.buildDimensionSql(dim)
  assert(sql.select.includes('`region` AS `地区`'), 'buildDimensionSql select 正确')
  assert(sql.groupBy.includes('`region`'), 'buildDimensionSql groupBy 正确')

  // 4. buildDimensionSql with tableAlias
  const sql2 = metrics.buildDimensionSql(dim, 'o')
  assert(sql2.select.includes('o.`region`'), 'buildDimensionSql 表别名正确')

  // 5. buildDatasetFromClause
  const ds = { tables: ['orders', 'users'], joins: [{ from: 'orders.user_id', to: 'users.id', type: 'LEFT JOIN' }] }
  const fromClause = metrics.buildDatasetFromClause(ds)
  assert(fromClause.includes('`orders`'), 'FROM 子句包含主表')
  assert(fromClause.includes('LEFT JOIN'), 'FROM 子句包含 JOIN')
}

async function testInference() {
  const columns = ['city', 'amount', 'created_at', 'count']
  const rows = [
    { city: '北京', amount: 100, created_at: '2026-01-01', count: 1 },
    { city: '上海', amount: 200, created_at: '2026-01-02', count: 2 },
    { city: '北京', amount: 150, created_at: '2026-01-03', count: 3 },
  ]

  // 1. inferDimensions
  const dims = metrics.inferDimensions(columns, rows)
  assert(dims.length > 0, 'inferDimensions 返回维度')
  const cityDim = dims.find(d => d.name === 'city')
  assert(cityDim && cityDim.cardinality === 2, 'city 维度基数为 2')

  // 2. inferMetrics
  const mets = metrics.inferMetrics(columns, rows)
  assert(mets.length > 0, 'inferMetrics 返回指标')
  const amountMet = mets.find(m => m.name === 'amount')
  assert(amountMet && amountMet.stats.sum === 450, 'amount 求和为 450')
  assert(amountMet && amountMet.stats.avg === 150, 'amount 平均为 150')
}

// ── 主流程 ──

async function main() {
  console.log('── metrics.js 测试 ──')
  try {
    await testMetrics()
    await testDimensions()
    await testDatasets()
    await testSqlBuilders()
    await testInference()
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