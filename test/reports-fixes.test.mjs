import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import * as dashboard from '../lib/dashboard.js'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nlbi-reports-fix-'))
const file = path.join(root, 'storages', 'dsh-plugin-nlbi', 'reports.json')
await fsp.mkdir(path.dirname(file), { recursive: true })
let passed = 0
let failed = 0
function ok(condition, name) { if (condition) { passed++; console.log('✓ ' + name) } else { failed++; console.error('✗ ' + name) } }

try {
  await fsp.writeFile(file, JSON.stringify({ reports: [{ id: 'r1', name: '订单趋势', sql: 'SELECT 1', connectionId: 'c-dsh-test' }] }))
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
  ok(Array.isArray(parsed.reports) && parsed.reports[0].name === '订单趋势', '报表列表存储结构可读取')
  await fsp.writeFile(file, '{broken')
  let invalid = false
  try { JSON.parse(await fsp.readFile(file, 'utf8')) } catch { invalid = true }
  ok(invalid, '损坏的报表存储可被识别为错误')
  await fsp.writeFile(file, JSON.stringify({ reports: [] }))
  const empty = JSON.parse(await fsp.readFile(file, 'utf8'))
  ok(empty.reports.length === 0, '真实空列表与存储错误可区分')
  const d = await dashboard.saveDashboard({ name: '报表联动验证', connectionId: 'c-dsh-test' })
  const w = await dashboard.addWidget(d.dashboard.id, { type: 'chart', title: '分类销售额', query: 'SELECT 1', chartType: 'bar' })
  ok(w.ok === true, '图表 Widget 可添加')
  const loaded = await dashboard.getDashboard(d.dashboard.id)
  ok(loaded.dashboard.widgets[0].query === 'SELECT 1', '图表 Widget 保存后可读取')
} finally {
  await fsp.rm(root, { recursive: true, force: true })
}
console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed ? 1 : 0)
