/*
 * Loki dashboard — vanilla client. No bundler, no framework.
 *
 * The server returns a per-page HTML shell (see `ui-mount.ts`); the
 * `<body data-page="...">` attribute tells this script which renderer
 * to run. Navigation is plain `<a href>` — no client-side router —
 * which means each page load is independent and the browser back/forward
 * buttons just work.
 *
 * Pages fetch their JSON via `api()` and render into `#page`. The flow
 * detail page additionally opens an EventSource for live count updates.
 */

import { renderStateMachine } from './state-machine.js'

const NAV_LINKS = [
  ['overview', '/', 'Overview'],
  ['schema', '/schema', 'Schema'],
  ['flows', '/flows', 'Flows'],
  ['transactions', '/transactions', 'Transactions'],
  ['actors', '/actors', 'Actors'],
  ['anomalies', '/anomalies', 'Anomalies'],
  ['outbox', '/outbox', 'Outbox'],
  ['scheduled', '/scheduled', 'Scheduler'],
  ['holds', '/holds', 'Holds'],
  ['disputes', '/disputes', 'Disputes'],
  ['reconciler', '/reconciler', 'Reconciler'],
  ['fx', '/fx', 'FX'],
]

let currentTenant = null
let activeES = null

// =============================================================================
// Bootstrap
// =============================================================================

async function init() {
  paintNav()
  await renderVersion()
  await refreshHealth()
  setInterval(refreshHealth, 15_000)
  await loadTenants()
  bindTenantSelect()
  renderActivePage()
}

function paintNav() {
  const nav = document.getElementById('nav')
  const active = document.body.dataset['activeNav']
  for (const [id, href, label] of NAV_LINKS) {
    const a = document.createElement('a')
    a.href = href
    a.textContent = label
    a.dataset['page'] = id
    if (id === active) a.setAttribute('aria-current', 'page')
    nav.appendChild(a)
  }
}

function bindTenantSelect() {
  document.getElementById('tenant-select').addEventListener('change', (e) => {
    currentTenant = e.target.value
    localStorage.setItem('loki:tenant', currentTenant)
    renderActivePage()
  })
}

// =============================================================================
// API helpers
// =============================================================================

async function api(path, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) }
  const res = await fetch(path, { ...opts, headers })
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json')) {
    throw new Error(`${res.status} ${res.statusText} — non-JSON response`)
  }
  const body = await res.json()
  if (!res.ok) throw new Error(body.detail || body.title || `${res.status}`)
  return body
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on') && typeof v === 'function') {
      e.addEventListener(k.slice(2).toLowerCase(), v)
    } else {
      e.setAttribute(k, String(v))
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    e.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return e
}

