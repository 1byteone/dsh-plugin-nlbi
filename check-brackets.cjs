// 精确定位括号不平衡的位置
const fs = require('fs')
const src = fs.readFileSync('lib/client.js', 'utf8')
const lines = src.split('\n')

let p = 0, b = 0, br = 0
let inTemplate = false, inString = false, strChar = ''
let inLineComment = false, inBlockComment = false
let prevP = 0, prevBr = 0
let lastP0 = -1, lastBr0 = -1

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  prevP = p; prevBr = br

  for (let j = 0; j < line.length; j++) {
    const c = line[j], nxt = j + 1 < line.length ? line[j + 1] : ''
    const prv = j > 0 ? line[j - 1] : ''

    if (inLineComment) { if (c === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (c === '*' && nxt === '/') { inBlockComment = false; j++ } continue }
    if (inTemplate) { if (c === '`' && prv !== '\\') inTemplate = false; continue }
    if (inString) { if (c === '\\' && prv !== '\\') j++; else if (c === strChar) inString = false; continue }

    if (c === '/' && nxt === '/') { inLineComment = true; j++; continue }
    if (c === '/' && nxt === '*') { inBlockComment = true; j++; continue }
    if (c === '`') { inTemplate = true; continue }
    if (c === "'" || c === '"') { inString = true; strChar = c; continue }

    if (c === '(') p++
    if (c === ')') p--
    if (c === '{') br++
    if (c === '}') br--
  }

  // 记录平衡恢复的位置
  if (prevP !== 0 && p === 0) lastP0 = i + 1
  if (prevBr !== 0 && br === 0) lastBr0 = i + 1
}

console.log('最终平衡: p=' + p + ' b=' + b + ' br=' + br)
console.log('最后恢复平衡的位置 - 括号: 行 ' + lastP0 + ', 花括号: 行 ' + lastBr0)

// 从末尾往前找问题
// 对于 p=1, 多了一个 ) 或少了一个 (
// 对于 br=2, 多了两个 } 或少了两 {

// 反向扫描：从末尾开始找第一个应该出现但没出现的位置
let rp = 0, rbr = 0
for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i]
  for (let j = line.length - 1; j >= 0; j--) {
    const c = line[j]
    if (c === '(') rp++
    if (c === ')') rp--
    if (c === '{') rbr++
    if (c === '}') rbr--
  }
  if (rp === p && rbr === br) {
    console.log('从末尾到行 ' + (i + 1) + ' 括号平衡: p=' + rp + ' br=' + rbr)
    break
  }
}

console.log('\n尝试修复: 在文件末尾添加缺失的括号')
if (p > 0) console.log('需要添加 ' + p + ' 个 )')
if (p < 0) console.log('需要添加 ' + Math.abs(p) + ' 个 (')
if (br > 0) console.log('需要添加 ' + br + ' 个 }')
if (br < 0) console.log('需要添加 ' + Math.abs(br) + ' 个 {')