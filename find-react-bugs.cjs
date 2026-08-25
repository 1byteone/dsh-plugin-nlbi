// 查找 React.createElement 中把函数作为 children 的潜在错误
const fs = require('fs')
const src = fs.readFileSync('lib/client.js', 'utf8')
const lines = src.split('\n')

// 模式：React.createElement(..., fnExpr) 或 React.createElement(..., ..., fnExpr)
// 其中 fnExpr 是箭头函数或函数标识符
const patterns = [
  /React\.createElement\([^)]*,\s*([A-Za-z_$][\w$]*)\s*=>/,
  /React\.createElement\([^)]*,\s*\([^)]*\)\s*=>/,
  /React\.createElement\([^)]*,\s*function\s*\(/,
  /React\.createElement\([^)]*,\s*\b([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*=>/,
]

let found = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  for (const pat of patterns) {
    if (pat.test(line)) {
      console.log(`L${i+1}: ${line.trim().slice(0, 120)}`)
      found++
    }
  }
}

// 另一类：函数标识符作为子元素但没有被调用（如：renderWidget, wResult）
// React.createElement('div', null, someFunction) —— someFunction 无 ()
const childFnPattern = /React\.createElement\(\s*'[^']*'\s*,\s*(?:null|undefined|props)?\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g
let m
while ((m = childFnPattern.exec(src)) !== null) {
  const fnName = m[1]
  // 如果这个名字是一个函数定义/const 箭头函数，就是 bug
  const isFn = new RegExp(`(?:function\\s+${fnName}|const\\s+${fnName}\\s*=\\s*(?:async\\s*)?\\(|let\\s+${fnName}\\s*=\\s*(?:async\\s*)?\\()`).test(src)
  if (isFn) {
    const lineNum = src.slice(0, m.index).split('\n').length
    console.log(`⚠️ L${lineNum}: 函数 '${fnName}' 被直接作为 React children: ${m[0].slice(0, 100)}`)
    found++
  }
}

console.log(found === 0 ? '\n✅ 未发现函数作为 children 的明显问题' : `\n⚠️ 发现 ${found} 处潜在问题`)