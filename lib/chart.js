/**
 * chart.js — dsh-plugin-nlbi BI 图表规格生成引擎 v2
 *
 * 基于查询结果列类型启发式推断图表配置（chartSpec），支持 15+ 种图表类型。
 * 规则引擎（非 LLM 出图）：稳定、可控、可测试。
 *
 * 支持图表类型：
 *   bar | line | pie | stat | funnel | scatter | heatmap | radar | sankey |
 *   gauge | treemap | area | stackedBar | waterfall | progress
 *
 * chartSpec 输出给前端 ECharts 渲染：
 *   {
 *     type: string,
 *     title: string,
 *     xField: string,
 *     yFields: string[],
 *     aggregate: string|null,
 *     columns: [{name, kind, comment}],
 *     data: rows[],
 *     ... (类型特有字段)
 *   }
 *
 * @module chart
 */

// ── 列类型推断 ──────────────────────────────────────────────────────────────

/**
 * MySQL 列类型 → 语义类型。
 * @param {string} mysqlType
 * @returns {'date'|'number'|'string'|'bool'|'other'}
 */
export function inferColumnKind(mysqlType) {
  const t = String(mysqlType || '').toLowerCase()
  if (/(date|datetime|timestamp|time|year)/.test(t)) return 'date'
  if (/(int|bigint|smallint|tinyint|mediumint|decimal|float|double|numeric|real)/.test(t) && !/tinyint\(1\)/.test(t)) return 'number'
  if (/tinyint\(1\)|bool|boolean/.test(t)) return 'bool'
  if (/(varchar|char|text|longtext|mediumtext|json|enum|set|blob)/.test(t)) return 'string'
  return 'other'
}

/**
 * 从数据内容推断列类型（比 schema 推断更准）。
 * @param {string[]} columns
 * @param {Array<object>} rows
 * @returns {Array<{name: string, kind: string}>}
 */
export function inferColumnKindsFromData(columns, rows) {
  if (!Array.isArray(columns)) return []
  return columns.map((name) => {
    const values = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== '')
    if (values.length === 0) return { name, kind: 'string' }

    const allNumeric = values.every((v) => typeof v === 'number' || (typeof v === 'string' && /^[-+]?\d+(\.\d+)?$/.test(v.trim())))
    if (allNumeric) return { name, kind: 'number' }

    const allDate = values.every((v) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())))
    if (allDate) return { name, kind: 'date' }

    const allBool = values.every((v) => v === true || v === false || v === 0 || v === 1)
    if (allBool) return { name, kind: 'bool' }

    return { name, kind: 'string' }
  })
}

// ── 多维分析计算函数 ──────────────────────────────────────────────────────

/**
 * 同比增长率：(本期 - 去年同期) / 去年同期 × 100%
 * @param {number} current - 本期值
 * @param {number} previous - 去年同期值
 * @returns {number|null} 百分比，保留 2 位小数
 */
export function computeYoYGrowth(current, previous) {
  if (typeof current !== 'number' || typeof previous !== 'number') return null
  if (previous === 0) return current === 0 ? 0 : null
  return Math.round((current - previous) / Math.abs(previous) * 10000) / 100
}

/**
 * 环比增长率：(本期 - 上期) / 上期 × 100%
 */
export function computeMoMGrowth(current, previous) {
  return computeYoYGrowth(current, previous) // 公式相同
}

/**
 * 累计值：逐行累加。
 * @param {Array<object>} rows
 * @param {string} valueField
 * @param {string} [dateField] - 排序字段
 * @returns {Array<object>} 新增 cumulative 字段
 */
export function computeCumulative(rows, valueField, dateField) {
  if (!Array.isArray(rows) || !valueField) return rows || []
  const sorted = dateField
    ? [...rows].sort((a, b) => {
        const va = a[dateField], vb = b[dateField]
        return va < vb ? -1 : va > vb ? 1 : 0
      })
    : [...rows]
  let cum = 0
  return sorted.map(r => {
    cum += Number(r[valueField] ?? 0)
    return { ...r, cumulative: Math.round(cum * 100) / 100 }
  })
}

/**
 * 移动平均。
 * @param {Array<object>} rows
 * @param {string} valueField
 * @param {number} window - 窗口大小（默认 7）
 * @param {string} [dateField] - 排序字段
 * @returns {Array<object>} 新增 ma{window} 字段
 */
