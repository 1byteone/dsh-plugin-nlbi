/**
 * text2sql.js — dsh-plugin-nlbi Text2SQL 编排核心
 *
 * 职责：
 *  1. 组装 Schema 上下文（基于当前连接的可读表结构）
 *  2. 构建 Text2SQL prompt（system 规则 + few-shot 示例 + schema + 用户问题）
 *  3. 调用 DSH 宿主 model 服务（或降级方案）
 *  4. 解析 LLM 返回的 JSON {sql, explain}
 *  5. 校验 → 执行 → 返回格式化结果
 *
 * 依赖：
 *  - sqlsafe.js：SQL 安全校验与改写（AST 级别）
 *  - shared.js：SQL 分类、白名单、多语句检测（双重防御）
 *  - DSH 运行时：model 服务（Text2SQL 生成）、mysql 连接池（执行）
 *
 * @module text2sql
 */

import { validateAndPrepare, checkReadOnly } from './sqlsafe.js'
import { MAX_ROWS, classifyStatement, checkTableAllowlist, hasMultipleStatements, stripSqlComments, jsonSafe } from './shared.js'

const MAX_EXECUTION_MS = 15000

/**
 * 默认 Text2SQL 系统提示词模板。
 * 指导 LLM 生成安全、准确的 SQL。
 *
 * @type {string}
 */
const DEFAULT_SYSTEM_PROMPT = `你是一个 MySQL 数据分析助手。你的职责是：
1. 根据用户的问题和数据库表结构，生成正确的 SQL 查询语句
2. 输出必须是 JSON 格式：{ "sql": "...", "explain": "..." }
3. sql 字段：只读 SQL（SELECT/SHOW/DESCRIBE/EXPLAIN），单条语句，不加注释
4. explain 字段：用一句话解释这条 SQL 在查什么，面向非技术用户
5. 安全规则：
   - 绝不生成 INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE 等写操作
   - 绝不生成多语句
   - 表名列名使用反引号包裹
   - 尽量使用参数化查询（? 占位符）
   - 聚合查询使用恰当的 GROUP BY 和 ORDER BY
   - 时间字段使用 DATE() 或 DATE_FORMAT() 按天/周/月聚合
6. 如果问题不明确，在 explain 中说明你的假设`

/**
 * Text2SQL 提示词中的 few-shot 示例。
 * 覆盖常见查询模式，提高生成准确率。
 *
 * @type {Array<{question: string, sql: string, explain: string}>}
 */
const FEW_SHOT_EXAMPLES = [
  {
    question: '查询所有用户',
    sql: 'SELECT * FROM users',
    explain: '查看全部用户记录',
  },
  {
    question: '上个月每天的新增用户数',
    sql: 'SELECT DATE(created_at) AS day, COUNT(*) AS cnt FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) GROUP BY DATE(created_at) ORDER BY day',
    explain: '统计近30天内每天新增的用户数量',
  },
  {
    question: '订单金额最高的前10个用户',
    sql: 'SELECT u.id, u.name, SUM(o.amount) AS total_amount FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.id, u.name ORDER BY total_amount DESC LIMIT 10',
    explain: '计算每个用户的订单总额，并找出消费最高的前10位用户',
  },
  {
    question: '各分类的商品数量',
    sql: 'SELECT category, COUNT(*) AS product_count FROM products GROUP BY category ORDER BY product_count DESC',
    explain: '按商品分类统计数量，从多到少排列',
  },
]

