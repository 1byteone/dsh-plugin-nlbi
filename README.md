# dsh-plugin-nlbi

[![npm version](https://img.shields.io/npm/v/dsh-plugin-nlbi.svg)](https://www.npmjs.com/package/dsh-plugin-nlbi)
[![GitHub](https://img.shields.io/github/license/1byteone/dsh-plugin-nlbi)](https://github.com/1byteone/dsh-plugin-nlbi)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/1byteone/dsh-plugin-nlbi)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

**Natural-language data queries + BI reports for DeepSeek Harness.**

在 DeepSeek Harness 对话里，用自然语言问数据库；答案不只是文字，而是「可编辑的 SQL + 可交互的数据表格 + 可复用的 BI 图表/报表」。

基于 `dsh-mysql` (v0.1.4) 连接底座二次开发，保留全部既有功能的同时，新增 Text2SQL、BI 图表、报表收藏、侧栏数据面板（借鉴 IDEA Database 工具窗）。

---

## Features

### 继承上游（dsh-mysql v0.1.4）

- **设置页连接管理**：多套 MySQL 连接 CRUD（表白名单/写权限/测试连通性）
- **会话级连接选择**：输入栏 🐬 按钮一键切换当前会话连接
- **3 个全局 Agent 工具**：

| 工具 | 用途 |
|------|------|
| `mysql_query` | 只读查询（SELECT/SHOW/DESCRIBE/EXPLAIN，单语句，白名单，超时，2000 行上限） |
| `mysql_tables` | 查看表结构（information_schema，受白名单约束） |
| `mysql_execute` | 写操作（INSERT/UPDATE/DELETE，需连接开启 allowWrite） |

### 新增能力（本插件）

| 能力 | 说明 |
|------|------|
| 🔍 **`nl_query`** | Text2SQL：自然语言→SQL 生成→AST 校验→护栏执行→结果表格+图表 |
| 📊 **`sql_to_chart`** | 对查询结果自动生成 BI 图表规格，支持柱/折线/饼/统计卡 |
| 💾 **报表收藏** | `save_report` / `list_reports` / `delete_report` / `rerun_report`，含重跑与导出 |
| 🗂 **数据浏览器** | 右侧栏 SchemaTree（表结构导航树）+ GridPanel（数据网格预览，分页/排序/WHERE 过滤） |
| 🎤 **智能查询** | 右侧栏自然语言输入框，即时查询 + 一键"发到对话" |
| 📋 **报表库** | 右侧栏自然语言生成报表 → 收藏 → 重跑/导出/删除 |

### 安全模型

- `nl_query` 强制只读（即使连接开了写权限）
- 双层 SQL 校验：**AST 级（node-sql-parser）+ 正则级（上游 shared.js）**，100% 防写操作泄露
- 表白名单、单语句、`MAX_EXECUTION_TIME(15000)`、2000 行截断
- 生成 SQL 以草稿展示，运行需显式点击（防模型幻觉）

---

## Quick Start

### 前置条件

- Node.js >= 18
- pnpm（推荐）或 npm
- DeepSeek Harness 已安装并配置好 web profile

### 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-plugin-nlbi

# 或从 GitHub 安装
dsh plugin --profile web add github:1byteone/dsh-plugin-nlbi

# 重启 DSH
dsh --profile web
```

### 配置数据库连接

1. 打开浏览器 → `http://127.0.0.1:3080`
2. 进入 **设置 → Nlbi 数据库**（唯一新增的 tab）
3. 点击「+ 添加连接」，填写数据库信息
4. 点击「测试连接」确认连通，点击「保存」

### 使用方式

**方式 A：对话中自然语言查库**
```
用户：上个月每天的订单量是多少？
Agent：调用 nl_query → 生成 SQL → 返回表格 + 图表
```

**方式 B：右侧栏全能工作台**
打开右侧栏 → 🛢 **Nlbi 数据库** tab，内含 3 个子区：

| 子区 | 功能 |
|------|------|
| 🔍 **智能查询** | 输入自然语言 → 即时出表格+图表 → 可一键"发到对话" |
| 🗂 **数据浏览** | 双击左侧表名 → 右侧数据网格（分页/排序/WHERE 过滤） |
| 📊 **报表** | 自然语言描述 → 生成图表 → 收藏 → 重跑/导出/删除 |

---

## Screenshots

```
右侧栏工作台（智能查询 / 数据浏览 / 报表 三合一）
┌─────────────────────────────────────────────┐
│ 🔌 dsh-test · dsh_test          ▼           │
│ [🔍 智能查询] [🗂 数据浏览] [📊 报表]      │
├─────────────────────────────────────────────┤
│ 💬 查询所有用户                              │
│ [🔍 查询]  [💬 发到对话]                     │
│ 💡 查询所有用户  💡 统计各分类商品数量        │
│ 💡 上个月每天的订单量  💡 订单最多的前5个用户  │
│ ┌─ 生成 SQL（只读）──────────────────────┐  │
│ │ SELECT * FROM users LIMIT 2000          │  │
│ │ [复制 SQL] [💾 收藏为报表]              │  │
│ └────────────────────────────────────────┘  │
│ ┌─ [表格 (50)] [图表] ────────────────────┐ │
│ │ id │ name │ email │ status │ created_at  │ │
│ │ 1  │ 张三  │ ...   │ active │ 2026-...   │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

---

## Architecture

```
┌───────────────────────────── DSH Web 浏览器 ─────────────────────────────┐
│                                                                           │
│  lib/client.js（单文件 bundle，React 无 JSX）                             │
│    ├─ 🐬 输入栏连接选择器（会话级）                                        │
│    ├─ ⚙️ 设置页「Nlbi 数据库」连接管理                                     │
│    ├─ 📊 BI 结果渲染（对话输出渲染表格/图表）                                │
│    └─ 🛢 右侧栏全能工作台（智能查询/数据浏览/报表）                          │
└───────────────┬────────────────────────────────────────────┬──────────────┘
                │                                            │
┌───────────────▼──────────────── DSH Host (Node) ──────────▼──────────────┐
│  lib/index.js（连接管理 + 5 工具 + 14 RPC 服务）                          │
│                                                                           │
│  新增模块：                                                                │
│  ├─ sqlsafe.js    AST 级 SQL 安全校验（分类/白名单/LIMIT 改写/一站式）      │
│  ├─ text2sql.js   Text2SQL 编排（Schema 注入/LLM 调用/JSON 解析/护栏执行）  │
│  └─ chart.js      BI 图表规格生成（5 类场景启发式）                         │
│                                                                           │
│  工具：mysql_query / mysql_tables / mysql_execute / nl_query / sql_to_chart │
└────────────────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 运行时 | Node.js ESM + Cordis 4 | DSH 插件框架 |
| SQL 解析 | `node-sql-parser` v5.4 | AST 级 SQL 分类/校验/改写 |
| 图表渲染 | ECharts（CDN 加载） | 柱/折线/饼/统计卡，失败降级 SVG |
| 数据库 | `mysql2` | 连接池、预处理、JSON 安全序列化 |
| 校验 | `zod` v4 | Typert RPC 网关边界校验 |
| 前端 | React 无 JSX | 单文件 bundle，CSS 主题变量跟随 DSH |

---

## Test

```bash
cd dsh-plugin-nlbi

# 语法检查
node --check lib/index.js lib/shared.js lib/sqlsafe.js lib/text2sql.js \
  lib/chart.js lib/typert.host.js lib/client.js

# 运行全部测试
node test/shared.test.mjs
node test/sqlsafe.test.mjs
node test/text2sql.test.mjs
node test/chart.test.mjs
```

当前测试覆盖：**69 组断言，全部通过** ✅

---

## Development

```bash
# 克隆
git clone https://github.com/1byteone/dsh-plugin-nlbi.git
cd dsh-plugin-nlbi

# 安装依赖
pnpm install

# 本地打包安装
pnpm pack
dsh plugin --profile web add dsh-plugin-nlbi-*.tgz

# 重启 DSH
dsh --profile web
```

---

## Limitations

| 限制 | 说明 | 计划 |
|------|------|------|
| Text2SQL 需要 LLM 模型 | `nl_query` 依赖 DSH 的 `llm` 服务（DeepSeek / OpenAI 等） | 已适配 DSH 标准模型路由 |
| 图表导出 | 当前仅支持 SQL 导出（Markdown） | 路线图：HTML/PNG 导出 |
| 仅 MySQL | 继承上游，仅支持 MySQL | 路线图：PostgreSQL 支持 |
| 侧栏依赖 betterSidebar | 需要 `@linxin666/dsh-web-ui-all` 提供 | 已做降级，无侧栏时功能仍可从设置页使用 |

---

## Changelog

### 0.0.9 (2026-08-23)
- 修复：模型调用链——默认走 DSH 用户当前会话选择的模型
- 修复：`llm.stream()` 注入 `provider` + `model` 路由
- 修复：`information_schema` 查询列名歧义
- 修复：错误路径返回 `undefined` 导致 `boundary validation` 报错
- 新增：推荐测试查询语句按钮
- 全面审计：7 项问题全部修复

### 0.0.1 ~ 0.0.8
- 初始版本迭代

---

## License

MIT

## Acknowledgements

Forked from [dsh-mysql](https://github.com/1321928757/dsh-mysql) (v0.1.4, MIT) by [1321928757](https://github.com/1321928757).

## Links

- [GitHub](https://github.com/1byteone/dsh-plugin-nlbi)
- [npm](https://www.npmjs.com/package/dsh-plugin-nlbi)
- [DSH Plugin 开发教程](https://github.com/1byteone/dsh-plugin-dev-tutorial)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)