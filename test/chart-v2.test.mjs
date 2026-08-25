/**
 * chart-v2.test.mjs — dsh-plugin-nlbi 增强图表引擎测试
 *
 * 测试新图表类型和数据分析函数。
 */

import * as chart from '../lib/chart.js'

let passed = 0
let failed = 0

function assert(ok, msg) {
  if (ok) { passed++; console.log('✓ ' + msg) }
  else { failed++; console.error('✗ ' + msg) }
}

// ── 新图表类型测试 ──

function testFunnel() {
  const columns = ['step', 'users']
  const rows = [
    { step: '展示', users: 100 },
    { step: '点击', users: 80 },
    { step: '访问', users: 60 },
    { step: '咨询', users: 40 },
    { step: '成交', users: 20 },
  ]
  const result = chart.suggestChartSpec({ columns, rows, title: '转化漏斗', chartType: 'funnel' })
  assert(result.ok === true, 'funnel 生成成功')
  assert(result.spec.type === 'funnel', 'funnel 类型正确')
  assert(Array.isArray(result.spec.data) && result.spec.data.length === 5, 'funnel 有 5 个数据点')
}

function testScatter() {
  const columns = ['price', 'sales']
  const rows = [
    { price: 10, sales: 100 },
    { price: 20, sales: 80 },
    { price: 30, sales: 60 },
  ]
  const result = chart.suggestChartSpec({ columns, rows, title: '价格-销量', chartType: 'scatter' })
  assert(result.ok === true, 'scatter 生成成功')
  assert(result.spec.type === 'scatter', 'scatter 类型正确')
}

function testHeatmap() {
  const columns = ['weekday', 'hour', 'visits']
  const rows = [
    { weekday: 'Mon', hour: 'Morning', visits: 5 },
    { weekday: 'Mon', hour: 'Afternoon', visits: 8 },
    { weekday: 'Tue', hour: 'Morning', visits: 7 },
  ]
  const result = chart.suggestChartSpec({ columns, rows, title: '访问热力图', chartType: 'heatmap' })
  assert(result.ok === true, 'heatmap 生成成功')
  assert(result.spec.type === 'heatmap', 'heatmap 类型正确')
  assert(result.spec.xValues && result.spec.yValues, 'heatmap 有坐标轴标签')
}

function testRadar() {
  const columns = ['category', 'score_a', 'score_b', 'score_c']
  const rows = [
    { category: '产品A', score_a: 90, score_b: 80, score_c: 70 },
    { category: '产品B', score_a: 70, score_b: 90, score_c: 85 },
  ]
  const result = chart.suggestChartSpec({ columns, rows, title: '多维评分', chartType: 'radar' })
  assert(result.ok === true, 'radar 生成成功')
  assert(result.spec.type === 'radar', 'radar 类型正确')
  assert(result.spec.indicators && result.spec.indicators.length > 0, 'radar 有指标')
}

function testGauge() {
  const columns = ['completion']
  const rows = [{ completion: 72 }]
  const result = chart.suggestChartSpec({ columns, rows, title: '完成率', chartType: 'gauge' })
  assert(result.ok === true, 'gauge 生成成功')
  assert(result.spec.type === 'gauge', 'gauge 类型正确')
  assert(result.spec.value === 72, 'gauge 值正确')
}

function testTreemap() {
  const columns = ['category', 'sales']
  const rows = [
    { category: 'A', sales: 100 },
    { category: 'B', sales: 80 },
    { category: 'C', sales: 60 },
  ]
  const result = chart.suggestChartSpec({ columns, rows, title: '销售树图', chartType: 'treemap' })
  assert(result.ok === true, 'treemap 生成成功')
  assert(result.spec.type === 'treemap', 'treemap 类型正确')
  assert(Array.isArray(result.spec.data), 'treemap 有数据')
}

function testProgress() {
  const columns = ['rate']
  const rows = [{ rate: 85 }]
  const result = chart.suggestChartSpec({ columns, rows, title: '进度', chartType: 'progress' })
  assert(result.ok === true, 'progress 生成成功')
  assert(result.spec.type === 'progress', 'progress 类型正确')
}

