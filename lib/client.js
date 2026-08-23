/**
 * dsh-plugin-nlbi 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 * 基于 dsh-mysql (v0.1.4) 二次开发：保留连接配置页/输入栏按钮，后续叠加 Text2SQL/BI 渲染。
 *
 * 提供两个界面：
 *  - conversation.input.left：🐬 数据库按钮 + 连接选择面板（会话级切换）；
 *  - settings.section（id: mysql）：连接配置页（增删改、测试连接、表白名单、写权限）。
 *
 * 数据通道：
 *  - remote.mysql.*（Typert RPC，见 ./typert.host.js 与下方 CONTRIBUTION）
 *    → 连接 CRUD / 测试 / 会话选择 / 表列表；
 *  - 宿主槽位 props（sessionId）→ 会话级选择的 key。
 *
 * 红线：网关返回 {ok, value|error} 包装，host.call 里必须解包。
 * 样式全部使用 --dsw-* 主题变量，跟随全局亮/暗主题。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-nlbi',
  factory: (require) => {
    const React = require('react')

    // ── 样式注入（防重复，随插件卸载由宿主 HMR 驱动清理）─────────────────
    const css = `
      .dsh-nlbi-root {
        display:inline-flex; align-items:center; gap:4px; position:relative;
        min-width:0; flex:0 1 auto;
        --dm-accent: color-mix(in srgb, var(--dsw-alias-brand-primary) 62%, #0D9488 38%);
        --dm-accent-soft: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
        --dm-ok: var(--dsw-alias-state-success-primary, #22c55e);
        --dm-warn: var(--dsw-alias-state-error-primary, #ef4444);
      }
      @supports not (background: color-mix(in srgb, red 50%, blue 50%)) {
        .dsh-nlbi-root {
          --dm-accent: var(--dsw-alias-brand-primary);
          --dm-accent-soft: transparent;
        }
      }
      .dsh-nlbi-btn {
        display:inline-flex; align-items:center; gap:5px;
        height:26px; padding:0 8px; font-size:12px; line-height:1; font-weight:600;
        max-width:132px; min-width:0; box-sizing:border-box;
        color:#fff; border:none; border-radius:8px; cursor:pointer;
        background:linear-gradient(135deg, var(--dm-accent), var(--dsw-alias-brand-primary));
        transition:all .18s ease;
      }
      .dsh-nlbi-btn-label {
        max-width:96px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .dsh-nlbi-btn.is-on { box-shadow:inset 0 0 0 1px rgba(255,255,255,.35); }
      .dsh-nlbi-btn:hover:not(:disabled) { transform:translateY(-1px); }
      .dsh-nlbi-btn:active:not(:disabled) { transform:scale(.98); }
      .dsh-nlbi-btn:disabled { opacity:.45; cursor:not-allowed; }
      .dsh-nlbi-btn:focus-visible { outline:2px solid var(--dm-accent); outline-offset:2px; }
      .dsh-nlbi-err {
        color:var(--dm-warn); font-size:11px; max-width:120px; min-width:0; flex:0 1 auto;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .dsh-nlbi-panel {
        position:absolute; bottom:calc(100% + 8px); right:0; z-index:150;
        width:min(340px, calc(100vw - 32px)); box-sizing:border-box; padding:0;
        max-height:min(480px, calc(100vh - 120px)); overflow-y:auto;
        background:var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));
        border:1px solid var(--dsw-alias-border-l1); border-radius:12px;
        box-shadow:var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.18));
        color:var(--dsw-alias-label-primary); font-size:12px; line-height:18px; cursor:default;
        animation:dm-slide-in .18s ease-out;
      }
      @keyframes dm-slide-in {
        from { opacity:0; transform:translateY(-8px) scale(.97); }
        to { opacity:1; transform:translateY(0) scale(1); }
      }
      .dsh-nlbi-panel-header {
        display:flex; align-items:center; justify-content:space-between; gap:8px;
        padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l1);
        position:sticky; top:0; background:inherit; border-radius:12px 12px 0 0;
      }
      .dsh-nlbi-panel-title { font-weight:600; font-size:13px; margin:0; }
      .dsh-nlbi-panel-sub { color:var(--dsw-alias-label-secondary); font-size:11px; margin:0; }
      .dsh-nlbi-panel-close {
        width:22px; height:22px; padding:0; display:inline-flex; align-items:center; justify-content:center;
        border:none; border-radius:6px; background:transparent; flex:none;
        color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1; cursor:pointer;
      }
      .dsh-nlbi-panel-close:hover { color:var(--dsw-alias-label-primary); background:var(--dm-accent-soft); }
      .dsh-nlbi-panel-body { padding:8px; display:flex; flex-direction:column; gap:6px; }
      .dsh-nlbi-empty { padding:10px 8px; color:var(--dsw-alias-label-secondary); }
      .dsh-nlbi-item {
        display:flex; flex-direction:column; gap:3px; padding:8px 10px;
        border:1px solid var(--dsw-alias-border-l1); border-radius:8px; cursor:pointer;
        transition:all .15s ease; text-align:left; width:100%; box-sizing:border-box;
        background:transparent; color:var(--dsw-alias-label-primary);
        font:inherit;
      }
      .dsh-nlbi-item:hover { border-color:var(--dm-accent); background:var(--dm-accent-soft); }
      .dsh-nlbi-item.is-selected { border-color:var(--dm-accent); background:var(--dm-accent-soft); }
      .dsh-nlbi-item:focus-visible { outline:2px solid var(--dm-accent); outline-offset:1px; }
      .dsh-nlbi-item-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .dsh-nlbi-item-name { font-weight:600; }
      .dsh-nlbi-badge {
        font-size:10px; line-height:1; padding:2px 6px; border-radius:999px;
        border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary);
      }
      .dsh-nlbi-badge.w { color:var(--dm-warn); border-color:currentColor; }
      .dsh-nlbi-badge.sel { color:var(--dm-ok); border-color:currentColor; }
      .dsh-nlbi-item-sub { color:var(--dsw-alias-label-secondary); font-size:11px; word-break:break-all; }
      .dsh-nlbi-chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:2px; }
      .dsh-nlbi-chip {
        font-size:10px; line-height:1; padding:3px 7px; border-radius:6px;
        background:var(--dsw-alias-bg-input, transparent); border:1px solid var(--dsw-alias-border-l1);
        color:var(--dsw-alias-label-secondary); font-family:ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .dsh-nlbi-chip.more { border-style:dashed; }

      /* ── 设置页 ── */
      .dsh-nlbi-settings { display:flex; flex-direction:column; gap:14px; padding:4px 2px 20px; }
      .dsh-nlbi-settings-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .dsh-nlbi-settings-title { font-size:15px; font-weight:600; margin:0; }
      .dsh-nlbi-settings-desc { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; margin:0; }
      .dsh-nlbi-card {
        border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:12px 14px;
        display:flex; flex-direction:column; gap:8px; background:var(--dsw-alias-bg-layer-1, transparent);
      }
      .dsh-nlbi-card-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dsh-nlbi-card-name { font-weight:600; font-size:13px; }
      .dsh-nlbi-card-sub { color:var(--dsw-alias-label-secondary); font-size:11px; word-break:break-all; }
      .dsh-nlbi-card-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .dsh-nlbi-form { display:flex; flex-direction:column; gap:10px; }
      .dsh-nlbi-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      @media (max-width: 560px) { .dsh-nlbi-form-grid { grid-template-columns:1fr; } }
      .dsh-nlbi-field { display:flex; flex-direction:column; gap:4px; }
      .dsh-nlbi-field.wide { grid-column:1 / -1; }
      .dsh-nlbi-field-label { color:var(--dsw-alias-label-secondary); font-size:11px; }
      .dsh-nlbi-input {
        box-sizing:border-box; width:100%; font-size:12px; line-height:18px;
        color:var(--dsw-alias-label-primary);
        background:var(--dsw-alias-bg-input, transparent);
        border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:6px 8px;
        outline:none; font-family:inherit;
        transition:border-color .15s ease, box-shadow .15s ease;
      }
      .dsh-nlbi-input:focus {
        border-color:var(--dm-accent, var(--dsw-alias-brand-primary));
        box-shadow:0 0 0 3px var(--dm-accent-soft, transparent);
      }
      .dsh-nlbi-check { display:flex; align-items:center; gap:8px; padding:4px 0; cursor:pointer; }
      .dsh-nlbi-switch { accent-color:var(--dm-accent, var(--dsw-alias-brand-primary)); width:34px; height:18px; cursor:pointer; }
      .dsh-nlbi-hint { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; margin:0; }
      .dsh-nlbi-btn2 {
        height:26px; padding:0 12px; font-size:12px; line-height:1; cursor:pointer;
        border-radius:6px; border:1px solid var(--dsw-alias-border-l1);
        background:transparent; color:var(--dsw-alias-label-primary);
        transition:all .15s ease;
      }
      .dsh-nlbi-btn2:hover:not(:disabled) { border-color:var(--dm-accent, var(--dsw-alias-brand-primary)); color:var(--dm-accent, var(--dsw-alias-brand-primary)); }
      .dsh-nlbi-btn2.primary {
        background:var(--dm-accent, var(--dsw-alias-brand-primary));
        border-color:var(--dm-accent, var(--dsw-alias-brand-primary)); color:#fff;
      }
      .dsh-nlbi-btn2.danger { color:var(--dm-warn); }
      .dsh-nlbi-btn2.danger:hover:not(:disabled) { border-color:var(--dm-warn); color:var(--dm-warn); }
      .dsh-nlbi-btn2:disabled { opacity:.45; cursor:not-allowed; }
      .dsh-nlbi-btn2:focus-visible { outline:2px solid var(--dm-accent, var(--dsw-alias-brand-primary)); outline-offset:2px; }
      .dsh-nlbi-msg { font-size:12px; padding:6px 10px; border-radius:6px; }
      .dsh-nlbi-msg.ok { color:var(--dm-ok); background:color-mix(in srgb, var(--dm-ok) 12%, transparent); }
      .dsh-nlbi-msg.err { color:var(--dm-warn); background:color-mix(in srgb, var(--dm-warn) 12%, transparent); }
      .dsh-nlbi-test-ok { color:var(--dm-ok); font-size:12px; }
      .dsh-nlbi-test-err { color:var(--dm-warn); font-size:12px; word-break:break-all; }
      @media (prefers-reduced-motion: reduce) {
        .dsh-nlbi-panel { animation:none; }
        .dsh-nlbi-root *, .dsh-nlbi-settings * { transition:none !important; }
      }
      @media (prefers-contrast: high) {
        .dsh-nlbi-input, .dsh-nlbi-btn2, .dsh-nlbi-item { border-width:2px; }
      }
    `
    const cssTagId = 'dsh-plugin-nlbi/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-nlbi'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 客户端 codec（与 ./typert.host.js 清单一一对应；宽松校验）──────────
    function looseParse(v) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('dsh-nlbi: 服务端数据非法')
      return v
    }
    const descriptor = (method) => ({
      id: 'dsh-nlbi#mysql/' + method,
      service: 'mysql',
      namespace: 'mysql',
      method,
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'args', wire: 'args', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-nlbi#Args', schema: { parse: looseParse } } },
      ],
      result: { mode: 'strict', typeSymbol: 'dsh-nlbi#Result', schema: { parse: looseParse } },
    })

    const METHODS = [
      'listConnections', 'getSelection', 'selectConnection',
      'saveConnection', 'deleteConnection', 'testConnection', 'listTables',
      // ★ 新增：Text2SQL / BI / 报表
      'nlQuery', 'schemaTree', 'tablePreview',
      'listReports', 'saveReport', 'deleteReport', 'rerunReport',
    ]
    const CONTRIBUTION = {
      package: 'dsh-plugin-nlbi',
      descriptors: METHODS.map(descriptor),
    }

    // 同页两个组件（输入栏按钮 / 设置页）之间的配置变更通知
    const CONFIG_EVENT = 'dsh-plugin-nlbi:config-changed'

    async function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      const remote = ctx.get('remote')
      if (remote === undefined || typeof remote.$mount !== 'function') return
      const unmount = await remote.$mount(CONTRIBUTION)
      ctx.effect(() => () => { unmount() }, 'dsh-nlbi: remote contribution')
      const api = ctx.get('remote.mysql')
      if (api === undefined) return

      // 红线：网关返回 {ok, value|error} 包装，必须解包成业务结果
      const host = {
        call: async (method, payload) => {
          const result = await api[method](payload)
          if (result === null || typeof result !== 'object') throw new Error('MySQL 服务无响应')
          if (result.ok !== true) {
            const detail = result.error !== undefined && result.error !== null
              ? (typeof result.error === 'string' ? result.error : result.error.message)
              : ''
            throw new Error(detail || '调用失败')
          }
          return result.value
        },
      }

      function notifyConfigChanged() {
        try { window.dispatchEvent(new CustomEvent(CONFIG_EVENT)) } catch (err) { /* ignore */ }
      }

      async function fetchConnections() {
        try {
          const res = await host.call('listConnections', {})
          if (res && res.ok === true && Array.isArray(res.connections)) return res.connections
        } catch (err) { /* ignore */ }
        return null
      }

      // ── 输入栏连接选择器 ────────────────────────────────────────────────
      function MysqlControl(props) {
        const sessionId = props && props.sessionId
        const [open, setOpen] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [connections, setConnections] = React.useState([])
        const [connectionId, setConnectionId] = React.useState(null)
        const [error, setError] = React.useState(null)

        const load = React.useCallback(async () => {
          try {
            const res = await host.call('getSelection', { sessionId })
            if (res && res.ok === true) {
              setConnections(Array.isArray(res.connections) ? res.connections : [])
              setConnectionId(res.connectionId !== undefined && res.connectionId !== null ? res.connectionId : null)
              setError(null)
            } else {
              setError((res && res.error) || '读取连接失败')
            }
          } catch (err) {
            setError(String((err && err.message) || err))
          }
        }, [sessionId])

        React.useEffect(() => { load() }, [load])
        React.useEffect(() => {
          const onChange = () => { load() }
          window.addEventListener(CONFIG_EVENT, onChange)
          return () => window.removeEventListener(CONFIG_EVENT, onChange)
        }, [load])

        // 外部点击 / Esc 关闭
        React.useEffect(() => {
          if (!open) return
          const onMouseDown = (e) => {
            if (!(e.target instanceof Element)) return
            if (e.target.closest('.dsh-nlbi-root') === null) setOpen(false)
          }
          const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false) }
          document.addEventListener('mousedown', onMouseDown)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('mousedown', onMouseDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open])

        const current = connections.find((c) => c.id === connectionId) || null

        const choose = async (id) => {
          setBusy(true)
          try {
            const res = await host.call('selectConnection', { sessionId, connectionId: id })
            if (res && res.ok === true) {
              setConnectionId(res.connectionId || id)
              setError(null)
            } else {
              setError((res && res.error) || '切换失败')
            }
          } catch (err) {
            setError(String((err && err.message) || err))
          } finally {
            setBusy(false)
            setOpen(false)
          }
        }

        return React.createElement(
          'span',
          { className: 'dsh-nlbi-root' },
          React.createElement(
            'button', {
              type: 'button',
              className: 'dsh-nlbi-btn' + (current ? ' is-on' : ''),
              title: current
                ? '当前连接：' + current.name + '（' + current.host + ':' + current.port + '/' + current.database + '）点击切换'
                : '选择当前会话使用的 MySQL 连接',
              disabled: busy,
              onClick: () => setOpen((v) => !v),
              onMouseDown: (e) => e.preventDefault(),
            },
            '🐬 ',
            React.createElement('span', { className: 'dsh-nlbi-btn-label' }, current ? current.name : '数据库'),
          ),
          error ? React.createElement('span', { className: 'dsh-nlbi-err', title: error }, error) : null,
          open ? React.createElement(
            'div', { className: 'dsh-nlbi-panel', onClick: (e) => e.stopPropagation() },
            React.createElement(
              'div', { className: 'dsh-nlbi-panel-header' },
              React.createElement(
                'div', null,
                React.createElement('div', { className: 'dsh-nlbi-panel-title' }, '选择数据库连接'),
                React.createElement('div', { className: 'dsh-nlbi-panel-sub' }, '仅对当前会话生效，随时可切换'),
              ),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-nlbi-panel-close',
                title: '关闭',
                'aria-label': '关闭',
                onClick: () => setOpen(false),
              }, '✕'),
            ),
            React.createElement(
              'div', { className: 'dsh-nlbi-panel-body' },
              connections.length === 0
                ? React.createElement(
                    'div', { className: 'dsh-nlbi-empty' },
                    '还没有配置 MySQL 连接。请打开 设置 → MySQL 数据库 添加连接（主机、账号、可读表）。',
                  )
                : connections.map((c) => {
                    const selected = c.id === connectionId
                    const chips = Array.isArray(c.tables) ? c.tables : []
                    const showMore = chips.length > 8
                    const shown = showMore ? chips.slice(0, 8) : chips
                    return React.createElement(
                      'button', {
                        type: 'button',
                        key: c.id,
                        className: 'dsh-nlbi-item' + (selected ? ' is-selected' : ''),
                        onClick: () => choose(c.id),
                        title: selected ? '当前连接' : '点击切换到此连接',
                      },
                      React.createElement(
                        'div', { className: 'dsh-nlbi-item-head' },
                        React.createElement('span', { className: 'dsh-nlbi-item-name' }, c.name),
                        selected ? React.createElement('span', { className: 'dsh-nlbi-badge sel' }, '✓ 当前') : null,
                        c.allowWrite ? React.createElement('span', { className: 'dsh-nlbi-badge w' }, '可写') : null,
                      ),
                      React.createElement(
                        'div', { className: 'dsh-nlbi-item-sub' },
                        c.host + ':' + c.port + ' / ' + (c.database || '未指定默认库'),
                      ),
                      chips.length > 0
                        ? React.createElement(
                            'div', { className: 'dsh-nlbi-chips' },
                            shown.map((t) => React.createElement('span', { key: t, className: 'dsh-nlbi-chip' }, t)),
                            showMore ? React.createElement('span', { className: 'dsh-nlbi-chip more' }, '+' + (chips.length - 8) + ' 表') : null,
                          )
                        : React.createElement(
                            'div', { className: 'dsh-nlbi-chips' },
                            React.createElement('span', { className: 'dsh-nlbi-chip' }, '全部表（未限制）'),
                          ),
                    )
                  }),
            ),
          ) : null,
        )
      }

      // ── 设置页：连接配置 ────────────────────────────────────────────────
      function blankDraft() {
        return { id: '', name: '', host: '127.0.0.1', port: '3306', user: 'root', password: '', database: '', tables: '', allowWrite: false }
      }

      function buildConnectionPayload(draft) {
        const tables = String(draft.tables || '')
          .split(/[,，;；\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
        return {
          id: draft.id || undefined,
          name: String(draft.name || '').trim(),
          host: String(draft.host || '').trim(),
          port: Number(draft.port),
          user: String(draft.user || '').trim(),
          password: draft.password === undefined ? undefined : String(draft.password),
          database: String(draft.database || '').trim(),
          tables,
          allowWrite: draft.allowWrite === true,
        }
      }

      function MysqlSettingsPage() {
        const [connections, setConnections] = React.useState(null) // null = 加载中
        const [loadError, setLoadError] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [message, setMessage] = React.useState(null)
        const [confirmId, setConfirmId] = React.useState(null)
        const [testResult, setTestResult] = React.useState(null)

        const load = React.useCallback(async () => {
          const list = await fetchConnections()
          if (list !== null) {
            setConnections(list)
            setLoadError(null)
          } else {
            setLoadError('连接列表加载失败：MySQL RPC 服务不可用（请确认插件已正确安装并重启 dsh web）。')
          }
        }, [])

        React.useEffect(() => {
          load()
          const onChange = () => { load() }
          window.addEventListener(CONFIG_EVENT, onChange)
          return () => window.removeEventListener(CONFIG_EVENT, onChange)
        }, [load])

        const startAdd = () => { setDraft(blankDraft()); setTestResult(null); setMessage(null) }
        const startEdit = (c) => {
          setDraft({
            id: c.id,
            name: c.name,
            host: c.host,
            port: String(c.port),
            user: c.user,
            password: '',
            database: c.database,
            tables: (c.tables || []).join(', '),
            allowWrite: c.allowWrite === true,
          })
          setTestResult(null)
          setMessage(null)
        }

        const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }))
        const setChecked = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.checked === true }))

        const save = async () => {
          if (!draft) return
          if (!String(draft.name || '').trim()) { setMessage({ kind: 'err', text: '连接名称不能为空' }); return }
          setBusy(true)
          setMessage(null)
          try {
            const res = await host.call('saveConnection', { connection: buildConnectionPayload(draft) })
            if (res && res.ok === true) {
              setDraft(null)
              setMessage({ kind: 'ok', text: '已保存：' + res.connection.name })
              await load()
              notifyConfigChanged()
            } else {
              setMessage({ kind: 'err', text: (res && res.error) || '保存失败' })
            }
          } catch (err) {
            setMessage({ kind: 'err', text: String((err && err.message) || err) })
          } finally {
            setBusy(false)
          }
        }

        const test = async () => {
          if (!draft) return
          setBusy(true)
          setTestResult(null)
          try {
            const res = await host.call('testConnection', { connection: buildConnectionPayload(draft) })
            setTestResult(res && res.ok === true
              ? { ok: true, latencyMs: res.latencyMs }
              : { ok: false, error: (res && res.error) || '连接失败' })
          } catch (err) {
            setTestResult({ ok: false, error: String((err && err.message) || err) })
          } finally {
            setBusy(false)
          }
        }

        const remove = async (c) => {
          if (confirmId !== c.id) { setConfirmId(c.id); return }
          setBusy(true)
          setMessage(null)
          try {
            const res = await host.call('deleteConnection', { connectionId: c.id })
            if (res && res.ok === true) {
              setMessage({ kind: 'ok', text: '已删除：' + c.name })
              await load()
              notifyConfigChanged()
            } else {
              setMessage({ kind: 'err', text: (res && res.error) || '删除失败' })
            }
          } catch (err) {
            setMessage({ kind: 'err', text: String((err && err.message) || err) })
          } finally {
            setBusy(false)
            setConfirmId(null)
          }
        }

        const editingExisting = draft !== null && draft.id !== ''

        return React.createElement(
          'div', { className: 'dsh-nlbi-settings' },
          React.createElement(
            'div', { className: 'dsh-nlbi-settings-head' },
            React.createElement(
              'div', null,
              React.createElement('h2', { className: 'dsh-nlbi-settings-title' }, '🐬 MySQL 数据库连接'),
              React.createElement('p', { className: 'dsh-nlbi-settings-desc' },
                '配置后，所有 Agent 预设的会话都能通过输入栏按钮选择连接，并使用 mysql_query / mysql_tables / mysql_execute 工具。连接信息保存在本机（' + 'DSH_HOME/storages/dsh-plugin-nlbi/connections.json' + '）。'),
            ),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-nlbi-btn2 primary',
              disabled: busy || draft !== null,
              onClick: startAdd,
            }, '+ 添加连接'),
          ),
          message ? React.createElement('div', { className: 'dsh-nlbi-msg ' + message.kind }, message.text) : null,
          connections === null
            ? React.createElement('div', { className: 'dsh-nlbi-empty' }, loadError || '加载中…')
            : connections.length === 0 && draft === null
              ? React.createElement('div', { className: 'dsh-nlbi-empty' }, '还没有配置任何连接。点击「添加连接」开始。')
              : null,
          Array.isArray(connections) ? connections.map((c) => React.createElement(
            'div', { key: c.id, className: 'dsh-nlbi-card' },
            React.createElement(
              'div', { className: 'dsh-nlbi-card-head' },
              React.createElement('span', { className: 'dsh-nlbi-card-name' }, c.name),
              c.allowWrite ? React.createElement('span', { className: 'dsh-nlbi-badge w' }, '可写') : React.createElement('span', { className: 'dsh-nlbi-badge' }, '只读'),
              c.tables.length > 0 ? React.createElement('span', { className: 'dsh-nlbi-badge' }, '白名单 ' + c.tables.length + ' 张表') : React.createElement('span', { className: 'dsh-nlbi-badge' }, '全部表'),
            ),
            React.createElement('div', { className: 'dsh-nlbi-card-sub' },
              c.host + ':' + c.port + ' / ' + (c.database || '未指定默认库') + ' · 用户 ' + c.user + (c.hasPassword ? ' · 已存密码' : ' · 无密码')),
            c.tables.length > 0 ? React.createElement(
              'div', { className: 'dsh-nlbi-chips' },
              c.tables.slice(0, 24).map((t) => React.createElement('span', { key: t, className: 'dsh-nlbi-chip' }, t)),
              c.tables.length > 24 ? React.createElement('span', { className: 'dsh-nlbi-chip more' }, '+' + (c.tables.length - 24) + ' 表') : null,
            ) : null,
            React.createElement(
              'div', { className: 'dsh-nlbi-card-actions' },
              React.createElement('button', { type: 'button', className: 'dsh-nlbi-btn2', disabled: busy, onClick: () => startEdit(c) }, '编辑'),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-nlbi-btn2',
                disabled: busy,
                onClick: async () => {
                  setBusy(true)
                  try {
                    const res = await host.call('testConnection', { connectionId: c.id })
                    setMessage(res && res.ok === true
                      ? { kind: 'ok', text: '连接正常：' + c.name + '（' + res.latencyMs + ' ms）' }
                      : { kind: 'err', text: (res && res.error) || '连接失败' })
                  } catch (err) {
                    setMessage({ kind: 'err', text: String((err && err.message) || err) })
                  } finally {
                    setBusy(false)
                  }
                },
              }, '测试'),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-nlbi-btn2 danger',
                disabled: busy,
                onClick: () => remove(c),
              }, confirmId === c.id ? '确认删除？' : '删除'),
            ),
          )) : null,
          draft !== null ? React.createElement(
            'div', { className: 'dsh-nlbi-card' },
            React.createElement(
              'div', { className: 'dsh-nlbi-card-head' },
              React.createElement('span', { className: 'dsh-nlbi-card-name' }, draft.id ? '编辑连接' : '新建连接'),
            ),
            React.createElement(
              'div', { className: 'dsh-nlbi-form' },
              React.createElement(
                'div', { className: 'dsh-nlbi-form-grid' },
                React.createElement(
                  'div', { className: 'dsh-nlbi-field wide' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, '连接名称 *'),
                  React.createElement('input', { className: 'dsh-nlbi-input', value: draft.name, placeholder: '例如：演示库（QA）', onChange: set('name') }),
                ),
                React.createElement(
                  'div', { className: 'dsh-nlbi-field' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, '主机'),
                  React.createElement('input', { className: 'dsh-nlbi-input', value: draft.host, placeholder: '192.168.9.181', onChange: set('host') }),
                ),
                React.createElement(
                  'div', { className: 'dsh-nlbi-field' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, '端口'),
                  React.createElement('input', { className: 'dsh-nlbi-input', type: 'number', min: 1, max: 65535, value: draft.port, onChange: set('port') }),
                ),
                React.createElement(
                  'div', { className: 'dsh-nlbi-field' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, '用户名'),
                  React.createElement('input', { className: 'dsh-nlbi-input', value: draft.user, placeholder: 'root', onChange: set('user') }),
                ),
                React.createElement(
                  'div', { className: 'dsh-nlbi-field' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, editingExisting ? '密码（留空保持不变）' : '密码'),
                  React.createElement('input', { className: 'dsh-nlbi-input', type: 'password', value: draft.password, autoComplete: 'new-password', onChange: set('password') }),
                ),
                React.createElement(
                  'div', { className: 'dsh-nlbi-field' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, '默认数据库'),
                  React.createElement('input', { className: 'dsh-nlbi-input', value: draft.database, placeholder: 'yd_wechat_rpa（可留空）', onChange: set('database') }),
                ),
                React.createElement(
                  'div', { className: 'dsh-nlbi-field' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, '只读模式'),
                  React.createElement('input', { className: 'dsh-nlbi-input', value: '强制只读（工具层拦截写语句）', readOnly: true }),
                ),
                React.createElement(
                  'div', { className: 'dsh-nlbi-field wide' },
                  React.createElement('span', { className: 'dsh-nlbi-field-label' }, '可读表白名单（逗号分隔；留空 = 不限制，可读全部表）'),
                  React.createElement('input', { className: 'dsh-nlbi-input', value: draft.tables, placeholder: 'rpa_task, rpa_order_group_binding', onChange: set('tables') }),
                ),
                React.createElement(
                  'label', { className: 'dsh-nlbi-check wide' },
                  React.createElement('input', { className: 'dsh-nlbi-switch', type: 'checkbox', checked: draft.allowWrite, onChange: setChecked('allowWrite') }),
                  React.createElement('span', null, '允许写操作（启用 mysql_execute 工具：仅 INSERT/UPDATE/DELETE，仍受白名单约束）'),
                ),
              ),
              React.createElement('p', { className: 'dsh-nlbi-hint' },
                '写操作默认关闭。即使开启，DROP/TRUNCATE/ALTER 等 DDL 与多语句执行也一律被拒绝。'),
              React.createElement(
                'div', { className: 'dsh-nlbi-card-actions' },
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-btn2 primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-btn2', disabled: busy, onClick: test }, busy ? '测试中…' : '测试连接'),
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-btn2', disabled: busy, onClick: () => { setDraft(null); setTestResult(null) } }, '取消'),
              ),
              testResult !== null
                ? testResult.ok
                  ? React.createElement('span', { className: 'dsh-nlbi-test-ok' }, '✓ 连接成功（' + testResult.latencyMs + ' ms）')
                  : React.createElement('span', { className: 'dsh-nlbi-test-err' }, '✗ ' + testResult.error)
                : null,
            ),
          ) : null,
        )
      }

      // ── ★ 新增：BI 结果渲染组件 ──────────────────────────────────────────
      // 渲染 nl_query 返回的：SQL 草稿 + 数据表格 + 图表（ECharts 按需加载）
      const BI_ACCENT = 'var(--dsw-alias-brand-primary, #0D9488)'
      const BI_CSS = `
        .dsh-nlbi-cards { display:flex; flex-direction:column; gap:8px; width:100%; max-width:900px; }
        .dsh-nlbi-card2 {
          border:1px solid var(--dsw-alias-border-l1); border-radius:10px; overflow:hidden;
          background:var(--dsw-alias-bg-layer-1, transparent);
        }
        .dsh-nlbi-card2-head {
          display:flex; align-items:center; justify-content:space-between; gap:8px;
          padding:8px 12px; font-size:12px; font-weight:600;
          border-bottom:1px solid var(--dsw-alias-border-l1);
          background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent);
        }
        .dsh-nlbi-sql {
          font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:11px;
          padding:8px 12px; white-space:pre-wrap; word-break:break-all; line-height:1.5;
          color:var(--dsw-alias-label-secondary);
        }
        .dsh-nlbi-actions { display:flex; gap:6px; padding:6px 12px; flex-wrap:wrap; }
        .dsh-nlbi-btn {
          height:24px; padding:0 10px; font-size:11px; border-radius:6px; cursor:pointer;
          border:1px solid var(--dsw-alias-border-l1); background:transparent;
          color:var(--dsw-alias-label-primary);
        }
        .dsh-nlbi-btn:hover { border-color:` + BI_ACCENT + `; color:` + BI_ACCENT + `; }
        .dsh-nlbi-btn.primary { background:` + BI_ACCENT + `; border-color:` + BI_ACCENT + `; color:#fff; }
        .dsh-nlbi-btn:disabled { opacity:.45; cursor:not-allowed; }
        .dsh-nlbi-table-wrap { overflow-x:auto; max-height:340px; overflow-y:auto; }
        .dsh-nlbi-table { border-collapse:collapse; width:100%; font-size:11px; min-width:480px; }
        .dsh-nlbi-table th, .dsh-nlbi-table td {
          border:1px solid var(--dsw-alias-border-l1); padding:5px 8px; text-align:left;
          white-space:nowrap; max-width:260px; overflow:hidden; text-overflow:ellipsis;
        }
        .dsh-nlbi-table th { position:sticky; top:0; background:var(--dsw-alias-bg-layer-2, #fff); font-weight:600; }
        .dsh-nlbi-table td { color:var(--dsw-alias-label-primary); }
        .dsh-nlbi-table tr:hover td { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, transparent); }
        .dsh-nlbi-chart-box { height:260px; padding:8px; }
        .dsh-nlbi-chart-empty { height:120px; display:flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-secondary); font-size:12px; }
        .dsh-nlbi-expl { padding:2px 12px 8px; font-size:11px; color:var(--dsw-alias-label-secondary); }
        .dsh-nlbi-tabs { display:flex; gap:4px; padding:6px 12px 0; }
        .dsh-nlbi-tab {
          font-size:11px; padding:3px 10px; border-radius:6px 6px 0 0; cursor:pointer;
          border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary);
        }
        .dsh-nlbi-tab.on { background:var(--dsw-alias-bg-layer-1); color:` + BI_ACCENT + `; border-color:var(--dsw-alias-border-l1); border-bottom-color:transparent; }
        /* ── ★ M2 新增：侧栏数据面板 SchemaTree + GridPanel ── */
        .dsh-nlbi-panel { display:flex; flex-direction:column; gap:8px; padding:4px 2px 20px; }
        .dsh-nlbi-tree { display:flex; flex-direction:column; gap:2px; font-size:12px; }
        .dsh-nlbi-tree-item {
          display:flex; align-items:center; gap:6px; padding:4px 8px; border-radius:6px; cursor:pointer;
          color:var(--dsw-alias-label-primary); border:none; background:transparent; text-align:left; font:inherit;
        }
        .dsh-nlbi-tree-item:hover { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
        .dsh-nlbi-tree-item.open { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
        .dsh-nlbi-tree-indent { padding-left:20px; display:flex; flex-direction:column; gap:2px; }
        .dsh-nlbi-coltype { color:var(--dsw-alias-label-secondary); font-size:10px; font-family:ui-monospace, monospace; }
        .dsh-nlbi-badge2 { font-size:9px; padding:1px 5px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
        .dsh-nlbi-badge2.key { color:` + BI_ACCENT + `; border-color:currentColor; }
        .dsh-nlbi-toolbar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:6px 0; }
        .dsh-nlbi-search {
          flex:1; min-width:120px; box-sizing:border-box; font-size:11px; padding:5px 8px; border-radius:6px;
          border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-input, transparent);
          color:var(--dsw-alias-label-primary);
        }
        .dsh-nlbi-grid-btn {
          height:22px; padding:0 8px; font-size:11px; border-radius:6px; cursor:pointer;
          border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-primary);
        }
        .dsh-nlbi-grid-btn:hover:not(:disabled) { border-color:` + BI_ACCENT + `; color:` + BI_ACCENT + `; }
        .dsh-nlbi-grid-btn:disabled { opacity:.45; cursor:not-allowed; }
        .dsh-nlbi-pager { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--dsw-alias-label-secondary); padding:4px 0; }
        .dsh-nlbi-pager-num { min-width:64px; text-align:center; }
        .dsh-nlbi-empty2 { padding:12px 8px; color:var(--dsw-alias-label-secondary); font-size:12px; text-align:center; }
        /* ── ★ M2 新增：报表管理 ── */
        .dsh-nlbi-reports { display:flex; flex-direction:column; gap:8px; }
        .dsh-nlbi-report-card {
          border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px;
          display:flex; flex-direction:column; gap:6px; background:var(--dsw-alias-bg-layer-1, transparent);
        }
        .dsh-nlbi-report-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
        .dsh-nlbi-report-name { font-weight:600; font-size:12px; }
        .dsh-nlbi-report-sub { color:var(--dsw-alias-label-secondary); font-size:10px; word-break:break-all; }
        .dsh-nlbi-report-actions { display:flex; gap:6px; flex-wrap:wrap; }
        /* ★★ 统一面板子导航 */
        .dsh-nlbi-uni { display:flex; flex-direction:column; gap:0; }
        .dsh-nlbi-utabs { display:flex; gap:0; border-bottom:1px solid var(--dsw-alias-border-l1); margin-bottom:14px; }
        .dsh-nlbi-utab {
          font-size:12px; font-weight:600; padding:8px 16px; cursor:pointer; border:none; background:transparent;
          color:var(--dsw-alias-label-secondary); border-bottom:2px solid transparent; transition:all .15s ease;
        }
        .dsh-nlbi-utab:hover { color:var(--dsw-alias-label-primary); }
        .dsh-nlbi-utab.on { color:` + BI_ACCENT + `; border-bottom-color:` + BI_ACCENT + `; }
        .dsh-nlbi-ubody { min-height:400px; }
        /* ★★ 右侧栏全能工作台 */
        .dsh-nlbi-wb { display:flex; flex-direction:column; height:100%; gap:0; font-size:12px; }
        .dsh-nlbi-wb-conn {
          display:flex; align-items:center; gap:8px; padding:10px 12px;
          border-bottom:1px solid var(--dsw-alias-border-l1);
        }
        .dsh-nlbi-wb-select {
          flex:1; min-width:0; font-size:12px; padding:5px 8px; border-radius:6px;
          border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-input, transparent);
          color:var(--dsw-alias-label-primary);
        }
        .dsh-nlbi-wb-hint { color:var(--dsw-alias-label-secondary); font-size:11px; }
        .dsh-nlbi-wb-tabs { display:flex; gap:0; border-bottom:1px solid var(--dsw-alias-border-l1); padding:0 8px; }
        .dsh-nlbi-wb-tab {
          font-size:12px; font-weight:600; padding:8px 12px; cursor:pointer; border:none; background:transparent;
          color:var(--dsw-alias-label-secondary); border-bottom:2px solid transparent; transition:all .15s ease;
        }
        .dsh-nlbi-wb-tab:hover { color:var(--dsw-alias-label-primary); }
        .dsh-nlbi-wb-tab.on { color:` + BI_ACCENT + `; border-bottom-color:` + BI_ACCENT + `; }
        .dsh-nlbi-wb-body { flex:1; overflow-y:auto; padding:12px; min-height:0; }
        .dsh-nlbi-wb-area { display:flex; flex-direction:column; gap:10px; height:100%; }
        .dsh-nlbi-wb-ask { display:flex; flex-direction:column; gap:8px; }
        .dsh-nlbi-wb-input {
          width:100%; box-sizing:border-box; font-size:12px; line-height:1.5; padding:8px 10px; resize:vertical;
          border:1px solid var(--dsw-alias-border-l1); border-radius:8px; font-family:inherit;
          background:var(--dsw-alias-bg-input, transparent); color:var(--dsw-alias-label-primary);
        }
        .dsh-nlbi-wb-input:focus { outline:none; border-color:` + BI_ACCENT + `; box-shadow:0 0 0 3px color-mix(in srgb, ` + BI_ACCENT + ` 14%, transparent); }
        .dsh-nlbi-wb-askbar { display:flex; gap:8px; }
        .dsh-nlbi-wb .dsh-nlbi-cards { max-width:none; }
      `

      function ensureBiCss() {
        if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="dsh-plugin-nlbi/bi.css"]')) {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-plugin-nlbi'
          tag.dataset.pluginCss = 'dsh-plugin-nlbi/bi.css'
          tag.textContent = BI_CSS
          document.head.appendChild(tag)
        }
      }
      ensureBiCss()

      /**
       * 渲染 BI 结果：SQL 草稿 + 表格 / 图表切换 + 收藏按钮。
       * 输入 props.biResult：{ sql, explain, result: {columns, rows, truncated}, chart }
       */
      function NlbiRenderResult({ biResult, sessionId, host, onSaved }) {
        const [tab, setTab] = React.useState('table')
        const [saving, setSaving] = React.useState(false)
        const [savedMsg, setSavedMsg] = React.useState(null)
        const [tableRows, setTableRows] = React.useState(
          biResult && biResult.result && Array.isArray(biResult.result.rows) ? biResult.result.rows.slice(0, 500) : [],
        )
        const [tableCols, setTableCols] = React.useState(
          biResult && biResult.result && Array.isArray(biResult.result.columns) ? biResult.result.columns : [],
        )

        if (!biResult || !biResult.result) return React.createElement('div', { className: 'dsh-nlbi-chart-empty' }, '无查询结果')

        const hasChart = biResult.chart !== undefined && biResult.chart !== null

        const saveAsReport = async () => {
          setSaving(true)
          setSavedMsg(null)
          try {
            const res = await host.call('saveReport', {
              report: {
                name: (biResult.question || '数据查询').slice(0, 60),
                question: biResult.question || '',
                connectionId: biResult.connectionId || '',
                sql: biResult.sql,
                chart: biResult.chart || null,
              },
            })
            if (res && res.ok === true) {
              setSavedMsg('已收藏为报表 ✓')
              if (typeof onSaved === 'function') onSaved()
            } else {
              setSavedMsg((res && res.error) || '收藏失败')
            }
          } catch (err) {
            setSavedMsg(String((err && err.message) || err))
          } finally {
            setSaving(false)
          }
        }

        return React.createElement(
          'div', { className: 'dsh-nlbi-cards' },
          // SQL 草稿卡
          React.createElement(
            'div', { className: 'dsh-nlbi-card2' },
            React.createElement('div', { className: 'dsh-nlbi-card2-head' }, '生成 SQL（只读）'),
            React.createElement('div', { className: 'dsh-nlbi-sql' }, biResult.sql || ''),
            React.createElement(
              'div', { className: 'dsh-nlbi-actions' },
              React.createElement('button', {
                type: 'button', className: 'dsh-nlbi-btn', disabled: saving,
                onClick: () => { navigator.clipboard && navigator.clipboard.writeText(biResult.sql || '') },
              }, '复制 SQL'),
              React.createElement('button', {
                type: 'button', className: 'dsh-nlbi-btn', disabled: saving,
                onClick: saveAsReport,
              }, saving ? '保存中…' : '💾 收藏为报表'),
              savedMsg ? React.createElement('span', { style: { fontSize: 11, color: savedMsg.includes('✓') ? 'var(--dsw-alias-state-success-primary,#22c55e)' : 'var(--dsw-alias-state-error-primary,#ef4444)' } }, savedMsg) : null,
            ),
          ),
          // 结果卡：tabs 切换 表格 / 图表
          React.createElement(
            'div', { className: 'dsh-nlbi-card2' },
            React.createElement(
              'div', { className: 'dsh-nlbi-tabs' },
              React.createElement('button', { type: 'button', className: 'dsh-nlbi-tab' + (tab === 'table' ? ' on' : ''), onClick: () => setTab('table') }, '表格 (' + tableRows.length + ')'),
              hasChart ? React.createElement('button', { type: 'button', className: 'dsh-nlbi-tab' + (tab === 'chart' ? ' on' : ''), onClick: () => setTab('chart') }, '图表') : null,
            ),
            React.createElement('div', { className: 'dsh-nlbi-expl' }, biResult.explain || ''),
            // 表格视图
            tab === 'table'
              ? React.createElement(
                  'div', { className: 'dsh-nlbi-table-wrap' },
                  React.createElement(
                    'table', { className: 'dsh-nlbi-table' },
                    React.createElement(
                      'thead', null,
                      React.createElement('tr', null, tableCols.map((c) => React.createElement('th', { key: c }, String(c)))),
                    ),
                    React.createElement(
                      'tbody', null,
                      tableRows.map((row, i) =>
                        React.createElement('tr', { key: i },
                          tableCols.map((c) => React.createElement('td', { key: c, title: String(row[c] ?? '') }, String(row[c] ?? '')))),
                      ),
                    ),
                  ),
                )
              : null,
            // 图表视图
            tab === 'chart'
              ? React.createElement(NlbiChart, { spec: biResult.chart, fallback: { tableCols, tableRows } })
              : null,
          ),
        )
      }

      /**
       * 轻量 ECharts 渲染（按 chartSpec 转 ECharts option）。
       * 若环境无 echarts 则降级为 SVG 直方图。
       */
      function NlbiChart({ spec, fallback }) {
        const boxRef = React.useRef(null)
        const [err, setErr] = React.useState(null)

        React.useEffect(() => {
          if (!boxRef.current || !spec) return
          const el = boxRef.current
          let disposed = false

          const renderEcharts = () => {
            try {
              const echartsLib = typeof window !== 'undefined' && (window.echarts || window.__echarts)
              if (!echartsLib || typeof echartsLib.init !== 'function') {
                // 降级：SVG 直方图
                renderSvgFallback(el, spec, fallback)
                return
              }
              const chart = echartsLib.init(el, null, { renderer: 'canvas' })
              chart.setOption(buildEchartsOption(spec, fallback))
              const onResize = () => { if (!disposed) chart.resize() }
              window.addEventListener('resize', onResize)
              return () => {
                disposed = true
                window.removeEventListener('resize', onResize)
                chart.dispose()
              }
            } catch (e) {
              setErr(String((e && e.message) || e))
              renderSvgFallback(el, spec, fallback)
            }
          }

          // 尝试动态加载 echarts（CDN），失败则 SVG
          if (!window.echarts && !window.__echarts) {
            const script = document.createElement('script')
            script.src = 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js'
            script.onload = () => renderEcharts()
            script.onerror = () => renderSvgFallback(el, spec, fallback)
            el.dataset.loading = '1'
            document.head.appendChild(script)
            return () => { try { script.remove() } catch (e) {} }
          }
          return renderEcharts()
        }, [spec])

        if (!spec) return React.createElement('div', { className: 'dsh-nlbi-chart-empty' }, '无图表数据')
        return React.createElement('div', { ref: boxRef, className: 'dsh-nlbi-chart-box', 'data-chart-type': spec.type || '' }, err ? React.createElement('div', { className: 'dsh-nlbi-chart-empty' }, '图表加载失败: ' + err) : null)
      }

      /** chartSpec → ECharts option */
      function buildEchartsOption(spec, fallback) {
        const data = spec.data || (fallback && fallback.tableRows) || []
        const cols = spec.xField ? [spec.xField, ...(spec.yFields || [])] : (fallback && fallback.tableCols) || []

        // pie
        if (spec.type === 'pie') {
          const nameKey = spec.pieField || (spec.xField && [spec.xField]) || (fallback && fallback.tableCols && fallback.tableCols[0]) || cols[0]
          const valueKey = (spec.yFields && spec.yFields[0]) || (cols.length > 1 ? cols[1] : null)
          return {
            title: { text: spec.title || '', left: 'center', textStyle: { fontSize: 13 } },
            tooltip: { trigger: 'item' },
            series: [{
              type: 'pie', radius: ['35%', '68%'], center: ['50%', '55%'],
              data: data.map((r) => ({ name: String(r[nameKey] ?? ''), value: Number(r[valueKey] ?? 0) })),
              label: { fontSize: 11 },
            }],
          }
        }

        // stat 统计卡（用柱状显示 SUM/AVG/MAX/MIN）
        if (spec.type === 'stat') {
          const stats = spec.stats || {}
          const items = [
            ['总和', stats.sum], ['平均', stats.avg], ['最大', stats.max], ['最小', stats.min],
          ].filter(([, v]) => v !== undefined && v !== null)
          return {
            title: { text: spec.title || '', left: 'center', textStyle: { fontSize: 13 } },
            tooltip: {},
            xAxis: { type: 'category', data: items.map(([n]) => n) },
            yAxis: { type: 'value' },
            series: [{ type: 'bar', data: items.map(([, v]) => v), barWidth: 40 }],
          }
        }

        // bar / line
        const xKey = spec.xField || (cols.length > 0 ? cols[0] : null)
        const yKeys = (spec.yFields && spec.yFields.length > 0 ? spec.yFields : (cols.length > 1 ? [cols[1]] : []))
        const categories = data.map((r) => String(r[xKey] ?? ''))
        return {
          title: { text: spec.title || '', left: 'center', textStyle: { fontSize: 13 } },
          tooltip: { trigger: 'axis' },
          legend: yKeys.length > 1 ? { bottom: 0, textStyle: { fontSize: 11 } } : undefined,
          grid: { left: 40, right: 16, top: 36, bottom: yKeys.length > 1 ? 40 : 28 },
          xAxis: { type: 'category', data: categories, axisLabel: { fontSize: 10, rotate: categories.length > 12 ? 30 : 0 } },
          yAxis: { type: 'value' },
          series: yKeys.map((y) => ({
            name: String(y), type: spec.type === 'line' ? 'line' : 'bar', smooth: spec.type === 'line',
            data: data.map((r) => Number(r[y] ?? 0)),
          })),
        }
      }

      /** SVG 直方图降级渲染（轻量自绘，避免第三方依赖） */
      function renderSvgFallback(el, spec, fallback) {
        if (!el) return
        const data = spec && spec.data ? spec.data : ((fallback && fallback.tableRows) || [])
        const dataArr = spec && spec.type === 'stat' && spec.stats
          ? [['总和', spec.stats.sum], ['平均', spec.stats.avg], ['最大', spec.stats.max], ['最小', spec.stats.min]].filter(([, v]) => v != null)
          : data.map((r) => [String(r[(spec.xField || (fallback && fallback.tableCols && fallback.tableCols[0]) || Object.keys(r)[0])] ?? ''), Number(r[spec.yFields ? spec.yFields[0] : (fallback && fallback.tableCols && fallback.tableCols[1]) || ''] ?? 0)])

        const width = el.clientWidth || 600
        const height = 240
        const margin = { top: 20, right: 16, bottom: 40, left: 44 }
        const maxV = Math.max(1, ...dataArr.map(([, v]) => Number(v)))
        const rectW = Math.min(42, (width - margin.left - margin.right) / dataArr.length * 0.6)
        const gap = (width - margin.left - margin.right) / dataArr.length

        let svg = '<svg width="' + width + '" height="' + height + '" xmlns="http://www.w3.org/2000/svg">'
        svg += '<text x="' + (width / 2) + '" y="14" text-anchor="middle" font-size="12" fill="#888">' + (spec && spec.title ? spec.title : '') + '</text>'
        dataArr.forEach(([label, value], i) => {
          const h = (Number(value) / maxV) * (height - margin.top - margin.bottom)
          const x = margin.left + i * gap + (gap - rectW) / 2
          const y = height - margin.bottom - h
          svg += '<rect x="' + x + '" y="' + y + '" width="' + rectW + '" height="' + h + '" fill="' + BI_ACCENT + '" rx="2">'
          svg += '<title>' + label + ': ' + value + '</title></rect>'
          svg += '<text x="' + (x + rectW / 2) + '" y="' + (height - margin.bottom + 12) + '" text-anchor="middle" font-size="9" fill="#888">' + String(label).slice(0, 12) + '</text>'
          svg += '<text x="' + (x + rectW / 2) + '" y="' + (y - 4) + '" text-anchor="middle" font-size="9" fill="#666">' + value + '</text>'
        })
        svg += '</svg>'
        el.innerHTML = svg
      }

      /**
       * ★ M2: SchemaTree — 侧栏表结构导航树（连接→库→表→列）
       * 模拟 IDEA Database 工具窗的树形导航体验。
       * 通过 host.call('schemaTree', {connectionId}) 获取数据。
       */
      function NlbiSchemaTree({ connectionId, host }) {
        const [loading, setLoading] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [schema, setSchema] = React.useState(null) // { database, tables }
        const [expanded, setExpanded] = React.useState({}) // { tableName: true }

        const load = React.useCallback(async () => {
          if (!connectionId) return
          setLoading(true)
          setError(null)
          try {
            const res = await host.call('schemaTree', { connectionId })
            if (res && res.ok === true) {
              setSchema(res)
            } else {
              setError((res && res.error) || '加载失败')
            }
          } catch (err) {
            setError(String((err && err.message) || err))
          } finally {
            setLoading(false)
          }
        }, [connectionId, host])

        React.useEffect(() => { load() }, [load])

        const toggle = (tbl) => setExpanded((prev) => ({ ...prev, [tbl]: !prev[tbl] }))

        if (loading) return React.createElement('div', { className: 'dsh-nlbi-empty2' }, '加载中…')
        if (error) return React.createElement('div', { className: 'dsh-nlbi-empty2', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error)
        if (!schema || !schema.tables || schema.tables.length === 0) return React.createElement('div', { className: 'dsh-nlbi-empty2' }, '当前连接无可读表')

        return React.createElement(
          'div', { className: 'dsh-nlbi-tree' },
          React.createElement('div', { style: { padding: '4px 8px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            schema.database ? '📁 ' + schema.database + ' (' + schema.tables.length + ' 表)' : schema.tables.length + ' 张表'),
          schema.tables.slice(0, 200).map((tbl) =>
            React.createElement(
              'div', { key: tbl.name },
              React.createElement('button', {
                type: 'button',
                className: 'dsh-nlbi-tree-item' + (expanded[tbl.name] ? ' open' : ''),
                onClick: () => toggle(tbl.name),
                onDoubleClick: () => {
                  // 双击触发 GridPanel 打开（通过事件通知父组件）
                  try { window.dispatchEvent(new CustomEvent('dsh-plugin-nlbi:preview-table', { detail: { table: tbl.name } })) } catch (e) {}
                },
                title: tbl.comment || tbl.name,
              },
                expanded[tbl.name] ? '▼' : '▶',
                '📋', tbl.name,
                tbl.comment ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10, marginLeft: 4 } }, tbl.comment) : null,
              ),
              expanded[tbl.name]
                ? React.createElement(
                    'div', { className: 'dsh-nlbi-tree-indent' },
                    (tbl.columns || []).map((col) =>
                      React.createElement(
                        'div', { key: col.column, className: 'dsh-nlbi-tree-item', style: { cursor: 'default' } },
                        React.createElement('span', { className: 'dsh-nlbi-coltype' }, col.type),
                        col.column,
                        col.key === 'PRI' ? React.createElement('span', { className: 'dsh-nlbi-badge2 key' }, 'PK') : null,
                        col.key === 'MUL' ? React.createElement('span', { className: 'dsh-nlbi-badge2' }, 'MUL') : null,
                        col.comment ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10 } }, col.comment) : null,
                      ),
                    ),
                  )
                : null,
            ),
          ),
        )
      }

      /**
       * ★ M2: GridPanel — 表数据网格预览（分页/排序/过滤）
       * 双击表或点击预览按钮打开，数据通过 host.call('tablePreview') 获取。
       * 与 IDEA Database 工具窗「双击表看数据」心智对齐。
       */
      function NlbiGridPanel({ connectionId, table, host, onClose }) {
        const [loading, setLoading] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [data, setData] = React.useState(null) // { columns, rows, page, totalPages, total }
        const [page, setPage] = React.useState(1)
        const [pageSize] = React.useState(100)
        const [sortColumn, setSortColumn] = React.useState(null)
        const [sortOrder, setSortOrder] = React.useState('ASC')
        const [where, setWhere] = React.useState('')
        const [whereInput, setWhereInput] = React.useState('')

        const load = React.useCallback(async () => {
          if (!connectionId || !table) return
          setLoading(true)
          setError(null)
          try {
            const res = await host.call('tablePreview', {
              connectionId,
              table,
              page,
              pageSize,
              sortColumn,
              sortOrder,
              where: where || undefined,
            })
            if (res && res.ok === true) {
              setData(res)
            } else {
              setError((res && res.error) || '加载失败')
            }
          } catch (err) {
            setError(String((err && err.message) || err))
          } finally {
            setLoading(false)
          }
        }, [connectionId, table, page, pageSize, sortColumn, sortOrder, where, host])

        React.useEffect(() => { load() }, [load])

        const doSort = (col) => {
          if (sortColumn === col) {
            setSortOrder((o) => (o === 'ASC' ? 'DESC' : 'ASC'))
          } else {
            setSortColumn(col)
            setSortOrder('ASC')
          }
          setPage(1)
        }

        const doWhere = () => {
          setWhere(whereInput.trim())
          setPage(1)
        }

        const resetFilter = () => {
          setWhereInput('')
          setWhere('')
          setSortColumn(null)
          setSortOrder('ASC')
          setPage(1)
        }

        if (!table) return React.createElement('div', { className: 'dsh-nlbi-empty2' }, '双击左侧表名查看数据')
        if (loading) return React.createElement('div', { className: 'dsh-nlbi-empty2' }, '加载数据…')

        return React.createElement(
          'div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          // 工具栏
          React.createElement(
            'div', { className: 'dsh-nlbi-toolbar' },
            React.createElement('input', {
              className: 'dsh-nlbi-search',
              placeholder: 'WHERE 条件（如 status=1）…',
              value: whereInput,
              onChange: (e) => setWhereInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doWhere() },
            }),
            React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', onClick: doWhere }, '过滤'),
            React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', onClick: resetFilter }, '重置'),
            React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', onClick: load, disabled: loading }, '↻ 刷新'),
          ),
          // 错误
          error ? React.createElement('div', { className: 'dsh-nlbi-empty2', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
          // 数据表格
          data && data.columns && data.columns.length > 0
            ? React.createElement(
                'div', { className: 'dsh-nlbi-table-wrap', style: { maxHeight: 400 } },
                React.createElement(
                  'table', { className: 'dsh-nlbi-table' },
                  React.createElement(
                    'thead', null,
                    React.createElement('tr', null,
                      data.columns.map((c) =>
                        React.createElement('th', {
                          key: c,
                          style: { cursor: 'pointer' },
                          onClick: () => doSort(c),
                          title: (sortColumn === c ? (sortOrder === 'ASC' ? '↑' : '↓') : '') + ' 点击排序',
                        },
                          c + (sortColumn === c ? (sortOrder === 'ASC' ? ' ↑' : ' ↓') : '')),
                      ),
                    ),
                  ),
                  React.createElement(
                    'tbody', null,
                    data.rows.map((row, i) =>
                      React.createElement('tr', { key: i },
                        data.columns.map((c) => React.createElement('td', { key: c, title: String(row[c] ?? '') }, String(row[c] ?? '')))),
                    ),
                  ),
                ),
              )
            : React.createElement('div', { className: 'dsh-nlbi-empty2' }, data ? '无数据' : ''),
          // 分页
          data
            ? React.createElement(
                'div', { className: 'dsh-nlbi-pager' },
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', disabled: page <= 1, onClick: () => setPage((p) => Math.max(1, p - 1)) }, '‹ 上一页'),
                React.createElement('span', { className: 'dsh-nlbi-pager-num' }, '第 ' + data.page + ' / ' + (data.totalPages || 1) + ' 页 (共 ' + data.total + ' 行)'),
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', disabled: page >= (data.totalPages || 1), onClick: () => setPage((p) => p + 1) }, '下一页 ›'),
              )
            : null,
        )
      }

      /**
       * ★ M2: ReportsPanel — 报表管理面板
       * 列出已收藏的报表，支持重跑、删除、导出 Markdown。
       */
      function NlbiReportsPanel({ host }) {
        const [reports, setReports] = React.useState(null) // null=loading
        const [loading, setLoading] = React.useState(false)
        const [rerunResult, setRerunResult] = React.useState({}) // { reportId: { data, loading, error } }
        const [confirmId, setConfirmId] = React.useState(null)

        const load = React.useCallback(async () => {
          try {
            const res = await host.call('listReports', {})
            if (res && res.ok === true) {
              setReports(Array.isArray(res.reports) ? res.reports : [])
            } else {
              setReports([])
            }
          } catch (err) {
            setReports([])
          }
        }, [host])

        React.useEffect(() => { load() }, [load])
        // 监听报表变更事件
        React.useEffect(() => {
          const onChange = () => load()
          window.addEventListener('dsh-plugin-nlbi:config-changed', onChange)
          return () => window.removeEventListener('dsh-plugin-nlbi:config-changed', onChange)
        }, [load])

        const rerun = async (reportId) => {
          setRerunResult((prev) => ({ ...prev, [reportId]: { loading: true, data: null, error: null } }))
          try {
            const res = await host.call('rerunReport', { reportId })
            if (res && res.ok === true) {
              setRerunResult((prev) => ({ ...prev, [reportId]: { loading: false, data: res, error: null } }))
            } else {
              setRerunResult((prev) => ({ ...prev, [reportId]: { loading: false, data: null, error: (res && res.error) || '执行失败' } }))
            }
          } catch (err) {
            setRerunResult((prev) => ({ ...prev, [reportId]: { loading: false, data: null, error: String((err && err.message) || err) } }))
          }
        }

        const remove = async (reportId) => {
          if (confirmId !== reportId) { setConfirmId(reportId); return }
          setConfirmId(null)
          try {
            await host.call('deleteReport', { reportId })
            load()
          } catch (err) { /* ignore */ }
        }

        const exportMd = (report) => {
          const md = [
            '# ' + report.name,
            '',
            report.question ? '> ' + report.question : '',
            '',
            '## SQL',
            '```sql',
            report.sql,
            '```',
            '',
            '*更新于: ' + new Date(report.updatedAt || Date.now()).toLocaleString() + '*',
          ].join('\n')
          navigator.clipboard && navigator.clipboard.writeText(md)
        }

        if (reports === null) return React.createElement('div', { className: 'dsh-nlbi-empty2' }, '加载中…')
        if (reports.length === 0) return React.createElement('div', { className: 'dsh-nlbi-empty2' }, '暂无收藏报表')

        return React.createElement(
          'div', { className: 'dsh-nlbi-reports' },
          reports.map((r) => {
            const runState = rerunResult[r.id] || {}
            return React.createElement(
              'div', { key: r.id, className: 'dsh-nlbi-report-card' },
              React.createElement(
                'div', { className: 'dsh-nlbi-report-head' },
                React.createElement('span', { className: 'dsh-nlbi-report-name' }, r.name),
                r.chart ? React.createElement('span', { className: 'dsh-nlbi-badge2', style: { color: 'var(--dsw-alias-state-success-primary)' } }, '📊 ' + (r.chart.type || 'chart')) : null,
              ),
              r.question ? React.createElement('div', { className: 'dsh-nlbi-report-sub' }, '💬 ' + r.question) : null,
              React.createElement('div', { className: 'dsh-nlbi-report-sub', style: { fontFamily: 'monospace', fontSize: 10 } }, r.sql),
              // 重跑结果
              runState.loading ? React.createElement('div', { className: 'dsh-nlbi-empty2' }, '执行中…') : null,
              runState.error ? React.createElement('div', { className: 'dsh-nlbi-empty2', style: { color: 'var(--dsw-alias-state-error-primary)' } }, runState.error) : null,
              runState.data
                ? React.createElement(
                    'div', { className: 'dsh-nlbi-table-wrap', style: { maxHeight: 200 } },
                    React.createElement(
                      'table', { className: 'dsh-nlbi-table' },
                      React.createElement('thead', null, React.createElement('tr', null, (runState.data.result && runState.data.result.columns || []).map((c) => React.createElement('th', { key: c }, c)))),
                      React.createElement('tbody', null, (runState.data.result && runState.data.result.rows || []).slice(0, 20).map((row, i) =>
                        React.createElement('tr', { key: i }, (runState.data.result.columns || []).map((c) => React.createElement('td', { key: c }, String(row[c] ?? '')))),
                      )),
                    ),
                  )
                : null,
              React.createElement(
                'div', { className: 'dsh-nlbi-report-actions' },
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', disabled: runState.loading, onClick: () => rerun(r.id) }, runState.loading ? '…' : '▶ 重跑'),
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', onClick: () => exportMd(r) }, '📋 导出 SQL'),
                React.createElement('button', { type: 'button', className: 'dsh-nlbi-grid-btn', style: { color: 'var(--dsw-alias-state-error-primary)' }, onClick: () => remove(r.id) }, confirmId === r.id ? '确认删除？' : '🗑 删除'),
              ),
            )
          }),
        )
      }

      /**
       * ★★ 右侧栏图标（数据库桶造型），betterSidebar 的 icon 约定：(size) => React 元素
       */
      function renderNlbiIcon(size) {
        return React.createElement('svg', {
          width: size, height: size, viewBox: '0 0 18 18', fill: 'none',
          stroke: 'currentColor', strokeWidth: '1.35', 'aria-hidden': 'true',
        },
          React.createElement('ellipse', { cx: 9, cy: 4, rx: 5.4, ry: 2.1 }),
          React.createElement('path', { d: 'M3.6 4v10c0 1.16 2.42 2.1 5.4 2.1s5.4-.94 5.4-2.1V4' }),
          React.createElement('path', { d: 'M3.6 9c0 1.16 2.42 2.1 5.4 2.1s5.4-.94 5.4-2.1' }),
        )
      }

      /**
       * ★★ 右侧栏「全能工作台」（图2 那种常驻右侧面板，用 betterSidebar.registerTab 挂载）。
       * 收到 betterSidebar 约定 props：{ ctx, scope, visible, host }，scope.sessionId = 当前会话。
       * 结构：顶部连接切换 + 3 个子区（🔍 智能查询 / 🗂 数据浏览 / 📊 报表）。
       */
      function NlbiSidebarWorkbench(tabProps) {
        const visible = tabProps && tabProps.visible
        const scope = tabProps && tabProps.scope
        const host = tabProps && tabProps.host
        const sessionId = (scope && scope.sessionId) || undefined
        const [subtab, setSubtab] = React.useState('query') // query | browse | reports
        const [connections, setConnections] = React.useState([])
        const [activeConnectionId, setActiveConnectionId] = React.useState(null)
        const [loading, setLoading] = React.useState(true)

        const loadConns = React.useCallback(async () => {
          try {
            const res = await host.call('getSelection', { sessionId })
            if (res && res.ok === true) {
              const list = Array.isArray(res.connections) ? res.connections : []
              setConnections(list)
              setActiveConnectionId(res.connectionId || (list[0] && list[0].id) || null)
            }
          } catch (err) { /* ignore */ } finally { setLoading(false) }
        }, [sessionId, host])

        React.useEffect(() => { if (visible) loadConns() }, [visible, loadConns])
        React.useEffect(() => {
          const on = () => loadConns()
          window.addEventListener('dsh-plugin-nlbi:config-changed', on)
          return () => window.removeEventListener('dsh-plugin-nlbi:config-changed', on)
        }, [loadConns])

        // 双击表 → 切到数据浏览子区
        React.useEffect(() => {
          const on = () => setSubtab('browse')
          window.addEventListener('dsh-plugin-nlbi:preview-table', on)
          return () => window.removeEventListener('dsh-plugin-nlbi:preview-table', on)
        }, [])

        const chooseConn = async (id) => {
          setActiveConnectionId(id)
          if (sessionId) { try { await host.call('selectConnection', { sessionId, connectionId: id }) } catch (e) {} }
        }

        if (visible === false) return null

        const subBtn = (key, label) =>
          React.createElement('button', {
            type: 'button', className: 'dsh-nlbi-wb-tab' + (subtab === key ? ' on' : ''),
            onClick: () => setSubtab(key),
          }, label)

        return React.createElement(
          'div', { className: 'dsh-nlbi-wb' },
          // 顶部连接切换
          React.createElement(
            'div', { className: 'dsh-nlbi-wb-conn' },
            React.createElement('span', { style: { fontSize: 13 } }, '🔌'),
            loading
              ? React.createElement('span', { className: 'dsh-nlbi-wb-hint' }, '加载连接…')
              : connections.length === 0
                ? React.createElement('span', { className: 'dsh-nlbi-wb-hint' }, '未配置连接，请到 设置 → Nlbi 数据库 添加')
                : React.createElement('select', {
                    className: 'dsh-nlbi-wb-select',
                    value: activeConnectionId || '',
                    onChange: (e) => chooseConn(e.target.value),
                  }, connections.map((c) => React.createElement('option', { key: c.id, value: c.id }, c.name + '  ·  ' + (c.database || c.host)))),
          ),
          // 子区导航
          React.createElement(
            'div', { className: 'dsh-nlbi-wb-tabs' },
            subBtn('query', '🔍 智能查询'),
            subBtn('browse', '🗂 数据浏览'),
            subBtn('reports', '📊 报表'),
          ),
          // 内容区
          React.createElement(
            'div', { className: 'dsh-nlbi-wb-body' },
            subtab === 'query' ? React.createElement(NlbiQueryConsole, { sessionId, connectionId: activeConnectionId, host }) : null,
            subtab === 'browse' ? React.createElement(NlbiBrowseArea, { connectionId: activeConnectionId, host }) : null,
            subtab === 'reports' ? React.createElement(NlbiReportsArea, { sessionId, connectionId: activeConnectionId, host }) : null,
          ),
        )
      }

      /**
       * 尝试把文本"发到对话"：定位对话输入框，填入并聚焦；失败则复制到剪贴板并提示。
       */
      function sendTextToChat(text) {
        try {
          const candidates = Array.prototype.slice.call(
            document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]'),
          )
          // 选可见且尺寸最大的候选（大概率是对话输入框）
          const el = candidates
            .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 120)
            .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
          if (el) {
            if (el.tagName === 'TEXTAREA') {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
              setter && setter.set ? setter.set.call(el, text) : (el.value = text)
              el.dispatchEvent(new Event('input', { bubbles: true }))
            } else {
              el.textContent = text
              el.dispatchEvent(new Event('input', { bubbles: true }))
            }
            el.focus()
            return { ok: true }
          }
        } catch (err) { /* 降级 */ }
        try { navigator.clipboard && navigator.clipboard.writeText(text) } catch (e) {}
        return { ok: false }
      }

      /**
       * 🔍 智能查询子区：自然语言即时查询 + 结果表格/图表 + 发到对话。
       */
      function NlbiQueryConsole({ sessionId, connectionId, host }) {
        const [q, setQ] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [result, setResult] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [sent, setSent] = React.useState(null)

        const run = async () => {
          const question = q.trim()
          if (!question) return
          setBusy(true); setError(null); setResult(null); setSent(null)
          try {
            const res = await host.call('nlQuery', { sessionId, question })
            if (res && res.ok === true) setResult(Object.assign({}, res, { question, connectionId }))
            else setError((res && res.error) || '查询失败')
          } catch (err) { setError(String((err && err.message) || err)) } finally { setBusy(false) }
        }

        const toChat = () => {
          const q2 = (result && result.question) || q
          const r = sendTextToChat(q2)
          setSent(r.ok ? '已填入对话输入框，回车发送即可' : '已复制问题到剪贴板，粘贴到对话框发送')
        }

        return React.createElement(
          'div', { className: 'dsh-nlbi-wb-area' },
          React.createElement(
            'div', { className: 'dsh-nlbi-wb-ask' },
            React.createElement('textarea', {
              className: 'dsh-nlbi-wb-input', rows: 2,
              placeholder: '用自然语言问数据，Ctrl+Enter 查询',
              value: q, onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run() },
            }),
            React.createElement(
              'div', { className: 'dsh-nlbi-wb-askbar' },
              React.createElement('button', { type: 'button', className: 'dsh-nlbi-btn primary', disabled: busy || !connectionId, onClick: run }, busy ? '查询中…' : '🔍 查询'),
              React.createElement('button', { type: 'button', className: 'dsh-nlbi-btn', disabled: !q.trim(), onClick: toChat }, '💬 发到对话'),
            ),
            // ★ 推荐测试查询语句
            React.createElement(
              'div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 } },
              ['查询所有用户', '统计各分类商品数量', '上个月每天的订单量', '订单最多的前5个用户'].map((s) =>
                React.createElement('button', {
                  type: 'button', key: s,
                  style: { fontSize: 11, padding: '3px 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, cursor: 'pointer', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)', color: 'var(--dsw-alias-label-secondary)' },
                  onClick: () => { setQ(s); setTimeout(() => { const t = document.querySelector('.dsh-nlbi-wb-input'); if (t) t.focus(); }, 50); },
                }, '💡 ' + s),
              ),
            ),
          ),
          sent ? React.createElement('div', { className: 'dsh-nlbi-wb-hint', style: { color: 'var(--dsw-alias-state-success-primary)' } }, sent) : null,
          error ? React.createElement('div', { className: 'dsh-nlbi-empty2', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
          !connectionId ? React.createElement('div', { className: 'dsh-nlbi-empty2' }, '请先在顶部选择数据库连接') : null,
          result ? React.createElement(NlbiRenderResult, { biResult: result, host, sessionId }) : null,
        )
      }

      /**
       * 🗂 数据浏览子区：表结构树（上）+ 数据网格（下），适配右侧栏窄布局。
       */
      function NlbiBrowseArea({ connectionId, host }) {
        const [table, setTable] = React.useState(null)
        React.useEffect(() => {
          const on = (e) => { if (e.detail && e.detail.table) setTable(e.detail.table) }
          window.addEventListener('dsh-plugin-nlbi:preview-table', on)
          return () => window.removeEventListener('dsh-plugin-nlbi:preview-table', on)
        }, [])
        React.useEffect(() => { setTable(null) }, [connectionId])

        if (!connectionId) return React.createElement('div', { className: 'dsh-nlbi-empty2' }, '请先在顶部选择数据库连接')
        return React.createElement(
          'div', { className: 'dsh-nlbi-wb-area' },
          React.createElement('div', { style: { maxHeight: 240, overflow: 'auto', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8, marginBottom: 8 } },
            React.createElement(NlbiSchemaTree, { connectionId, host }),
          ),
          React.createElement('div', { style: { flex: 1, overflow: 'auto' } },
            table
              ? React.createElement(NlbiGridPanel, { connectionId, table, host })
              : React.createElement('div', { className: 'dsh-nlbi-empty2' }, '双击上方表名查看数据'),
          ),
        )
      }

      /**
       * 📊 报表子区：自然语言生成报表（描述→图表+数据）+ 收藏 + 已收藏列表（可重跑/导出/删除）。
       */
      function NlbiReportsArea({ sessionId, connectionId, host }) {
        const [desc, setDesc] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [gen, setGen] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [refreshKey, setRefreshKey] = React.useState(0)

        const generate = async () => {
          const question = desc.trim()
          if (!question) return
          setBusy(true); setError(null); setGen(null)
          try {
            const res = await host.call('nlQuery', { sessionId, question })
            if (res && res.ok === true) setGen(Object.assign({}, res, { question, connectionId }))
            else setError((res && res.error) || '生成失败')
          } catch (err) { setError(String((err && err.message) || err)) } finally { setBusy(false) }
        }

        return React.createElement(
          'div', { className: 'dsh-nlbi-wb-area' },
          React.createElement(
            'div', { className: 'dsh-nlbi-wb-ask' },
            React.createElement('textarea', {
              className: 'dsh-nlbi-wb-input', rows: 2,
              placeholder: '描述报表，例如：按分类统计商品数量做成饼图 / 近3个月订单金额趋势',
              value: desc, onChange: (e) => setDesc(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate() },
            }),
            React.createElement('button', { type: 'button', className: 'dsh-nlbi-btn primary', disabled: busy || !connectionId, onClick: generate }, busy ? '生成中…' : '📊 生成报表'),
          ),
          error ? React.createElement('div', { className: 'dsh-nlbi-empty2', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
          gen ? React.createElement(NlbiRenderResult, { biResult: gen, host, sessionId, onSaved: () => setRefreshKey((x) => x + 1) }) : null,
          React.createElement('div', { style: { marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } },
            React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--dsw-alias-label-secondary)' } }, '📁 已收藏报表'),
            React.createElement(NlbiReportsPanel, { host, key: refreshKey }),
          ),
        )
      }

      /**
       * 对话输出渲染器：识别消息中内嵌的 BI 结果 JSON 并渲染。
       * DSH 输出槽位把消息内容作为 props 传入，我们按约定解析。
       */
      function NlbiOutputRenderer({ props, host }) {
        // props 透传，直接渲染子内容（若 DSH 支持后处理标记）
        if (!props) return null

        // 尝试从 props 中找到包含 nlbi 结果的内容
        const raw = props && (props.content || props.text || props.value || props.children)
        if (!raw) return null

        // 若是字符串且含 nlbi-result 标记，尝试解析渲染
        if (typeof raw === 'string' && raw.includes('__nlbi_result__')) {
          try {
            const markerStart = raw.indexOf('__nlbi_result__')
            const jsonStart = markerStart + '__nlbi_result__'.length
            const parsed = JSON.parse(raw.slice(jsonStart))
            if (parsed && parsed.sql && parsed.result) {
              return React.createElement(NlbiRenderResult, { biResult: parsed, host })
            }
          } catch (err) { /* 解析失败则走默认文本渲染 */ }
        }
        // 不匹配则原样渲染内容（保持默认行为）
        return React.createElement('div', null, typeof raw === 'string' ? raw : JSON.stringify(raw))
      }

      // ── 槽位注册 ─────────────────────────────────────────────────────────
      // 1) 输入栏 🐬 连接选择按钮（会话级）
      slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'dsh-plugin-nlbi', order: 90, label: 'MySQL 数据库' },
        (props) => React.createElement(MysqlControl, props),
      ))

      // 2) 对话输出：BI 结果渲染（识别内嵌结果 JSON）
      slots.inject('conversation.output', () => slots.register(
        { name: 'conversation.output', id: 'dsh-plugin-nlbi-output', order: 500, label: 'BI 结果渲染' },
        (props) => React.createElement(NlbiOutputRenderer, { props, host }),
      ))

      // 3) ★ 右侧栏全能工作台（betterSidebar 服务存在时挂载；不存在则注册到 settings.section 降级）
      //    功能：连接切换 + 智能查询 + 数据浏览 + 报表
      try {
        const sidebar = ctx.get('betterSidebar')
        if (sidebar && typeof sidebar.registerTab === 'function') {
          // betterSidebar 在线 → 注册右侧栏 tab
          ctx.inject(['betterSidebar'], (scope) => {
            const sb = scope && scope.betterSidebar
            if (!sb || typeof sb.registerTab !== 'function') return
            scope.effect(() => {
              const dispose = sb.registerTab({
                id: 'dsh-plugin-nlbi-workbench',
                title: 'Nlbi 数据库',
                icon: renderNlbiIcon,
                order: 32,
                single: true,
                component: (tabProps) => React.createElement(NlbiSidebarWorkbench, Object.assign({}, tabProps, { host })),
              })
              return () => { if (typeof dispose === 'function') dispose() }
            }, 'dsh-plugin-nlbi: sidebar workbench tab')
          })
        } else {
          // betterSidebar 不可用 → 注册 settings.section 降级 + 提示安装前置插件
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'nlbi', order: 25, label: 'Nlbi 数据库' },
            () => React.createElement('div', { className: 'dsh-nlbi-settings' },
              React.createElement('div', { className: 'dsh-nlbi-settings-head' },
                React.createElement('div', null,
                  React.createElement('h2', { className: 'dsh-nlbi-settings-title' }, '🛢 Nlbi 数据库'),
                  React.createElement('p', { className: 'dsh-nlbi-settings-desc' }, '要使用右侧栏全能工作台，需要安装前置插件 dsh-better-sidebar。'),
                ),
              ),
              React.createElement('div', { className: 'dsh-nlbi-card', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 10%, transparent)', borderColor: 'var(--dsw-alias-state-warning-primary, #f59e0b)' } },
                React.createElement('div', { className: 'dsh-nlbi-card-head' },
                  React.createElement('span', { style: { fontSize: 14 } }, '⚠️ 需要前置插件'),
                ),
                React.createElement('div', { style: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
                  React.createElement('p', null, '当前 DSH 环境缺少右侧栏支持。请安装以下任意一个前置插件：'),
                  React.createElement('p', { style: { fontFamily: 'monospace', fontSize: 11, background: 'var(--dsw-alias-bg-input)', padding: '8px 12px', borderRadius: 6 } },
                    'dsh plugin --profile web add dsh-better-sidebar'),
                  React.createElement('p', { style: { fontFamily: 'monospace', fontSize: 11, background: 'var(--dsw-alias-bg-input)', padding: '8px 12px', borderRadius: 6 } },
                    'dsh plugin --profile web add @linxin666/dsh-web-ui-all'),
                  React.createElement('p', null, '安装后重启 DSH（dsh --profile web），即可在右侧栏看到 🛢 Nlbi 数据库 工作台。'),
                  React.createElement('p', null, '安装前，仍可通过以下方式使用本插件的基础功能：'),
                  React.createElement('ul', null,
                    React.createElement('li', null, '🐬 输入栏左侧选择数据库连接'),
                    React.createElement('li', null, '💬 对话中直接询问数据（Agent 会自动调用 mysql_query 工具）'),
                  ),
                ),
              ),
              // 连接管理功能（即使没有侧栏也可用）
              React.createElement('div', { style: { marginTop: 16 } },
                React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '🔌 连接管理'),
                React.createElement(MysqlSettingsPage, null),
              ),
            ),
          ))
        }
      } catch (err) {
        // betterSidebar 探测失败，降级注册 settings.section
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'nlbi', order: 25, label: 'Nlbi 数据库' },
          () => React.createElement(MysqlSettingsPage),
        ))
      }
    }

    return { inject: ['remote'], apply }
  },
})
