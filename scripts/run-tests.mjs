/**
 * run-tests.mjs — 统一测试入口
 *
 * 遍历 test/*.test.mjs 逐个执行，任一失败即非零退出。
 * 附带语法检查（lib/*.js）。
 *
 *   node scripts/run-tests.mjs          # 语法检查 + 全量测试
 *   node scripts/run-tests.mjs --unit   # 仅执行单元测试（跳过语法检查）
 *   node scripts/run-tests.mjs --check  # 仅语法检查
 *
 * 需要 Node.js >= 18，无第三方依赖。
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const flags = new Set(process.argv.slice(2))
const onlyUnit = flags.has('--unit')
const onlyCheck = flags.has('--check')

let failures = 0

function syntaxCheck() {
  if (onlyUnit) return true
  console.log('── 语法检查 lib/*.js ──')
  const libs = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).sort()
  let ok = true
  for (const f of libs) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, 'lib', f)], { stdio: 'inherit' })
    if (r.status !== 0) { ok = false; failures++ }
  }
  console.log(ok ? `${libs.length} 个文件全部通过` : `语法检查存在失败`)
  return ok
}

function runTests() {
  if (onlyCheck) return true
  console.log('── 单元测试 test/*.test.mjs ──')
  const tests = readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).sort()
  let ok = true
  for (const f of tests) {
    const r = spawnSync(process.execPath, [path.join(root, 'test', f)], { stdio: 'inherit' })
    if (r.status !== 0) { ok = false; failures++ }
  }
  console.log(ok ? `${tests.length} 个测试文件全部通过` : `${failures} 个文件失败`)
  return ok
}

syntaxCheck()
runTests()

if (failures > 0) {
  console.error(`\n${failures} 个检查失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')