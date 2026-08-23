/**
 * dsh-plugin-nlbi 宿主插件（单一行挂载，见 cordis.patch.yml）。
 * 基于 dsh-mysql (v0.1.4) 二次开发：连接管理 + Text2SQL + BI 图表 + 报表。
 *
 * 职责：
 *  1. 连接管理：$DSH_HOME/storages/dsh-plugin-nlbi/connections.json 持久化多套
 *     MySQL 连接（名称/host/port/user/password/默认库/表白名单/写权限），
 *     按连接懒创建 mysql2 连接池（配置变更自动重建，dispose 全部回收）；
 *  2. 全局注册模型工具（所有 Agent 预设可见）：
 *     - mysql_query    只读查询（SELECT/SHOW/DESCRIBE/EXPLAIN，单语句，
 *                      白名单表校验，SELECT 自动注入 MAX_EXECUTION_TIME 提示，
 *                      最多返回 MAX_ROWS 行）；
 *     - mysql_tables   查看当前连接可读表的结构（information_schema）；
 *     - mysql_execute  写操作（仅 INSERT/UPDATE/DELETE），连接必须显式开启
 *                      allowWrite（默认关闭），同样受白名单约束；
 *     - nl_query       ★ Text2SQL：自然语言 → SQL 生成 → 校验 → 护栏执行 →
 *                      结果表格 + 图表规格（强制只读）
 *     - sql_to_chart   ★ 对查询结果生成 BI 图表规格（chartSpec）
 *  3. 会话级连接选择：sessionId → connectionId 映射，由 Client 输入栏按钮
 *     经 Typert RPC 切换；工具执行时用 exec.agent.id 解析当前连接；
 *  4. systemPrompt 动态 section：每次提示词装配时注入「当前连接 + 可读表」+
 *     Text2SQL 使用指引，所有预设的模型无需任何预设改动即可感知当前数据库；
 *  5. 提供 `mysql` 服务（Typert 网关）：连接 CRUD、测试、选择、表列表 +
 *     ★ schemaTree / tablePreview（侧栏数据面板）
 *     ★ nlQuery（前端直接调用 Text2SQL）
 *     ★ saveReport / listReports / deleteReport（BI 报表收藏）
 *
 * 只通过 ctx API 使用宿主能力，不 import 任何 @deepseek-ai 运行时包，
 * 因此与宿主进程共享同一套运行时实例。
 */

import { createPool } from 'mysql2/promise'
import { promises as fsp, appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  MAX_ROWS,
  stripSqlComments,
  classifyStatement,
  checkTableAllowlist,
  hasMultipleStatements,
  jsonSafe,
  normalizeTables,
} from './shared.js'
import { validateAndPrepare } from './sqlsafe.js'
import { text2sql, getSchemaInfo, getTablePreview } from './text2sql.js'
import { suggestChartForResult } from './chart.js'

export const name = 'dsh-plugin-nlbi'
export const inject = ['tools']

/** SELECT 注入的执行超时提示（MySQL 5.7.8+ 支持，秒级会被驱动换算为毫秒）。 */
const MAX_EXECUTION_MS = 15000
const POOL_CONNECTION_LIMIT = 3
const CONNECT_TIMEOUT_MS = 10000

/**
 * 递归保证对象 JSON 安全（Typert 网关边界要求）：
 *  - Date/BigInt/Buffer → 基础类型（复用 jsonSafe）
 *  - NaN/Infinity/-Infinity → null（网关 assertJsonValue 会拒绝非有限数字）
 *  - 深层递归处理，确保永不出非 JSON 安全值
 */
function sanitizeForBoundary(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('base64')
  if (Array.isArray(value)) return value.map(sanitizeForBoundary)
  if (typeof value === 'object') {
    // try/catch：某些对象（如 mysql2 RowDataPacket）getPrototypeOf 可能抛错
    let proto = null
    try { proto = Object.getPrototypeOf(value) } catch (err) { proto = Object.prototype }
    // 非 plain object（RowDataPacket / marshalling 包装等）：提取自有属性再递归
    if (proto !== null && proto !== Object.prototype) {
      try {
        return sanitizeForBoundary(Object.assign({}, value))
      } catch (err) {
        // 某些不可枚举对象直接退回浅拷贝
        const out = {}
        try { for (const k of Object.getOwnPropertyNames(value)) out[k] = value[k] } catch (e) {}
        return out
      }
    }
    const out = {}
    for (const key of Object.keys(value)) {
      try { out[key] = sanitizeForBoundary(value[key]) } catch (err) { out[key] = null }
    }
    return out
  }
  return value
}

/** 运行时全局 ctx 引用（apply 时赋值），供 RPC nlQuery 调用 model 服务。 */
let activeCtx = null