export function computeMovingAverage(rows, valueField, window = 7, dateField) {
  if (!Array.isArray(rows) || !valueField) return rows || []
  const sorted = dateField
    ? [...rows].sort((a, b) => {
        const va = a[dateField], vb = b[dateField]
        return va < vb ? -1 : va > vb ? 1 : 0
      })
    : [...rows]
  const key = 'ma' + window
  return sorted.map((r, i) => {
    const start = Math.max(0, i - window + 1)
    const slice = sorted.slice(start, i + 1)
    const avg = slice.reduce((s, x) => s + Number(x[valueField] ?? 0), 0) / slice.length
    return { ...r, [key]: Math.round(avg * 100) / 100 }
  })
}

/**
 * Top N 排名。
 * @param {Array<object>} rows
 * @param {string} valueField
 * @param {number} n
 * @param {'DESC'|'ASC'} [order='DESC']
 * @returns {Array<object>}
 */
export function computeTopN(rows, valueField, n = 10, order = 'DESC') {
  if (!Array.isArray(rows) || !valueField) return rows || []
  const sorted = [...rows].sort((a, b) => {
    const va = Number(a[valueField] ?? 0), vb = Number(b[valueField] ?? 0)
    return order === 'DESC' ? vb - va : va - vb
  })
  return sorted.slice(0, Math.max(1, n))
}

/**
 * 排名。
 * @param {Array<object>} rows
 * @param {string} valueField
 * @param {string} [rankField='rank']
 * @returns {Array<object>}
 */
export function computeRanking(rows, valueField, rankField = 'rank') {
  if (!Array.isArray(rows) || !valueField) return rows || []
  const sorted = [...rows].sort((a, b) => Number(b[valueField] ?? 0) - Number(a[valueField] ?? 0))
  return sorted.map((r, i) => ({ ...r, [rankField]: i + 1 }))
}

/**
 * 增长率。
 */
export function computeGrowthRate(current, previous) {
  return computeYoYGrowth(current, previous)
}

// ── 图表类型定义 ──────────────────────────────────────────────────────────

export const CHART_TYPES = {
  bar:         '柱状图',
  line:        '折线图',
  pie:         '饼图',
  stat:        '统计卡',
  funnel:      '漏斗图',
  scatter:     '散点图',
  heatmap:     '热力图',
  radar:       '雷达图',
  sankey:      '桑基图',
  gauge:       '仪表盘',
  treemap:     '矩形树图',
  area:        '面积图',
  stackedBar:  '堆叠柱状图',
  waterfall:   '瀑布图',
  progress:    '进度条',
}

// ── 核心：图表规格生成 ──────────────────────────────────────────────────────

/**
 * 生成图表规格（chartSpec）。
 * 启发式规则：根据列类型和数据特征自动选择最佳图表。
 *
 * @param {object} params
 * @param {string[]} params.columns
 * @param {Array<object>} params.rows
 * @param {string} [params.title='数据查询结果']
 * @param {string} [params.chartType] - 用户指定的图表类型（强制）
 * @returns {{ ok: boolean, spec?: object, error?: string }}
 */