/**
 * 构建 Text2SQL 的完整 prompt。
 *
 * @param {object} options
 * @param {string} options.question - 用户的自然语言问题
 * @param {Array<{name: string, columns: Array<{column: string, type: string, comment: string}>}>} options.schema - 表结构列表
 * @param {string} [options.connectionName] - 当前连接名称
 * @param {string} [options.databaseName] - 当前数据库名称
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildPrompt({ question, schema, connectionName, databaseName }) {
  if (!question || typeof question !== 'string') {
    throw new Error('question 不能为空')
  }

  // 组装 Schema 上下文
  const schemaParts = []
  if (connectionName) schemaParts.push(`当前数据库连接：${connectionName}`)
  if (databaseName) schemaParts.push(`当前数据库：${databaseName}`)

  if (schema && schema.length > 0) {
    // 表数 ≤30 时全量列结构注入
    if (schema.length <= 30) {
      schemaParts.push('可用的数据库表结构：')
      for (const table of schema) {
        const cols = (table.columns || [])
          .map(c => {
            const parts = [`  - ${c.column} ${c.type}`]
            if (c.comment) parts.push(`(${c.comment})`)
            if (c.key) parts.push(`[${c.key}]`)
            return parts.join(' ')
          })
          .join('\n')
        schemaParts.push(`表 ${table.name}：${table.comment ? '(' + table.comment + ')' : ''}\n${cols}`)
      }
    } else {
      // 表数 >30 时只注入表名+注释清单
      schemaParts.push('可用的数据库表（共 ' + schema.length + ' 张表）：')
      for (const table of schema) {
        const comment = table.comment ? ` — ${table.comment}` : ''
        schemaParts.push(`  - ${table.name}${comment}`)
      }
      schemaParts.push('（如需具体表结构，可先查询后再生成 SQL）')
    }
  }

  // 构建 few-shot 示例
  const examplesText = FEW_SHOT_EXAMPLES
    .map((ex, i) => {
      return `示例 ${i + 1}：
问题：${ex.question}
SQL：${ex.sql}
说明：${ex.explain}`
    })
    .join('\n\n')

  const systemPrompt = DEFAULT_SYSTEM_PROMPT + '\n\n## 示例\n\n' + examplesText

  const userPrompt = [
    '## 数据库结构',
    ...schemaParts,
    '',
    '## 用户问题',
    question,
    '',
    '请输出 JSON 格式：{ "sql": "...", "explain": "..." }',
  ].join('\n')

  return { systemPrompt, userPrompt }
}

/**
 * 解析 LLM 返回的 Text2SQL 结果。
 * 支持多种输出格式（纯 JSON / 代码块中的 JSON / 带引号的 JSON）。
 *
 * @param {string} raw - LLM 原始输出
 * @returns {{ ok: boolean, sql?: string, explain?: string, error?: string }}
 */
export function parseLlmResult(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: '模型输出为空' }
  }

  let text = raw.trim()

  // 尝试从代码块中提取 JSON
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonBlockMatch) {
    text = jsonBlockMatch[1].trim()
  }

  // 尝试解析 JSON
  // 先找第一个 { 和最后一个 }
  const startIdx = text.indexOf('{')
  const endIdx = text.lastIndexOf('}')
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { ok: false, error: '模型输出未包含有效的 JSON' }
  }

  const jsonStr = text.slice(startIdx, endIdx + 1)

  try {
    const parsed = JSON.parse(jsonStr)
    const sql = parsed.sql || parsed.query || ''
    const explain = parsed.explain || parsed.explanation || parsed.description || ''

    if (!sql || typeof sql !== 'string' || !sql.trim()) {
      return { ok: false, error: '模型未生成 SQL 语句', raw: text }
    }

    return { ok: true, sql: sql.trim(), explain: explain.trim() || '（无说明）' }
  } catch (err) {
    // JSON 解析失败：尝试更宽松的提取
    return { ok: false, error: 'JSON 解析失败: ' + err.message, raw: text }
  }
}

/**
 * 调用 DSH 宿主 LLM 服务进行 Text2SQL 生成。
 * 优先级：1. ctx.get('llm').stream（DSH 标准模型服务，走用户当前会话选择的模型）
 *          2. ctx.get('model').chat（兼容旧版）
 *          3. ctx.get('model.api') / ctx.get('openai'）（OpenAI 兼容 API）
 *          4. 降级提示
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} prompt - buildPrompt 的返回值
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000] - LLM 调用超时
 * @returns {Promise<{ ok: boolean, sql?: string, explain?: string, error?: string }>}
 */
