# CHANGELOG

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-08-24

### 🎉 全面升级为企业级 BI 报表系统

本次升级从「基础 Text2SQL + 简单图表」升级为覆盖 10 大模块的专业 BI 系统：
**数据接入 → 数据建模 → 指标计算 → 可视化 → Dashboard → 多维分析 → 自助分析 → 报表导出 → 权限治理 → 审计追踪**。

### ✨ 新增特性

#### 📐 数据建模层（`lib/metrics.js`，全新）
- **业务指标管理**：定义 GMV、订单数、客单价等指标（表达式/聚合类型/格式/口径说明）
- **分析维度管理**：地区、时间、商品类别等维度，支持 **层级定义**（省→市→区 → 支持下钻）
- **数据集管理**：关联表 + Join 关系 + 指标 + 维度，形成可复用分析模型
- **智能推断**：从查询结果自动识别维度和指标
- **SQL 片段构建**：根据指标/维度定义自动生成 SELECT/GROUP BY/FROM+JOIN 片段

#### 📊 可视化引擎 v2（`lib/chart.js`，重写）
- 图表类型从 **4 种扩展到 15+ 种**：
  `bar` `line` `pie` `stat` + `funnel` `scatter` `heatmap` `radar` `sankey` `gauge` `treemap` `area` `stackedBar` `waterfall` `progress`
- **多维分析函数**：同比增长、环比增长、累计值、移动平均、Top N 排名、排名、增长率
- **用户指定图表类型**：支持强制覆盖自动推断
- 增强 ECharts option 生成，覆盖所有新图表类型

#### 📐 Dashboard 仪表盘（`lib/dashboard.js`，全新）
- **完整 CRUD**：创建/读取/更新/删除/复制 Dashboard
- **Widget 管理**：添加/编辑/删除/移动组件（KPI 卡片、图表、表格、文本）
- **网格布局引擎**：12 列网格，组件可自定义位置和大小
- **全局筛选器**：select / multiSelect / dateRange / text / number 五种类型
- **筛选条件注入**：自动将筛选器值注入 SQL（WHERE / AND 逻辑处理）
- **下钻查询**：基于维度值构建下钻 SQL
- **并行查询执行**：Promise.allSettled 并行执行所有 Widget 查询，单点失败不影响整体
- **自动刷新**：支持定时刷新配置

#### 📥 数据导出（`lib/export.js`，全新）
- **CSV 导出**：含 **CSV 注入防护**（`=` `+` `-` `@` 前缀值自动转义）
- **TSV 导出**：适合直接粘贴到 Excel
- **Markdown 表格**：自动列宽计算、超长截断
- **Excel（HTML 格式）**：兼容 WPS / Office / Google Sheets
- **统一导出入口**：`exportResult(format, columns, rows)`

#### 🔍 Text2SQL 增强（`lib/text2sql.js`）
- **Prompt 升级**：注入业务指标/维度上下文
- **chartType 输出**：LLM 推荐报告图表类型（15 种可选）
- **analysisType 输出**：识别分析意图（趋势/对比/排名/占比/分布/漏斗/相关）
- **分析能力指引**：同比/环比/窗口函数/占比计算的 SQL 模式示例
- **Few-shot 扩充**：从 4 例扩到 7 例，覆盖漏斗转化/相关性/同比等场景

#### 🛡 数据权限（`lib/index.js`）
- **行级权限**：按列值过滤（`=` `!=` `IN` `LIKE` 四种操作符）
- **列级黑名单**：禁止查看敏感列
- **权限自动注入**：Text2SQL prompt + 系统上下文双重注入
- 查询超时和行数上限配置

#### 📋 审计日志（`lib/index.js`）
- 记录所有查询操作（类型/时间/耗时/成功/失败）
- 环形缓冲（最多 1000 条）
- 实时内存存储，重启后清空（有意为之，避免敏感数据落盘）

#### 🖥 前端 UI 全面升级（`lib/client.js`）
- **Dashboard 编辑器**：网格布局拖拽 + 组件编辑表单 + 全局筛选器配置
- **Dashboard 查看器**：KPI 卡片渲染 + 图表渲染 + 表格渲染 + 筛选器交互 + 自动刷新
- **Dashboard 列表**：卡片式管理
- **图表类型选择器**：15+ 种图表类型手动切换
- **指标管理面板**：指标 CRUD
- **自助分析面板**：字段点击选择 → 维度/指标槽位 → 自动生成 SQL
- **审计日志面板**：查询历史记录查看
- **导出按钮组**：CSV/TSV/Markdown/Excel 一键导出
- **图表联动**：点击图表数据点触发全局事件（`dsh-plugin-nlbi:chart-interact`）

#### 🔌 Typert RPC 扩展（`lib/typert.host.js`）
- 服务方法从 14 个扩展到 **39 个**
- 全部经过 zod schema 校验声明

### 🐛 修复

- 修复 Text2SQL 结果解析器对 chartType/analysisType 字段的提取
- 修复图表类型强制覆盖时的 spec 结构兼容
- 修复筛选条件注入时 WHERE 子句位置的定位

### 🔧 结构调整

```
lib/
├── index.js          ← 修改：新增 25 个 RPC 服务 + 审计 + 权限
├── shared.js         ← 不变
├── sqlsafe.js        ← 不变
├── text2sql.js       ← 修改：增强 prompt
├── chart.js          ← 重写：15+ 图表类型 + 分析函数
├── metrics.js        ← 新增：指标/维度/数据集管理
├── dashboard.js      ← 新增：Dashboard 引擎
├── export.js         ← 新增：导出引擎
├── typert.host.js    ← 修改：39 个方法声明
└── client.js         ← 修改：全新 UI 组件
```

### 📦 包信息

- 版本：`0.1.1` → `0.2.0`
- 文件数：7 → 10（lib）
- 测试用例：54 → 208+（含新增集成测试 51 个）

---

## [0.1.1] — 初始版本

### 功能
- Text2SQL 自然语言查库（nl_query 工具 + nlQuery RPC）
- 基础 BI 图表渲染（bar/line/pie/stat）
- 报表收藏（saveReport / listReports / deleteReport / rerunReport）
- 侧栏数据面板（SchemaTree + GridPanel）
- 双层 SQL 安全（AST + 正则）

### 依赖
- 基于 dsh-mysql v0.1.4 二次开发