function set(node, ...children) {
  node.replaceChildren()
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

function pill(text, cls = '') {
  return el('span', { class: `pill ${cls}` }, text)
}

function actorLink(actor) {
  if (!actor || !actor.type || !actor.id) return '—'
  return el('a', {
    href: `/actors/${encodeURIComponent(actor.type)}/${encodeURIComponent(actor.id)}`,
    class: 'mono',
  }, `${actor.type}:${actor.id}`)
}

const CURRENCY_SYMBOLS = {
  NGN: '₦',
  USD: '$',
  EUR: '€',
  GBP: '£',
  KES: 'KSh ',
  GHS: 'GH₵',
  ZAR: 'R',
}

/**
 * Render an account balance cell. Positive balances ("money is here") get an
 * inflow indicator; negative balances ("money has flowed out through this
 * account") show the absolute value with an outflow tag — bare minus signs
 * read as bugs, even though they're accounting-correct for credit-side
 * accounts (platform history, processor sources, fee sinks, etc.).
 */
function balanceCell(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return '—'
  let n
  try { n = BigInt(amount) } catch { return String(amount) }
  if (n === 0n) {
    return el('span', { class: 'balance balance-zero mono right' }, fmtMinor('0', currency))
  }
  if (n < 0n) {
    return el('span', { class: 'balance balance-out mono right' },
      `↓ ${fmtMinor((-n).toString(), currency)} `,
      el('span', { class: 'tag tag-out' }, 'outflow'),
    )
  }
  return el('span', { class: 'balance balance-in mono right' },
    `↑ ${fmtMinor(amount, currency)} `,
    el('span', { class: 'tag tag-in' }, 'held'),
  )
}

const DEFAULT_SCALE = 2
function fmtMinor(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return '—'
  let n
  try { n = BigInt(amount) } catch { return String(amount) }
  const neg = n < 0n
  if (neg) n = -n
  const override = (currency && window.__LOKI_CURRENCY_SCALE) ? window.__LOKI_CURRENCY_SCALE[currency] : undefined
  const scale = typeof override === 'number' ? override : DEFAULT_SCALE
  const sym = currency ? (CURRENCY_SYMBOLS[currency] ?? `${currency} `) : ''
  if (scale === 0) {
    const grouped = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return `${neg ? '-' : ''}${sym}${grouped}`
  }
  const divisor = 10n ** BigInt(scale)
  const whole = n / divisor
  const frac = (n % divisor).toString().padStart(scale, '0')
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${sym}${grouped}.${frac}`
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch { return iso }
}

function showError(err) {
  return el('div', { class: 'error' }, err.message || String(err))
}

// =============================================================================
// Tenant loading + version + health
// =============================================================================

async function renderVersion() {
  try {
    const v = await api('/api/v1/version')
    document.getElementById('version-cell').textContent =
      `core ${v.core} • cli ${v.cli} • schema ${v.schemaFingerprint.slice(0, 8)} • build ${v.buildHash}`
  } catch (e) {
    document.getElementById('version-cell').textContent = `version: ${e.message}`
  }
}

async function refreshHealth() {
  const cell = document.getElementById('health-cell')
  try {
    const h = await api('/api/v1/health')
    cell.className = h.ok ? 'health-ok' : 'health-bad'
    cell.textContent = `health: ${h.ok ? 'ok' : 'degraded'} • primary ${h.primary.ok ? 'up' : 'down'}` +
      (h.replica ? ` • replica ${h.replica.ok ? 'up' : 'down'}` : '')
  } catch (e) {
    cell.className = 'health-bad'
    cell.textContent = `health: ${e.message}`
  }
}

async function loadTenants() {
  try {
    const r = await api('/api/v1/tenants')
    const select = document.getElementById('tenant-select')
    set(select, ...r.items.map((t) =>
      el('option', { value: t.id }, `${t.id} (${t.state})`),
    ))
    const stored = localStorage.getItem('loki:tenant')
    if (stored && r.items.some((t) => t.id === stored)) {
      select.value = stored
      currentTenant = stored
    } else if (r.items.length > 0) {
      currentTenant = r.items[0].id
      select.value = currentTenant
    }
  } catch (e) {
    document.getElementById('tenant-select').replaceChildren(
      el('option', {}, `(error loading: ${e.message})`),
    )
  }
}

// =============================================================================
// Per-page renderers
// =============================================================================

function renderActivePage() {
  closeStream()
  const main = document.getElementById('page')
  if (!currentTenant) {
    set(main, el('p', { class: 'empty' }, 'No tenant available. Run `loki tenant create <id> --name <name>`.'))
    return
  }
  const page = document.body.dataset['page'] || 'overview'
  const renderer = RENDERERS[page] || pageOverview
  renderer(main).catch((e) => set(main, showError(e)))
}

async function pageOverview(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const s = await api(`/api/v1/tenants/${currentTenant}/summary`)
  set(main,
    el('h1', {}, `Overview · ${s.tenant.name}`),
    el('div', { class: 'grid grid-3' },
      card('Records', s.records),
      card('Transitions', s.transitions),
      card('Accounts', s.accounts),
      card('Compromised', s.compromised, s.compromised > 0 ? 'bad' : ''),
      card('Open anomalies', s.openAnomalies, s.openAnomalies > 0 ? 'warn' : ''),
      card('Outbox pending', s.outbox.pending),
      card('Outbox in-flight', s.outbox.inflight),
      card('Outbox terminal', s.outbox.terminal),
      card('Scheduled', s.scheduler.scheduled),
      card('Scheduled due', s.scheduler.due, s.scheduler.due > 0 ? 'warn' : ''),
    ),
    el('h2', {}, 'Schema versions'),
    s.schemaVersions.length === 0
      ? el('p', { class: 'empty' }, 'No data yet.')
      : table(['Version', 'Records', 'Transitions'],
          s.schemaVersions.map((v) => [String(v.version), String(v.records), String(v.transitions)])),
  )
}

function card(label, value, extra = '') {
  return el('div', { class: `card ${extra}` },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, String(value)),
  )
}

function table(headers, rows) {
  return el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, c))))),
  )
}

/**
 * Cursor-paginated table. `firstPage` is `{ items, nextCursor }` already
 * fetched. `fetchPage(cursor)` returns the same shape for subsequent pages.
 * `rowFor(item)` returns an array of cells matching `headers`. Renders a
 * single <table> + a "Load more" button that appends to the tbody and
 * removes itself when there's nothing left.
 */
function paginatedTable(headers, firstPage, fetchPage, rowFor) {
  const wrap = el('div', { class: 'paginated' })
  const tbody = el('tbody', {})
  const tbl = el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    tbody,
  )
  const appendRows = (items) => {
    for (const it of items) {
      tbody.appendChild(el('tr', {}, ...rowFor(it).map((c) => el('td', {}, c))))
    }
  }
  appendRows(firstPage.items)

  const counter = el('span', { class: 'page-counter muted' }, `${firstPage.items.length} loaded`)
  let total = firstPage.items.length
  let cursor = firstPage.nextCursor
  const moreBtn = el('button', { type: 'button', class: 'load-more' }, 'Load more')
  const controls = el('div', { class: 'pager' }, counter, moreBtn)

  const update = () => {
    counter.textContent = `${total} loaded`
    if (!cursor) moreBtn.remove()
  }

  moreBtn.addEventListener('click', async () => {
    moreBtn.disabled = true
    moreBtn.textContent = 'Loading…'
    try {
      const page = await fetchPage(cursor)
      appendRows(page.items)
      total += page.items.length
      cursor = page.nextCursor
      moreBtn.disabled = false
      moreBtn.textContent = 'Load more'
      update()
    } catch (e) {
      moreBtn.disabled = false
      moreBtn.textContent = 'Load more'
      wrap.appendChild(showError(e))
    }
  })

  wrap.appendChild(tbl)
  wrap.appendChild(controls)
  update()
  return wrap
}

async function pageSchema(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const s = await api('/api/v1/schema')
  set(main,
    el('h1', {}, `Schema · ${s.tenant}`),
    el('p', { class: 'mono' }, `version ${s.version}`),
    el('h2', {}, 'Actors'),
    table(['Type', 'Accounts'],
      s.actors.map((a) => [a.name, el('span', { class: 'mono' },
        a.accounts.map((acc) => `${acc.name}:${acc.currency}`).join(' · '),
      )])),
    el('h2', {}, 'Transaction types'),
    table(['Type', 'Initial', 'States', 'Terminal', 'Transitions'],
      s.transactions.map((t) => [
        t.name,
        t.initial,
        t.states.join(' → '),
        t.terminal.join(', '),
        t.transitions.join(' · '),
      ])),
  )
}

async function pageFlows(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const r = await api(`/api/v1/tenants/${currentTenant}/flows`)
  set(main,
    el('h1', {}, 'Flows'),
    r.items.length === 0
      ? el('p', { class: 'empty' }, 'No transaction types defined on this tenant.')
      : table(
          ['Type', 'Total instances', 'By state'],
          r.items.map((flow) => [
            el('a', { href: `/flow/${encodeURIComponent(flow.txnType)}` }, flow.txnType),
            String(flow.totalInstances),
            el('span', { class: 'mono' }, Object.entries(flow.byState).map(([s, n]) => `${s}: ${n}`).join(' · ')),
          ]),
        ),
  )
}

async function pageFlowDetail(main) {
  const m = window.location.pathname.match(/^\/flow\/([^/]+)$/)
  const txnType = m ? decodeURIComponent(m[1]) : ''
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const f = await api(`/api/v1/tenants/${currentTenant}/flows/${encodeURIComponent(txnType)}`)
  const svg = renderStateMachine(f)
  set(main,
    el('h1', {}, `Flow · ${f.txnType}`),
    svg,
    el('h2', {}, 'Transitions'),
    table(['Name', 'From', 'To', 'By', 'Count', 'Last fire'],
      f.transitions.map((t) => [
        t.name,
        Array.isArray(t.from) ? t.from.join(' | ') : t.from,
        t.to,
        t.by.join(', ') || '—',
        String(t.count),
        fmtTime(t.lastAt),
      ])),
  )
  const es = openStream(`/api/v1/tenants/${currentTenant}/stream/flows/${encodeURIComponent(txnType)}`)
  es.addEventListener('flow-counts', (e) => {
    try {
      const data = JSON.parse(e.data)
      for (const [stateName, count] of Object.entries(data.byState)) {
        const node = svg.querySelector(`[data-state="${CSS.escape(stateName)}"] text.state-count`)
        if (node) node.textContent = String(count)
      }
    } catch { /* ignore */ }
  })
}

async function pageTransactions(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/transactions`
  const first = await api(`${base}?limit=50`)
  const liveBadge = el('span', { class: 'live-badge', 'data-count': '0' }, '● live')
  const refreshLink = el('a', { href: '#', class: 'refresh' }, 'refresh')
  refreshLink.addEventListener('click', (e) => {
    e.preventDefault()
    renderActivePage()
  })
  const rowFor = (t) => [
    el('a', { href: `/transactions/${t.id}`, class: 'mono' }, t.id.slice(0, 8)),
    t.type,
    pill(t.state, t.compromised ? 'bad' : 'good'),
    fmtTime(t.updatedAt),
    t.compromised ? pill('compromised', 'bad') : '',
  ]
  set(main,
    el('div', { class: 'page-head' }, el('h1', {}, 'Transactions'), liveBadge, refreshLink),
    first.items.length === 0
      ? el('p', { class: 'empty' }, 'No transactions yet.')
      : paginatedTable(
          ['ID', 'Type', 'State', 'Updated', 'Compromised'],
          first,
          (cursor) => api(`${base}?limit=50&cursor=${encodeURIComponent(cursor)}`),
          rowFor,
        ),
  )
  let live = 0
  const es = openStream(`/api/v1/tenants/${currentTenant}/stream/transitions`)
  es.addEventListener('transition', () => {
    live += 1
    liveBadge.dataset['count'] = String(live)
    liveBadge.textContent = `● live · ${live} new transition${live === 1 ? '' : 's'}`
  })
}

async function pageTransactionDetail(main) {
  const m = window.location.pathname.match(/^\/transactions\/([0-9a-f-]{36})$/i)
  const txnId = m ? m[1] : ''
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const r = await api(`/api/v1/tenants/${currentTenant}/transactions/${encodeURIComponent(txnId)}`)
  const trace = await api(`/api/v1/tenants/${currentTenant}/transactions/${encodeURIComponent(txnId)}/trace`)
  set(main,
    el('h1', {}, `Transaction · ${r.type}`),
    el('p', { class: 'mono' }, r.id),
    el('div', { class: 'grid grid-3' },
      card('State', r.state, r.compromised ? 'bad' : ''),
      card('Version', r.version),
      card('Schema version', r.schemaVersion),
    ),
    el('h2', {}, 'Trace'),
    trace.transitions.length === 0
      ? el('p', { class: 'empty' }, 'No transitions.')
      : table(['Name', 'From → To', 'Actor', 'When', 'Hash'],
          trace.transitions.map((t) => [
            t.name,
            `${t.fromState || '—'} → ${t.toState}`,
            actorLink(t.actor),
            fmtTime(t.occurredAt),
            el('span', { class: 'mono' }, (t.rowHash || '').slice(0, 12)),
          ])),
  )
}

async function pageAnomalies(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/anomalies?unresolved=true&limit=50`
  const first = await api(base)
  const liveBadge = el('span', { class: 'live-badge', 'data-count': '0' }, '● live')
  const refreshLink = el('a', { href: '#', class: 'refresh' }, 'refresh')
  refreshLink.addEventListener('click', (e) => {
    e.preventDefault()
    renderActivePage()
  })
  const rowFor = (a) => [
    fmtTime(a.detectedAt),
    a.check,
    pill(a.severity, a.severity === 'critical' ? 'bad' : a.severity === 'error' ? 'warn' : ''),
    el('span', { class: 'mono' }, a.txnId ? a.txnId.slice(0, 8) : '—'),
  ]
  set(main,
    el('div', { class: 'page-head' }, el('h1', {}, 'Anomalies'), liveBadge, refreshLink),
    first.items.length === 0
      ? el('p', { class: 'empty' }, 'No open anomalies.')
      : paginatedTable(
          ['Detected', 'Check', 'Severity', 'Txn'],
          first,
          (cursor) => api(`${base}&cursor=${encodeURIComponent(cursor)}`),
          rowFor,
        ),
  )
  let live = 0
  const es = openStream(`/api/v1/tenants/${currentTenant}/stream/anomalies`)
  es.addEventListener('anomaly', () => {
    live += 1
    liveBadge.dataset['count'] = String(live)
    liveBadge.textContent = `● live · ${live} new anomal${live === 1 ? 'y' : 'ies'}`
  })
}

async function pageOutbox(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/outbox?limit=50`
  const first = await api(base)
  const rowFor = (o) => [
    el('span', { class: 'mono' }, o.id.slice(0, 8)),
    o.event,
    pill(o.status, o.status === 'failed_terminal' ? 'bad' : o.status === 'pending' ? 'warn' : 'good'),
    String(o.attempts),
    fmtTime(o.nextAttemptAt),
  ]
  set(main,
    el('h1', {}, 'Outbox'),
    first.items.length === 0
      ? el('p', { class: 'empty' }, 'No outbox events.')
      : paginatedTable(
          ['ID', 'Event', 'Status', 'Attempts', 'Next attempt'],
          first,
          (cursor) => api(`${base}&cursor=${encodeURIComponent(cursor)}`),
          rowFor,
        ),
  )
}

async function pageScheduled(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/scheduled?limit=50`
  const first = await api(base)
  const rowFor = (s) => [
    el('span', { class: 'mono' }, s.id.slice(0, 8)),
    s.name,
    fmtTime(s.runAt),
    pill(s.status),
    String(s.attempts),
  ]
  set(main,
    el('h1', {}, 'Scheduler'),
    first.items.length === 0
      ? el('p', { class: 'empty' }, 'Nothing scheduled.')
      : paginatedTable(
          ['ID', 'Name', 'Run at', 'Status', 'Attempts'],
          first,
          (cursor) => api(`${base}&cursor=${encodeURIComponent(cursor)}`),
          rowFor,
        ),
  )
}

async function pageHolds(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/holds?limit=50`
  const first = await api(base)
  const rowFor = (h) => [
    el('span', { class: 'mono' }, h.id.slice(0, 8)),
    el('span', { class: 'mono right' }, fmtMinor(h.amount, h.currency)),
    pill(h.status),
    fmtTime(h.placedAt),
    fmtTime(h.releasedAt),
  ]
  set(main,
    el('h1', {}, 'Holds'),
    first.items.length === 0
      ? el('p', { class: 'empty' }, 'No holds.')
      : paginatedTable(
          ['ID', 'Amount', 'Status', 'Placed', 'Released'],
          first,
          (cursor) => api(`${base}&cursor=${encodeURIComponent(cursor)}`),
          rowFor,
        ),
  )
}

async function pageDisputes(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/disputes?limit=50`
  const first = await api(base)
  const rowFor = (d) => [
    el('span', { class: 'mono' }, d.id.slice(0, 8)),
    pill(d.status, d.status === 'open' ? 'warn' : 'good'),
    fmtTime(d.openedAt),
    d.reason || '—',
  ]
  set(main,
    el('h1', {}, 'Disputes'),
    first.items.length === 0
      ? el('p', { class: 'empty' }, 'No disputes.')
      : paginatedTable(
          ['ID', 'Status', 'Opened', 'Reason'],
          first,
          (cursor) => api(`${base}&cursor=${encodeURIComponent(cursor)}`),
          rowFor,
        ),
  )
}

async function pageReconciler(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const [state, runs] = await Promise.all([
    api(`/api/v1/tenants/${currentTenant}/reconciler/state`),
    api(`/api/v1/tenants/${currentTenant}/reconciler/runs`),
  ])
  const liveBadge = el('span', { class: 'live-badge' }, '● live')
  const watermarks = el('div', { id: 'rec-watermarks' })
  const renderWatermarks = (items) => {
    set(watermarks,
      items.length === 0
        ? el('p', { class: 'empty' }, 'No watermarks yet (run the reconciler once).')
        : table(['Check', 'Watermark', 'Last sweep', 'Full sweep'],
            items.map((s) => [s.checkKind, s.watermark || '—', fmtTime(s.lastSweepAt), fmtTime(s.fullSweepAt)])),
    )
  }
  set(main,
    el('div', { class: 'page-head' }, el('h1', {}, 'Reconciler'), liveBadge),
    el('h2', {}, 'Watermarks'),
    watermarks,
    el('h2', {}, 'Recent runs (dashboard-triggered)'),
    runs.items.length === 0
      ? el('p', { class: 'empty' }, runs.note || 'No runs.')
      : table(['Run', 'Started', 'Duration', 'Anomalies', 'Status'],
          runs.items.map((r) => [
            r.id,
            fmtTime(r.startedAt),
            `${r.durationMs}ms`,
            String(r.anomalies),
            pill(r.status, r.status === 'ok' ? 'good' : 'bad'),
          ])),
  )
  renderWatermarks(state.items)

  const es = openStream(`/api/v1/tenants/${currentTenant}/stream/reconciler`)
  es.addEventListener('reconciler-state', (e) => {
    try {
      const data = JSON.parse(e.data)
      renderWatermarks(data.items || [])
    } catch { /* ignore */ }
  })
}

async function pageFx(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const s = await api('/api/v1/schema')
  const currencies = Array.from(new Set(
    s.actors.flatMap((a) => a.accounts.map((acc) => acc.currency))
  )).sort()

  if (currencies.length < 2) {
    set(main,
      el('h1', {}, 'FX'),
      el('p', { class: 'empty' }, 'Schema declares fewer than two currencies; nothing to plot.'))
    return
  }

  const stored = (() => {
    try { return JSON.parse(localStorage.getItem('loki:fx') || 'null') } catch { return null }
  })()
  const initialBase = stored?.base && currencies.includes(stored.base) ? stored.base : currencies[0]
  const initialQuote = stored?.quote && currencies.includes(stored.quote) ? stored.quote
    : currencies.find((c) => c !== initialBase) || currencies[0]

  const baseSel = el('select', { id: 'fx-base', 'aria-label': 'Base currency' },
    ...currencies.map((c) => el('option', { value: c, ...(c === initialBase ? { selected: '' } : {}) }, c)))
  const quoteSel = el('select', { id: 'fx-quote', 'aria-label': 'Quote currency' },
    ...currencies.map((c) => el('option', { value: c, ...(c === initialQuote ? { selected: '' } : {}) }, c)))
  const loadBtn = el('button', { id: 'fx-load', type: 'button' }, 'Load')
  const out = el('div', { id: 'fx-out' })

  const load = async () => {
    const base = baseSel.value
    const quote = quoteSel.value
    if (base === quote) {
      set(out, el('p', { class: 'empty' }, 'Pick two different currencies.'))
      return
    }
    localStorage.setItem('loki:fx', JSON.stringify({ base, quote }))
    set(out, el('p', { class: 'loading' }, 'Loading…'))
    try {
      const r = await api(`/api/v1/tenants/${currentTenant}/fx?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}&limit=200`)
      set(out,
        el('h2', {}, `${base} → ${quote}`),
        r.items.length === 0
          ? el('p', { class: 'empty' }, 'No FX rates published for this pair.')
          : table(['Fixed at', 'Rate', 'Source', 'Expires', 'Published'],
              r.items.map((row) => [
                fmtTime(row.fixedAt),
                el('span', { class: 'mono' }, row.rate),
                row.source,
                fmtTime(row.expiresAt) || '—',
                fmtTime(row.createdAt),
              ])),
      )
    } catch (e) {
      set(out, showError(e))
    }
  }
  loadBtn.addEventListener('click', load)

  set(main,
    el('h1', {}, 'FX'),
    el('div', { class: 'fx-controls' },
      el('label', { for: 'fx-base' }, 'Base'), baseSel,
      el('label', { for: 'fx-quote' }, 'Quote'), quoteSel,
      loadBtn),
    out,
  )
  await load()
}

async function pageActors(main) {
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const r = await api(`/api/v1/tenants/${currentTenant}/actors`)
  set(main,
    el('h1', {}, 'Actors'),
    el('p', { class: 'muted' }, 'Actor types declared on the schema. "With accounts" counts every distinct actor id that has ever had an account on this tenant. "Active (7d)" counts those who fired at least one transition in the last 7 days.'),
    r.items.length === 0
      ? el('p', { class: 'empty' }, 'Schema declares no actor types.')
      : table(['Type', 'With accounts', 'Active (7d)', 'Accounts owned'],
          r.items.map((a) => [
            el('a', { href: `/actors/${encodeURIComponent(a.type)}` }, a.type),
            String(a.count),
            String(a.active7d ?? 0),
            el('span', { class: 'mono' }, a.accounts.map((acc) => `${acc.name}:${acc.currency}`).join(' · ')),
          ])),
  )
}

async function pageActorType(main) {
  const m = window.location.pathname.match(/^\/actors\/([^/]+)$/)
  const actorType = m ? decodeURIComponent(m[1]) : ''
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/actors/${encodeURIComponent(actorType)}?limit=100`
  const first = await api(base)
  const rowFor = (a) => [
    el('a', {
      href: `/actors/${encodeURIComponent(a.type)}/${encodeURIComponent(a.id)}`,
      class: 'mono',
    }, a.id),
  ]
  set(main,
    el('div', { class: 'page-head' },
      el('h1', {}, `Actors · ${actorType}`),
      el('a', { href: '/actors', class: 'refresh' }, '← all actor types')),
    first.items.length === 0
      ? el('p', { class: 'empty' }, 'No actors of this type have any accounts on this tenant.')
      : paginatedTable(
          ['Actor ID'],
          first,
          (cursor) => api(`${base}&cursor=${encodeURIComponent(cursor)}`),
          rowFor,
        ),
  )
}