// ── 配置存储（$DSH_HOME/storages/dsh-plugin-nlbi/connections.json）────────

function storageDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-plugin-nlbi')
}

function storageFile() {
  return path.join(storageDir(), 'connections.json')
}

/** 启动诊断日志（$DSH_HOME/storages/dsh-plugin-nlbi/boot.log），尽力而为。 */
function bootLog(line) {
  try {
    mkdirSync(storageDir(), { recursive: true })
    appendFileSync(path.join(storageDir(), 'boot.log'), new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch (err) { /* 诊断日志失败不影响插件 */ }
}

/** Host 是唯一写入方：内存缓存作为权威快照（section 文本提供器要求同步读取）。 */
let cachedConfigs = { connections: [] }
let loadedPromise = null

async function loadConfigsFromDisk() {
  try {
    const text = await fsp.readFile(storageFile(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.connections)) {
      return { connections: parsed.connections.map(normalizeConnection).filter((c) => c.name) }
    }
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND')) return { connections: [] }
    bootLog('load failed: ' + String((err && err.message) || err))
    console.error('[dsh-plugin-nlbi] 读取连接配置失败', (err && err.message) || err)
  }
  return { connections: [] }
}

function ensureLoaded() {
  if (loadedPromise === null) {
    loadedPromise = loadConfigsFromDisk()
      .then((configs) => { cachedConfigs = configs })
      .catch((err) => {
        console.error('[dsh-plugin-nlbi] 初始化连接配置失败', (err && err.message) || err)
        cachedConfigs = { connections: [] }
      })
  }
  // loadedPromise 只作为一次性「已加载」门闩；每次调用都解析到当前 cachedConfigs，
  // 保证保存/删除后所有读取路径立即可见最新快照（修复旧版返回启动时旧快照的问题）。
  return loadedPromise.then(() => cachedConfigs)
}

async function persistConfigs(configs) {
  const previous = cachedConfigs
  cachedConfigs = configs
  try {
    await fsp.mkdir(storageDir(), { recursive: true })
    const file = storageFile()
    const tmp = file + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(configs, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    cachedConfigs = previous // 写盘失败：内存回滚，与磁盘保持一致
    console.error('[dsh-plugin-nlbi] 保存连接配置失败', (err && err.message) || err)
    throw err
  }
}

// ── 连接配置归一化与对外视图 ───────────────────────────────────────────────

function normalizeConnection(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 64) : ''
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : '',
    host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim().slice(0, 255) : '127.0.0.1',
    port: Number.isFinite(Number(raw.port)) && Number(raw.port) > 0 ? Math.floor(Number(raw.port)) : 3306,
    user: typeof raw.user === 'string' ? raw.user.slice(0, 64) : 'root',
    password: typeof raw.password === 'string' ? raw.password : '',
    database: typeof raw.database === 'string' ? raw.database.trim().slice(0, 128) : '',
    tables: normalizeTables(raw.tables),
    allowWrite: raw.allowWrite === true,
  }
}

/** 对外安全视图：绝不回传密码，只回 hasPassword。 */
function publicView(c) {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    user: c.user,
    database: c.database,
    tables: c.tables.slice(),
    allowWrite: c.allowWrite,
    hasPassword: c.password.length > 0,
  }
}

// ── 连接池管理 ─────────────────────────────────────────────────────────────

const pools = new Map() // connectionId -> { fingerprint, pool }

function fingerprint(c) {
  return [c.host, String(c.port), c.user, c.password, c.database].join('\u0000')
}

async function getPool(configs, connId) {
  const cfg = configs.connections.find((c) => c.id === connId)
  if (cfg === undefined) return { error: '连接不存在：' + connId }
  const fp = fingerprint(cfg)
  const hit = pools.get(connId)
  if (hit !== undefined && hit.fingerprint === fp) return { pool: hit.pool, config: cfg }
  if (hit !== undefined) {
    pools.delete(connId)
    hit.pool.end().catch(() => {})
  }
  const pool = createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    waitForConnections: true,
    connectionLimit: POOL_CONNECTION_LIMIT,
    enableKeepAlive: true,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  })
  pools.set(connId, { fingerprint: fp, pool })
  return { pool, config: cfg }
}

async function dropPool(connId) {
  const hit = pools.get(connId)
  pools.delete(connId)
  if (hit !== undefined) await hit.pool.end().catch(() => {})
}

// ── 会话级连接选择 ─────────────────────────────────────────────────────────

const sessionSelection = new Map() // sessionId -> connectionId

function resolveSelection(configs, sessionId) {
  let connection = null
  if (typeof sessionId === 'string') {
    const connId = sessionSelection.get(sessionId)
    connection = configs.connections.find((c) => c.id === connId) || null
  }
  if (connection === null && configs.connections.length === 1) {
    // 只配置了一个连接：自动选中（并记录，让 UI 与工具行为一致）
    connection = configs.connections[0]
    if (typeof sessionId === 'string') sessionSelection.set(sessionId, connection.id)
  }
  return connection
}

