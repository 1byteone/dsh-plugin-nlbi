/**
 * chart.js — dsh-plugin-nlbi BI 图表规格生成
 *
 * 基于查询结果列类型启发式推断图表配置（chartSpec）。
 * 规则引擎（非 LLM 出图）：稳定、可控、可测试。
 *
 * chartSpec 输出给前端 ECharts 渲染：
 *   {
 *     type: 'bar' | 'line' | 'pie' | 'stat',
 *     title: string,
 *     xField: string,          // 类目字段
 *     yFields: string[],       // 数值字段
 *     aggregate: string|null,  // SUM/AVG/COUNT/MIN/MAX
 *     columns: [{name, kind, comment}],  // 列元信息
 *     data: rows[]             // 透传数据
 *   }
 *
 * @module chart
 */

/**
 * 列类型推断：
 *  - date:    DATE/DATETIME/TIMESTAMP（时间轴）
 *  - number:  INT/BIGINT/DECIMAL/FLOAT/DOUBLE/NUMERIC（数值轴）
 *  - string:  VARCHAR/CHAR/TEXT（类目）
 *  - bool:    BOOLEAN/TINYINT(1)
 *
 * @param {string} mysqlType - MySQL 列类型（column_type）
 * @returns {'date'|'number'|'string'|'bool'|'other'}
 */
export function inferColumnKind(mysqlType) {
  const t = String(mysqlType || '').toLowerCase()
  if (/(date|datetime|timestamp|time|year)/.test(t)) return 'date'
  if (/(int|bigint|smallint|tinyint|mediumint|decimal|float|double|numeric|real)/.test(t) && !/tinyint\(1\)/.test(t)) {
    return 'number'
  }
  if (/tinyint\(1\)|bool|boolean/.test(t)) return 'bool'
  if (/(varchar|char|text|longtext|mediumtext|json|enum|set|blob)/.test(t)) return 'string'
  return 'other'
}

/**
 * 从查询结果推断每列的实际值类型（基于数据内容，而非仅 schema）。
 * 用于图表选择时更准：即使 schema 是 varchar，但值都是数字，也可当数值轴。
 *
 * @param {string[]} columns - 列名
 * @param {Array<object>} rows - 数据行
 * @returns {Array<{name: string, kind: string}>}
 */
export function inferColumnKindsFromData(columns, rows) {
  if (!Array.isArray(columns)) return []
  return columns.map((name) => {
    const values = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== '')
    if (values.length === 0) return { name, kind: 'string' }

    // 全数字 → number
    const allNumeric = values.every((v) => typeof v === 'number' || (typeof v === 'string' && /^[-+]?\d+(\.\d+)?$/.test(v.trim())))
    if (allNumeric) return { name, kind: 'number' }

    // 全日期 → date
    const allDate = values.every((v) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())))
    if (allDate) return { name, kind: 'date' }

    // 布尔
    const allBool = values.every((v) => v === true || v === false || v === 0 || v === 1)
    if (allBool) return { name, kind: 'bool' }

    return { name, kind: 'string' }
  })
}

/**
 * 生成图表规格（chartSpec）。
 * 启发式规则：
 *  - 0 列 → 无图
 *  - 1 数值列且无其它列 → stat 统计卡
 *  - 2 列且 [类目, 数值] → bar（若类目是日期 → line）
 *  - 2 列且 [类目, 数值] 且类目基数 ≤ 12 → pie
 *  - ≥3 列（多数值）→ 分组 bar / line 对比
 *
 * @param {object} params
 * @param {string[]} params.columns - 查询结果列名
 * @param {Array<object>} params.rows - 查询结果行
 * @param {string} [params.title='数据查询结果'] - 图表标题
 * @returns {{ ok: boolean, spec?: object, error?: string }}
 */
export function suggestChartSpec({ columns, rows, title = '数据查询结果' }) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return { ok: false, error: '无可用列，无法生成图表' }
  }
  if (!Array.isArray(rows)) rows = []

  const kinds = inferColumnKindsFromData(columns, rows)

  // 分类数值列
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
    // 类目基数小（≤12）且只有 2 列 → pie
    const uniqueCount = new Set(rows.map((r) => String(r[xField] ?? ''))).size
    const type = uniqueCount > 0 && uniqueCount <= 12 ? 'pie' : 'bar'
    return {
      ok: true,
      spec: makeCartesianSpec(type === 'pie' ? 'pie' : 'bar', type === 'pie' ? null : xField, [yField], rows, title, type === 'pie' ? { pieField: xField } : {}),
    }
  }

  // ── 场景 5：3-4 列（类目 + 数值），多列但非多数值对比 → 单数值柱状 ──
  if (stringCols.length >= 1 && numericCols.length >= 1 && columns.length <= 4) {
    const xField = stringCols[0]
    const yField = numericCols[0]
    return {
      ok: true,
      spec: makeCartesianSpec('bar', xField, [yField], rows, title),
    }
  }

  // ── 场景 4：多数值列对比 → 分组柱/折线 ──
  if (numericCols.length >= 2) {
    const xField = stringCols[0] || dateCols[0] || null
    const yFields = numericCols.slice(0, 8)
    const type = dateCols.length > 0 ? 'line' : 'bar'
    return {
      ok: true,
      spec: makeCartesianSpec(type, xField, yFields, rows, title),
    }
  }

  // ── 场景 5：只有字符串列 → 用 count 做柱状图（统计频次） ──
  if (stringCols.length >= 1) {
    const xField = stringCols[0]
    // 统计各值出现次数
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
 * 构造统计卡 spec。
 */
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
    stats: {
      sum: round2(sum),
      avg: round2(avg),
      max: round2(max),
      min: round2(min),
      count: values.length,
    },
  }
}

/**
 * 构造笛卡尔坐标系图表 spec（bar/line/pie）。
 */
function makeCartesianSpec(type, xField, yFields, rows, title, extra = {}) {
  return {
    type,
    title,
    xField,            // pie 时为 null，用 extra.pieField
    yFields,
    ...extra,
    data: rows,
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * schema 类型 → 数值列启发（用于 SQL 层面预判）。
 * 供 nl_query 工具在返回前做 chart 建议时使用。
 *
 * @param {object} result - text2sql 返回的 result（含 columns/rows）
 * @param {string} [title]
 * @returns {{ ok: boolean, spec?: object, error?: string }}
 */
export function suggestChartForResult(result, title) {
  if (!result || !Array.isArray(result.columns)) {
    return { ok: false, error: '无查询结果' }
  }
  return suggestChartSpec({
    columns: result.columns,
    rows: result.rows || [],
    title: title || '查询结果',
  })
}

export default {
  inferColumnKind,
  inferColumnKindsFromData,
  suggestChartSpec,
  suggestChartForResult,
}