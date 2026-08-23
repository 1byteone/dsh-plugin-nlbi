/**
 * sqlsafe.js — dsh-plugin-nlbi SQL 安全校验层
 *
 * 基于 node-sql-parser (v5.4.0) 的 AST 级 SQL 校验。
 * 相对于 lib/shared.js 的正则方案，AST 方案更精确（无字符串/注释误判）、
 * 可获取列信息、可自动改写 SQL（补 LIMIT / 超时提示）。
 *
 * 设计原则：
 *  - 纯函数，无外部依赖（除 node-sql-parser）
 *  - 所有函数输入 SQL 字符串，输出结构化结果
 *  - 与 shared.js 中已有的分类/白名单/多语句检测形成双重防御
 *
 * @module sqlsafe
 */

import pkg from 'node-sql-parser'
const { Parser } = pkg

const parser = new Parser()
const MYSQL_OPT = { database: 'mysql' }

/**
 * AST 级 SQL 语句分类。
 * 相比 shared.js 的正则方案，AST 能精确区分不同语境。
 *
 * @param {string} sql - 原始 SQL
 * @returns {{ type: 'read'|'write-dml'|'ddl'|'dcl'|'unknown'|'empty', ast?: object, error?: string }}
 */
export function classifyStatementAst(sql) {
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return { type: 'empty' }
  }

  try {
    const ast = parser.astify(sql, MYSQL_OPT)
    // 多语句会返回数组
    const statements = Array.isArray(ast) ? ast : [ast]
    if (statements.length > 1) {
      return { type: 'unknown', error: '多语句不允许' }
    }
    const node = statements[0]

    const type = classifyAstNode(node)
    return { type, ast: node }
  } catch (err) {
    // 解析失败时降级到 shared.js 匹配
    return { type: 'unknown', error: 'SQL 解析失败: ' + (err.message || String(err)) }
  }
}

/**
 * 对单个 AST 节点分类。
 * @param {object} node - AST 节点
 * @returns {string}
 */
function classifyAstNode(node) {
  if (!node || !node.type) return 'unknown'

  switch (node.type) {
    // 只读查询
    case 'select':
    case 'union':
    case 'intersect':
    case 'except':
      return 'read'

    // DML 写操作
    case 'insert':
    case 'update':
    case 'delete':
    case 'replace':
      return 'write-dml'

    // DDL
    case 'drop':
    case 'create':
    case 'alter':
    case 'truncate':
    case 'rename':
      return 'ddl'

    // DCL / 管理
    case 'grant':
    case 'revoke':
    case 'lock':
    case 'unlock':
    case 'set':
    case 'call':
    case 'use':
      return 'dcl'

    default:
      return 'unknown'
  }
}

/**
 * 从 AST 中提取所有表引用（表名，小写）。
 * 支持 JOIN / 子查询 / 别名，递归提取。
 *
 * @param {object} ast - AST 节点
 * @returns {string[]} 表名数组（小写，去重）
 */
export function extractTableNamesFromAst(ast) {
  if (!ast) return []
  const names = new Set()

  function walk(node) {
    if (!node || typeof node !== 'object') return

    // 处理 from 子句
    if (node.from && Array.isArray(node.from)) {
      for (const item of node.from) {
        if (item.table) {
          names.add(item.table.toLowerCase())
        }
        // 子查询：递归提取（node-sql-parser 将子查询 AST 放在 expr.ast）
        if (item.expr && item.expr.ast && item.expr.ast.type === 'select') {
          walk(item.expr.ast)
        } else if (item.expr && item.expr.type === 'select') {
          walk(item.expr)
        } else if (item.expr && typeof item.expr === 'object') {
          walkExpr(item.expr, walk)
        }
      }
    }

    // 处理 JOIN 表
    if (node.join && Array.isArray(node.join)) {
      for (const join of node.join) {
        if (join.table) {
          names.add(join.table.toLowerCase())
        }
        // JOIN 子查询
        if (join.expr && join.expr.ast && join.expr.ast.type === 'select') {
          walk(join.expr.ast)
        } else if (join.expr && join.expr.type === 'select') {
          walk(join.expr)
        } else if (join.expr && typeof join.expr === 'object') {
          walkExpr(join.expr, walk)
        }
      }
    }

    // 处理 UPDATE 目标表
    if (node.table && Array.isArray(node.table)) {
      for (const t of node.table) {
        if (t.table) names.add(t.table.toLowerCase())
      }
    }

    // 处理 INSERT INTO
    if (node.type === 'insert' && node.table && node.table.table) {
      names.add(node.table.table.toLowerCase())
    }

    // 处理 DELETE 表
    if (node.type === 'delete' && node.from && Array.isArray(node.from)) {
      for (const item of node.from) {
        if (item.table) names.add(item.table.toLowerCase())
      }
    }

    // CTE (WITH 子句)
    if (node.with && Array.isArray(node.with)) {
      for (const cte of node.with) {
        if (cte.stmt) walk(cte.stmt)
      }
    }

    // 子查询在 WHERE/HAVING 中
    if (node.where) walkExpr(node.where, walk)
    if (node.having) walkExpr(node.having, walk)
  }

  function walkExpr(expr, visitor) {
    if (!expr || typeof expr !== 'object') return
    if (expr.type === 'select') { visitor(expr); return }
    // 递归遍历表达式属性
    for (const key of Object.keys(expr)) {
      if (key === 'parent') continue
      const val = expr[key]
      if (Array.isArray(val)) {
        val.forEach(v => { if (v && typeof v === 'object') walkExpr(v, visitor) })
      } else if (val && typeof val === 'object') {
        walkExpr(val, visitor)
      }
    }
  }

  walk(ast)
  return [...names]
}

