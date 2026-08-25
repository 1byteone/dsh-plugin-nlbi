/**
 * dsh-plugin-nlbi Typert 清单（Host 侧）。
 * 基于 dsh-mysql (v0.1.4)；保持 `mysql` service 命名以兼容既有 Client 调用，
 * package 字段更新为本包名（必须 == package.json 的 name）。
 * 由 @deepseek-ai/dsh-typert-loader 解析 exports["./typert"] 后自动注册，
 * 并逐字段强校验（loader：dsh-typert-loader/lib/index.js validateTypertManifest）：
 *  - package 必须等于包名；
 *  - face 必须严格为 "host"；
 *  - codec schema 必须是 zod v4 实例（含 _zod + parse）；
 *  - TYPERT.model 必须存在（services/events/objects 至少是空数组）——
 *    缺失会导致整个 typert-loader 行激活失败、所有插件的 RPC 路由不可用。
 * zod 因此放在 dependencies。
 */
import { z } from 'zod'

const args$codec = { mode: 'strict', typeSymbol: 'dsh-plugin-nlbi#Args', schema: z.record(z.string(), z.unknown()) }
const result$codec = { mode: 'strict', typeSymbol: 'dsh-plugin-nlbi#Result', schema: z.record(z.string(), z.unknown()) }

const invocation = (method) => ({
  id: 'mysql/' + method,
  service: 'mysql',
  namespace: 'mysql',
  method,
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'args', wire: 'args', source: 'json', codec: args$codec },
  ],
  result: result$codec,
})

const member = (name, signature, summary, jsDoc) => ({
  kind: 'method',
  name,
  signature,
  summary,
  jsDoc,
})

