import { inferColumnKind, inferColumnKindsFromData, suggestChartSpec, suggestChartForResult } from '../lib/chart.js'

let pass = 0, fail = 0
const assert = (name, cond, extra) => {
  if (cond) { pass++; console.log('✓', name) }
  else { fail++; console.log('✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// 1. inferColumnKind
assert('date 类型', inferColumnKind('datetime') === 'date')
assert('int 类型', inferColumnKind('int') === 'number')
assert('decimal 类型', inferColumnKind('decimal(10,2)') === 'number')
assert('varchar 类型', inferColumnKind('varchar(64)') === 'string')
assert('text 类型', inferColumnKind('text') === 'string')
assert('tinyint(1) 布尔', inferColumnKind('tinyint(1)') === 'bool')

// 2. inferColumnKindsFromData
const rows = [
  { id: 1, name: 'a', created: '2026-01-01', amount: 12.5 },
  { id: 2, name: 'b', created: '2026-01-02', amount: 35 },
]
const kinds = inferColumnKindsFromData(['id', 'name', 'created', 'amount'], rows)
assert('id 数值', kinds[0].kind === 'number')
assert('name 字符串', kinds[1].kind === 'string')
assert('created 日期', kinds[2].kind === 'date')
assert('amount 数值', kinds[3].kind === 'number')

// 3. suggestChartSpec
const s1 = suggestChartSpec({ columns: ['cnt'], rows: [{ cnt: 10 }] })
assert('单数值列 stat', s1.ok === true && s1.spec.type === 'stat', s1.spec)

const timeRows = [{ d: '2026-01-01', v: 1 }, { d: '2026-01-02', v: 2 }]
const s2 = suggestChartSpec({ columns: ['d', 'v'], rows: timeRows })
assert('时间+数值 line', s2.ok === true && s2.spec.type === 'line', s2.spec)

const catRows = [{ cat: 'A', cnt: 5 }, { cat: 'B', cnt: 3 }, { cat: 'C', cnt: 1 }]
const s3 = suggestChartSpec({ columns: ['cat', 'cnt'], rows: catRows })
assert('类目+数值 低基数 pie', s3.ok === true && s3.spec.type === 'pie', s3.spec)

const catRows2 = [{ cat: 'A', cnt: 5 }, { cat: 'B', cnt: 3 }, { cat: 'C', cnt: 1 }, { cat: 'D', cnt: 1 }, { cat: 'E', cnt: 1 }, { cat: 'F', cnt: 1 }, { cat: 'G', cnt: 1 }, { cat: 'H', cnt: 1 }, { cat: 'I', cnt: 1 }, { cat: 'J', cnt: 1 }, { cat: 'K', cnt: 1 }, { cat: 'L', cnt: 1 }, { cat: 'M', cnt: 1 }, { cat: 'N', cnt: 1 }]
const s4 = suggestChartSpec({ columns: ['cat', 'cnt'], rows: catRows2 })
assert('高基数类目 bar', s4.ok === true && s4.spec.type === 'bar', s4.spec)

const multiRows = [{ cat: 'A', v1: 1, v2: 2 }, { cat: 'B', v1: 3, v2: 4 }]
const s5 = suggestChartSpec({ columns: ['cat', 'v1', 'v2'], rows: multiRows })
assert('多数值 bar', s5.ok === true && s5.spec.type === 'bar' && s5.spec.yFields.length === 2, s5.spec)

const s6 = suggestChartSpec({ columns: ['name'], rows: [{ name: 'a' }, { name: 'b' }, { name: 'a' }] })
assert('纯字符串频次 bar', s6.ok === true && s6.spec.type === 'bar' && s6.spec.yFields[0] === 'count', s6.spec)

assert('无列报错', suggestChartSpec({ columns: [] }).ok === false)

// 4. suggestChartForResult
const r1 = suggestChartForResult({ columns: ['cnt'], rows: [{ cnt: 42 }] }, '统计')
assert('result 包装', r1.ok === true && r1.spec.stats.count === 1, r1.spec)

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