/**
 * 校验 SQL 是否只读（AST 级别）。
 * 比 shared.js 的 classifyStatement 更精确——能识别 UNION/子查询等复合类型。
 *
 * @param {string} sql
 * @returns {{ ok: boolean, type?: string, error?: string, tables?: string[] }}
 */
export function checkReadOnly(sql) {
  const result = classifyStatementAst(sql)
  if (result.type === 'empty') {
    return { ok: false, error: 'SQL 为空' }
  }
  if (result.error) {
    return { ok: false, error: result.error }
  }
  if (result.type !== 'read') {
    return { ok: false, type: result.type, error: '只允许 SELECT/UNION 等只读查询，不允许 ' + result.type }
  }
  const tables = extractTableNamesFromAst(result.ast)
  return { ok: true, type: 'read', tables }
}

/**
 * 表白名单校验（AST 级别）。
 * 相比 shared.js 的正则方案，AST 不会误判字符串/注释中的表名。
 *
 * @param {string} sql
 * @param {string[]} allowlist - 白名单表名（小写）
 * @returns {{ ok: boolean, denied?: string[], tables?: string[] }}
 */
export function checkTableAllowlistAst(sql, allowlist) {
  const list = (allowlist || []).map(t => t.toLowerCase().trim()).filter(Boolean)
  if (list.length === 0) return { ok: true, tables: [] } // 空名单=不限制

  const result = classifyStatementAst(sql)
  if (result.error || !result.ast) {
    // 解析失败时降级到 shared.js 的正则方案
    return fallbackCheckTableAllowlist(sql, list)
  }

  const tables = extractTableNamesFromAst(result.ast)
  const denied = tables.filter(t => !list.includes(t))
  if (denied.length > 0) {
    return { ok: false, denied, tables }
  }
  return { ok: true, tables }
}

/**
 * 降级方案：使用 shared.js 的正则提取表名
 */
function fallbackCheckTableAllowlist(sql, list) {
  try {
    // 动态引入 shared.js（避免循环依赖）
    const shared = require('./shared.js')
    const refs = shared.extractTableRefs(sql)
    const denied = refs.filter(t => !list.includes(t))
    if (denied.length > 0) return { ok: false, denied, tables: refs }
    return { ok: true, tables: refs }
  } catch (err) {
    return { ok: false, denied: ['(无法解析 SQL 表名)'], tables: [] }
  }
}

/**
 * 为 SELECT 查询自动补 LIMIT 子句。
 * 如果原始 SQL 没有 LIMIT，追加 LIMIT {maxRows}。
 * 如果已有 LIMIT 但值大于 maxRows，改写为 maxRows。
 *
 * @param {string} sql
 * @param {number} [maxRows=2000]
 * @returns {{ sql: string, modified: boolean, originalLimit?: number }}
 */
export function injectLimit(sql, maxRows = 2000) {
  if (!sql || typeof sql !== 'string') return { sql: sql || '', modified: false }

  try {
    const ast = parser.astify(sql, MYSQL_OPT)
    if (Array.isArray(ast)) return { sql, modified: false } // 多语句不处理

    const node = ast
    if (node.type !== 'select' && node.type !== 'union') {
      return { sql, modified: false }
    }

    // union 类型需要找到最后一个 select 节点
    let target = node
    while (target.type === 'union' && target.union && target.union.length > 0) {
      const last = target.union[target.union.length - 1]
      if (last && last.type === 'select') {
        target = last
        break
      }
      // 从右操作数继续
      if (target.union[0] && target.union[0].type === 'select') {
        target = target.union[0]
        break
      }
      if (target.union[1] && target.union[1].type === 'select') {
        target = target.union[1]
        break
      }
      break
    }

    const originalLimit = target.limit ? (target.limit.value && Array.isArray(target.limit.value) ? target.limit.value[0].value : null) : null
    let modified = false

    if (!target.limit) {
      // 没有 LIMIT → 追加
      target.limit = { seperator: '', value: [{ type: 'number', value: maxRows }] }
      modified = true
    } else if (target.limit.value && Array.isArray(target.limit.value) && target.limit.value[0] && target.limit.value[0].value > maxRows) {
      // LIMIT 值过大 → 改写
      target.limit.value[0].value = maxRows
      modified = true
    }

    if (modified) {
      const newSql = parser.sqlify(node)
      return { sql: newSql, modified: true, originalLimit }
    }

    return { sql, modified: false, originalLimit }
  } catch (err) {
    // 解析失败时不改写，原样返回
    return { sql, modified: false }
  }
}

