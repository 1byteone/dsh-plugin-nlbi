/**
 * export.test.mjs — dsh-plugin-nlbi 导出引擎测试
 */

import * as ext from '../lib/export.js'

let passed = 0
let failed = 0

function assert(ok, msg) {
  if (ok) { passed++; console.log('✓ ' + msg) }
  else { failed++; console.error('✗ ' + msg) }
}

const columns = ['city', 'sales', 'year']
const rows = [
  { city: '北京', sales: 100, year: 2026 },
  { city: '上海', sales: 200, year: 2026 },
  { city: '广州', sales: 150, year: 2026 },
]

function testCSV() {
  const csv = ext.toCSV(columns, rows)
  assert(csv.includes('city,sales,year'), 'CSV 包含表头')
  assert(csv.includes('北京,100,2026'), 'CSV 包含北京行')
  assert(csv.includes('上海,200,2026'), 'CSV 包含上海行')

  // 空数据
  const empty = ext.toCSV(columns, [])
  assert(empty.includes('city,sales,year'), 'CSV 空数据有表头')
  assert(empty === 'city,sales,year', 'CSV 空数据仅表头（无尾行）')
}

function testTSV() {
  const tsv = ext.toTSV(columns, rows)
  assert(tsv.includes('city\tsales\tyear'), 'TSV 包含表头')
  assert(tsv.includes('北京\t100\t2026'), 'TSV 包含北京行')
}

function testMarkdown() {
  const md = ext.toMarkdownTable(columns, rows)
  assert(md.includes('| city | sales | year |'), 'Markdown 包含表头')
  assert(md.includes('| ---- |') || md.includes('| --- |'), 'Markdown 包含分隔线')
  assert(md.includes('| 北京 | 100 | 2026 |') || md.includes('北京'), 'Markdown 包含北京行')

  // 空数据
  const empty = ext.toMarkdownTable(columns, [])
  assert(empty.includes('| city | sales | year |'), 'Markdown 空数据有表头')
  assert(empty.includes('| ---- | ----- | ---- |') || /^\| -+ \|/.test(empty), 'Markdown 空数据有分隔线')
}

function testExcel() {
  const html = ext.toExcel(columns, rows)
  assert(html.includes('<table'), 'Excel 包含 table 标签')
  assert(html.includes('北京'), 'Excel 包含数据')
  assert(html.includes('utf-8'), 'Excel 包含编码声明')
}

function testExportResult() {
  // CSV
  const r1 = ext.exportResult('csv', columns, rows)
  assert(r1.extension === 'csv', 'exportResult csv 扩展名正确')
  assert(r1.mimeType.includes('csv'), 'exportResult csv mime 正确')

  // Markdown
  const r2 = ext.exportResult('markdown', columns, rows)
  assert(r2.extension === 'md', 'exportResult md 扩展名正确')

  // Excel
  const r3 = ext.exportResult('excel', columns, rows)
  assert(r3.extension === 'html', 'exportResult excel 扩展名正确')

  // 空列
  const r4 = ext.exportResult('csv', [], [])
  assert(r4.content === '', 'exportResult 空列返回空')
}

function testCSVInjection() {
  // 防止 CSV 注入：以 = + - @ 开头的值
  const injectCols = ['name']
  const injectRows = [{ name: '=SUM(A1:A10)' }]
  const csv = ext.toCSV(injectCols, injectRows)
  assert(csv.includes("'=SUM(A1:A10)"), 'CSV 注入防护有效')
}

// ── 主流程 ──

function main() {
  console.log('── export.js 测试 ──')
  try {
    testCSV()
    testTSV()
    testMarkdown()
    testExcel()
    testExportResult()
    testCSVInjection()
  } catch (err) {
    console.error('测试异常:', err.message)
    failed++
  }
  console.log(`\n${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main()