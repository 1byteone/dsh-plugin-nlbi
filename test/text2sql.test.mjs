import { buildPrompt, parseLlmResult } from '../lib/text2sql.js'

let pass = 0, fail = 0
const assert = (name, cond, extra) => {
  if (cond) { pass++; console.log('✓', name) }
  else { fail++; console.log('✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// 1. buildPrompt
const schema = [
  { name: 'users', comment: '用户表', columns: [
    { column: 'id', type: 'int', comment: '主键', key: 'PRI' },
    { column: 'name', type: 'varchar(64)', comment: '姓名', key: '' },
  ]},
]
const p1 = buildPrompt({ question: '查看所有用户', schema, connectionName: '演示库', databaseName: 'demo' })
assert('prompt 包含 schema', p1.userPrompt.includes('users') && p1.userPrompt.includes('varchar(64)'))
assert('prompt 包含问题', p1.userPrompt.includes('查看所有用户'))
assert('system 包含安全规则', p1.systemPrompt.includes('绝不生成'))
assert('system 包含 few-shot', p1.systemPrompt.includes('示例 1'))

// 2. Schema >30 张表时降级为清单
const bigSchema = Array.from({ length: 35 }, (_, i) => ({ name: 'tbl' + i, comment: '', columns: [] }))
const p2 = buildPrompt({ question: 'q', schema: bigSchema })
assert('>30 表降级清单', p2.userPrompt.includes('共 35 张表') && !p2.userPrompt.includes('columns'))

// 3. parseLlmResult
assert('纯 JSON', parseLlmResult('{"sql":"SELECT 1","explain":"ok"}').ok === true)
assert('代码块 JSON', parseLlmResult('```json\n{"sql":"SELECT 1","explain":"ok"}\n```').ok === true)
assert('宽松 JSON', parseLlmResult('好的，这是查询：\n{"sql": "SELECT * FROM users", "explain": "查询用户"}').ok === true)
assert('无 JSON', parseLlmResult('抱歉，我无法生成 SQL').ok === false)
assert('空 SQL', parseLlmResult('{"sql":"","explain":""}').ok === false)
const r1 = parseLlmResult('{"query":"SELECT 1","description":"x"}')
assert('字段别名兼容', r1.ok === true && r1.sql === 'SELECT 1', r1)
assert('空输入', parseLlmResult('').ok === false)

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