// ── 查询执行 ───────────────────────────────────────────────────────────────

/** 为 SELECT 注入 MAX_EXECUTION_TIME 提示，防止无 LIMIT 的长查询拖垮连接。 */
function prependExecutionHint(sql, kind) {
  if (kind !== 'read') return sql
  if (/\/\*\+/i.test(sql)) return sql // 已自带优化器提示时不重复注入
  return sql.replace(/^(\s*)(select)/i, '$1$2 /*+ MAX_EXECUTION_TIME(' + MAX_EXECUTION_MS + ') */')
}

async function runQuery(pool, sql, params) {
  const [rows, fields] = await pool.query(sql, Array.isArray(params) ? params : [])
  const columns = Array.isArray(fields) ? fields.map((f) => f.name) : []
  const list = Array.isArray(rows) ? rows : []
  const truncated = list.length > MAX_ROWS
  const slice = truncated ? list.slice(0, MAX_ROWS) : list
  return {
    columns,
    rowCount: slice.length,
    totalRowCount: list.length,
    truncated,
    rows: slice.map(jsonSafe),
  }
}

/** 工具执行公共前置：解析会话 → 选中连接 → 连接池。 */
async function execCtx(exec) {
  const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : undefined
  const configs = await ensureLoaded()
  const connection = resolveSelection(configs, sessionId)
  if (connection === null) {
    if (configs.connections.length === 0) {
      return { error: '尚未配置任何 MySQL 连接：请打开 设置 → MySQL 数据库 添加连接。' }
    }
    return { error: '当前会话尚未选择数据库连接：请在输入栏点击 🐬 数据库按钮选择一个连接后再试。' }
  }
  const got = await getPool(configs, connection.id)
  if (got.error !== undefined) return { error: got.error }
  return { sessionId, configs, connection, pool: got.pool }
}

// ── 模型工具 ───────────────────────────────────────────────────────────────

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function toolError(error) {
  return { ok: false, error: String(error) }
}

const mysqlQueryTool = {
  name: 'mysql_query',
  description:
    '对当前选中 MySQL 连接执行一条只读 SQL（仅 SELECT/SHOW/DESCRIBE/EXPLAIN，单条语句），受表白名单限制（空名单=不限制）。' +
    '返回 { columns, rowCount, totalRowCount, truncated, rows }，最多 ' + MAX_ROWS + ' 行。查询前先用 mysql_tables 确认结构；写操作用 mysql_execute。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      sql: { type: 'string', description: '一条 SELECT/SHOW/DESCRIBE/EXPLAIN SQL 语句。' },
      params: { type: 'array', description: '可选的位置参数，对应 SQL 中的 ? 占位符。' },
    },
    required: ['sql'],
  },
  output: OUTPUT,
  timeoutMs: 30000,
  async execute(args, exec) {
    const sql = stripSqlComments(typeof (args && args.sql) === 'string' ? args.sql : '').trim()
    if (!sql) return toolError('SQL 为空')
    const base = await execCtx(exec)
    if (base.error !== undefined) return toolError(base.error)
    const kind = classifyStatement(sql)
    if (kind !== 'read') {
      return toolError('mysql_query 只允许 SELECT/SHOW/DESCRIBE/EXPLAIN 语句；写入请使用 mysql_execute')
    }
    if (hasMultipleStatements(sql)) return toolError('不允许一次执行多条语句')
    const allow = checkTableAllowlist(sql, base.connection.tables)
    if (!allow.ok) return toolError('查询涉及白名单外的表：' + allow.denied.join(', '))
    try {
      const result = await runQuery(base.pool, prependExecutionHint(sql, kind), args && args.params)
      return { ok: true, connection: base.connection.name, ...result }
    } catch (err) {
      return toolError('查询失败：' + String((err && err.message) || err))
    }
  },
}

