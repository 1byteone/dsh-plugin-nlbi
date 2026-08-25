/**
 * dashboard.js — dsh-plugin-nlbi Dashboard 仪表盘引擎
 *
 * 职责：
 *  1. Dashboard CRUD：创建/读取/更新/删除/复制仪表盘
 *  2. Widget 管理：添加/更新/删除/移动组件
 *  3. 布局引擎：12 列网格布局，支持响应式
 *  4. 全局筛选器：Dashboard 级筛选条件，注入到所有 widget 查询
 *  5. Widget 查询执行：并行执行所有 widget 的 SQL 查询
 *  6. 下钻查询：根据维度值构建下钻 SQL
 *  7. 自动刷新配置
 *
 * Storage: $DSH_HOME/storages/dsh-plugin-nlbi/dashboards.json
 *
 * @module dashboard
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { jsonSafe } from './shared.js'

// ── Storage ────────────────────────────────────────────────────────────────

function storageDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-plugin-nlbi')
}

function dashboardsFile() {
  return path.join(storageDir(), 'dashboards.json')
}

let cachedDashboards = null
let loadPromise = null

async function loadFromDisk() {
  try {
    const text = await fsp.readFile(dashboardsFile(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.dashboards)) {
      return { dashboards: parsed.dashboards }
    }
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND')) {
      return { dashboards: [] }
    }
  }
  return { dashboards: [] }
}

function ensureLoaded() {
  if (loadPromise === null) {
    loadPromise = loadFromDisk()
      .then((data) => { cachedDashboards = data })
      .catch(() => { cachedDashboards = { dashboards: [] } })
  }
  return loadPromise.then(() => cachedDashboards)
}

async function persist(data) {
  const previous = cachedDashboards
  cachedDashboards = data
  try {
    await fsp.mkdir(storageDir(), { recursive: true })
    const file = dashboardsFile()
    const tmp = file + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    cachedDashboards = previous
    throw err
  }
}

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

// ── 归一化 ────────────────────────────────────────────────────────────────

function normalizePosition(input) {
  const raw = (input && typeof input === 'object') ? input : {}
  return {
    x: Number.isFinite(Number(raw.x)) ? Math.max(0, Math.floor(Number(raw.x))) : 0,
    y: Number.isFinite(Number(raw.y)) ? Math.max(0, Math.floor(Number(raw.y))) : 0,
    w: Number.isFinite(Number(raw.w)) ? Math.max(1, Math.min(12, Math.floor(Number(raw.w)))) : 4,
    h: Number.isFinite(Number(raw.h)) ? Math.max(1, Math.min(12, Math.floor(Number(raw.h)))) : 3,
  }
}

function normalizeWidget(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '',
    type: ['kpi', 'chart', 'table', 'text'].includes(raw.type) ? raw.type : 'chart',
    title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 128) : '',
    query: typeof raw.query === 'string' ? raw.query.trim() : '',
    chartType: typeof raw.chartType === 'string' ? raw.chartType.trim() : '',
    position: normalizePosition(raw.position),
    refreshInterval: Number.isFinite(Number(raw.refreshInterval)) ? Math.max(0, Number(raw.refreshInterval)) : 0,
    pageSize: Number.isFinite(Number(raw.pageSize)) ? Math.max(1, Math.min(100, Number(raw.pageSize))) : 20,
    drillDown: raw.drillDown && typeof raw.drillDown === 'object' ? {
      dimension: typeof raw.drillDown.dimension === 'string' ? raw.drillDown.dimension : '',
      query: typeof raw.drillDown.query === 'string' ? raw.drillDown.query : '',
    } : null,
    linkedFilters: Array.isArray(raw.linkedFilters) ? raw.linkedFilters.filter(f => typeof f === 'string') : [],
  }
}

function normalizeFilter(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : genId('f'),
    type: ['select', 'multiSelect', 'dateRange', 'text', 'number'].includes(raw.type) ? raw.type : 'select',
    label: typeof raw.label === 'string' ? raw.label.trim().slice(0, 64) : '',
    dimension: typeof raw.dimension === 'string' ? raw.dimension.trim() : '',
    defaultValue: raw.defaultValue !== undefined ? raw.defaultValue : '',
    options: typeof raw.options === 'string' ? raw.options.trim() : '',
  }
}

function normalizeDashboard(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const layout = raw.layout && typeof raw.layout === 'object' ? {
    columns: Number.isFinite(Number(raw.layout.columns)) ? Number(raw.layout.columns) : 12,
    rowHeight: Number.isFinite(Number(raw.layout.rowHeight)) ? Number(raw.layout.rowHeight) : 80,
    gap: Number.isFinite(Number(raw.layout.gap)) ? Number(raw.layout.gap) : 12,
  } : { columns: 12, rowHeight: 80, gap: 12 }

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '',
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 128) : '',
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 512) : '',
    connectionId: typeof raw.connectionId === 'string' ? raw.connectionId.trim() : '',
    layout,
    widgets: Array.isArray(raw.widgets) ? raw.widgets.map(normalizeWidget) : [],
    filters: Array.isArray(raw.filters) ? raw.filters.map(normalizeFilter) : [],
    theme: ['default', 'dark', 'blue', 'green'].includes(raw.theme) ? raw.theme : 'default',
    autoRefresh: Number.isFinite(Number(raw.autoRefresh)) ? Math.max(0, Number(raw.autoRefresh)) : 0,
  }
}

// ── Dashboard CRUD ────────────────────────────────────────────────────────

export async function listDashboards() {
  const data = await ensureLoaded()
  return { ok: true, dashboards: data.dashboards.map(d => ({
    id: d.id,
    name: d.name,
    description: d.description,
    connectionId: d.connectionId,
    widgetCount: (d.widgets || []).length,
    theme: d.theme,
    autoRefresh: d.autoRefresh,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  })) }
}

export async function getDashboard(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: '缺少 Dashboard ID' }
  const data = await ensureLoaded()
  const d = data.dashboards.find(d => d.id === id)
  return d ? { ok: true, dashboard: d } : { ok: false, error: 'Dashboard 不存在' }
}

export async function saveDashboard(input) {
  const next = normalizeDashboard(input)
  if (!next.name) return { ok: false, error: 'Dashboard 名称不能为空' }

  const data = await ensureLoaded()
  const id = next.id || genId('dash')
  next.id = id

  const idx = data.dashboards.findIndex(d => d.id === id)
  const now = new Date().toISOString()
  if (idx >= 0) {
    data.dashboards[idx] = { ...data.dashboards[idx], ...next, updatedAt: now }
  } else {
    next.createdAt = now
    next.updatedAt = now
    data.dashboards.push(next)
  }
  await persist(data)
  return { ok: true, dashboard: next }
}

export async function deleteDashboard(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: '缺少 Dashboard ID' }
  const data = await ensureLoaded()
  const next = data.dashboards.filter(d => d.id !== id)
  if (next.length === data.dashboards.length) return { ok: false, error: 'Dashboard 不存在' }
  data.dashboards = next
  await persist(data)
  return { ok: true }
}

export async function duplicateDashboard(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: '缺少 Dashboard ID' }
  const data = await ensureLoaded()
  const original = data.dashboards.find(d => d.id === id)
  if (!original) return { ok: false, error: 'Dashboard 不存在' }

  const now = new Date().toISOString()
  const copy = {
    ...JSON.parse(JSON.stringify(original)),
    id: genId('dash'),
    name: original.name + '（副本）',
    createdAt: now,
    updatedAt: now,
  }
  // 重新生成 widget ID
  copy.widgets = copy.widgets.map(w => ({ ...w, id: genId('w') }))

  data.dashboards.push(copy)
  await persist(data)
  return { ok: true, dashboard: copy }
}

// ── Widget 管理 ────────────────────────────────────────────────────────────

async function findDashboard(id) {
  const data = await ensureLoaded()
  const idx = data.dashboards.findIndex(d => d.id === id)
  return idx >= 0 ? { data, idx, dashboard: data.dashboards[idx] } : null
}

export async function addWidget(dashboardId, widgetInput) {
  const found = await findDashboard(dashboardId)
  if (!found) return { ok: false, error: 'Dashboard 不存在' }

  const widget = normalizeWidget(widgetInput)
  widget.id = widget.id || genId('w')
  found.dashboard.widgets.push(widget)
  found.dashboard.updatedAt = new Date().toISOString()
  await persist(found.data)
  return { ok: true, widget }
}

export async function updateWidget(dashboardId, widgetId, patch) {
  const found = await findDashboard(dashboardId)
  if (!found) return { ok: false, error: 'Dashboard 不存在' }

  const idx = found.dashboard.widgets.findIndex(w => w.id === widgetId)
  if (idx < 0) return { ok: false, error: 'Widget 不存在' }

  const existing = found.dashboard.widgets[idx]
  const merged = { ...existing }
  if (patch.title !== undefined) merged.title = typeof patch.title === 'string' ? patch.title : merged.title
  if (patch.query !== undefined) merged.query = typeof patch.query === 'string' ? patch.query : merged.query
  if (patch.chartType !== undefined) merged.chartType = typeof patch.chartType === 'string' ? patch.chartType : merged.chartType
  if (patch.type !== undefined) merged.type = ['kpi', 'chart', 'table', 'text'].includes(patch.type) ? patch.type : merged.type
  if (patch.position !== undefined) merged.position = normalizePosition(patch.position)
  if (patch.refreshInterval !== undefined) merged.refreshInterval = Number(patch.refreshInterval) || 0
  if (patch.pageSize !== undefined) merged.pageSize = Number(patch.pageSize) || 20
  if (patch.drillDown !== undefined) merged.drillDown = patch.drillDown
  if (patch.linkedFilters !== undefined) merged.linkedFilters = Array.isArray(patch.linkedFilters) ? patch.linkedFilters : merged.linkedFilters

  found.dashboard.widgets[idx] = merged
  found.dashboard.updatedAt = new Date().toISOString()
  await persist(found.data)
  return { ok: true, widget: merged }
}

export async function removeWidget(dashboardId, widgetId) {
  const found = await findDashboard(dashboardId)
  if (!found) return { ok: false, error: 'Dashboard 不存在' }

  const before = found.dashboard.widgets.length
  found.dashboard.widgets = found.dashboard.widgets.filter(w => w.id !== widgetId)
  if (found.dashboard.widgets.length === before) return { ok: false, error: 'Widget 不存在' }

  found.dashboard.updatedAt = new Date().toISOString()
  await persist(found.data)
  return { ok: true }
}

export async function moveWidget(dashboardId, widgetId, position) {
  const found = await findDashboard(dashboardId)
  if (!found) return { ok: false, error: 'Dashboard 不存在' }

  const widget = found.dashboard.widgets.find(w => w.id === widgetId)
  if (!widget) return { ok: false, error: 'Widget 不存在' }

  widget.position = normalizePosition(position)
  found.dashboard.updatedAt = new Date().toISOString()
  await persist(found.data)
  return { ok: true, widget }
}

// ── 筛选器管理 ────────────────────────────────────────────────────────────

export async function updateFilters(dashboardId, filters) {
  const found = await findDashboard(dashboardId)
  if (!found) return { ok: false, error: 'Dashboard 不存在' }

  found.dashboard.filters = Array.isArray(filters) ? filters.map(normalizeFilter) : []
  found.dashboard.updatedAt = new Date().toISOString()
  await persist(found.data)
  return { ok: true, filters: found.dashboard.filters }
}

// ── 查询执行 ──────────────────────────────────────────────────────────────

/**
 * 为 widget 查询注入全局筛选条件。
 * @param {string} sql - 原始 SQL
 * @param {Array<object>} filters - 筛选器配置
 * @param {object} filterValues - 用户选择的筛选值 { filterId: value }
 * @returns {string} 注入 WHERE 条件后的 SQL
 */
