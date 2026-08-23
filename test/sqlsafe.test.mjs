import {
  classifyStatementAst,
  checkReadOnly,
  checkTableAllowlistAst,
  extractTableNamesFromAst,
  injectLimit,
  injectMaxExecutionTime,
  validateAndPrepare,
  extractColumnInfo,
} from '../lib/sqlsafe.js'

let pass = 0, fail = 0
const assert = (name, cond, extra) => {
  if (cond) { pass++; console.log('✓', name) }
  else { fail++; console.log('✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// 1. 分类
assert('SELECT → read', classifyStatementAst('SELECT * FROM users').type === 'read')
assert('UNION → read', classifyStatementAst('SELECT id FROM users UNION SELECT id FROM admins').type === 'read')
assert('INSERT → write-dml', classifyStatementAst('INSERT INTO users(id) VALUES(1)').type === 'write-dml')
assert('UPDATE → write-dml', classifyStatementAst('UPDATE users SET name="a"').type === 'write-dml')
assert('DELETE → write-dml', classifyStatementAst('DELETE FROM users').type === 'write-dml')
assert('DROP → ddl', classifyStatementAst('DROP TABLE users').type === 'ddl')
assert('ALTER → ddl', classifyStatementAst('ALTER TABLE users ADD COLUMN x INT').type === 'ddl')
assert('空 SQL → empty', classifyStatementAst('   ').type === 'empty')

// 2. 只读
assert('SELECT 通过只读', checkReadOnly('SELECT * FROM users').ok === true)
assert('UPDATE 拒绝只读', checkReadOnly('UPDATE users SET x=1').ok === false)
assert('DROP 拒绝只读', checkReadOnly('DROP TABLE users').ok === false)

// 3. 表提取
const tables = extractTableNamesFromAst((classifyStatementAst('SELECT a.id FROM users a JOIN orders o ON a.id=o.uid').ast))
assert('JOIN 表提取', tables.includes('users') && tables.includes('orders'), tables)
const subTables = extractTableNamesFromAst((classifyStatementAst('SELECT * FROM (SELECT id FROM inner_tbl) t').ast))
assert('子查询表提取', subTables.includes('inner_tbl'), subTables)

// 4. 白名单
assert('白名单通过', checkTableAllowlistAst('SELECT * FROM users', ['users']).ok === true)
assert('白名单拒绝', checkTableAllowlistAst('SELECT * FROM secret', ['users']).ok === false)
assert('空白名单不限制', checkTableAllowlistAst('SELECT * FROM anything', []).ok === true)

// 5. LIMIT 注入
const l1 = injectLimit('SELECT * FROM users')
assert('无 LIMIT 自动补', l1.modified === true && /LIMIT\s+2000/i.test(l1.sql), l1.sql)
const l2 = injectLimit('SELECT * FROM users LIMIT 100')
assert('已有 LIMIT 不动', l2.modified === false)
const l3 = injectLimit('SELECT * FROM users LIMIT 99999', 2000)
assert('超 LIMIT 改写', l3.modified === true, l3.sql)

// 6. 超时提示
const h1 = injectMaxExecutionTime('SELECT * FROM users')
assert('注入超时提示', /MAX_EXECUTION_TIME\(15000\)/.test(h1), h1)
const h2 = injectMaxExecutionTime('SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM users')
assert('已有提示不重复', !/MAX_EXECUTION_TIME\(15000\)/.test(h2), h2)

// 7. 一站式
const v1 = validateAndPrepare('SELECT * FROM users', { allowlist: ['users'] })
assert('validateAndPrepare 通过', v1.ok === true && /MAX_EXECUTION_TIME/.test(v1.safeSql), v1)
const v2 = validateAndPrepare('UPDATE users SET x=1', { allowlist: ['users'] })
assert('写操作被拒', v2.ok === false)
const v3 = validateAndPrepare('SELECT * FROM secret', { allowlist: ['users'] })
assert('白名单外被拒', v3.ok === false)
const v4 = validateAndPrepare('SELECT 1; DROP TABLE users', { allowlist: [] })
assert('多语句被拒', v4.ok === false)

// 8. 列提取
const c1 = extractColumnInfo('SELECT id, name AS n FROM users')
assert('列提取', c1.columns.length === 2, c1.columns)

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