const mysqlTablesTool = {
  name: 'mysql_tables',
  description:
    '列出当前选中 MySQL 连接的可读表结构（表名/列名/类型/可否空/键/注释），受白名单限制；table 参数可模糊过滤，缺省返回全部。' +
    '写 SQL 前先用它确认字段名与类型，避免凭空猜测。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      table: { type: 'string', description: '可选：按表名模糊过滤（不区分大小写）。' },
    },
  },
  output: OUTPUT,
  timeoutMs: 15000,
  async execute(args, exec) {
    const base = await execCtx(exec)
    if (base.error !== undefined) return toolError(base.error)
    const filter = typeof (args && args.table) === 'string' ? args.table.trim().toLowerCase() : ''
    const allowed = base.connection.tables
    try {
      const [rows] = await base.pool.query(
        'SELECT table_name AS table_name, column_name AS column_name, column_type AS column_type, ' +
        'is_nullable AS is_nullable, column_key AS column_key, column_comment AS column_comment ' +
        'FROM information_schema.columns WHERE table_schema = DATABASE() ' +
        'ORDER BY table_name, ordinal_position',
      )
      const byTable = new Map()
      for (const r of rows) {
        const t = String(r.table_name).toLowerCase()
        if (allowed.length > 0 && !allowed.includes(t)) continue
        if (filter && !t.includes(filter)) continue
        if (!byTable.has(t)) byTable.set(t, [])
        byTable.get(t).push({
          column: String(r.column_name),
          type: String(r.column_type),
          nullable: String(r.is_nullable).toUpperCase() === 'YES',
          key: r.column_key ? String(r.column_key) : '',
          comment: r.column_comment ? String(r.column_comment) : '',
        })
      }
      const tables = [...byTable.keys()].sort().map((t) => ({ name: t, columns: byTable.get(t) }))
      return { ok: true, connection: base.connection.name, tables }
    } catch (err) {
      return toolError('读取表结构失败：' + String((err && err.message) || err))
    }
  },
}

const mysqlExecuteTool = {
  name: 'mysql_execute',
  description:
    '对当前选中 MySQL 连接执行一条写 SQL（仅 INSERT/UPDATE/DELETE，单条语句）。仅当连接在设置中显式开启「允许写操作」时可用（默认关闭）；' +
    '表名受白名单限制；DDL 与多语句一律拒绝。返回 { affectedRows, insertId }。写前先查库确认目标数据，值用 ? 占位符传参。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      sql: { type: 'string', description: '一条 INSERT/UPDATE/DELETE SQL 语句。' },
      params: { type: 'array', description: '可选的位置参数，对应 SQL 中的 ? 占位符。' },
    },
    required: ['sql'],
  },
  output: OUTPUT,
  timeoutMs: 30000,
  async execute(args, exec) {
    const sql = stripSqlComments(typeof (args && args.sql) === 'string' ? args.sql : '').trim()
    if (!sql) return toolError('SQL 为空')
    const base = await execCtx(exec)
    if (base.error !== undefined) return toolError(base.error)
    if (base.connection.allowWrite !== true) {
      return toolError('当前连接未开启写权限（allowWrite=false）：请在 设置 → MySQL 数据库 中为该连接开启「允许写操作」')
    }
    const kind = classifyStatement(sql)
    if (kind !== 'write-dml') {
      return toolError('mysql_execute 只允许 INSERT/UPDATE/DELETE 语句；DDL 与其它写操作一律拒绝')
    }
    if (hasMultipleStatements(sql)) return toolError('不允许一次执行多条语句')
    const allow = checkTableAllowlist(sql, base.connection.tables)
    if (!allow.ok) return toolError('写入涉及白名单外的表：' + allow.denied.join(', '))
    try {
      const [result] = await base.pool.execute(sql, Array.isArray(args && args.params) ? args.params : [])
      return {
        ok: true,
        connection: base.connection.name,
        affectedRows: (result && result.affectedRows) || 0,
        insertId: (result && result.insertId) || 0,
      }
    } catch (err) {
      return toolError('写入失败：' + String((err && err.message) || err))
    }
  },
}

// ── ★ 新增：nl_query — Text2SQL 自然语言查库 ──────────────────────────────

const nlQueryTool = {
  name: 'nl_query',
  description:
    '用自然语言描述的数据查询需求，自动生成 SQL 并执行，返回表格结果 + 图表建议。' +
    '支持筛选、聚合、排序、多表关联。仅执行只读查询（SELECT/UNION 等），写操作走 mysql_execute。' +
    '示例：查询上个月每天的订单量、各分类商品数量、金额最高的前10个用户。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      question: { type: 'string', description: '自然语言查询问题，例如"上个月每天的订单量"或"用户表结构"。' },
    },
    required: ['question'],
  },
  output: OUTPUT,
  timeoutMs: 60000,
  async execute(args, exec) {
    // execute 在 apply 时被包装注入 ctx，见下方注册段
    return toolError('nl_query 尚未初始化')
  },
}

// ── ★ 新增：sql_to_chart — 对查询结果生成 BI 图表规格 ─────────────────────