export const TYPERT = {
  package: 'dsh-plugin-nlbi', // 必须 == package.json 的 name
  face: 'host',         // 必须严格 "host"
  schemas: [],
  invocations: [
    invocation('listConnections'),
    invocation('getSelection'),
    invocation('selectConnection'),
    invocation('saveConnection'),
    invocation('deleteConnection'),
    invocation('testConnection'),
    invocation('listTables'),
    // ★ 新增：Text2SQL / BI / 报表
    invocation('nlQuery'),
    invocation('schemaTree'),
    invocation('tablePreview'),
    invocation('listReports'),
    invocation('saveReport'),
    invocation('deleteReport'),
    invocation('rerunReport'),
    // ★ 新增：指标/维度/数据集
    invocation('listMetrics'),
    invocation('saveMetric'),
    invocation('deleteMetric'),
    invocation('listDimensions'),
    invocation('saveDimension'),
    invocation('deleteDimension'),
    invocation('listDatasets'),
    invocation('saveDataset'),
    invocation('deleteDataset'),
    invocation('getMetricSuggestions'),
    // ★ 新增：Dashboard
    invocation('listDashboards'),
    invocation('getDashboard'),
    invocation('saveDashboard'),
    invocation('deleteDashboard'),
    invocation('duplicateDashboard'),
    invocation('addWidget'),
    invocation('updateWidget'),
    invocation('removeWidget'),
    invocation('moveWidget'),
    invocation('updateDashboardFilters'),
    invocation('executeDashboardQuery'),
    invocation('getDrillDown'),
    // ★ 新增：导出 / 审计 / 权限
    invocation('exportData'),
    invocation('getAuditLog'),
    invocation('updatePermissions'),
  ],
  model: {
    services: [
      {
        description: 'dsh-plugin-nlbi MySQL 连接 + Text2SQL + BI 报表服务 (ctx.mysql)：连接 CRUD、连通性测试、会话级选择、表列表、自然语言查库、Schema 树、数据网格预览与报表收藏。NLBI service: connection management, Text2SQL, schema browsing, data grid, and BI reports.',
        summary: 'dsh-plugin-nlbi 数据库服务 (dsh-plugin-nlbi database service)。',
        tags: [],
        jsDoc: '/** dsh-plugin-nlbi 数据库服务 (ctx.mysql)：连接管理 + Text2SQL + BI。dsh-plugin-nlbi database service (ctx.mysql): connections, Text2SQL and BI. */',
        key: 'mysql',
        exportName: 'MysqlService',
        members: [
          member(
            'listConnections',
            'listConnections(): Promise<object>',
            '列出全部连接的安全视图（不含密码）。List all connections without passwords.',
            '/**\n * 列出全部连接（安全视图：密码仅回传 hasPassword）。\n * @returns { ok:true, connections } 或 { ok:false, error }\n */',
          ),
          member(
            'getSelection',
            'getSelection(args: object): Promise<object>',
            '读取会话当前选中的连接与全部连接列表。Read the session selection and the connection list.',
            '/**\n * @param args - { sessionId }\n * @returns { ok:true, connectionId, connections } 或 { ok:false, error }\n */',
          ),
          member(
            'selectConnection',
            'selectConnection(args: object): Promise<object>',
            '为当前会话切换连接（会话级）。Switch the connection for a session.',
            '/**\n * @param args - { sessionId, connectionId }\n * @returns { ok:true, connectionId, name } 或 { ok:false, error }\n */',
          ),
          member(
            'saveConnection',
            'saveConnection(args: object): Promise<object>',
            '新增或更新连接（编辑时密码留空 = 保留原密码）。Create or update a connection.',
            '/**\n * @param args - { connection: { id?, name, host, port, user, password, database, tables, allowWrite } }\n * @returns { ok:true, connection } 或 { ok:false, error }\n */',
          ),
          member(
            'deleteConnection',
            'deleteConnection(args: object): Promise<object>',
            '删除连接并回收其连接池与会话选择。Delete a connection, its pool and selections.',
            '/**\n * @param args - { connectionId }\n * @returns { ok:true } 或 { ok:false, error }\n */',
          ),
          member(
            'testConnection',
            'testConnection(args: object): Promise<object>',
            '测试已保存连接或未保存的表单草稿连通性。Test a saved connection or a form draft.',
            '/**\n * @param args - { connectionId } 或 { connection: 草稿 }\n * @returns { ok:true, latencyMs } 或 { ok:false, error }\n */',
          ),
          member(
            'listTables',
            'listTables(args: object): Promise<object>',
            '读取连接可读表列表（information_schema，受白名单约束）。List readable tables for a connection.',
            '/**\n * @param args - { connectionId }\n * @returns { ok:true, tables } 或 { ok:false, error }\n */',
          ),
          // ★ 新增成员
          member(
            'nlQuery',
            'nlQuery(args: object): Promise<object>',
            '自然语言查库（Text2SQL）：自动生成 SQL、安全校验并执行，返回表格与图表建议。Natural-language database query.',
            '/**\n * @param args - { sessionId, question }\n * @returns { ok:true, sql, explain, result, chart } 或 { ok:false, error }\n */',
          ),
          member(
            'schemaTree',
            'schemaTree(args: object): Promise<object>',
            '读取连接的表结构导航树（库→表→列，受白名单约束）。Read the schema tree for a connection.',
            '/**\n * @param args - { connectionId }\n * @returns { ok:true, database, tables } 或 { ok:false, error }\n */',
          ),
          member(
            'tablePreview',
            'tablePreview(args: object): Promise<object>',
            '表数据网格预览（分页/排序/过滤，受护栏约束）。Preview table data with paging/sorting/filtering.',
            '/**\n * @param args - { connectionId, table, page, pageSize, sortColumn, sortOrder, where }\n * @returns { ok:true, columns, rows, page, pageSize, total, totalPages } 或 { ok:false, error }\n */',
          ),
          member(
            'listReports',
            'listReports(args?: object): Promise<object>',
            '列出已收藏的 BI 报表。List saved BI reports.',
            '/**\n * @returns { ok:true, reports } 或 { ok:false, error }\n */',
          ),
          member(
            'saveReport',
            'saveReport(args: object): Promise<object>',
            '收藏一个 BI 报表（名称+问题+SQL+图表配置）。Save a BI report.',
            '/**\n * @param args - { report: { id?, name, question, connectionId, sql, chart } }\n * @returns { ok:true, report } 或 { ok:false, error }\n */',
          ),
          member(
            'deleteReport',
            'deleteReport(args: object): Promise<object>',
            '删除一个已收藏的 BI 报表。Delete a saved BI report.',
            '/**\n * @param args - { reportId }\n * @returns { ok:true } 或 { ok:false, error }\n */',
          ),
          member(
            'rerunReport',
            'rerunReport(args: object): Promise<object>',
            '重新执行某报表的 SQL（同护栏），返回最新数据与图表。Re-run a saved report.',
            '/**\n * @param args - { reportId }\n * @returns { ok:true, sql, result, chart } 或 { ok:false, error }\n */',
          ),
          // ★ 新增成员：指标/维度/数据集
          member(
            'listMetrics',
            'listMetrics(): Promise<object>',
            '列出全部已定义的业务指标。List all defined business metrics.',
            '/**\n * @returns { ok:true, metrics } 或 { ok:false, error }\n */',
          ),
          member(
            'saveMetric',
            'saveMetric(args: object): Promise<object>',
            '新增或更新业务指标定义。Create or update a business metric.',
            '/**\n * @param args - { metric: { id?, name, expression, sourceTable, sourceColumn, type, format, description } }\n * @returns { ok:true, metric } 或 { ok:false, error }\n */',
          ),
          member(
            'deleteMetric',
            'deleteMetric(args: object): Promise<object>',
            '删除一个业务指标。Delete a business metric.',
            '/**\n * @param args - { metricId }\n * @returns { ok:true } 或 { ok:false, error }\n */',
          ),
          member(
            'listDimensions',
            'listDimensions(): Promise<object>',
            '列出全部已定义的分析维度。List all defined analysis dimensions.',
            '/**\n * @returns { ok:true, dimensions } 或 { ok:false, error }\n */',
          ),
          member(
            'saveDimension',
            'saveDimension(args: object): Promise<object>',
            '新增或更新分析维度定义。Create or update an analysis dimension.',
            '/**\n * @param args - { dimension: { id?, name, sourceTable, sourceColumn, type, hierarchy, description } }\n * @returns { ok:true, dimension } 或 { ok:false, error }\n */',
          ),
          member(
            'deleteDimension',
            'deleteDimension(args: object): Promise<object>',
            '删除一个分析维度。Delete an analysis dimension.',
            '/**\n * @param args - { dimensionId }\n * @returns { ok:true } 或 { ok:false, error }\n */',
          ),
          member(
            'listDatasets',
            'listDatasets(): Promise<object>',
            '列出全部已定义的数据集。List all defined datasets.',
            '/**\n * @returns { ok:true, datasets } 或 { ok:false, error }\n */',
          ),
          member(
            'saveDataset',
            'saveDataset(args: object): Promise<object>',
            '新增或更新数据集定义。Create or update a dataset.',
            '/**\n * @param args - { dataset: { id?, name, connectionId, tables, joins, metrics, dimensions } }\n * @returns { ok:true, dataset } 或 { ok:false, error }\n */',
          ),
          member(
            'deleteDataset',
            'deleteDataset(args: object): Promise<object>',
            '删除一个数据集。Delete a dataset.',
            '/**\n * @param args - { datasetId }\n * @returns { ok:true } 或 { ok:false, error }\n */',
          ),
          member(
            'getMetricSuggestions',
            'getMetricSuggestions(args: object): Promise<object>',
            '根据当前连接的表结构推荐指标候选。Get metric suggestions from table schema.',
            '/**\n * @param args - { connectionId }\n * @returns { ok:true, suggestions } 或 { ok:false, error }\n */',
          ),
          // ★ 新增成员：Dashboard
          member(
            'listDashboards',
            'listDashboards(): Promise<object>',
            '列出全部 Dashboard。List all dashboards.',
            '/**\n * @returns { ok:true, dashboards } 或 { ok:false, error }\n */',
          ),
          member(
            'getDashboard',
            'getDashboard(args: object): Promise<object>',
            '获取单个 Dashboard 详情。Get a dashboard by ID.',
            '/**\n * @param args - { dashboardId }\n * @returns { ok:true, dashboard } 或 { ok:false, error }\n */',
          ),
          member(
            'saveDashboard',
            'saveDashboard(args: object): Promise<object>',
            '新增或更新 Dashboard。Create or update a dashboard.',
            '/**\n * @param args - { dashboard: { id?, name, description, connectionId, layout, widgets, filters, theme, autoRefresh } }\n * @returns { ok:true, dashboard } 或 { ok:false, error }\n */',
          ),
          member(
            'deleteDashboard',
            'deleteDashboard(args: object): Promise<object>',
            '删除 Dashboard。Delete a dashboard.',
            '/**\n * @param args - { dashboardId }\n * @returns { ok:true } 或 { ok:false, error }\n */',
          ),
          member(
            'duplicateDashboard',
            'duplicateDashboard(args: object): Promise<object>',
            '复制 Dashboard。Duplicate a dashboard.',
            '/**\n * @param args - { dashboardId }\n * @returns { ok:true, dashboard } 或 { ok:false, error }\n */',
          ),
          member(
            'addWidget',
            'addWidget(args: object): Promise<object>',
            '向 Dashboard 添加组件。Add a widget to a dashboard.',
            '/**\n * @param args - { dashboardId, widget }\n * @returns { ok:true, widget } 或 { ok:false, error }\n */',
          ),
          member(
            'updateWidget',
            'updateWidget(args: object): Promise<object>',
            '更新 Dashboard 组件。Update a widget in a dashboard.',
            '/**\n * @param args - { dashboardId, widgetId, patch }\n * @returns { ok:true, widget } 或 { ok:false, error }\n */',
          ),
          member(
            'removeWidget',
            'removeWidget(args: object): Promise<object>',
            '删除 Dashboard 组件。Remove a widget from a dashboard.',
            '/**\n * @param args - { dashboardId, widgetId }\n * @returns { ok:true } 或 { ok:false, error }\n */',
          ),
          member(
            'moveWidget',
            'moveWidget(args: object): Promise<object>',
            '移动 Dashboard 组件位置。Move a widget position.',
            '/**\n * @param args - { dashboardId, widgetId, position: { x, y, w, h } }\n * @returns { ok:true, widget } 或 { ok:false, error }\n */',
          ),
          member(
            'updateDashboardFilters',
            'updateDashboardFilters(args: object): Promise<object>',
            '更新 Dashboard 全局筛选器。Update dashboard global filters.',
            '/**\n * @param args - { dashboardId, filters }\n * @returns { ok:true, filters } 或 { ok:false, error }\n */',
          ),
          member(
            'executeDashboardQuery',
            'executeDashboardQuery(args: object): Promise<object>',
            '执行 Dashboard 中所有组件的查询。Execute all widget queries in a dashboard.',
            '/**\n * @param args - { dashboardId, filterValues }\n * @returns { ok:true, results, errors } 或 { ok:false, error }\n */',
          ),
          member(
            'getDrillDown',
            'getDrillDown(args: object): Promise<object>',
            '执行下钻查询。Execute a drill-down query.',
            '/**\n * @param args - { sessionId, baseQuery, dimension, value }\n * @returns { ok:true, sql, result, chart } 或 { ok:false, error }\n */',
          ),
          // ★ 新增成员：导出 / 审计 / 权限
          member(
            'exportData',
            'exportData(args: object): Promise<object>',
            '导出查询结果为 CSV/TSV/Markdown/Excel 格式。Export query results.',
            '/**\n * @param args - { format, columns, rows, options }\n * @returns { ok:true, content, mimeType, extension } 或 { ok:false, error }\n */',
          ),
          member(
            'getAuditLog',
            'getAuditLog(args?: object): Promise<object>',
            '获取审计日志。Get audit log entries.',
            '/**\n * @param args - { limit, offset }\n * @returns { ok:true, entries, total } 或 { ok:false, error }\n */',
          ),
          member(
            'updatePermissions',
            'updatePermissions(args: object): Promise<object>',
            '更新连接的权限配置（行级/列级）。Update connection permissions.',
            '/**\n * @param args - { connectionId, permissions: { rowFilters, columnBlacklist, maxRows, queryTimeout } }\n * @returns { ok:true, permissions } 或 { ok:false, error }\n */',
          ),
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
