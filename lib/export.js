/**
 * export.js — dsh-plugin-nlbi 报表导出引擎
 *
 * 支持导出格式：
 *  - CSV（逗号分隔值）
 *  - TSV（制表符分隔值）
 *  - Markdown 表格
 *  - 简易 Excel（HTML 表格格式，可被 Excel 打开）
 *
 * 设计原则：
 *  - 纯函数，无外部依赖
 *  - 所有函数输入 columns + rows，输出字符串
 *  - 安全：特殊字符转义，防止 CSV 注入
 *
 * @module export
 */

// ── CSV 导出 ──────────────────────────────────────────────────────────────

/**
 * 将查询结果导出为 CSV 字符串。
 *
 * @param {string[]} columns - 列名
 * @param {Array<object>} rows - 数据行
 * @param {object} [options]
 * @param {string} [options.delimiter=','] - 分隔符
 * @param {string} [options.lineEnding='\n'] - 行尾符
 * @param {boolean} [options.includeHeader=true] - 是否包含表头
 * @param {number} [options.maxRows=0] - 最大行数（0=不限制）
 * @returns {string} CSV 内容
 */
export function toCSV(columns, rows, options = {}) {
  const {
    delimiter = ',',
    lineEnding = '\n',
    includeHeader = true,
    maxRows = 0,
  } = options

  if (!Array.isArray(columns) || columns.length === 0) return ''
  if (!Array.isArray(rows)) rows = []

  const lines = []

  // 表头
  if (includeHeader) {
    lines.push(columns.map(c => escapeCsvField(String(c), delimiter)).join(delimiter))
  }

  // 数据行
  const dataRows = maxRows > 0 ? rows.slice(0, maxRows) : rows
  for (const row of dataRows) {
    const cells = columns.map(c => {
      const val = row[c]
      return escapeCsvField(formatCellValue(val), delimiter)
    })
    lines.push(cells.join(delimiter))
  }

  return lines.join(lineEnding)
}