export function injectFilterConditions(sql, filters, filterValues) {
  if (!filters || filters.length === 0 || !filterValues) return sql
  if (!sql || typeof sql !== 'string') return sql

  const conditions = []
  for (const f of filters) {
    const val = filterValues[f.id] || filterValues[f.dimension]
    if (val === undefined || val === null || val === '' || val === 'all') continue
    if (!f.dimension) continue

    const col = '`' + f.dimension.replace(/`/g, '') + '`'

    switch (f.type) {
      case 'select':
        if (typeof val === 'string' && val) conditions.push(col + ' = ' + escapeValue(val))
        break
      case 'multiSelect':
        if (Array.isArray(val) && val.length > 0) {
          conditions.push(col + ' IN (' + val.map(escapeValue).join(', ') + ')')
        } else if (typeof val === 'string' && val) {
          conditions.push(col + ' = ' + escapeValue(val))
        }
        break
      case 'text':
        if (typeof val === 'string' && val.trim()) {
          conditions.push(col + ' LIKE ' + escapeValue('%' + val.trim() + '%'))
        }
        break
      case 'dateRange':
        if (val && typeof val === 'object') {
          if (val.start) conditions.push(col + ' >= ' + escapeValue(val.start))
          if (val.end) conditions.push(col + ' <= ' + escapeValue(val.end))
        } else if (typeof val === 'string' && val) {
          conditions.push(col + ' = ' + escapeValue(val))
        }
        break
      case 'number':
        if (typeof val === 'number' || (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val))) {
          conditions.push(col + ' = ' + Number(val))
        }
        break
    }
  }

  if (conditions.length === 0) return sql

  // 简单注入：在 SQL 末尾（GROUP BY/ORDER BY/LIMIT 之前）添加 WHERE
  // 如果已有 WHERE，追加 AND
  const upperSql = sql.toUpperCase()
  const whereIdx = upperSql.indexOf(' WHERE ')
  if (whereIdx >= 0) {
    // 找到 WHERE 子句结束位置（GROUP BY / ORDER BY / LIMIT / 末尾）
    const afterWhere = sql.slice(whereIdx + 7)
    const insertPos = findClausePosition(afterWhere)
    const before = sql.slice(0, whereIdx + 7 + insertPos)
    const after = sql.slice(whereIdx + 7 + insertPos)
    return before + ' AND ' + conditions.join(' AND ') + after
  } else {
    // 没有 WHERE → 添加 WHERE
    const insertPos = findClausePosition(sql)
    const before = sql.slice(0, insertPos)
    const after = sql.slice(insertPos)
    return before + ' WHERE ' + conditions.join(' AND ') + after
  }
}

