# dsh-plugin-nlbi v0.2.0 升级指南

## 适用版本

从 **v0.1.x** 升级到 **v0.2.0**。

## 升级前准备

1. **备份现有配置**：`$DSH_HOME/storages/dsh-plugin-nlbi/` 目录下的 `connections.json` 和 `reports.json`
2. **确认插件列表**：`dsh plugin --profile web ls | grep nlbi`
3. **确认当前版本**：检查 `node_modules/dsh-plugin-nlbi/package.json` 中的 version 字段

## 升级步骤

### 方式一：直接替换 tgz（推荐）

```powershell
# 1. 打包新版本
cd dsh-plugin-nlbi
pnpm pack

# 2. 更新 profile 依赖
cd $env:DSH_HOME\profiles\web
# 编辑 package.json，将 dsh-plugin-nlbi 的版本号从 0.1.1 改为 0.2.0
pnpm install

# 3. 重启 DSH
dsh stop --profile web
dsh start --profile web

# 4. 验证更新
dsh plugin --profile web ls | grep nlbi
# 应显示：dsh-plugin-nlbi@0.2.0
```

### 方式二：完整重新安装

```powershell
# 1. 移除旧版本
cd $env:DSH_HOME\profiles\web
pnpm remove dsh-plugin-nlbi

# 2. 安装新版本
pnpm add file:D:\path\to\dsh-plugin-nlbi-0.2.0.tgz

# 3. 重启 DSH
dsh stop --profile web
dsh start --profile web
```

## 验证安装

### 1. 文件完整性检查

```powershell
cd $env:DSH_HOME\profiles\web\node_modules\dsh-plugin-nlbi
dir lib\

# 应包含以下 10 个文件：
# chart.js, client.js, dashboard.js, export.js, index.js
# metrics.js, shared.js, sqlsafe.js, text2sql.js, typert.host.js*
```

### 2. 语法检查

```powershell
node --check lib\index.js lib\chart.js lib\metrics.js lib\dashboard.js lib\export.js
```

### 3. 运行测试

```powershell
cd dsh-plugin-nlbi
node test\shared.test.mjs
node test\sqlsafe.test.mjs
node test\text2sql.test.mjs
node test\chart.test.mjs
node test\chart-v2.test.mjs
node test\metrics.test.mjs
node test\dashboard.test.mjs
node test\export.test.mjs
node test\integration.test.mjs
```

## 新功能快速上手

### 1. 定义业务指标

打开右侧栏 → 📐 指标 → `+ 新增指标`，填写：

| 字段 | 示例 | 说明 |
|------|------|------|
| 名称 | GMV | 业务指标名称 |
| SQL 表达式 | SUM(order_amount) | 聚合表达式 |
| 聚合类型 | sum | sum/count/avg/min/max/derived |
| 格式 | currency | number/currency/percent/integer |
| 说明 | 总成交金额 | 口径说明（会注入到 AI prompt） |

### 2. 创建 Dashboard 仪表盘

1. 右侧栏 → 📐 仪表盘 → `+ 新建`
2. 输入 Dashboard 名称
3. 点击「+ 添加组件」选择类型（图表/KPI/表格/文本）
4. 编辑组件时填写 SQL 查询语句
5. 保存后自动切换到查看模式

### 3. 使用自助分析

1. 右侧栏 → 🔧 自助分析
2. 从可用字段列表中点击字段（数值字段自动添加到指标，类目字段添加到维度）
3. 选择聚合方式和排序
4. 点击「生成 SQL」查看 SQL 预览

### 4. 导出数据

在查询结果页面，点击：
- 📥 CSV → 下载 CSV 文件
- 📥 TSV → 下载 TSV 文件
- 📋 MD → 复制 Markdown 表格到剪贴板
- 📥 Excel → 下载 HTML 格式 Excel（兼容 WPS/Office）

### 5. 配置数据权限

打开 设置 → Nlbi 数据库 → 编辑连接 → 权限配置：

**行级权限**：限制只能查看特定数据
```json
{ "column": "region", "operator": "=", "value": "华东" }
{ "column": "status", "operator": "IN", "values": ["active", "pending"] }
```

**列级黑名单**：禁止查看敏感列
```json
["password", "id_card", "phone"]
```

## 向后兼容说明

### ✅ 完全兼容（无需修改）
- 所有现有连接配置（`connections.json`）
- 所有已收藏报表（`reports.json`）
- 所有现有 API 方法名和参数
- 所有现有工具（`mysql_query`, `mysql_tables`, `mysql_execute`, `nl_query`, `sql_to_chart`）
- systemPrompt 动态上下文注入

### ⚠️ 新增功能（需主动配置）
- 指标/维度/数据集：需要重新创建（v0.1.1 无此功能）
- Dashboard：需要新建
- 数据权限：需要主动配置
- 审计日志：自动启用，无需配置

## 升级后验证清单

- [ ] `dsh plugin --profile web ls` 显示 `dsh-plugin-nlbi@0.2.0`
- [ ] 设置页 → Nlbi 数据库 → 连接列表正常显示
- [ ] 输入栏 🐬 按钮可用
- [ ] 对话中 `nl_query` 工具正常工作
- [ ] 右侧栏工作台正常显示 7 个子区
- [ ] 📐 指标管理 → 可创建/编辑/删除指标
- [ ] 📐 仪表盘 → 可创建/查看/编辑/删除 Dashboard
- [ ] 🔧 自助分析 → 字段可点击、SQL 可生成
- [ ] 📊 报表 → 可收藏/重跑/删除
- [ ] 📋 审计 → 显示查询记录

## 回滚方案

如果升级后出现问题，可按以下步骤回滚：

```powershell
# 1. 移除 v0.2.0
cd $env:DSH_HOME\profiles\web
pnpm remove dsh-plugin-nlbi

# 2. 重新安装 v0.1.1
pnpm add file:D:\path\to\dsh-plugin-nlbi-0.1.1.tgz

# 3. 重启 DSH
dsh stop --profile web
dsh start --profile web
```

**注意**：v0.2.0 新增的指标/维度/数据集/Dashboard 数据存储在 `metrics.json` 和 `dashboards.json` 中，回滚后这些数据不会被自动清理，但旧版本不会读取它们。