const sqlToChartTool = {
  name: 'sql_to_chart',
  description:
    '对 mysql_query 或 nl_query 的查询结果生成 BI 图表规格（chartSpec）。' +
    '输入 columns 和 rows，输出 { type, xField, yFields, stats } 供前端渲染。' +
    '支持柱状/折线/饼图/统计卡，基于列类型自动推断。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      columns: { type: 'array', items: { type: 'string' }, description: '列名数组' },
      rows: { type: 'array', items: { type: 'object' }, description: '数据行数组' },
      title: { type: 'string', description: '图表标题（可选）' },
    },
    required: ['columns', 'rows'],
  },
  output: OUTPUT,
  timeoutMs: 10000,
  async execute(args, exec) {
    const columns = Array.isArray(args && args.columns) ? args.columns : []
    const rows = Array.isArray(args && args.rows) ? args.rows : []
    const title = typeof (args && args.title) === 'string' ? args.title : '查询结果'

    if (columns.length === 0) return toolError('列信息不能为空')

    const chart = suggestChartForResult({ columns, rows }, title)
    if (!chart.ok) return toolError(chart.error)

    return { ok: true, ...chart.spec }
  },
}

// ── Typert 服务方法（Client 经网关调用）───────────────────────────────────

async function listConnections() {
  const configs = await ensureLoaded()
  return { ok: true, connections: configs.connections.map(publicView) }
}

async function getSelection(args) {
  const configs = await ensureLoaded()
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined
  const connection = resolveSelection(configs, sessionId)
  return {
    ok: true,
    connectionId: connection ? connection.id : null,
    connections: configs.connections.map(publicView),
  }
}

async function selectConnection(args) {
  const configs = await ensureLoaded()
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined
  const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: '缺少会话标识' }
  const conn = configs.connections.find((c) => c.id === connectionId)
  if (conn === undefined) return { ok: false, error: '连接不存在：' + connectionId }
  sessionSelection.set(sessionId, connectionId)
  return { ok: true, connectionId, name: conn.name }
}

async function saveConnection(args) {
  const input = args && typeof args.connection === 'object' && !Array.isArray(args.connection) ? args.connection : null
  if (input === null) return { ok: false, error: '缺少连接配置' }
  const next = normalizeConnection(input)
  if (!next.name) return { ok: false, error: '连接名称不能为空' }
  const configs = await ensureLoaded()
  const existing = next.id ? configs.connections.find((c) => c.id === next.id) : undefined
  let id = next.id
  if (id === '') {
    id = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }
  next.id = id
  if (existing !== undefined && (input.password === undefined || input.password === null || input.password === '')) {
    // 编辑时密码留空 = 保留原密码
    next.password = existing.password
  }
  const list = configs.connections.filter((c) => c.id !== id)
  list.push(next)
  try {
    await persistConfigs({ connections: list })
  } catch (err) {
    return { ok: false, error: '保存失败：' + String((err && err.message) || err) }
  }
  // 配置变更：丢弃旧池，下次使用时按新配置重建
  await dropPool(id)
  return { ok: true, connection: publicView(next) }
}

async function deleteConnection(args) {
  const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
  const configs = await ensureLoaded()
  const list = configs.connections.filter((c) => c.id !== connectionId)
  if (list.length === configs.connections.length) return { ok: false, error: '连接不存在：' + connectionId }
  try {
    await persistConfigs({ connections: list })
  } catch (err) {
    return { ok: false, error: '删除失败：' + String((err && err.message) || err) }
  }
  await dropPool(connectionId)
  for (const [sid, cid] of sessionSelection) {
    if (cid === connectionId) sessionSelection.delete(sid)
  }
  return { ok: true }
}

async function testConnection(args) {
  const configs = await ensureLoaded()
  const input = args && typeof args.connection === 'object' && !Array.isArray(args.connection) ? args.connection : null
  let cfg
  if (input !== null && input.name !== undefined) {
    // 测试未保存的表单草稿
    cfg = normalizeConnection(input)
    if (cfg.id && (input.password === undefined || input.password === null || input.password === '')) {
      const existing = configs.connections.find((c) => c.id === cfg.id)
      if (existing !== undefined) cfg.password = existing.password
    }
  } else {
    const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
    const existing = configs.connections.find((c) => c.id === connectionId)
    if (existing === undefined) return { ok: false, error: '连接不存在：' + connectionId }
    cfg = existing
  }
  let pool = null
  const started = Date.now()
  try {
    pool = createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database || undefined,
      connectTimeout: CONNECT_TIMEOUT_MS,
      connectionLimit: 1,
      multipleStatements: false,
    })
    const [rows] = await pool.query('SELECT 1 AS ok')
    return { ok: true, latencyMs: Date.now() - started, reached: !!(rows && rows[0]) }
  } catch (err) {
    return { ok: false, error: '连接失败：' + String((err && err.message) || err) }
  } finally {
    if (pool !== null) await pool.end().catch(() => {})
  }
}