export function suggestChartSpec({ columns, rows, title = '数据查询结果', chartType }) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return { ok: false, error: '无可用列，无法生成图表' }
  }
  if (!Array.isArray(rows)) rows = []

  // 用户强制指定图表类型
  if (chartType && CHART_TYPES[chartType]) {
    const forced = makeForcedSpec(chartType, columns, rows, title)
    if (forced) return { ok: true, spec: forced }
  }

  const kinds = inferColumnKindsFromData(columns, rows)
  const numericCols = kinds.filter((c) => c.kind === 'number').map((c) => c.name)
  const dateCols = kinds.filter((c) => c.kind === 'date').map((c) => c.name)
  const stringCols = kinds.filter((c) => c.kind === 'string' || c.kind === 'bool').map((c) => c.name)

  // ── 场景 1：只有 1 个数值列 → 统计卡 ──
  if (numericCols.length >= 1 && columns.length === 1) {
    return { ok: true, spec: makeStatSpec(columns[0], rows, title) }
  }

  // ── 场景 2：1 时间 + 1 数值 → 折线（时间轴优先） ──
  if (dateCols.length >= 1 && numericCols.length >= 1) {
    const xField = dateCols[0]
    const yFields = numericCols.slice(0, 8)
    const type = numericCols.length > 3 ? 'bar' : 'line'
    return {
      ok: true,
      spec: makeCartesianSpec(type, xField, yFields, rows, title),
    }
  }

  // ── 场景 3：多数值列对比（≥2 数值列 + 有类目）→ 分组柱/折线 ──
  if (numericCols.length >= 2 && (stringCols.length >= 1 || dateCols.length >= 1)) {
    const xField = stringCols[0] || dateCols[0]
    const yFields = numericCols.slice(0, 8)
    return {
      ok: true,
      spec: makeCartesianSpec('bar', xField, yFields, rows, title),
    }
  }

  // ── 场景 4：2 列（类目 + 数值）→ 柱/饼 ──
  if (stringCols.length >= 1 && numericCols.length >= 1 && columns.length === 2) {
    const xField = stringCols[0]
    const yField = numericCols[0]
    const uniqueCount = new Set(rows.map((r) => String(r[xField] ?? ''))).size
    const type = uniqueCount > 0 && uniqueCount <= 12 ? 'pie' : 'bar'
    return {
      ok: true,
      spec: makeCartesianSpec(type === 'pie' ? 'pie' : 'bar', type === 'pie' ? null : xField, [yField], rows, title, type === 'pie' ? { pieField: xField } : {}),
    }
  }

  // ── 场景 5：3-4 列（类目 + 数值）→ 单数值柱状 ──
  if (stringCols.length >= 1 && numericCols.length >= 1 && columns.length <= 4) {
    const xField = stringCols[0]
    const yField = numericCols[0]
    return {
      ok: true,
      spec: makeCartesianSpec('bar', xField, [yField], rows, title),
    }
  }

  // ── 场景 6：多数值列对比 → 分组柱/折线 ──
  if (numericCols.length >= 2) {
    const xField = stringCols[0] || dateCols[0] || null
    const yFields = numericCols.slice(0, 8)
    const type = dateCols.length > 0 ? 'line' : 'bar'
    return {
      ok: true,
      spec: makeCartesianSpec(type, xField, yFields, rows, title),
    }
  }

  // ── 场景 7：只有字符串列 → 用 count 做柱状图（统计频次） ──
  if (stringCols.length >= 1) {
    const xField = stringCols[0]
    const counts = new Map()
    for (const r of rows) {
      const key = String(r[xField] ?? '(空)')
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const countRows = [...counts.entries()].map(([name, count]) => ({ [xField]: name, count }))
    return {
      ok: true,
      spec: makeCartesianSpec('bar', xField, ['count'], countRows, title + '（频次统计）'),
    }
  }

  return { ok: false, error: '无法从查询结果推断图表类型' }
}

/**
 * 用户强制指定图表类型时，尽力构建对应 spec。
 */
