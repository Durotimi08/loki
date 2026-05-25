/*
 * SVG state-machine renderer — DASHBOARD.md §7.2.
 *
 * Pure function: takes a `Flow` payload from `/api/v1/tenants/:tid/flows/:txnType`
 * and returns an `<svg>` element. Nodes are positioned on a circle; node
 * fill encodes terminal-vs-non-terminal; node radius is fixed but the
 * count text underneath is live-updatable. Edges are quadratic Béziers
 * with width scaled to the per-transition count in the requested window;
 * the heaviest half are drawn in the accent colour.
 *
 * No dependencies. Renderer hardens against `<` / `>` / `&` in state +
 * transition names by setting `textContent` (browsers escape) rather
 * than `innerHTML`.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

const DEFAULTS = {
  width: 720,
  height: 360,
  ringRadius: 110,
  nodeRadius: 36,
}

/**
 * @param {{
 *   states: { name: string, count: number, terminal: boolean, initial: boolean }[],
 *   transitions: { name: string, from: string|string[], to: string, count: number, lastAt: string|null, by: string[], needs: string|null, unlocks: string[], emit: string|null }[],
 * }} flow
 */
export function renderStateMachine(flow) {
  const { width: w, height: h, ringRadius: r, nodeRadius: nodeR } = DEFAULTS
  const cx = w / 2
  const cy = h / 2
  const states = flow.states
  const angle = (i) => (i / Math.max(1, states.length)) * 2 * Math.PI - Math.PI / 2
  const pos = (i) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))]

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'flow')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'State machine diagram')
  svg.appendChild(defs())

  const maxEdge = Math.max(1, ...flow.transitions.map((t) => t.count))
  for (const t of flow.transitions) {
    drawEdges(svg, states, t, pos, maxEdge, nodeR)
  }

  states.forEach((state, i) => {
    const [x, y] = pos(i)
    svg.appendChild(stateNode(state, x, y, nodeR))
  })

  return svg
}

function defs() {
  // DOM-API construction (not innerHTML) so the strict Trusted Types
  // CSP `require-trusted-types-for 'script'` doesn't reject the write.
  const d = document.createElementNS(SVG_NS, 'defs')
  d.appendChild(marker('arr', 'arrowhead'))
  d.appendChild(marker('arr-hot', 'arrowhead hot'))
  return d
}

function marker(id, pathClass) {
  const m = document.createElementNS(SVG_NS, 'marker')
  m.setAttribute('id', id)
  m.setAttribute('viewBox', '0 0 10 10')
  m.setAttribute('refX', '9')
  m.setAttribute('refY', '5')
  m.setAttribute('markerWidth', '6')
  m.setAttribute('markerHeight', '6')
  m.setAttribute('orient', 'auto')
  const p = document.createElementNS(SVG_NS, 'path')
  p.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z')
  p.setAttribute('class', pathClass)
  m.appendChild(p)
  return m
}

function drawEdges(svg, states, t, pos, maxEdge, nodeR) {
  const froms = Array.isArray(t.from) ? t.from : [t.from]
  for (const from of froms) {
    const fi = states.findIndex((s) => s.name === from)
    const ti = states.findIndex((s) => s.name === t.to)
    if (fi < 0 || ti < 0) continue
    const [x1, y1] = pos(fi)
    const [x2, y2] = pos(ti)
    const hot = t.count > maxEdge / 2
    const path = document.createElementNS(SVG_NS, 'path')
    if (fi === ti) {
      // Self-loop: small circle above the node.
      path.setAttribute('d', `M ${x1} ${y1 - nodeR} a 24 24 0 1 1 -0.1 0`)
    } else {
      const mx = (x1 + x2) / 2
      const my = (y1 + y2) / 2
      const dx = x2 - x1
      const dy = y2 - y1
      const norm = Math.sqrt(dx * dx + dy * dy)
      const ox = (-dy / norm) * 28
      const oy = (dx / norm) * 28
      path.setAttribute('d', `M ${x1} ${y1} Q ${mx + ox} ${my + oy} ${x2} ${y2}`)
    }
    path.setAttribute('class', `edge ${hot ? 'hot' : ''}`)
    path.setAttribute('stroke-width', String(1 + (t.count / maxEdge) * 3))
    path.setAttribute('marker-end', hot ? 'url(#arr-hot)' : 'url(#arr)')
    const title = document.createElementNS(SVG_NS, 'title')
    title.textContent = `${t.name} — ${t.count} fires${t.lastAt ? ` (last ${t.lastAt})` : ''}`
    path.appendChild(title)
    svg.appendChild(path)
  }
}

function stateNode(state, x, y, nodeR) {
  const g = document.createElementNS(SVG_NS, 'g')
  g.setAttribute('data-state', state.name)
  g.setAttribute('transform', `translate(${x},${y})`)
  const circle = document.createElementNS(SVG_NS, 'circle')
  circle.setAttribute('r', String(nodeR))
  circle.setAttribute('class', [
    'state-circle',
    state.terminal ? 'terminal' : '',
    state.initial ? 'initial' : '',
  ].filter(Boolean).join(' '))
  g.appendChild(circle)
  const label = document.createElementNS(SVG_NS, 'text')
  label.setAttribute('class', 'state-label')
  label.setAttribute('text-anchor', 'middle')
  label.setAttribute('y', '-2')
  label.textContent = state.name
  g.appendChild(label)
  const count = document.createElementNS(SVG_NS, 'text')
  count.setAttribute('class', 'state-count')
  count.setAttribute('text-anchor', 'middle')
  count.setAttribute('y', '14')
  count.textContent = String(state.count)
  g.appendChild(count)
  return g
}