async function listTables(args) {
  const configs = await ensureLoaded()
  const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
  const cfg = configs.connections.find((c) => c.id === connectionId)
  if (cfg === undefined) return { ok: false, error: '连接不存在：' + connectionId }
  const got = await getPool(configs, connectionId)
  if (got.error !== undefined) return { ok: false, error: got.error }
  try {
    const [rows] = await got.pool.query(
      'SELECT table_name AS table_name, table_comment AS table_comment ' +
        'FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
    )
    const allowed = cfg.tables
    const tables = rows
      .filter((r) => allowed.length === 0 || allowed.includes(String(r.table_name).toLowerCase()))
      .map((r) => ({ name: String(r.table_name), comment: r.table_comment ? String(r.table_comment) : '' }))
    return { ok: true, tables }
  } catch (err) {
    return { ok: false, error: '读取表列表失败：' + String((err && err.message) || err) }
  }
}

// ── ★ 新增：BI 服务 ────────────────────────────────────────────────────────

/**
 * 前端直接调用 Text2SQL（不走 Agent 工具链）。
 * 用于侧栏/内联查询输入。
 */
async function nlQuery(args) {
  const configs = await ensureLoaded()
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined
  const connection = resolveSelection(configs, sessionId)
  if (connection === null) {
    return { ok: false, error: '当前会话尚未选择数据库连接' }
  }
  const got = await getPool(configs, connection.id)
  if (got.error !== undefined) return { ok: false, error: got.error }

  const question = args && typeof args.question === 'string' ? args.question.trim() : ''
  if (!question) return { ok: false, error: '查询问题不能为空' }

  try {
    // ★ 通过运行时闭包持有 ctx（apply 时赋值），使前端 RPC 也可调用 Text2SQL
    const result = await text2sql(
      activeCtx,
      question,
      connection,
      got.pool,
      { allowlist: connection.tables, maxRows: MAX_ROWS },
    )
    if (!result.ok) {
      // ★ 错误路径也必须 sanitize（sql/explain 可能 undefined，网关 assertJsonValue 会拒绝 undefined）
      return sanitizeForBoundary({ ok: false, error: result.error, sql: result.sql || null, explain: result.explain || null })
    }
    const chart = suggestChartForResult(result.result, question)
    // ★ 边界安全清洗：Chart/结果若含 NaN/Date 等非 JSON 安全值会被 Typert 网关拒绝
    const payload = {
      ok: true,
      connection: connection.name,
      sql: result.sql,
      explain: result.explain,
      result: result.result,
      chart: chart.ok ? chart.spec : null,
    }
    return sanitizeForBoundary(payload)
  } catch (err) {
    return { ok: false, error: 'Text2SQL 查询失败：' + String((err && err.message) || err) }
  }
}

/**
 * 侧栏 Schema 导航树（连接 → 库 → 表 → 列）。
 */
async function schemaTree(args) {
  const configs = await ensureLoaded()
  const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
  const cfg = configs.connections.find((c) => c.id === connectionId)
  if (cfg === undefined) return { ok: false, error: '连接不存在：' + connectionId }
  const got = await getPool(configs, connectionId)
  if (got.error !== undefined) return { ok: false, error: got.error }
  const schemaResult = await getSchemaInfo(got.pool, cfg.tables)
  if (!schemaResult.ok) return { ok: false, error: schemaResult.error }
  return sanitizeForBoundary({ ok: true, database: cfg.database, tables: schemaResult.schema })
}

/**
 * 表数据网格预览（分页/排序/过滤）。
 */
async function tablePreview(args) {
  const configs = await ensureLoaded()
  const connectionId = args && typeof args.connectionId === 'string' ? args.connectionId : ''
  const cfg = configs.connections.find((c) => c.id === connectionId)
  if (cfg === undefined) return { ok: false, error: '连接不存在：' + connectionId }
  const got = await getPool(configs, connectionId)
  if (got.error !== undefined) return { ok: false, error: got.error }

  const table = args && typeof args.table === 'string' ? args.table : ''
  const previewResult = await getTablePreview(got.pool, table, {
    page: args && typeof args.page === 'number' ? args.page : 1,
    pageSize: args && typeof args.pageSize === 'number' ? args.pageSize : 100,
    sortColumn: args && typeof args.sortColumn === 'string' ? args.sortColumn : undefined,
    sortOrder: args && typeof args.sortOrder === 'string' ? args.sortOrder : 'ASC',
    where: args && typeof args.where === 'string' ? args.where : undefined,
    allowlist: cfg.tables,
  })
  // ★ 边界安全清洗：rows 可能含 Date 等非 JSON 安全值
  return sanitizeForBoundary(previewResult)
}

// ── ★ 新增：报表收藏 ────────────────────────────────────────────────────────

function reportsStorageFile() {
  return path.join(storageDir(), 'reports.json')
}