function makeForcedSpec(chartType, columns, rows, title) {
  const kinds = inferColumnKindsFromData(columns, rows)
  const numericCols = kinds.filter(c => c.kind === 'number').map(c => c.name)
  const dateCols = kinds.filter(c => c.kind === 'date').map(c => c.name)
  const stringCols = kinds.filter(c => c.kind === 'string' || c.kind === 'bool').map(c => c.name)

  switch (chartType) {
    case 'stat':
      if (numericCols.length >= 1) return makeStatSpec(numericCols[0], rows, title)
      if (columns.length >= 1) return makeStatSpec(columns[0], rows, title)
      return null

    case 'pie': {
      const cat = stringCols[0] || dateCols[0]
      const val = numericCols[0]
      if (cat && val) return makeCartesianSpec('pie', null, [val], rows, title, { pieField: cat })
      return null
    }

    case 'bar':
    case 'line':
    case 'area':
    case 'stackedBar': {
      const x = stringCols[0] || dateCols[0] || columns[0]
      const y = numericCols.slice(0, 8)
      if (y.length === 0 && columns.length >= 2) y.push(columns[1])
      if (x && y.length > 0) return makeCartesianSpec(chartType === 'stackedBar' ? 'bar' : chartType, x, y, rows, title, chartType === 'stackedBar' ? { stack: true } : {})
      return null
    }

    case 'funnel': {
      const cat = stringCols[0] || columns[0]
      const val = numericCols[0] || (columns.length > 1 ? columns[1] : null)
      if (cat && val) return makeFunnelSpec(cat, val, rows, title)
      return null
    }

    case 'scatter': {
      if (numericCols.length >= 2) return makeScatterSpec(numericCols[0], numericCols[1], rows, title, stringCols[0])
      return null
    }

    case 'heatmap': {
      if (stringCols.length >= 2 && numericCols.length >= 1) return makeHeatmapSpec(stringCols[0], stringCols[1], numericCols[0], rows, title)
      return null
    }

    case 'radar': {
      if (stringCols.length >= 1 && numericCols.length >= 1) return makeRadarSpec(stringCols[0], numericCols.slice(0, 8), rows, title)
      return null
    }

    case 'gauge': {
      if (numericCols.length >= 1) return makeGaugeSpec(numericCols[0], rows, title)
      return null
    }

    case 'treemap': {
      if (stringCols.length >= 1 && numericCols.length >= 1) return makeTreemapSpec(stringCols[0], numericCols[0], rows, title, stringCols[1])
      return null
    }

    case 'waterfall': {
      if (stringCols.length >= 1 && numericCols.length >= 1) return makeWaterfallSpec(stringCols[0], numericCols[0], rows, title)
      return null
    }

    case 'progress': {
      if (numericCols.length >= 1) return makeProgressSpec(numericCols[0], rows, title)
      return null
    }

    case 'sankey': {
      // 桑基图需要 source → target + value 格式
      if (columns.length >= 3) return makeSankeySpec(columns[0], columns[1], columns[2], rows, title)
      return null
    }

    default:
      return null
  }
}

// ── Spec 构造函数 ──────────────────────────────────────────────────────────

function makeStatSpec(field, rows, title) {
  const values = rows.map((r) => r[field]).filter((v) => typeof v === 'number' && Number.isFinite(v))
  const sum = values.reduce((a, b) => a + b, 0)
  const avg = values.length > 0 ? sum / values.length : 0
  const max = values.length > 0 ? Math.max(...values) : 0
  const min = values.length > 0 ? Math.min(...values) : 0
  return {
    type: 'stat',
    title,
    field,
    stats: { sum: round2(sum), avg: round2(avg), max: round2(max), min: round2(min), count: values.length },
  }
}

function makeCartesianSpec(type, xField, yFields, rows, title, extra = {}) {
  return {
    type,
    title,
    xField,
    yFields,
    ...extra,
    data: rows,
  }
}

function makeFunnelSpec(nameField, valueField, rows, title) {
  // 漏斗图：按值降序排列
  const data = [...rows]
    .sort((a, b) => Number(b[valueField] ?? 0) - Number(a[valueField] ?? 0))
    .map(r => ({ name: String(r[nameField] ?? ''), value: Number(r[valueField] ?? 0) }))
  return { type: 'funnel', title, nameField, valueField, data }
}

function makeScatterSpec(xField, yField, rows, title, sizeField) {
  const data = rows.map(r => {
    const point = [Number(r[xField] ?? 0), Number(r[yField] ?? 0)]
    if (sizeField && typeof r[sizeField] === 'number') point.push(r[sizeField])
    return { x: point[0], y: point[1], size: point[2], raw: r }
  })
  return { type: 'scatter', title, xField, yField, sizeField, data }
}

function makeHeatmapSpec(xField, yField, valueField, rows, title) {
  const xValues = [...new Set(rows.map(r => String(r[xField] ?? '')))]
  const yValues = [...new Set(rows.map(r => String(r[yField] ?? '')))]
  const data = rows.map(r => [
    xValues.indexOf(String(r[xField] ?? '')),
    yValues.indexOf(String(r[yField] ?? '')),
    Number(r[valueField] ?? 0),
  ])
  return { type: 'heatmap', title, xField, yField, valueField, xValues, yValues, data }
}

