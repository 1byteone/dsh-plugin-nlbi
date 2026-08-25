// 浏览器环境模拟 - 完整执行 client.js factory + apply + 渲染
// 用于找出"插件未加载"真正原因

// ── 模拟浏览器全局 ──
globalThis.window = {
  __ModuleLoader__: null,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.document = {
  createElement: (tag) => ({ dataset: {}, style: {}, appendChild: () => {} }),
  head: { appendChild: () => {}, querySelector: () => null },
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
}
try { globalThis.navigator = {} } catch (e) { } // navigator 只读，跳过
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
globalThis.setTimeout = (fn) => 0
globalThis.clearTimeout = () => {}
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
globalThis.Blob = class { constructor() { this.size = 0 } }
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail } }

// ── 模拟 React ──
const React = {
  createElement: (type, props, ...children) => {
    if (typeof type === 'function') {
      try {
        const result = type(props || {})
        return result === null || result === undefined ? null : result
      } catch (e) {
        console.error(`❌ [React] 组件渲染异常 ${type.name || '(anonymous)'}:`, e.message)
        throw e
      }
    }
    return { type, props: props || {}, children }
  },
  Fragment: Symbol('Fragment'),
  useState: (init) => {
    const val = typeof init === 'function' ? init() : init
    return [val, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn(),
}
globalThis.React = React

// ── 模拟 host ──
const mockHost = {
  call: async (method) => {
    if (method === 'getSelection') return { ok: true, connectionId: 'c-dsh-test', connections: [
      { id: 'c-dsh-test', name: 'dsh-test', host: '127.0.0.1', port: 3306, database: 'dsh_test', tables: ['users','orders','products','order_items'], allowWrite: true }
    ]}
    if (method === 'schemaTree') return { ok: true, database: 'dsh_test', tables: [
      { name: 'users', columns: [{ column: 'id', type: 'int' }, { column: 'name', type: 'varchar(64)' }] },
      { name: 'orders', columns: [{ column: 'id', type: 'int' }, { column: 'amount', type: 'decimal(12,2)' }] },
      { name: 'products', columns: [{ column: 'id', type: 'int' }, { column: 'name', type: 'varchar(128)' }] },
      { name: 'order_items', columns: [{ column: 'id', type: 'int' }] },
    ]}
    if (method === 'listDashboards') return { ok: true, dashboards: [] }
    if (method === 'listMetrics') return { ok: true, metrics: [] }
    if (method === 'getAuditLog') return { ok: true, entries: [] }
    if (method === 'listReports') return { ok: true, reports: [] }
    return { ok: true }
  },
}

// ── 模拟 slots ──
const slotRegistrations = []
const slots = {
  inject: (name, fn) => { slotRegistrations.push({ slot: name, fn }) },
  register: (config, component) => { return () => {} },
}

// ── 模拟 betterSidebar ──
const registeredTabs = []
const betterSidebar = {
  registerTab: (descriptor) => {
    registeredTabs.push(descriptor.id)
    console.log(`✅ registerTab 被调用: ${descriptor.id}`)
    // 渲染组件验证
    try {
      const el = descriptor.component({ visible: true, scope: { sessionId: 's1' }, host: mockHost })
      console.log(`   component 渲染: ${el === null ? 'null' : 'OK'}`)
    } catch (e) {
      console.error(`   ❌ component 渲染失败: ${e.message}`)
    }
    return () => {}
  },
}

// ── 加载 client.js ──
console.log('═══════════ 加载 client.js ═══════════')
let factoryFn = null
globalThis.window.__ModuleLoader__ = {
  load: (cfg) => { factoryFn = cfg.factory; console.log('✅ ModuleLoader.load:', cfg.id) },
}

import('../lib/client.js').then(async () => {
  if (!factoryFn) { console.error('❌ factory 未注册'); process.exit(1) }

  // 执行 factory 获取 apply
  console.log('═══════════ 执行 factory ═══════════')
  let mod = null
  try {
    mod = factoryFn((name) => {
      if (name === 'react') return React
      throw new Error('unknown require: ' + name)
    })
    console.log('✅ factory 执行成功, exports:', Object.keys(mod))
  } catch (e) {
    console.error('❌ factory 执行失败:', e.message)
    console.error(e.stack)
    process.exit(1)
  }

  // 执行 apply（async 函数，必须 await）
  console.log('═══════════ 执行 apply ═══════════')
  const ctx = {
    get: (key) => {
      if (key === 'slots') return slots
      if (key === 'remote') return { $mount: async () => () => {} }
      if (key === 'remote.mysql') return mockHost
      if (key === 'betterSidebar') return betterSidebar
      return undefined
    },
    inject: (deps, fn) => {
      console.log('ctx.inject:', deps)
      const scope = { betterSidebar, effect: (fn) => { try { return fn() } catch(e) { console.error('scope.effect error:', e.message) } } }
      fn(scope)
    },
    effect: (fn) => fn(),
    on: () => {},
  }

  try {
    await mod.apply(ctx)
    console.log('✅ apply 执行成功')
  } catch (e) {
    console.error('❌ apply 执行失败:', e.message)
    console.error(e.stack)
    process.exit(1)
  }

  console.log('═══════════ 验证结果 ═══════════')
  console.log('betterSidebar 注册的标签:', registeredTabs)
  console.log('slots 注册:', slotRegistrations.map(r => r.slot))
  console.log(registeredTabs.includes('dsh-plugin-nlbi-workbench') ? '✅ 侧边栏标签已注册' : '❌ 侧边栏标签未注册')
}).catch(e => {
  console.error('❌ client.js 加载失败:', e.message)
  console.error(e.stack)
  process.exit(1)
})