async function loadReports() {
  try {
    const text = await fsp.readFile(reportsStorageFile(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && Array.isArray(parsed.reports)) return parsed.reports
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND')) return []
  }
  return []
}

async function persistReports(reports) {
  const file = reportsStorageFile()
  const tmp = file + '.tmp'
  await fsp.mkdir(storageDir(), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify({ reports }, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

async function listReports() {
  const reports = await loadReports()
  return { ok: true, reports }
}

async function saveReport(args) {
  const input = args && typeof args.report === 'object' && !Array.isArray(args.report) ? args.report : null
  if (input === null) return { ok: false, error: '缺少报表数据' }
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 128) : ''
  const question = typeof input.question === 'string' ? input.question.trim().slice(0, 512) : ''
  const sql = typeof input.sql === 'string' ? input.sql.trim() : ''
  if (!name || !sql) return { ok: false, error: '报表名称与 SQL 不能为空' }
  // 重放安全校验：只能收藏已通过的只读 SQL
  const validation = validateAndPrepare(sql, { allowlist: [], maxRows: MAX_ROWS })
  if (!validation.ok) return { ok: false, error: '报表 SQL 未通过安全校验：' + validation.error }

  const reports = await loadReports()
  const id = (input.id && typeof input.id === 'string') ? input.id : ('r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
  const existingIdx = reports.findIndex((r) => r.id === id)
  const report = {
    id,
    name,
    question,
    connectionId: typeof input.connectionId === 'string' ? input.connectionId : '',
    sql,
    chart: input.chart !== undefined ? input.chart : null,
    updatedAt: new Date().toISOString(),
  }
  if (existingIdx >= 0) {
    reports[existingIdx] = { ...reports[existingIdx], ...report }
  } else {
    report.createdAt = new Date().toISOString()
    reports.push(report)
  }
  await persistReports(reports)
  return { ok: true, report }
}

async function deleteReport(args) {
  const id = args && typeof args.reportId === 'string' ? args.reportId : ''
  const reports = await loadReports()
  const next = reports.filter((r) => r.id !== id)
  if (next.length === reports.length) return { ok: false, error: '报表不存在' }
  await persistReports(next)
  return { ok: true }
}

async function rerunReport(args) {
  const id = args && typeof args.reportId === 'string' ? args.reportId : ''
  const reports = await loadReports()
  const report = reports.find((r) => r.id === id)
  if (!report) return { ok: false, error: '报表不存在' }

  const configs = await ensureLoaded()
  const connection = configs.connections.find((c) => c.id === report.connectionId)
  if (!connection) return { ok: false, error: '报表关联的连接不存在或已被删除' }
  const got = await getPool(configs, connection.id)
  if (got.error !== undefined) return { ok: false, error: got.error }

  const validation = validateAndPrepare(report.sql, { allowlist: connection.tables, maxRows: MAX_ROWS })
  if (!validation.ok) return { ok: false, error: '报表 SQL 未通过安全校验：' + validation.error }

  try {
    const [rows, fields] = await got.pool.query(validation.safeSql)
    const columns = Array.isArray(fields) ? fields.map((f) => f.name) : []
    const list = Array.isArray(rows) ? rows : []
    const truncated = list.length > MAX_ROWS
    const result = {
      columns,
      rowCount: Math.min(list.length, MAX_ROWS),
      totalRowCount: list.length,
      truncated,
      rows: list.slice(0, MAX_ROWS).map(jsonSafe),
    }
    const chart = report.chart || (suggestChartForResult(result, report.name).ok ? suggestChartForResult(result, report.name).spec : null)
    // ★ 边界安全清洗：图表/结果可能含 NaN/Date
    return sanitizeForBoundary({ ok: true, sql: validation.safeSql, result, chart })
  } catch (err) {
    return { ok: false, error: '报表执行失败：' + String((err && err.message) || err) }
  }
}

const service = {
  listConnections,
  getSelection,
  selectConnection,
  saveConnection,
  deleteConnection,
  testConnection,
  listTables,
  nlQuery,
  schemaTree,
  tablePreview,
  listReports,
  saveReport,
  deleteReport,
  rerunReport,
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

export function apply(ctx) {
  bootLog('apply start; storage file: ' + storageFile())
  activeCtx = ctx // ★ 保存全局 ctx 供 RPC nlQuery 使用
  ensureLoaded() // 启动即加载（systemPrompt section 提供器同步读取内存缓存）
  ensureLoaded().then((c) => bootLog('configs loaded: ' + c.connections.length)).catch(() => {})

  // 全局工具注册：所有 Agent 预设的会话都可见。
  // 分段防护：任何一段失败只记录日志，不拖垮其余注册。
  try {
    ctx.tools.register(mysqlQueryTool)
    ctx.tools.register(mysqlTablesTool)
    ctx.tools.register(mysqlExecuteTool)
    bootLog('tools registered: mysql_query, mysql_tables, mysql_execute')
  } catch (err) {
    bootLog('tools register FAILED: ' + String((err && err.message) || err))
    console.error('[dsh-plugin-nlbi] tools register failed', err)
  }

  // ★ 注册 Text2SQL 与 BI 工具
  try {
    // 将 ctx 注入 nlQueryTool 的 execute 闭包
    const nlQueryToolWithCtx = { ...nlQueryTool }
    const origExecute = nlQueryToolWithCtx.execute
    nlQueryToolWithCtx.execute = async (args, exec) => {
      const question = args && typeof args.question === 'string' ? args.question.trim() : ''
      if (!question) return toolError('查询问题不能为空')
      const base = await execCtx(exec)
      if (base.error !== undefined) return toolError(base.error)
      try {
        const result = await text2sql(ctx, question, base.connection, base.pool, {
          allowlist: base.connection.tables,
          maxRows: MAX_ROWS,
        })
        if (!result.ok) {
          return { ok: false, error: result.error, sql: result.sql || null, explain: result.explain || null }
        }
        const chart = suggestChartForResult(result.result, question)
        return {
          ok: true,
          connection: base.connection.name,
          sql: result.sql,
          explain: result.explain,
          result: result.result,
          chart: chart.ok ? chart.spec : null,
        }
      } catch (err) {
        return toolError('Text2SQL 查询失败：' + String((err && err.message) || err))
      }
    }
    ctx.tools.register(nlQueryToolWithCtx)
    ctx.tools.register(sqlToChartTool)
    bootLog('tools registered: nl_query, sql_to_chart')
  } catch (err) {
    bootLog('nl_query/sql_to_chart register FAILED: ' + String((err && err.message) || err))
    console.error('[dsh-plugin-nlbi] nl_query/sql_to_chart register failed', err)
  }

  // 动态 MySQL 上下文：走 systemPrompt.context（对话尾部的运行时上下文快照），
  // 不写入系统提示词前缀 —— 切换连接/编辑配置不会让该会话的前缀缓存失效。
  // ★ 已扩展：注入 Text2SQL 工具指引，让模型优先使用 nl_query 回答问题。
  try {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
      systemPrompt.context({
        name: 'dsh-plugin-nlbi-context',
        order: 200,
        text: (assemble) => {
          const agent = assemble && assemble.agent
          const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
          if (cachedConfigs.connections.length === 0) return ''
          const connection = resolveSelection(cachedConfigs, sessionId)
          if (connection === null) {
            return 'MySQL 数据库：当前会话尚未选择连接。需要查库时，请提醒用户在输入栏点击 🐬 数据库按钮选择一个连接。'
          }
          return [
            'MySQL 数据库上下文（用户已在输入栏选定连接）：',
            '- 连接：' + connection.name + '（' + connection.host + ':' + connection.port + '/' + (connection.database || '未指定默认库') + '）',
            '- 可读表：' + (connection.tables.length > 0 ? connection.tables.join('、') : '全部（未配置白名单）'),
            '- 工具：',
            '  · nl_query 自然语言查库（用户用日常语言问数据时优先使用它，自动生成 SQL 并执行，返回表格+图表）',
            '  · mysql_query 只读查询（SELECT/SHOW/DESCRIBE/EXPLAIN，单条语句，最多返回 ' + MAX_ROWS + ' 行）',
            '  · mysql_tables 查看表结构',
            '  · sql_to_chart 对查询结果生成图表规格',
            '  · mysql_execute 写操作（仅 INSERT/UPDATE/DELETE，需连接开启写权限）',
            '- 表名受白名单限制；nl_query 强制只读，绝不会写库。',
          ].join('\n')
        },
      })
      bootLog('systemPrompt context registered')
    }
  } catch (err) {
    bootLog('systemPrompt context FAILED: ' + String((err && err.message) || err))
    console.error('[dsh-plugin-nlbi] systemPrompt context failed', err)
  }

  // 会话销毁时清理选择映射
  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (agent && typeof agent.id === 'string') sessionSelection.delete(agent.id)
  })

  // Typert 服务提供（网关经 ./typert 清单暴露给客户端）
  try {
    Object.defineProperty(service, 'typertRemote', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: { service, serviceKey: 'mysql', namespace: 'mysql' },
    })
    ctx.provide('mysql', service)
    bootLog('service mysql provided')
  } catch (err) {
    bootLog('provide mysql FAILED: ' + String((err && err.message) || err))
    console.error('[dsh-plugin-nlbi] provide mysql failed', err)
  }

  // 回收全部连接池
  ctx.on('dispose', () => {
    for (const hit of pools.values()) hit.pool.end().catch(() => {})
    pools.clear()
  })

  bootLog('apply complete')
  console.log('[dsh-plugin-nlbi] host mounted, connections =', cachedConfigs.connections.length)
}