async function callLlm(ctx, prompt, options = {}) {
  const { timeoutMs = 30000 } = options

  if (!ctx) {
    return { ok: false, error: '宿主上下文不可用，Text2SQL 需要 DSH 运行时。' }
  }

  // 1) DSH 标准 LLM 服务（当前会话选择的模型，dsv 或标准 adapter）
  try {
    const llm = ctx.get('llm')
    if (llm && typeof llm.stream === 'function') {
      // 解析当前用户选择的模型路由（provider + model）
      // 优先级：会话级 agent 模型 > 全局默认模型
      const route = await resolveModelRoute(ctx)
      if (!route || !route.provider || !route.model) {
        return { ok: false, error: '未解析到当前模型路由。请在 DSH 设置 → 模型 中选择一个模型，或在对话顶部的模型选择器选好模型后再试。' }
      }

      const { BlockAssembler, createUserMessage, deepFreeze } = await importLlmHelper()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const messages = [createUserMessage({
        content: [{ type: 'text', text: prompt.userPrompt }],
      })]
      const llmOptions = deepFreeze({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        system: prompt.systemPrompt,
        messages,
        maxTokens: 1024,
        temperature: 0.1,
        sessionId: 'dsh-plugin-nlbi-text2sql',
        purpose: 'text2sql',
        signal: controller.signal,
      })

      try {
        const assembler = new BlockAssembler()
        for await (const chunk of llm.stream(llmOptions)) {
          assembler.push(chunk)
        }
        clearTimeout(timer)
        const terminalError = finishError(assembler.finish)
        if (terminalError) throw terminalError
        const blocks = assembler.blocks()
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (!text) return { ok: false, error: '模型未返回文本内容' }
        return parseLlmResult(text)
      } catch (err) {
        clearTimeout(timer)
        if (err.name === 'AbortError') return { ok: false, error: '模型调用超时' }
        return { ok: false, error: '模型调用失败: ' + (err.message || String(err)) }
      }
    }
  } catch (err) { /* llm 服务不可用，继续降级 */ }

  // 2) 尝试获取宿主 model 服务（兼容旧版）
  try {
    const model = ctx.get('model')
    if (model && typeof model.chat === 'function') {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const result = await model.chat({
        messages: [
          { role: 'system', content: prompt.systemPrompt },
          { role: 'user', content: prompt.userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 1024,
        signal: controller.signal,
      })

      clearTimeout(timer)
      const raw = result && (result.content || result.message?.content || result.text || '')
      return parseLlmResult(raw)
    }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: '模型调用超时' }
    return { ok: false, error: '模型调用失败: ' + (err.message || String(err)) }
  }

  // 3) 尝试通过 OpenAI 兼容 API（兼容旧版）
  try {
    const modelApi = ctx.get('model.api') || ctx.get('openai')
    if (modelApi && typeof modelApi.chat === 'function') {
      const result = await modelApi.chat({
        messages: [
          { role: 'system', content: prompt.systemPrompt },
          { role: 'user', content: prompt.userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 1024,
      })
      const raw = result && (result.content || result.message?.content || result.text || '')
      return parseLlmResult(raw)
    }
  } catch (err) {
    return { ok: false, error: '模型 API 调用失败: ' + (err.message || String(err)) }
  }

  // 4) 宿主未暴露任何模型服务 → 降级
  return { ok: false, error: '宿主未提供模型服务，Text2SQL 不可用。您仍可使用数据浏览功能查看表数据，或在对话中使用 mysql_query 工具。' }
}

/**
 * 动态导入 dsh-llm 的辅助模块（避免硬依赖）。
 */
let llmHelper = null
async function importLlmHelper() {
  if (llmHelper) return llmHelper
  try {
    // 在 DSH 运行时，dsh-llm 已经在宿主进程中
    const mod = await import('@deepseek-ai/dsh-llm')
    llmHelper = mod
    return mod
  } catch (err) {
    // 不在 DSH 运行时（如单元测试），回退
    llmHelper = { BlockAssembler: null, createUserMessage: null, deepFreeze: null }
    return llmHelper
  }
}

/**
 * 解析当前用户选择的模型路由 { provider, model, reasoningEffort? }。
 * 优先级：
 *  1. 会话级 Agent 当前模型（ctx.get('agents') → agent.session.requestContext().model）
 *  2. 全局默认模型（ctx.get('agentDefaultModel').currentSelection()）
 * 失败时返回 null。
 *
 * @param {object} ctx - Cordis 上下文
 * @returns {Promise<{provider: string, model: string, reasoningEffort?: string} | null>}
 */
async function resolveModelRoute(ctx) {
  // 1) 会话级模型（用户在对话顶部选的）
  try {
    const agents = ctx.get('agents')
    if (agents) {
      // 尝试从当前会话拿 model
      const list = agents.list && typeof agents.list === 'function' ? agents.list() : null
      const current = list && list.current ? list.current : null
      if (current) {
        const agent = agents.get ? agents.get(current) : null
        if (agent && agent.session && typeof agent.session.requestContext === 'function') {
          const rc = agent.session.requestContext()
          if (rc && rc.provider && rc.model) {
            return { provider: rc.provider, model: rc.model, ...(rc.reasoningEffort ? { reasoningEffort: rc.reasoningEffort } : {}) }
          }
        }
      }
    }
  } catch (err) { /* 会话级解析失败，降级到全局默认 */ }

  // 2) 全局默认模型
  try {
    const agentDefaultModel = ctx.get('agentDefaultModel')
    if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
      const sel = agentDefaultModel.currentSelection()
      if (sel && sel.provider && sel.model) {
        return sel
      }
    }
  } catch (err) { /* 全局默认解析失败 */ }

  return null
}

/**
 * 翻译终端 finish reason 为 Error。
 * @param {object} finish - BlockAssembler 的 finish 对象
 * @returns {Error|undefined}
 */
function finishError(finish) {
  if (!finish) return
  switch (finish.kind) {
    case 'stop': return
    case 'error':
    case 'aborted': {
      const err = new Error(finish.failure?.message || '模型调用失败')
      err.code = finish.failure?.code
      return err
    }
    case 'max-tokens': return new Error('模型输出达到 maxTokens 限制')
    case 'tool-calls': return new Error('模型意外请求了工具调用')
    default: return new Error('模型调用结束: ' + String(finish.kind))
  }
}

/**
 * 执行 Text2SQL 完整流水线。
 * 入口函数，供 nl_query 工具调用。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {string} question - 用户自然语言问题
 * @param {object} connection - 当前连接配置
 * @param {object} pool - mysql2 连接池
 * @param {object} [options]
 * @param {string[]} [options.allowlist] - 表白名单
 * @param {number} [options.maxRows=2000] - 行数上限
 * @returns {Promise<object>}
 */
export async function text2sql(ctx, question, connection, pool, options = {}) {
  const { allowlist = [], maxRows = 2000 } = options

  if (!question || typeof question !== 'string' || !question.trim()) {
    return { ok: false, error: '问题不能为空' }
  }

  // 1. 获取 Schema 结构
  let schema = []
  try {
    const [rows] = await pool.query(
      'SELECT c.table_name AS table_name, c.column_name AS column_name, c.column_type AS column_type, ' +
      'c.is_nullable AS is_nullable, c.column_key AS column_key, c.column_comment AS column_comment, ' +
      't.table_comment AS table_comment ' +
      'FROM information_schema.columns c ' +
      'LEFT JOIN information_schema.tables t ON c.table_schema = t.table_schema AND c.table_name = t.table_name ' +
      'WHERE c.table_schema = DATABASE() ' +
      'ORDER BY c.table_name, c.ordinal_position',
    )
    const byTable = new Map()
    const tableComments = new Map()
    for (const r of rows) {
      const t = String(r.table_name).toLowerCase()
      if (allowlist.length > 0 && !allowlist.includes(t)) continue
      tableComments.set(t, r.table_comment || '')
      if (!byTable.has(t)) byTable.set(t, [])
      byTable.get(t).push({
        column: String(r.column_name),
        type: String(r.column_type),
        nullable: String(r.is_nullable).toUpperCase() === 'YES',
        key: r.column_key ? String(r.column_key) : '',
        comment: r.column_comment ? String(r.column_comment) : '',
      })
    }
    schema = [...byTable.keys()].sort().map(t => ({ name: t, columns: byTable.get(t), comment: tableComments.get(t) || '' }))
  } catch (err) {
    return { ok: false, error: '读取表结构失败: ' + (err.message || String(err)) }
  }

  if (schema.length === 0) {
    return { ok: false, error: '当前连接没有可读的表（受白名单限制），请检查设置' }
  }

  // 2. 构建 Prompt
  let prompt
  try {
    prompt = buildPrompt({
      question: question.trim(),
      schema,
      connectionName: connection.name,
      databaseName: connection.database,
    })
  } catch (err) {
    return { ok: false, error: 'Prompt 构建失败: ' + (err.message || String(err)) }
  }

  // 3. 调用 LLM 生成 SQL
  const llmResult = await callLlm(ctx, prompt)
  if (!llmResult.ok) {
    return {
      ok: false,
      error: llmResult.error,
      schema, // 返回 schema 信息，方便用户参考
    }
  }

  // 4. 安全校验（双层防御：AST + 正则）
  const validation = validateAndPrepare(llmResult.sql, { allowlist, maxRows })
  if (!validation.ok) {
    return {
      ok: false,
      error: '生成的 SQL 未通过安全校验: ' + validation.error,
      sql: llmResult.sql,
      explain: llmResult.explain,
      schema,
    }
  }

  // 5. 执行查询
  try {
    const safeSql = validation.safeSql
    const [rows, fields] = await pool.query(safeSql)
    const columns = Array.isArray(fields) ? fields.map(f => f.name) : []
    const list = Array.isArray(rows) ? rows : []
    const truncated = list.length > maxRows
    const slice = truncated ? list.slice(0, maxRows) : list

    return {
      ok: true,
      sql: safeSql,
      originalSql: llmResult.sql,
      explain: llmResult.explain,
      result: {
        columns,
        rowCount: slice.length,
        totalRowCount: list.length,
        truncated,
        rows: slice.map(jsonSafe),
      },
      schema,
    }
  } catch (err) {
    return {
      ok: false,
      error: '查询执行失败: ' + (err.message || String(err)),
      sql: validation.safeSql,
      originalSql: llmResult.sql,
      explain: llmResult.explain,
      schema,
    }
  }
}

/**
 * 获取当前连接的 Schema 信息（用于前端侧栏预览）。
 *
 * @param {object} pool - mysql2 连接池
 * @param {string[]} allowlist - 表白名单
 * @returns {Promise<{ok: boolean, schema?: Array, error?: string}>}
 */
export async function getSchemaInfo(pool, allowlist = []) {
  try {
    const [rows] = await pool.query(
      'SELECT c.table_name AS table_name, c.column_name AS column_name, c.column_type AS column_type, ' +
      'c.is_nullable AS is_nullable, c.column_key AS column_key, c.column_comment AS column_comment, ' +
      'c.ordinal_position AS ordinal_position, t.table_comment AS table_comment, t.table_rows AS table_rows ' +
      'FROM information_schema.columns c ' +
      'LEFT JOIN information_schema.tables t ON c.table_schema = t.table_schema AND c.table_name = t.table_name ' +
      'WHERE c.table_schema = DATABASE() ' +
      'ORDER BY c.table_name, c.ordinal_position',
    )
    const byTable = new Map()
    for (const r of rows) {
      const t = String(r.table_name).toLowerCase()
      if (allowlist.length > 0 && !allowlist.includes(t)) continue
      if (!byTable.has(t)) {
        byTable.set(t, {
          name: t,
          comment: r.table_comment || '',
          rowEstimate: r.table_rows || 0,
          columns: [],
        })
      }
      const entry = byTable.get(t)
      entry.columns.push({
        column: String(r.column_name),
        type: String(r.column_type),
        nullable: String(r.is_nullable).toUpperCase() === 'YES',
        key: r.column_key ? String(r.column_key) : '',
        comment: r.column_comment ? String(r.column_comment) : '',
        position: r.ordinal_position,
      })
    }
    const schema = [...byTable.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { ok: true, schema }
  } catch (err) {
    return { ok: false, error: '读取 Schema 失败: ' + (err.message || String(err)) }
  }
}

/**
 * 获取表数据预览（分页/排序/过滤）。
 *
 * @param {object} pool - mysql2 连接池
 * @param {string} tableName - 表名
 * @param {object} [options]
 * @param {number} [options.page=1] - 页码
 * @param {number} [options.pageSize=100] - 每页行数
 * @param {string} [options.sortColumn] - 排序列
 * @param {string} [options.sortOrder='ASC'] - 排序方向
 * @param {string} [options.where] - WHERE 条件（受护栏校验）
 * @param {string[]} [options.allowlist] - 表白名单
 * @returns {Promise<object>}
 */
export async function getTablePreview(pool, tableName, options = {}) {
  const {
    page = 1,
    pageSize = 100,
    sortColumn,
    sortOrder = 'ASC',
    where,
    allowlist = [],
  } = options

  const table = tableName.toLowerCase().trim()
  if (!table) return { ok: false, error: '表名不能为空' }

  // 白名单校验
  if (allowlist.length > 0 && !allowlist.includes(table)) {
    return { ok: false, error: '表 ' + table + ' 不在白名单中' }
  }

  // 构建 SQL
  let sql = 'SELECT * FROM `' + table.replace(/`/g, '') + '`'

  // WHERE 条件（安全校验）
  if (where && typeof where === 'string' && where.trim()) {
    const whereClause = where.trim()
    // 安全检查：只允许 SELECT 子查询，不允许 DML
    const kind = classifyStatement('SELECT * FROM t WHERE ' + whereClause)
    if (kind !== 'read' || hasMultipleStatements(whereClause)) {
      return { ok: false, error: 'WHERE 条件包含不允许的语句' }
    }
    sql += ' WHERE ' + whereClause
  }

  // ORDER BY（列名校验）
  if (sortColumn && typeof sortColumn === 'string') {
    const col = sortColumn.trim().replace(/`/g, '')
    // 只允许字母数字下划线
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
      const order = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      sql += ' ORDER BY `' + col + '` ' + order
    }
  }

  // LIMIT + OFFSET
  const offset = Math.max(0, (page - 1) * pageSize)
  const limit = Math.min(Math.max(1, pageSize), 1000)
  sql += ' LIMIT ' + limit + ' OFFSET ' + offset

  try {
    const [rows, fields] = await pool.query(sql)
    const columns = Array.isArray(fields) ? fields.map(f => f.name) : []
    const list = Array.isArray(rows) ? rows : []

    // 获取总行数
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM `' + table.replace(/`/g, '') + '`',
    )
    const total = (countRows && countRows[0] && countRows[0].cnt) || 0

    return {
      ok: true,
      columns,
      rows: list.map(jsonSafe),
      page,
      pageSize: limit,
      total: Number(total),
      totalPages: Math.ceil(Number(total) / limit),
    }
  } catch (err) {
    return { ok: false, error: '查询失败: ' + (err.message || String(err)) }
  }
}

export default {
  buildPrompt,
  parseLlmResult,
  text2sql,
  getSchemaInfo,
  getTablePreview,
}