function escapeCsvField(field, delimiter) {
  if (field === null || field === undefined) return ''
  const str = String(field)
  // 如果包含分隔符、换行符或引号，需要用引号包裹
  if (str.includes(delimiter) || str.includes('\n') || str.includes('\r') || str.includes('"')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  // 防止 CSV 注入：以 = + - @ 开头的值前加单引号
  if (/^[=+\-@\t\r]/.test(str)) {
    return "'" + str
  }
  return str
}

function formatCellValue(val) {
  if (val === null || val === undefined) return ''
  if (typeof val === 'bigint') return val.toString()
  if (val instanceof Date) return val.toISOString()
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) return val.toString('base64')
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

// ── TSV 导出 ──────────────────────────────────────────────────────────────

/**
 * 将查询结果导出为 TSV 字符串（Tab 分隔）。
 * TSV 更适合粘贴到 Excel。
 *
 * @param {string[]} columns
 * @param {Array<object>} rows
 * @param {object} [options]
 * @returns {string} TSV 内容
 */
export function toTSV(columns, rows, options = {}) {
  return toCSV(columns, rows, { ...options, delimiter: '\t' })
}

// ── Markdown 表格 ─────────────────────────────────────────────────────────

/**
 * 将查询结果导出为 Markdown 表格。
 *
 * @param {string[]} columns
 * @param {Array<object>} rows
 * @param {object} [options]
 * @param {number} [options.maxRows=50] - 最大行数
 * @param {number} [options.maxColWidth=40] - 列最大显示宽度
 * @returns {string} Markdown 表格
 */
export function toMarkdownTable(columns, rows, options = {}) {
  const { maxRows = 50, maxColWidth = 40 } = options
  if (!Array.isArray(columns) || columns.length === 0) return ''
  if (!Array.isArray(rows)) rows = []

  const lines = []

  // 计算每列最大宽度
  const widths = columns.map(c => Math.min(String(c).length, maxColWidth))
  const displayRows = rows.slice(0, maxRows)
  for (const row of displayRows) {
    for (let i = 0; i < columns.length; i++) {
      const len = Math.min(String(formatCellValue(row[columns[i]])).length, maxColWidth)
      if (len > widths[i]) widths[i] = len
    }
  }

  // 表头
  const header = columns.map((c, i) => padRight(String(c), widths[i])).join(' | ')
  lines.push('| ' + header + ' |')

  // 分隔线
  const sep = columns.map((_, i) => '-'.repeat(Math.max(3, widths[i]))).join(' | ')
  lines.push('| ' + sep + ' |')

  // 数据行
  for (const row of displayRows) {
    const cells = columns.map((c, i) => {
      const val = formatCellValue(row[c])
      return padRight(truncate(val, maxColWidth), widths[i])
    })
    lines.push('| ' + cells.join(' | ') + ' |')
  }

  if (rows.length > maxRows) {
    lines.push('')
    lines.push('*（共 ' + rows.length + ' 行，仅显示前 ' + maxRows + ' 行）*')
  }

  return lines.join('\n')
}

function padRight(str, len) {
  const s = truncate(str, len)
  return s + ' '.repeat(Math.max(0, len - s.length))
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

// ── Excel（HTML 表格格式）────────────────────────────────────────────────

/**
 * 将查询结果导出为 HTML 表格（可被 Excel/Google Sheets 打开）。
 *
 * @param {string[]} columns
 * @param {Array<object>} rows
 * @param {object} [options]
 * @param {string} [options.sheetName='Sheet1'] - 工作表名
 * @param {number} [options.maxRows=0] - 最大行数
 * @returns {string} HTML 内容
 */
export function toExcel(columns, rows, options = {}) {
  const { sheetName = 'Sheet1', maxRows = 0 } = options
  if (!Array.isArray(columns) || columns.length === 0) return ''
  if (!Array.isArray(rows)) rows = []

  const dataRows = maxRows > 0 ? rows.slice(0, maxRows) : rows

  const html = [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office"',
    ' xmlns:x="urn:schemas-microsoft-com:office:excel"',
    ' xmlns="http://www.w3.org/TR/REC-html40">',
    '<head>',
    '<meta charset="utf-8">',
    '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>',
    '<x:ExcelWorksheet><x:Name>' + escapeHtml(sheetName) + '</x:Name>',
    '<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>',
    '</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->',
    '<style>td{mso-number-format:\\@;}</style>',
    '</head><body>',
    '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:11px;">',
    // 表头
    '<thead><tr style="background:#f0f0f0;font-weight:bold;">',
    ...columns.map(c => '<td>' + escapeHtml(String(c)) + '</td>'),
    '</tr></thead>',
    '<tbody>',
    // 数据行
    ...dataRows.map(row => {
      const cells = columns.map(c => {
        const val = formatCellValue(row[c])
        return '<td>' + escapeHtml(val) + '</td>'
      })
      return '<tr>' + cells.join('') + '</tr>'
    }),
    '</tbody></table></body></html>',
  ].join('\n')

  return html
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── 通用导出入口 ──────────────────────────────────────────────────────────

/**
 * 根据格式名导出查询结果。
 *
 * @param {string} format - 'csv' | 'tsv' | 'markdown' | 'excel'
 * @param {string[]} columns
 * @param {Array<object>} rows
 * @param {object} [options]
 * @returns {{ content: string, mimeType: string, extension: string }}
 */
export function exportResult(format, columns, rows, options = {}) {
  switch (format) {
    case 'csv':
      return {
        content: toCSV(columns, rows, options),
        mimeType: 'text/csv; charset=utf-8',
        extension: 'csv',
      }
    case 'tsv':
      return {
        content: toTSV(columns, rows, options),
        mimeType: 'text/tab-separated-values; charset=utf-8',
        extension: 'tsv',
      }
    case 'markdown':
    case 'md':
      return {
        content: toMarkdownTable(columns, rows, options),
        mimeType: 'text/markdown; charset=utf-8',
        extension: 'md',
      }
    case 'excel':
    case 'xlsx':
    case 'html':
      return {
        content: toExcel(columns, rows, options),
        mimeType: 'text/html; charset=utf-8',
        extension: 'html',
      }
    default:
      return {
        content: toCSV(columns, rows, options),
        mimeType: 'text/csv; charset=utf-8',
        extension: 'csv',
      }
  }
}

// ── 默认导出 ──────────────────────────────────────────────────────────────

export default {
  toCSV,
  toTSV,
  toMarkdownTable,
  toExcel,
  exportResult,
}