const RANGE_PRESETS = [
  { id: '1h',  label: '1 hour',   ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d',  label: '7 days',   ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30 days',  ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '90d', label: '90 days',  ms: 90 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All time', ms: null },
]

function rangeFromStored(stored) {
  if (stored && stored.kind === 'preset') {
    const p = RANGE_PRESETS.find((x) => x.id === stored.id)
    if (p) return { kind: 'preset', preset: p }
  }
  if (stored && stored.kind === 'custom' && stored.since) {
    return { kind: 'custom', since: stored.since, until: stored.until || null }
  }
  return { kind: 'preset', preset: RANGE_PRESETS[2] }
}

function rangeToQuery(range) {
  if (range.kind === 'preset') {
    if (range.preset.ms === null) return ''
    const since = new Date(Date.now() - range.preset.ms).toISOString()
    return `?since=${encodeURIComponent(since)}`
  }
  const parts = [`since=${encodeURIComponent(range.since)}`]
  if (range.until) parts.push(`until=${encodeURIComponent(range.until)}`)
  return `?${parts.join('&')}`
}

function rangeLabel(range) {
  if (range.kind === 'preset') return range.preset.label
  const s = new Date(range.since).toLocaleString()
  const u = range.until ? new Date(range.until).toLocaleString() : 'now'
  return `${s} → ${u}`
}

function rangePicker(initialRange, onChange) {
  const wrap = el('div', { class: 'range-picker' })
  const presetSel = el('select', { 'aria-label': 'Time range' },
    ...RANGE_PRESETS.map((p) => el('option', {
      value: p.id,
      ...(initialRange.kind === 'preset' && initialRange.preset.id === p.id ? { selected: '' } : {}),
    }, p.label)),
    el('option', {
      value: '__custom',
      ...(initialRange.kind === 'custom' ? { selected: '' } : {}),
    }, 'Custom…'),
  )
  const sinceIn = el('input', { type: 'datetime-local', 'aria-label': 'Since' })
  const untilIn = el('input', { type: 'datetime-local', 'aria-label': 'Until (blank = now)' })
  const applyBtn = el('button', { type: 'button', class: 'load-more' }, 'Apply')
  const custom = el('span', { class: 'range-custom' },
    el('label', {}, 'From', sinceIn),
    el('label', {}, 'To', untilIn),
    applyBtn,
  )
  const setCustomVisible = (v) => { custom.style.display = v ? 'inline-flex' : 'none' }
  setCustomVisible(initialRange.kind === 'custom')

  if (initialRange.kind === 'custom') {
    sinceIn.value = isoToLocalInput(initialRange.since)
    if (initialRange.until) untilIn.value = isoToLocalInput(initialRange.until)
  }

  presetSel.addEventListener('change', () => {
    if (presetSel.value === '__custom') {
      setCustomVisible(true)
      return
    }
    setCustomVisible(false)
    const p = RANGE_PRESETS.find((x) => x.id === presetSel.value)
    if (p) onChange({ kind: 'preset', preset: p })
  })
  applyBtn.addEventListener('click', () => {
    if (!sinceIn.value) return
    const since = new Date(sinceIn.value).toISOString()
    const until = untilIn.value ? new Date(untilIn.value).toISOString() : null
    onChange({ kind: 'custom', since, until })
  })

  wrap.appendChild(el('label', {}, 'Range', presetSel))
  wrap.appendChild(custom)
  return wrap
}

function isoToLocalInput(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function pageActor(main) {
  const m = window.location.pathname.match(/^\/actors\/([^/]+)\/([^/]+)$/)
  const actorType = m ? decodeURIComponent(m[1]) : ''
  const actorId = m ? decodeURIComponent(m[2]) : ''
  set(main, el('p', { class: 'loading' }, 'Loading…'))
  const base = `/api/v1/tenants/${currentTenant}/actors/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}`

  let range
  try { range = rangeFromStored(JSON.parse(localStorage.getItem('loki:actor-range') || 'null')) }
  catch { range = rangeFromStored(null) }

  const detail = await api(base)
  const guessCurrency = (detail.accounts.find((a) => a.currency) || {}).currency
  const summaryCards = el('div', { class: 'summary-cards' })
  const summaryLabel = el('span', { class: 'muted', id: 'range-label' }, rangeLabel(range))
  const txnsHost = el('div', { id: 'actor-txns' })

  const renderSummary = async () => {
    set(summaryCards, el('p', { class: 'loading' }, 'Loading…'))
    try {
      const s = await api(`${base}/summary${rangeToQuery(range)}`)
      // Account-perspective: every transition that hit this actor's books,
      // regardless of who fired it (the right metric for "what happened
      // to this actor's accounts").
      const acct = s.account || { transitionsTouched: 0, credited: '0', debited: '0' }
      set(summaryCards,
        el('div', { class: 'grid grid-3' },
          card(`Transitions on books · ${rangeLabel(range)}`, String(acct.transitionsTouched)),
          card(`Credited to books · ${rangeLabel(range)}`, fmtMinor(acct.credited, guessCurrency)),
          card(`Debited from books · ${rangeLabel(range)}`, fmtMinor(acct.debited, guessCurrency)),
        ),
        // "Initiated" view — the narrow "transitions this actor itself
        // fired". Useful for actor-action accountability (e.g. how many
        // confirms did this driver tap?), but for an accounting view of
        // an actor's accounts, the cards above are what you want.
        el('div', { class: 'sub-cards' },
          el('span', { class: 'muted' }, 'Initiated by this actor:'),
          el('span', {}, `${s.transitions} transition${s.transitions === 1 ? '' : 's'}`),
          el('span', { class: 'muted' }, '·'),
          el('span', {}, `credited ${fmtMinor(s.totalCredited, guessCurrency)}`),
          el('span', { class: 'muted' }, '·'),
          el('span', {}, `debited ${fmtMinor(s.totalDebited, guessCurrency)}`),
        ),
      )
    } catch (e) {
      set(summaryCards, showError(e))
    }
  }

  const renderTxns = async () => {
    set(txnsHost, el('p', { class: 'loading' }, 'Loading…'))
    try {
      const txBase = `${base}/transactions?limit=50`
      const first = await api(txBase)
      const rowFor = (t) => [
        el('a', { href: `/transactions/${t.id}`, class: 'mono' }, t.id.slice(0, 8)),
        t.type,
        pill(t.state, t.compromised ? 'bad' : 'good'),
        fmtTime(t.updatedAt),
        t.compromised ? pill('compromised', 'bad') : '',
      ]
      set(txnsHost,
        first.items.length === 0
          ? el('p', { class: 'empty' }, 'No transactions involve this actor.')
          : paginatedTable(
              ['ID', 'Type', 'State', 'Updated', 'Compromised'],
              first,
              (cursor) => api(`${txBase}&cursor=${encodeURIComponent(cursor)}`),
              rowFor,
            ),
      )
    } catch (e) {
      set(txnsHost, showError(e))
    }
  }

  const onRangeChange = (r) => {
    range = r
    localStorage.setItem('loki:actor-range', JSON.stringify(
      r.kind === 'preset' ? { kind: 'preset', id: r.preset.id } : r,
    ))
    summaryLabel.textContent = rangeLabel(r)
    renderSummary()
  }

  set(main,
    el('div', { class: 'page-head' },
      el('h1', {}, `Actor · ${detail.type}`),
      el('a', { href: `/actors/${encodeURIComponent(detail.type)}`, class: 'refresh' }, '← back to actors')),
    el('p', { class: 'mono' }, detail.id),
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('h2', {}, 'Activity'),
        summaryLabel,
      ),
      rangePicker(range, onRangeChange),
      summaryCards,
    ),
    el('h2', {}, 'Accounts'),
    detail.accounts.length === 0
      ? el('p', { class: 'empty' }, 'No accounts.')
      : table(['Name', 'Currency', 'Balance'],
          detail.accounts.map((a) => [
            a.name,
            a.currency,
            balanceCell(a.balance, a.currency),
          ])),
    el('h2', {}, 'Recent transactions'),
    el('p', { class: 'muted' }, 'Includes every record where this actor (1) created the txn, (2) fired any transition on it, or (3) is named in the participants. A payment processed by another actor will appear here if this actor is listed as a participant on that record — useful for tracing, occasionally surprising.'),
    txnsHost,
  )

  renderSummary()
  renderTxns()
}

const RENDERERS = {
  overview: pageOverview,
  schema: pageSchema,
  flows: pageFlows,
  'flow-detail': pageFlowDetail,
  transactions: pageTransactions,
  'transaction-detail': pageTransactionDetail,
  actors: pageActors,
  'actor-type': pageActorType,
  actor: pageActor,
  anomalies: pageAnomalies,
  outbox: pageOutbox,
  scheduled: pageScheduled,
  holds: pageHolds,
  disputes: pageDisputes,
  reconciler: pageReconciler,
  fx: pageFx,
}

// =============================================================================
// SSE
// =============================================================================

function openStream(url) {
  closeStream()
  activeES = new EventSource(url)
  return activeES
}

function closeStream() {
  if (activeES) {
    try { activeES.close() } catch { /* ignore */ }
    activeES = null
  }
}

window.addEventListener('beforeunload', closeStream)

// =============================================================================
// Boot
// =============================================================================

init().catch((e) => {
  document.getElementById('page').replaceChildren(showError(e))
})