function testStackedBar() {
  const columns = ['month', 'revenue', 'cost']
  const rows = [
    { month: '1月', revenue: 100, cost: 60 },
    { month: '2月', revenue: 120, cost: 70 },
  ]
  const result = chart.suggestChartSpec({ columns, rows, title: '堆叠图', chartType: 'stackedBar' })
  assert(result.ok === true, 'stackedBar 生成成功')
  assert(result.spec.type === 'bar', 'stackedBar 类型为 bar')
  assert(result.spec.stack === true, 'stackedBar 有 stack 标记')
}

function testWaterfall() {
  const columns = ['item', 'amount']
  const rows = [
    { item: '收入', amount: 1000 },
    { item: '成本', amount: -300 },
    { item: '税费', amount: -200 },
    { item: '利润', amount: 500 },
  ]
  const result = chart.suggestChartSpec({ columns, rows, title: '瀑布图', chartType: 'waterfall' })
  assert(result.ok === true, 'waterfall 生成成功')
  assert(result.spec.type === 'waterfall', 'waterfall 类型正确')
}

// ── 强制指定图表类型 vs 自动推断 ──

function testForceOverride() {
  const columns = ['date', 'sales']
  const rows = [
    { date: '2026-01', sales: 100 },
    { date: '2026-02', sales: 120 },
    { date: '2026-03', sales: 90 },
  ]
  // 自动推断应返回 pie（2列：string+number，低基数≤12）
  const auto = chart.suggestChartSpec({ columns, rows })
  assert(auto.ok === true, '自动推断成功')
  assert(auto.spec.type === 'pie', '自动推断为 pie（2列string+number，低基数≤12）')

  // 强制指定 bar
  const forced = chart.suggestChartSpec({ columns, rows, chartType: 'bar' })
  assert(forced.ok === true, '强制 bar 成功')
  assert(forced.spec.type === 'bar', '强制 bar 类型正确')
}

// ── 数据分析函数测试 ──

function testComputeFunctions() {
  // 1. 同比
  const yoy = chart.computeYoYGrowth(120, 100)
  assert(yoy === 20, '同比增长 20% 正确')

  const yoy2 = chart.computeYoYGrowth(100, 0)
  assert(yoy2 === null, '同比增长 分母为 0 返回 null')

  const yoy3 = chart.computeYoYGrowth(90, 100)
  assert(yoy3 === -10, '同比下降 10% 正确')

  // 2. 环比
  const mom = chart.computeMoMGrowth(120, 100)
  assert(mom === 20, '环比增长 20% 正确')

  // 3. 累计
  const rows = [{ v: 10 }, { v: 20 }, { v: 30 }]
  const cum = chart.computeCumulative(rows, 'v')
  assert(cum.length === 3, '累计计算返回 3 行')
  assert(cum[2].cumulative === 60, '累计值 60 正确')

  // 4. 移动平均
  const ma = chart.computeMovingAverage(rows, 'v', 2)
  assert(ma.length === 3, '移动平均返回 3 行')
  assert(ma[2].ma2 === 25, '移动平均 ma2 正确')

  // 5. Top N
  const topN = chart.computeTopN(rows, 'v', 2)
  assert(topN.length === 2, 'Top2 返回 2 行')
  assert(topN[0].v === 30, 'Top1 为 30')

  // 6. 排名
  const ranked = chart.computeRanking(rows, 'v')
  assert(ranked[0].rank === 1, '排名第一正确')
}

// ── 主流程 ──

function main() {
  console.log('── chart.js v2 测试 ──')
  try {
    testFunnel()
    testScatter()
    testHeatmap()
    testRadar()
    testGauge()
    testTreemap()
    testProgress()
    testStackedBar()
    testWaterfall()
    testForceOverride()
    testComputeFunctions()
  } catch (err) {
    console.error('测试异常:', err.message)
    failed++
  }
  console.log(`\n${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main()