# dsh-plugin-nlbi — 自然语言查询 + 商业智能报表插件

## 项目定位

DSH（DeepSeek Harness）的 MySQL 数据库连接 + 自然语言查询 + 商业智能报表插件。在 dsh-mysql 连接底座之上，提供 Text2SQL、15+ 图表类型、Dashboard 仪表盘、指标/维度管理、多维分析、自助分析、报表导出、审计日志与数据权限。

## 快速开始

```bash
# 打包
pnpm pack

# 安装到 DSH profile
dsh plugin --profile web add dsh-plugin-nlbi-0.2.0.tgz

# 重启 DSH 后生效
dsh --profile web
```

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  dsh-plugin-nlbi v0.2.0                             │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Host 层 (Node.js)                                   │
│  ┌─────────────────────────────────────────────┐    │
│  │  lib/index.js      — 插件入口 + 连接管理     │    │
│  │  lib/shared.js     — SQL 工具函数            │    │
│  │  lib/sqlsafe.js    — AST 级 SQL 安全校验     │    │
│  │  lib/text2sql.js   — Text2SQL 编排           │    │
│  │  lib/chart.js      — 图表规格生成引擎        │    │
│  │  lib/metrics.js    — 指标/维度/数据集管理    │    │
│  │  lib/dashboard.js  — Dashboard 仪表盘引擎    │    │
│  │  lib/export.js     — 数据导出引擎            │    │
│  │  lib/typert.host.js— Typert RPC 清单         │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  Client 层 (浏览器, React 18)                        │
│  ┌─────────────────────────────────────────────┐    │
│  │  lib/client.js — 单文件浏览器 bundle        │    │
│  │  (React.createElement, 无 JSX)              │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  通信: Typert RPC (remote.mysql.*)                  │
│                                                      │
└─────────────────────────────────────────────────────┘
```

## 核心模块详解

### 1. 数据接入 (lib/index.js)

**职责**：MySQL 连接池管理、会话级连接选择、全局 Agent 工具注册、动态 systemPrompt 注入

**关键函数**：
- `apply(ctx)` — 插件入口，注册工具、服务、systemPrompt 上下文
- `execCtx(exec)` — 工具执行前置：解析会话 → 选中连接 → 连接池
- `runQuery(pool, sql, params)` — 查询执行 + 行数截断 + JSON 安全转换
- `sanitizeForBoundary(value)` — 递归 JSON 安全清洗（Date/BigInt/NaN → 基础类型）

**全局工具（所有 Agent 预设可见）**：
| 工具 | 用途 | 时限 |
|------|------|------|
| `mysql_query` | 只读 SELECT/SHOW/DESCRIBE/EXPLAIN | 30s |
| `mysql_tables` | 查看表结构（information_schema） | 15s |
| `mysql_execute` | INSERT/UPDATE/DELETE（需写权限） | 30s |
| `nl_query` | 自然语言 → SQL → 执行 → 结果+图表 | 60s |
| `sql_to_chart` | 对查询结果生成图表规格 | 10s |

**RPC 服务方法（39 个）**：
连接管理（7 个）：`listConnections` `getSelection` `selectConnection` `saveConnection` `deleteConnection` `testConnection` `listTables`
Text2SQL/BI（3 个）：`nlQuery` `schemaTree` `tablePreview`
报表（4 个）：`listReports` `saveReport` `deleteReport` `rerunReport`
指标/维度/数据集（10 个）：`listMetrics` `saveMetric` `deleteMetric` `listDimensions` `saveDimension` `deleteDimension` `listDatasets` `saveDataset` `deleteDataset` `getMetricSuggestions`
Dashboard（11 个）：`listDashboards` `getDashboard` `saveDashboard` `deleteDashboard` `duplicateDashboard` `addWidget` `updateWidget` `removeWidget` `moveWidget` `updateDashboardFilters` `executeDashboardQuery` `getDrillDown`
导出/审计/权限（3 个）：`exportData` `getAuditLog` `updatePermissions`

### 2. SQL 安全 (lib/sqlsafe.js + shared.js)

**双层安全模型**：
- **AST 层**（node-sql-parser）：精确解析 SQL 结构，提取表名、列信息
- **正则层**（shared.js）：降级方案，处理 AST 解析失败的场景

**关键函数**：
- `validateAndPrepare(sql, options)` — 一站式安全校验：基本检查 → 多语句检测 → 只读校验 → 表白名单 → LIMIT 注入 → 超时提示
- `classifyStatementAst(sql)` — AST 级语句分类（read/write-dml/ddl/dcl）
- `checkReadOnly(sql)` — 只读校验（识别 UNION/子查询等复合类型）
- `injectLimit(sql, maxRows)` — 自动补 LIMIT / 改写过大 LIMIT
- `stripSqlComments(sql)` — 去掉 SQL 注释（字符串原样保留）
- `classifyStatement(sql)` — 正则级语句分类（read/write-dml/forbidden）
- `checkTableAllowlist(sql, allowlist)` — 表白名单校验
- `jsonSafe(value)` — 安全 JSON 转换（Date/BigInt/Buffer 安全）

### 3. Text2SQL (lib/text2sql.js)

**流水线**：
1. 获取 Schema 结构（information_schema）
2. 构建 Prompt（system 规则 + 指标/维度上下文 + few-shot 示例 + 用户问题）
3. 调用 LLM（DSH 标准模型服务，支持回退到旧版 model.chat 和 OpenAI API）
4. 解析 LLM 返回 JSON（{sql, explain, chartType, analysisType}）
5. 安全校验（validateAndPrepare）
6. 执行查询，返回格式化结果

**关键函数**：
- `text2sql(ctx, question, connection, pool, options)` — 完整 Text2SQL 流水线
- `buildPrompt({question, schema, connectionName, databaseName})` — Prompt 构建（含指标/维度上下文注入）
- `parseLlmResult(raw)` — 解析 LLM 输出（支持纯 JSON / 代码块 / 宽松格式）
- `callLlm(ctx, prompt, options)` — LLM 调用（三层降级：llm.stream → model.chat → OpenAI API）

**Few-shot 示例**（7 个）：
- 查询所有用户 → stat
- 上个月每天新增用户 → line
- 订单金额最高前10用户 → bar
- 各分类商品数量 → pie
- 各地区销售额占比 → pie
- 用户注册漏斗 → funnel
- 价格和销量关系 → scatter

### 4. 图表引擎 (lib/chart.js)

**15+ 图表类型**：
`bar` `line` `pie` `stat` `funnel` `scatter` `heatmap` `radar` `sankey` `gauge` `treemap` `area` `stackedBar` `waterfall` `progress`

**推断规则**：
- 1 列数值 → stat 统计卡
- 时间 + 数值 → line 折线图
- 类目 + 数值（低基数 ≤12）→ pie 饼图
- 类目 + 数值（高基数）→ bar 柱状图
- 多数值列 → 分组 bar/line
- 强制指定 → 用户指定图表类型

**多维分析函数**：
- `computeYoYGrowth(current, previous)` — 同比增长率
- `computeMoMGrowth(current, previous)` — 环比增长率
- `computeCumulative(rows, valueField, dateField)` — 累计值
- `computeMovingAverage(rows, valueField, window, dateField)` — 移动平均
- `computeTopN(rows, valueField, n, order)` — Top N 排名
- `computeRanking(rows, valueField, rankField)` — 排名
- `computeGrowthRate(current, previous)` — 增长率

### 5. 指标/维度/数据集管理 (lib/metrics.js)

**数据模型**：
- **指标**：{id, name, expression, sourceTable, sourceColumn, type(sum/count/avg/min/max/derived), format(currency/number/percent), description, createdAt, updatedAt}
- **维度**：{id, name, sourceTable, sourceColumn, type(string/date/number), hierarchy[], description}
- **数据集**：{id, name, connectionId, tables[], joins[{from, to, type}], metrics[], dimensions[], description}

**关键函数**：
- `listMetrics()` / `saveMetric(input)` / `deleteMetric(id)` / `getMetricById(id)`
- `listDimensions()` / `saveDimension(input)` / `deleteDimension(id)` / `getDimensionById(id)`
- `listDatasets()` / `saveDataset(input)` / `deleteDataset(id)` / `getDatasetById(id)`
- `buildMetricExpression(metric, alias)` — 生成 SQL 表达式片段
- `buildDimensionSql(dimension, tableAlias)` — 生成 SELECT/GROUP BY 片段
- `buildDatasetFromClause(dataset)` — 生成 FROM + JOIN 子句
- `inferDimensions(columns, rows)` — 从查询结果推断维度
- `inferMetrics(columns, rows)` — 从查询结果推断指标
- `buildMetricsContext()` — 生成指标上下文文本（注入 Text2SQL prompt）

### 6. Dashboard 仪表盘 (lib/dashboard.js)

**数据模型**：
- **Dashboard**：{id, name, description, connectionId, layout{columns, rowHeight, gap}, widgets[], filters[], theme, autoRefresh}
- **Widget**：{id, type(kpi/chart/table/text), title, query, chartType, position{x,y,w,h}, refreshInterval, drillDown, linkedFilters[]}
- **Filter**：{id, type(select/dateRange/text/number), label, dimension, defaultValue, options}

**关键函数**：
- `listDashboards()` / `getDashboard(id)` / `saveDashboard(input)` / `deleteDashboard(id)` / `duplicateDashboard(id)`
- `addWidget(dashboardId, widget)` / `updateWidget(dashboardId, widgetId, patch)` / `removeWidget(dashboardId, widgetId)` / `moveWidget(dashboardId, widgetId, position)`
- `updateFilters(dashboardId, filters)`
- `injectFilterConditions(sql, filters, filterValues)` — 筛选条件注入 SQL
- `executeDashboardQueries(pool, dashboard, filterValues)` — 并行执行所有 widget 查询
- `buildDrillDownQuery(baseQuery, dimension, value)` — 构建下钻查询

### 7. 数据导出 (lib/export.js)

**支持格式**：CSV / TSV / Markdown 表格 / Excel（HTML 格式）

**关键函数**：
- `toCSV(columns, rows, options)` — CSV 导出（含注入防护）
- `toTSV(columns, rows, options)` — TSV 导出
- `toMarkdownTable(columns, rows, options)` — Markdown 表格
- `toExcel(columns, rows, options)` — HTML 表格（兼容 Excel/WPS）
- `exportResult(format, columns, rows, options)` — 统一导出入口

### 8. 前端 UI (lib/client.js)

**组件架构**（单文件，2715 行，React.createElement，无 JSX）：
```
apply()
├── slots.inject('conversation.input.left')  → MysqlControl
├── slots.inject('conversation.output')      → NlbiOutputRenderer
├── ctx.inject(['betterSidebar'])            → NlbiSidebarWorkbench
│   ├── NlbiQueryConsole        — 智能查询（动态推荐查询）
│   ├── NlbiBrowseArea          — 数据浏览（SchemaTree + GridPanel）
│   ├── NlbiReportsArea         — 报表管理
│   ├── NlbiDashboardClient     — 仪表盘管理
│   ├── NlbiMetricsManager      — 指标管理
│   ├── NlbiSelfServicePanel    — 自助分析
│   └── NlbiAuditLogPanel       — 审计日志
├── NlbiRenderResult            — BI 结果渲染（SQL + 表格 + 图表）
├── NlbiChart                   — ECharts 渲染（15+ 图表类型）
├── NlbiDashboardEditor         — Dashboard 编辑器（网格布局）
├── NlbiDashboardViewer         — Dashboard 查看器
├── NlbiExportButtons           — 导出按钮组
└── NlbiChartTypeSelector       — 图表类型选择器
```

**CSS 主题变量**：所有样式使用 `--dsw-*` 变量，随 DSH 全局亮/暗模式自动适配

## 测试

```bash
# 运行所有测试
for f in test/*.test.mjs; do node "$f"; done

# 运行单个测试
node test/integration.test.mjs    # 集成测试（51 个用例）
node test/metrics.test.mjs        # 指标管理测试（43 个用例）
node test/chart-v2.test.mjs       # 图表引擎测试（39 个用例）
node test/dashboard.test.mjs      # Dashboard 测试（36 个用例）
node test/sqlsafe.test.mjs        # SQL 安全测试（26 个用例）
node test/export.test.mjs         # 导出测试（21 个用例）
node test/chart.test.mjs          # 基础图表测试（18 个用例）
node test/shared.test.mjs         # 工具函数测试（13 个用例）
node test/text2sql.test.mjs       # Text2SQL 测试（12 个用例）
node test/client-load.test.mjs    # 客户端加载模拟测试

# 语法检查
for f in lib/*.js; do node --check "$f" && echo "OK: $f" || echo "FAIL: $f"; done
```

### 8.1 专业交付验收与故障排查

#### 标准测试命令

```bash
# 全部自动化测试
for f in test/*.test.mjs; do node "$f"; done

# 专项回归
node test/dashboard-fixes.test.mjs
node test/reports-fixes.test.mjs
node test/client-load.test.mjs

# 全部语法检查
for f in lib/*.js; do node --check "$f"; done
```

交付门槛：所有测试退出码为 0；集成测试必须 51/51；客户端加载测试必须成功注册 NLBI 侧栏及会话 slots。

#### dsh-test 真实数据库验收

`dsh-test` 使用数据库 `dsh_test`，标准只读验收覆盖 4 张表：`users`（50 行）、`orders`（150 行）、`products`（60 行）、`order_items`（367 行）。推荐查询：

```sql
SELECT COUNT(*) AS total_users FROM users;
SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       COUNT(*) AS order_count, SUM(amount) AS total_amount
FROM orders GROUP BY month ORDER BY month;
SELECT p.category, SUM(oi.quantity * oi.price) AS sales
FROM order_items oi JOIN products p ON p.id = oi.product_id
GROUP BY p.category ORDER BY sales DESC;
SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC;
```

四条查询必须可执行；验收只读，不修改 dsh_test 数据，不记录或输出数据库密码。

#### 专项验收标准

- **TC-3.3 报表列表**：保存报表后重新挂载/刷新必须显示卡片；真实空数组才显示“暂无收藏报表”；RPC、JSON、IO 错误必须显示“报表列表加载失败”。报表文件格式为 `{ "reports": [] }`。
- **TC-4.3 图表 Widget**：查询前必须经过 `validateAndPrepare()`；返回 `columns`、`rows` 和完整 `chartSpec`（至少 `type/title/data`，笛卡尔图表还需 `xField/yFields`）；单 Widget 失败不能阻塞其他 Widget。
- **编辑实时更新**：使用 `editingWidgetId` 查找最新 Widget，状态更新必须使用函数式写法，标题、类型、SQL、图表类型不能回退。
- **保存有效**：保存成功使用服务端归一化 Dashboard 更新查看器；失败留在编辑模式并显示错误；无连接时禁止保存。
- **模式回退**：查看器和编辑器都必须有“← 返回列表”，不依赖浏览器后退。

#### DSH Web 启动故障排查经验

- `cannot resolve profile bundle` 通常表示 profile 的 `node_modules` 未安装、链接断裂或 bundle 无对应包。检查 `dsh --profile web --dump-config`、profile 实际目录和 `node_modules/<package>/package.json`。
- 本地 `link:` 插件必须指向有效目录；源码插件如 `dsh-better-sidebar` 必须先执行 `pnpm install`/`pnpm build` 生成 `lib/index.js`。
- GitHub/npm 安装失败先检查 Clash/registry 网络；不要只修改 bundles 隐藏缺包。
- `Cannot find package '@deepseek-ai/dsh-tools'`、`dsh-llm`、`dsh-settings` 等时，必须让 peer 依赖从同一 DSH 安装闭包解析，不要混装不匹配版本。
- `EADDRINUSE 127.0.0.1:3080` 表示已有 DSH 进程；用 `netstat -ano | findstr :3080` 找 PID，确认后结束旧进程再启动。
- `duplicate prefix route` 表示插件重复挂载；若聚合 UI 已包含 `dsh-better-sidebar`，不能再单独加入同一 bundle。
- 成功判据：输出 `dsh web: http://127.0.0.1:3080`、3080 处于 LISTENING，NLBI 日志含 `host mounted`、`tools registered`、`service mysql provided`、`apply complete`。

#### 自动化测试经验

- 客户端是 React.createElement 单文件 bundle，UI 测试使用 `client-load.test.mjs` 的浏览器/React/Host mock。
- 后端存储测试用临时 `DSH_HOME`，结束必须清理。
- Dashboard 查询必须覆盖成功、空 SQL、非法 SQL、异常及多 Widget 单点失败隔离。
- 前端不能把 RPC 异常转换成空数组；加载、错误、空、数据四种状态必须分别断言。
- 真实 dsh_test 验收只使用只读 SQL；JOIN 必须验证表白名单和结果列。


### 代码风格
- ES Modules（`"type": "module"`）
- 所有 React 组件使用 `React.createElement`（无 JSX）
- 前端代码全部在 `client.js` 单文件中（DSH __ModuleLoader__ 约束）
- 无构建工具，代码直接运行

### 命名约定
- 文件：kebab-case（`lib/chart.js`）
- 函数：camelCase（`suggestChartSpec`）
- 组件：PascalCase + Nlbi 前缀（`NlbiSidebarWorkbench`）
- 常量：UPPER_SNAKE_CASE（`MAX_ROWS`）
- CSS 类：`dsh-nlbi-` 前缀（`dsh-nlbi-dash-grid`）

### 错误处理
- 所有 RPC 服务返回 `{ ok: true, ... }` 或 `{ ok: false, error: "..." }`
- 边界值通过 `sanitizeForBoundary()` 清洗（防止 NaN/Date 被 Typert 网关拒绝）
- 所有 slots 注册用 try-catch 保护，单个失败不影响其他
- 前端组件渲染用 try-catch 保护，渲染失败显示友好提示

### 安全规范
- 所有 SQL 执行前必须经过 `validateAndPrepare()` 校验
- 拒绝多语句、DDL、DCL 操作
- 表白名单：空名单 = 不限制，非空则强制校验
- 写操作需显式开启 allowWrite（默认关闭）
- LIMIT 自动注入（默认 2000 行）
- MAX_EXECUTION_TIME 优化器提示（默认 15s）
- CSV 导出防注入（`= + - @` 前缀自动转义）

## 依赖

| 依赖 | 用途 | 版本 |
|------|------|------|
| mysql2 | MySQL 数据库驱动 | ^3.11.0 |
| node-sql-parser | SQL AST 解析与校验 | ^5.4.0 |
| zod | Typert 网关 schema 校验 | ^4.4.3 |
| @deepseek-ai/cordis | DSH 插件框架（peer） | ^4.0.1 |
| react | 前端 UI（peer） | ^18.2.0 |

## 环境要求

- Node.js >= 18
- pnpm（推荐）或 npm
- DSH >= 0.1.1-rc.1
- MySQL 5.7+ / 8.0+

## 发布

```bash
# 更新版本号
pnpm version patch   # 0.2.0 → 0.2.1
pnpm version minor   # 0.2.0 → 0.3.0
pnpm version major   # 0.2.0 → 1.0.0

# 打包
pnpm pack

# 发布（待配置）
npm publish
```

## 项目文件清单

```
dsh-plugin-nlbi/
├── lib/
│   ├── index.js          — 插件入口 + 连接管理 + RPC 服务（~1250 行）
│   ├── shared.js         — SQL 工具函数（~210 行）
│   ├── sqlsafe.js        — AST 级 SQL 安全校验（~440 行）
│   ├── text2sql.js       — Text2SQL 编排（~800 行）
│   ├── chart.js          — 图表规格生成引擎（~650 行）
│   ├── metrics.js        — 指标/维度/数据集管理（~400 行）
│   ├── dashboard.js      — Dashboard 仪表盘引擎（~350 行）
│   ├── export.js         — 数据导出引擎（~150 行）
│   ├── typert.host.js    — Typert RPC 清单（~265 行）
│   └── client.js         — 浏览器端 bundle（~2715 行）
├── test/
│   ├── integration.test.mjs    — 集成测试（51 用例）
│   ├── metrics.test.mjs        — 指标管理测试（43 用例）
│   ├── chart-v2.test.mjs       — 图表引擎测试（39 用例）
│   ├── dashboard.test.mjs      — Dashboard 测试（36 用例）
│   ├── sqlsafe.test.mjs        — SQL 安全测试（26 用例）
│   ├── export.test.mjs         — 导出测试（21 用例）
│   ├── chart.test.mjs          — 基础图表测试（18 用例）
│   ├── shared.test.mjs         — 工具函数测试（13 用例）
│   ├── text2sql.test.mjs       — Text2SQL 测试（12 用例）
│   └── client-load.test.mjs    — 客户端加载模拟测试
├── package.json
├── cordis.patch.yml
├── README.md
├── README.zh-CN.md
├── CHANGELOG.md
├── UPGRADE.md
└── CLAUDE.md
```