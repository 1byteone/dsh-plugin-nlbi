/**
 * metrics.js — dsh-plugin-nlbi 指标/维度/数据模型管理
 *
 * 职责：
 *  1. 指标（Metric）CRUD：定义业务指标（GMV、订单数、客单价等），
 *     包含 SQL 表达式、聚合类型、格式化规则
 *  2. 维度（Dimension）CRUD：定义分析维度（地区、时间、商品类别等），
 *     支持层级定义（省→市→区）用于下钻
 *  3. 数据集（Dataset）CRUD：关联指标+维度+表+Join 关系，
 *     形成可复用的分析数据模型
 *  4. 智能推断：从查询结果自动推断维度和指标
 *  5. SQL 片段构建：根据指标定义生成可执行的 SQL 片段
 *
 * Storage: $DSH_HOME/storages/dsh-plugin-nlbi/metrics.json
 *
 * @module metrics
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── Storage ────────────────────────────────────────────────────────────────

function storageDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-plugin-nlbi')
}

function metricsFile() {
  return path.join(storageDir(), 'metrics.json')
}

let cachedMetrics = null
let loadPromise = null

async function loadFromDisk() {
  try {
    const text = await fsp.readFile(metricsFile(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
        dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
        datasets: Array.isArray(parsed.datasets) ? parsed.datasets : [],
      }
    }
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND')) {
      return { metrics: [], dimensions: [], datasets: [] }
    }
  }
  return { metrics: [], dimensions: [], datasets: [] }
}

function ensureLoaded() {
  if (loadPromise === null) {
    loadPromise = loadFromDisk()
      .then((data) => { cachedMetrics = data })
      .catch(() => { cachedMetrics = { metrics: [], dimensions: [], datasets: [] } })
  }
  return loadPromise.then(() => cachedMetrics)
}

async function persist(data) {
  const previous = cachedMetrics
  cachedMetrics = data
  try {
    await fsp.mkdir(storageDir(), { recursive: true })
    const file = metricsFile()
    const tmp = file + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    cachedMetrics = previous
    throw err
  }
}

// ── ID 生成 ────────────────────────────────────────────────────────────────

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

// ── 归一化 ────────────────────────────────────────────────────────────────

function normalizeMetric(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '',
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 128) : '',
    expression: typeof raw.expression === 'string' ? raw.expression.trim() : '',
    sourceTable: typeof raw.sourceTable === 'string' ? raw.sourceTable.trim().toLowerCase() : '',
    sourceColumn: typeof raw.sourceColumn === 'string' ? raw.sourceColumn.trim().toLowerCase() : '',
    type: ['sum', 'count', 'avg', 'min', 'max', 'derived', 'count_distinct'].includes(raw.type) ? raw.type : 'sum',
    format: ['currency', 'number', 'percent', 'integer', 'decimal'].includes(raw.format) ? raw.format : 'number',
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 512) : '',
  }
}

function normalizeDimension(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const hierarchy = Array.isArray(raw.hierarchy)
    ? raw.hierarchy.filter(h => typeof h === 'string' && h.trim()).map(h => h.trim().toLowerCase())
    : []
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '',
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 128) : '',
    sourceTable: typeof raw.sourceTable === 'string' ? raw.sourceTable.trim().toLowerCase() : '',
    sourceColumn: typeof raw.sourceColumn === 'string' ? raw.sourceColumn.trim().toLowerCase() : '',
    type: ['string', 'date', 'number', 'bool'].includes(raw.type) ? raw.type : 'string',
    hierarchy,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 512) : '',
  }
}

function normalizeDataset(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const tables = Array.isArray(raw.tables) ? raw.tables.filter(t => typeof t === 'string').map(t => t.trim().toLowerCase()) : []
  const joins = Array.isArray(raw.joins) ? raw.joins.filter(j => j && typeof j === 'object').map(j => ({
    from: typeof j.from === 'string' ? j.from.trim() : '',
    to: typeof j.to === 'string' ? j.to.trim() : '',
    type: ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN'].includes(j.type) ? j.type : 'LEFT JOIN',
  })) : []
  const metrics = Array.isArray(raw.metrics) ? raw.metrics.filter(m => typeof m === 'string') : []
  const dimensions = Array.isArray(raw.dimensions) ? raw.dimensions.filter(d => typeof d === 'string') : []
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '',
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 128) : '',
    connectionId: typeof raw.connectionId === 'string' ? raw.connectionId.trim() : '',
    tables,
    joins,
    metrics,
    dimensions,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 512) : '',
  }
}

// ── 指标 CRUD ──────────────────────────────────────────────────────────────

export async function listMetrics() {
  const data = await ensureLoaded()
  return { ok: true, metrics: data.metrics }
}

export async function saveMetric(input) {
  const next = normalizeMetric(input)
  if (!next.name) return { ok: false, error: '指标名称不能为空' }
  if (!next.expression) return { ok: false, error: '指标表达式不能为空' }

  const data = await ensureLoaded()
  const id = next.id || genId('m')
  next.id = id

  const idx = data.metrics.findIndex(m => m.id === id)
  if (idx >= 0) {
    data.metrics[idx] = { ...data.metrics[idx], ...next, updatedAt: new Date().toISOString() }
  } else {
    next.createdAt = new Date().toISOString()
    next.updatedAt = next.createdAt
    data.metrics.push(next)
  }
  await persist(data)
  return { ok: true, metric: next }
}

export async function deleteMetric(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: '缺少指标 ID' }
  const data = await ensureLoaded()
  const next = data.metrics.filter(m => m.id !== id)
  if (next.length === data.metrics.length) return { ok: false, error: '指标不存在' }
  data.metrics = next
  await persist(data)
  return { ok: true }
}

export async function getMetricById(id) {
  const data = await ensureLoaded()
  const m = data.metrics.find(m => m.id === id)
  return m ? { ok: true, metric: m } : { ok: false, error: '指标不存在' }
}

// ── 维度 CRUD ──────────────────────────────────────────────────────────────

export async function listDimensions() {
  const data = await ensureLoaded()
  return { ok: true, dimensions: data.dimensions }
}

export async function saveDimension(input) {
  const next = normalizeDimension(input)
  if (!next.name) return { ok: false, error: '维度名称不能为空' }
  if (!next.sourceColumn) return { ok: false, error: '维度字段不能为空' }

  const data = await ensureLoaded()
  const id = next.id || genId('d')
  next.id = id

  const idx = data.dimensions.findIndex(d => d.id === id)
  if (idx >= 0) {
    data.dimensions[idx] = { ...data.dimensions[idx], ...next, updatedAt: new Date().toISOString() }
  } else {
    next.createdAt = new Date().toISOString()
    next.updatedAt = next.createdAt
    data.dimensions.push(next)
  }
  await persist(data)
  return { ok: true, dimension: next }
}

export async function deleteDimension(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: '缺少维度 ID' }
  const data = await ensureLoaded()
  const next = data.dimensions.filter(d => d.id !== id)
  if (next.length === data.dimensions.length) return { ok: false, error: '维度不存在' }
  data.dimensions = next
  await persist(data)
  return { ok: true }
}

export async function getDimensionById(id) {
  const data = await ensureLoaded()
  const d = data.dimensions.find(d => d.id === id)
  return d ? { ok: true, dimension: d } : { ok: false, error: '维度不存在' }
}

// ── 数据集 CRUD ────────────────────────────────────────────────────────────

export async function listDatasets() {
  const data = await ensureLoaded()
  return { ok: true, datasets: data.datasets }
}

export async function saveDataset(input) {
  const next = normalizeDataset(input)
  if (!next.name) return { ok: false, error: '数据集名称不能为空' }
  if (next.tables.length === 0) return { ok: false, error: '至少选择一张表' }

  const data = await ensureLoaded()
  const id = next.id || genId('ds')
  next.id = id

  const idx = data.datasets.findIndex(d => d.id === id)
  if (idx >= 0) {
    data.datasets[idx] = { ...data.datasets[idx], ...next, updatedAt: new Date().toISOString() }
  } else {
    next.createdAt = new Date().toISOString()
    next.updatedAt = next.createdAt
    data.datasets.push(next)
  }
  await persist(data)
  return { ok: true, dataset: next }
}

export async function deleteDataset(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: '缺少数据集 ID' }
  const data = await ensureLoaded()
  const next = data.datasets.filter(d => d.id !== id)
  if (next.length === data.datasets.length) return { ok: false, error: '数据集不存在' }
  data.datasets = next
  await persist(data)
  return { ok: true }
}

export async function getDatasetById(id) {
  const data = await ensureLoaded()
  const d = data.datasets.find(d => d.id === id)
  return d ? { ok: true, dataset: d } : { ok: false, error: '数据集不存在' }
}

// ── SQL 片段构建 ────────────────────────────────────────────────────────────

/**
 * 根据指标定义生成 SQL 表达式片段。
 *
 * @param {object} metric - 指标对象
 * @param {string} [alias] - 别名（默认用指标名）
 * @returns {string} SQL 片段，如 "SUM(o.amount) AS `GMV`"
 */