function findClausePosition(sql) {
  const upper = sql.toUpperCase()
  const clauses = ['\nGROUP BY', '\nORDER BY', '\nLIMIT', '\nHAVING', '\nUNION']
  let minPos = sql.length
  for (const clause of clauses) {
    const idx = upper.lastIndexOf(clause)
    if (idx >= 0 && idx < minPos) minPos = idx
  }
  // 也检查行首
  const lineClauses = ['GROUP BY ', 'ORDER BY ', 'LIMIT ', 'HAVING ', 'UNION ']
  for (const clause of lineClauses) {
    const idx = upper.lastIndexOf('\n' + clause)
    if (idx >= 0 && idx + 1 < minPos) minPos = idx + 1
  }
  return minPos
}

function escapeValue(val) {
  if (typeof val === 'number') return String(val)
  return "'" + String(val).replace(/'/g, "''") + "'"
}

/**
 * 执行 Dashboard 中所有 widget 的查询。
 * @param {object} pool - mysql2 连接池
 * @param {object} dashboard - Dashboard 对象
 * @param {object} [filterValues] - 筛选器值
 * @returns {Promise<{ok: boolean, results: object[], errors: object[]}>}
 */
export async function executeDashboardQueries(pool, dashboard, filterValues, options = {}) {
  if (!pool || !dashboard || !Array.isArray(dashboard.widgets)) {
    return { ok: false, results: [], errors: ['无效的 Dashboard 或连接'] }
  }

  const validateQuery = typeof options.validateQuery === 'function' ? options.validateQuery : null
  const buildChartSpec = typeof options.buildChartSpec === 'function' ? options.buildChartSpec : null
  const tasks = dashboard.widgets.map(async (widget) => {
    if (!widget.query) return { widgetId: widget.id, ok: false, error: '查询为空', rows: [], columns: [] }
    try {
      const safeSql = injectFilterConditions(widget.query, dashboard.filters, filterValues)
      const checkedSql = validateQuery ? validateQuery(safeSql, widget) : { ok: true, sql: safeSql }
      if (!checkedSql || checkedSql.ok === false) {
        return { widgetId: widget.id, ok: false, error: (checkedSql && checkedSql.error) || '查询未通过安全校验', rows: [], columns: [] }
      }
      const executableSql = checkedSql.sql || safeSql
      const [rows, fields] = await pool.query(executableSql)
      const columns = Array.isArray(fields) ? fields.map(f => f.name) : []
      const list = Array.isArray(rows) ? rows.slice(0, 2000) : []
      const result = {
        widgetId: widget.id,
        ok: true,
        sql: executableSql,
        columns,
        rows: list.map(jsonSafe),
        rowCount: list.length,
      }
      if (widget.type === 'chart' && buildChartSpec) {
        const chart = buildChartSpec({ columns, rows: result.rows }, widget.title, widget.chartType || undefined)
        if (chart && chart.ok) result.chartSpec = chart.spec
      }
      return result
    } catch (err) {
      return { widgetId: widget.id, ok: false, error: String(err.message || err), rows: [], columns: [] }
    }
  })

  const results = await Promise.allSettled(tasks)
  const output = results.map(r => r.status === 'fulfilled' ? r.value : { widgetId: '?', ok: false, error: String(r.reason) })
  const errors = output.filter(r => !r.ok)
  return { ok: output.length > 0 && errors.length < output.length, results: output, errors }
}

/**
 * 构建下钻查询。
 * @param {string} baseQuery - 基础查询
 * @param {string} dimension - 下钻维度
 * @param {string} value - 维度值
 * @returns {string} 下钻 SQL
 */
export function buildDrillDownQuery(baseQuery, dimension, value) {
  if (!baseQuery || !dimension || value === undefined) return baseQuery
  const col = '`' + dimension.replace(/`/g, '') + '`'
  const val = escapeValue(value)
  const upper = baseQuery.toUpperCase()
  if (upper.includes(' WHERE ')) {
    return baseQuery + ' AND ' + col + ' = ' + val
  }
  return baseQuery + ' WHERE ' + col + ' = ' + val
}

// ── 默认导出 ──────────────────────────────────────────────────────────────

export default {
  listDashboards,
  getDashboard,
  saveDashboard,
  deleteDashboard,
  duplicateDashboard,
  addWidget,
  updateWidget,
  removeWidget,
  moveWidget,
  updateFilters,
  injectFilterConditions,
  executeDashboardQueries,
  buildDrillDownQuery,
}
