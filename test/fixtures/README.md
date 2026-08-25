# dsh_test 测试数据库与 GitHub 测试资产

本目录提供 dsh-plugin-nlbi 的公开、可重复测试数据库 fixture。SQL 使用合成数据，不包含真实账户、密码、生产数据或个人隐私。

## 1. 导入测试数据库

要求：MySQL 5.7+ 或 MySQL 8.0+。

```bash
mysql -u <your_user> -p < test/fixtures/dsh_test.sql
```

Windows PowerShell：

```powershell
Get-Content .\test\fixtures\dsh_test.sql -Raw | mysql -u <your_user> -p
```

导入脚本会：

1. 创建 `dsh_test` 数据库；
2. 重建 `users`、`products`、`orders`、`order_items` 四张表；
3. 创建主键、索引和外键；
4. 生成确定性的合成种子数据；
5. 输出行数校验结果。

预期行数：

| 表 | 预期行数 |
|---|---:|
| users | 50 |
| products | 60 |
| orders | 150 |
| order_items | 367 |

也可以手动确认：

```sql
USE dsh_test;
SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items;
```

## 2. 在 DSH 中配置连接

不要把密码提交到 GitHub。通过 DSH Web 界面新建连接，或使用本机 profile 的安全配置：

- 连接名称：`dsh-test`
- 数据库：`dsh_test`
- 主机、端口、用户名、密码：使用本机 MySQL 实例的值
- 表白名单：`users, products, orders, order_items`
- 测试阶段优先关闭写权限

仓库中禁止提交 `connections.json`、`reports.json`、`dashboards.json`、密码和运行日志。

## 3. 专业测试入口

```bash
# 全部测试
for f in test/*.test.mjs; do node "$f"; done

# 修复专项
node test/dashboard-fixes.test.mjs
node test/reports-fixes.test.mjs
node test/client-load.test.mjs

# 语法检查
for f in lib/*.js; do node --check "$f"; done
```

当前专项覆盖：

- 报表保存、列表读取、空列表和损坏存储区分；
- 图表 Widget 查询结果和完整 chartSpec；
- Widget 查询失败隔离；
- Dashboard Widget 编辑持久化；
- 客户端 bundle、侧栏和 slots 加载。

## 4. dsh_test 功能验收 SQL

### 智能查询

```sql
SELECT COUNT(*) AS total_users FROM users;
SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC;
SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       COUNT(*) AS order_count, SUM(amount) AS total_amount
FROM orders GROUP BY month ORDER BY month;
SELECT u.name, SUM(o.amount) AS total_spend
FROM users u JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.name ORDER BY total_spend DESC LIMIT 10;
```

### 图表 Widget / 报表

```sql
SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       COUNT(*) AS order_count,
       SUM(amount) AS total_amount
FROM orders
GROUP BY month
ORDER BY month;

SELECT p.category, SUM(oi.quantity * oi.price) AS sales
FROM order_items oi
JOIN products p ON p.id = oi.product_id
GROUP BY p.category
ORDER BY sales DESC;
```

### 安全测试

以下语句必须被拒绝，不得执行：

```sql
DROP TABLE users;
DELETE FROM users;
SELECT 1; SELECT 2;
SELECT * FROM table_not_in_allowlist;
```

## 5. 交付门槛

- 全部自动化测试退出码为 0；
- 集成测试 51/51；
- `node --check` 全部通过；
- dsh_test 四张表和真实只读验收 SQL 执行成功；
- 不修改测试数据库之外的数据；
- 不提交任何连接密码或用户隐私；
- `dsh web` 启动时必须确认 3080 端口没有已有实例，避免 `EADDRINUSE`；若已有实例返回 200，应直接访问现有地址而不是重复启动。

详细故障排查和测试经验见项目根目录 `CLAUDE.md`。