export function buildMetricExpression(metric, alias) {
  if (!metric || !metric.expression) return ''
  const asName = alias || metric.name || 'metric'
  return metric.expression + ' AS `' + asName.replace(/`/g, '') + '`'
}

/**
 * 根据维度定义生成 SQL GROUP BY 片段和 SELECT 片段。
 *
 * @param {object} dimension - 维度对象
 * @param {string} [tableAlias] - 表别名
 * @returns {{ select: string, groupBy: string }}
 */
export function buildDimensionSql(dimension, tableAlias) {
  if (!dimension || !dimension.sourceColumn) return { select: '', groupBy: '' }
  const prefix = tableAlias ? tableAlias + '.' : ''
  const col = prefix + '`' + dimension.sourceColumn.replace(/`/g, '') + '`'
  const asName = dimension.name || dimension.sourceColumn
  return {
    select: col + ' AS `' + asName.replace(/`/g, '') + '`',
    groupBy: col,
  }
}

/**
 * 根据数据集定义构建完整的 FROM + JOIN 子句。
 *
 * @param {object} dataset - 数据集对象
 * @returns {string} FROM 子句
 */
export function buildDatasetFromClause(dataset) {
  if (!dataset || !dataset.tables || dataset.tables.length === 0) return ''
  const mainTable = '`' + dataset.tables[0].replace(/`/g, '') + '`'
  let sql = mainTable
  for (const join of (dataset.joins || [])) {
    if (!join.from || !join.to) continue
    const fromTable = '`' + join.from.split('.')[0].replace(/`/g, '') + '`'
    const fromCol = join.from.split('.').slice(1).join('.')
    const toTable = '`' + join.to.split('.')[0].replace(/`/g, '') + '`'
    const toCol = join.to.split('.').slice(1).join('.')
    sql += '\n  ' + join.type + ' ' + fromTable + ' ON ' + fromTable + '.' + fromCol + ' = ' + toTable + '.' + toCol
  }
  return sql
}

// ── 智能推断 ────────────────────────────────────────────────────────────────

/**
 * 从查询结果推断维度（类目字段）。
 *
 * @param {string[]} columns - 列名
 * @param {Array<object>} rows - 数据行
 * @returns {Array<{name: string, kind: string, cardinality: number}>}
 */
export function inferDimensions(columns, rows) {
  if (!Array.isArray(columns) || !Array.isArray(rows)) return []
  const results = []
  for (const col of columns) {
    const values = rows.map(r => r[col]).filter(v => v !== null && v !== undefined && v !== '')
    if (values.length === 0) continue
    const uniqueVals = new Set(values.map(v => String(v)))
    const cardinality = uniqueVals.size

    // 判断类型
    let kind = 'string'
    const allNumeric = values.every(v => typeof v === 'number' || (typeof v === 'string' && /^[-+]?\d+(\.\d+)?$/.test(String(v).trim())))
    const allDate = values.every(v => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(String(v).trim())))

    if (allDate) kind = 'date'
    else if (allNumeric && cardinality > 20) kind = 'number'
    else kind = 'string'

    // 只有低基数字段或日期字段才是好维度
    if (kind === 'date' || (kind === 'string' && cardinality <= 100) || (kind === 'number' && cardinality <= 20)) {
      results.push({ name: col, kind, cardinality })
    }
  }
  return results
}

/**
 * 从查询结果推断指标（数值字段）。
 *
 * @param {string[]} columns - 列名
 * @param {Array<object>} rows - 数据行
 * @returns {Array<{name: string, kind: string, stats: object}>}
 */
export function inferMetrics(columns, rows) {
  if (!Array.isArray(columns) || !Array.isArray(rows)) return []
  const results = []
  for (const col of columns) {
    const values = rows.map(r => r[col]).filter(v => typeof v === 'number' && Number.isFinite(v))
    if (values.length === 0) continue

    const sum = values.reduce((a, b) => a + b, 0)
    const avg = values.length > 0 ? sum / values.length : 0
    const max = Math.max(...values)
    const min = Math.min(...values)

    results.push({
      name: col,
      kind: 'number',
      stats: {
        sum: Math.round(sum * 100) / 100,
        avg: Math.round(avg * 100) / 100,
        max,
        min,
        count: values.length,
      },
    })
  }
  return results
}

// ── 指标上下文文本（供 Text2SQL prompt 注入） ──────────────────────────────

/**
 * 生成指标/维度上下文文本，注入到 Text2SQL prompt 中。
 *
 * @returns {Promise<string>}
 */
export async function buildMetricsContext() {
  const data = await ensureLoaded()
  const parts = []

  if (data.metrics.length > 0) {
    parts.push('## 已定义的业务指标')
    for (const m of data.metrics) {
      const desc = m.description ? ' — ' + m.description : ''
      parts.push('- ' + m.name + ': ' + m.expression + desc)
    }
    parts.push('')
  }

  if (data.dimensions.length > 0) {
    parts.push('## 已定义的分析维度')
    for (const d of data.dimensions) {
      const hierarchy = d.hierarchy && d.hierarchy.length > 0 ? ' (层级: ' + d.hierarchy.join('→') + ')' : ''
      const desc = d.description ? ' — ' + d.description : ''
      parts.push('- ' + d.name + ': ' + d.sourceTable + '.' + d.sourceColumn + hierarchy + desc)
    }
    parts.push('')
  }

  if (data.datasets.length > 0) {
    parts.push('## 已定义的数据集')
    for (const ds of data.datasets) {
      parts.push('- ' + ds.name + ': 表 ' + ds.tables.join(', ') + (ds.description ? ' — ' + ds.description : ''))
    }
    parts.push('')
  }

  return parts.join('\n')
}

// ── 默认导出 ──────────────────────────────────────────────────────────────

export default {
  listMetrics,
  saveMetric,
  deleteMetric,
  getMetricById,
  listDimensions,
  saveDimension,
  deleteDimension,
  getDimensionById,
  listDatasets,
  saveDataset,
  deleteDataset,
  getDatasetById,
  buildMetricExpression,
  buildDimensionSql,
  buildDatasetFromClause,
  inferDimensions,
  inferMetrics,
  buildMetricsContext,
}