function makeRadarSpec(nameField, valueFields, rows, title) {
  // 雷达图：每行一个系列，nameField 为指标名，valueFields 为各列值
  // 如果只有一行，则 valueFields 为各维度，行数据为值
  const indicators = []
  const seriesData = []

  if (rows.length === 1) {
    // 单行：各数值列作为指标
    for (const vf of valueFields) {
      const vals = rows.map(r => Number(r[vf] ?? 0))
      indicators.push({ name: vf, max: Math.max(...vals) * 1.2 || 100 })
    }
    seriesData.push({
      value: valueFields.map(vf => Number(rows[0][vf] ?? 0)),
      name: rows[0][nameField] || '当前',
    })
  } else {
    // 多行：nameField 的值作为指标名，每行一个系列
    const uniqueNames = [...new Set(rows.map(r => String(r[nameField] ?? '')))]
    for (const name of uniqueNames) {
      indicators.push({ name, max: 100 })
    }
    // 每个数值列一个系列
    for (const vf of valueFields.slice(0, 4)) {
      const values = uniqueNames.map(name => {
        const row = rows.find(r => String(r[nameField] ?? '') === name)
        return row ? Number(row[vf] ?? 0) : 0
      })
      seriesData.push({ value: values, name: vf })
    }
  }

  return { type: 'radar', title, indicators, series: seriesData }
}

function makeSankeySpec(sourceField, targetField, valueField, rows, title) {
  const nodeSet = new Set()
  const links = []
  for (const r of rows) {
    const source = String(r[sourceField] ?? '')
    const target = String(r[targetField] ?? '')
    const value = Number(r[valueField] ?? 0)
    if (!source || !target || value <= 0) continue
    nodeSet.add(source)
    nodeSet.add(target)
    links.push({ source, target, value })
  }
  const data = [...nodeSet].map(name => ({ name }))
  return { type: 'sankey', title, sourceField, targetField, valueField, data, links }
}

function makeGaugeSpec(valueField, rows, title) {
  const value = rows.length > 0 ? Number(rows[0][valueField] ?? 0) : 0
  return { type: 'gauge', title, valueField, value, max: Math.max(value * 1.2, 100) }
}

function makeTreemapSpec(nameField, valueField, rows, title, parentField) {
  if (parentField) {
    // 有层级：构建树形结构
    const byParent = new Map()
    for (const r of rows) {
      const parent = String(r[parentField] ?? '')
      const name = String(r[nameField] ?? '')
      const value = Number(r[valueField] ?? 0)
      if (!byParent.has(parent)) byParent.set(parent, [])
      byParent.get(parent).push({ name, value })
    }
    const data = [...byParent.entries()].map(([parent, children]) => ({
      name: parent,
      value: children.reduce((s, c) => s + c.value, 0),
      children,
    }))
    return { type: 'treemap', title, nameField, valueField, parentField, data }
  }
  // 无层级：扁平矩形树图
  const data = rows.map(r => ({
    name: String(r[nameField] ?? ''),
    value: Number(r[valueField] ?? 0),
  }))
  return { type: 'treemap', title, nameField, valueField, data }
}

function makeWaterfallSpec(nameField, valueField, rows, title) {
  // 瀑布图：累计增减
  let cumulative = 0
  const data = rows.map(r => {
    const v = Number(r[valueField] ?? 0)
    const start = cumulative
    cumulative += v
    return {
      name: String(r[nameField] ?? ''),
      value: v,
      start,
      end: cumulative,
      isPositive: v >= 0,
    }
  })
  return { type: 'waterfall', title, nameField, valueField, data }
}

function makeProgressSpec(valueField, rows, title) {
  const value = rows.length > 0 ? Number(rows[0][valueField] ?? 0) : 0
  return { type: 'progress', title, valueField, value, max: 100 }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

// ── 对外入口 ──────────────────────────────────────────────────────────────

/**
 * 对 text2sql 返回的 result 生成图表规格。
 * @param {object} result - { columns, rows }
 * @param {string} [title]
 * @param {string} [chartType] - 用户指定图表类型
 * @returns {{ ok: boolean, spec?: object, error?: string }}
 */
export function suggestChartForResult(result, title, chartType) {
  if (!result || !Array.isArray(result.columns)) {
    return { ok: false, error: '无查询结果' }
  }
  return suggestChartSpec({
    columns: result.columns,
    rows: result.rows || [],
    title: title || '查询结果',
    chartType,
  })
}

export default {
  inferColumnKind,
  inferColumnKindsFromData,
  suggestChartSpec,
  suggestChartForResult,
  computeYoYGrowth,
  computeMoMGrowth,
  computeCumulative,
  computeMovingAverage,
  computeTopN,
  computeRanking,
  computeGrowthRate,
  CHART_TYPES,
}