/**
 * 为 SELECT 注入 MAX_EXECUTION_TIME 优化器提示。
 * 与 shared.js 中的 prependExecutionHint 功能一致，但基于 AST 更精确。
 *
 * @param {string} sql
 * @param {number} [timeoutMs=15000]
 * @returns {string}
 */
export function injectMaxExecutionTime(sql, timeoutMs = 15000) {
  if (!sql || typeof sql !== 'string') return sql || ''
  // 已自带优化器提示时跳过
  if (/\/\*\+/i.test(sql)) return sql
  return sql.replace(/^(\s*)(select\b)/i, '$1$2 /*+ MAX_EXECUTION_TIME(' + timeoutMs + ') */')
}

/**
 * 一站式安全校验 + SQL 改写。
 * 用于 nl_query 工具执行前对生成 SQL 的最终检查。
 *
 * @param {string} sql - 原始 SQL
 * @param {object} [options]
 * @param {string[]} [options.allowlist] - 表白名单
 * @param {number} [options.maxRows=2000] - LIMIT 上限
 * @param {number} [options.timeoutMs=15000] - 执行超时
 * @returns {{
 *   ok: boolean,
 *   safeSql?: string,
 *   tables?: string[],
 *   error?: string,
 *   details?: object
 * }}
 */
export function validateAndPrepare(sql, options = {}) {
  const { allowlist = [], maxRows = 2000, timeoutMs = 15000 } = options

  // 1. 基本检查
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return { ok: false, error: 'SQL 为空' }
  }

  // 2. 多语句检测（双层防御）
  const cleaned = sql.trim()
  // 先做 AST 解析
  try {
    const ast = parser.astify(cleaned, MYSQL_OPT)
    if (Array.isArray(ast) && ast.length > 1) {
      return { ok: false, error: '不允许一次执行多条 SQL 语句' }
    }
  } catch (err) {
    // 解析失败时用 shared.js 的正则检测
    const { hasMultipleStatements } = require('./shared.js')
    if (hasMultipleStatements(cleaned)) {
      return { ok: false, error: '不允许一次执行多条 SQL 语句' }
    }
  }

  // 3. 只读校验
  const readOnly = checkReadOnly(cleaned)
  if (!readOnly.ok) {
    return { ok: false, error: readOnly.error }
  }

  // 4. 表白名单校验
  const allowCheck = checkTableAllowlistAst(cleaned, allowlist)
  if (!allowCheck.ok) {
    return { ok: false, error: '查询涉及白名单外的表: ' + allowCheck.denied.join(', ') }
  }

  // 5. 注入 LIMIT（安全改写）
  const limitResult = injectLimit(cleaned, maxRows)

  // 6. 注入 MAX_EXECUTION_TIME
  let safeSql = injectMaxExecutionTime(limitResult.sql, timeoutMs)

  return {
    ok: true,
    safeSql,
    tables: readOnly.tables,
    modified: limitResult.modified,
    originalLimit: limitResult.originalLimit,
  }
}

/**
 * 从 SQL 中提取列信息（列名、表来源）。
 * 用于 chartSpec 生成和 schema 上下文注入。
 *
 * @param {string} sql
 * @returns {{ columns: Array<{name: string, table?: string}>, error?: string }}
 */
export function extractColumnInfo(sql) {
  try {
    const ast = parser.astify(sql, MYSQL_OPT)
    if (Array.isArray(ast)) return { columns: [] }

    const columns = (ast.columns || []).map(col => {
      if (col.expr && col.expr.type === 'column_ref') {
        return {
          name: col.as || col.expr.column,
          table: col.expr.table || undefined,
        }
      }
      // 聚合函数、表达式等
      if (col.expr && col.expr.type === 'aggr_func') {
        return { name: col.as || col.expr.name || 'aggregate' }
      }
      return { name: col.as || 'expr' }
    })

    return { columns }
  } catch (err) {
    return { columns: [], error: err.message }
  }
}

export default {
  classifyStatementAst,
  checkReadOnly,
  checkTableAllowlistAst,
  extractTableNamesFromAst,
  injectLimit,
  injectMaxExecutionTime,
  validateAndPrepare,
  extractColumnInfo,
}