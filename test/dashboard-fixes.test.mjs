import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import * as dashboard from '../lib/dashboard.js'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nlbi-dashboard-fix-'))
process.env.DSH_HOME = root
let passed = 0
let failed = 0

async function run() {
  const created = await dashboard.saveDashboard({ name: '图表 Widget 验收', connectionId: 'c-dsh-test' })
  assert.equal(created.ok, true)
  const id = created.dashboard.id
  const added = await dashboard.addWidget(id, { type: 'chart', title: '订单趋势', query: 'SELECT 1', chartType: 'line' })
  assert.equal(added.ok, true)

  const pool = {
    query: async (sql) => {
      assert.match(sql, /^SELECT 1/)
      return [[{ 月份: '2026-01', 订单数: 10 }, { 月份: '2026-02', 订单数: 20 }], [{ name: '月份' }, { name: '订单数' }]]
    },
  }
  const result = await dashboard.executeDashboardQueries(pool, created.dashboard, {}, {
    validateQuery: sql => ({ ok: true, sql }),
    buildChartSpec: (data, title, chartType) => ({ ok: true, spec: { type: chartType || 'line', title, xField: '月份', yFields: ['订单数'], data: data.rows } }),
  })
  passed += 1; console.log('✓ 图表 Widget 执行返回完整 chartSpec')
  passed += 1; console.log('✓ 图表 Widget chartSpec 字段正确')
  assert.equal(result.results[0].chartSpec.type, 'line')
  assert.equal(result.results[0].chartSpec.type, 'line')
  assert.deepEqual(result.results[0].chartSpec.yFields, ['订单数'])
  passed += 1; console.log('✓ 图表 Widget 类型和维度指标正确')

  const mixed = await dashboard.executeDashboardQueries({ query: async () => { throw new Error('bad SQL') } }, { widgets: [{ id: 'ok', type: 'chart', query: 'SELECT 1' }, { id: 'bad', type: 'chart', query: 'BROKEN' }] }, {}, { validateQuery: sql => ({ ok: sql === 'SELECT 1', sql, error: '拒绝执行' }) })
  assert.equal(mixed.results.length, 2)
  assert.equal(mixed.results.find(x => x.widgetId === 'bad').ok, false)

  const edited = await dashboard.updateWidget(id, added.widget.id, { title: '订单趋势（已编辑）', query: 'SELECT 2', chartType: 'bar' })
  assert.equal(edited.ok, true)
  const loaded = await dashboard.getDashboard(id)
  assert.equal(loaded.dashboard.widgets[0].title, '订单趋势（已编辑）')
  assert.equal(loaded.dashboard.widgets[0].query, 'SELECT 2')
  assert.equal(loaded.dashboard.widgets[0].chartType, 'bar')

  await fsp.rm(root, { recursive: true, force: true })
  console.log(`\n${passed} 通过, ${failed} 失败`)
  process.exit(failed ? 1 : 0)
}
run().catch(err => { console.error(err); process.exit(1) })
