import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { cn } from '../lib/utils'

/* ───────────────────────────── Types (mirror backend routing/) ───────────────────────────── */

type NodeKind = 'input' | 'processor' | 'output'

interface ConfigField {
  key: string
  label: string
  type: 'cron' | 'number' | 'text' | 'select' | 'boolean'
  placeholder?: string
  options?: { value: string; label: string }[]
  help?: string
  showWhen?: { key: string; equals: unknown }
}

interface NodeTypeMeta {
  type: string
  kind: NodeKind
  label: string
  description: string
  category: string
  configFields: ConfigField[]
  defaultConfig: Record<string, unknown>
  singleton?: boolean
}

interface RouteNode {
  id: string
  kind: NodeKind
  type: string
  label: string
  enabled: boolean
  config: Record<string, unknown>
  position: { x: number; y: number }
  managed?: boolean
}

interface RouteEdge {
  id: string
  from: string
  to: string
  enabled: boolean
  cooldownSec?: number
  maxPerHour?: number
}

interface RoutingGraph {
  enabled: boolean
  nodes: RouteNode[]
  edges: RouteEdge[]
}

// Live guardrail snapshot from /api/routing/state. `now` is the server clock at
// fetch time; we correct for client/server skew locally to drive countdowns.
interface RoutingState {
  now: number
  fetchedAt: number
  nodeCooldowns: Record<string, number>
  edgeCooldowns: Record<string, number>
  edgeHourly: Record<string, number>
}

interface DebugRecord {
  id: number
  node_id: string
  label: string
  note: string
  trigger: string
  symbol: string | null
  payload: string
  created_at: string
}

const DEBUG_MAX = 200

/* ───────────────────────────── Visual constants ───────────────────────────── */

const NODE_W = 212
const NODE_H = 82
const PULSE_MS = 750

// Category → theme token (reuses the Event Stream palette so themes stay coherent).
const CAT_STYLE: Record<string, { text: string; dot: string; ring: string; stroke: string }> = {
  market: { text: 'text-accent', dot: 'bg-accent', ring: 'ring-accent/50', stroke: 'rgb(var(--accent-rgb))' },
  strategy: { text: 'text-accent2', dot: 'bg-accent2', ring: 'ring-accent2/50', stroke: 'rgb(var(--accent2-rgb))' },
  risk: { text: 'text-warn', dot: 'bg-warn', ring: 'ring-warn/50', stroke: 'rgb(var(--warn-rgb))' },
  execution: { text: 'text-buy', dot: 'bg-buy', ring: 'ring-buy/50', stroke: 'rgb(var(--buy-rgb))' },
  system: { text: 'text-muted', dot: 'bg-muted', ring: 'ring-border', stroke: 'rgb(148 163 184)' },
}
const catStyle = (c: string) => CAT_STYLE[c] ?? CAT_STYLE.system

const KIND_LABEL: Record<NodeKind, string> = { input: 'INPUT', processor: 'PROCESSOR', output: 'OUTPUT' }

// Route colours: a route carries either a DATA signal (coin/price payload, only
// processors read it) or a plain SIMPLE trigger. Data routes are accent-tinted,
// simple routes grey — matching the per-node Signal toggle on Binance inputs.
const DATA_STROKE = 'rgb(var(--accent-rgb))'
const SIMPLE_STROKE = 'rgb(var(--border-rgb, 100 116 139))'
const SIMPLE_ACTIVE = 'rgb(148 163 184)'

const isBinanceInput = (n: RouteNode) => n.kind === 'input' && n.type.startsWith('binance')
/** A Binance input emits the per-coin data signal unless explicitly switched off. */
const emitsDataSignal = (n: RouteNode) => isBinanceInput(n) && n.config.dataMode !== false

/**
 * Compute which nodes a data signal reaches. A data-mode Binance input seeds it,
 * and the flavour propagates downstream through the whole chain (a node fed any
 * data route re-emits data). Returns the set of node ids that emit a data route.
 */
function computeDataNodes(graph: RoutingGraph): Set<string> {
  const incoming = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = incoming.get(e.to) ?? []
    list.push(e.from)
    incoming.set(e.to, list)
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const memo = new Map<string, boolean>()
  const visiting = new Set<string>()
  const emits = (id: string): boolean => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return false // cycle guard
    visiting.add(id)
    const node = byId.get(id)
    const res = !node ? false
      : node.kind === 'input' ? emitsDataSignal(node)
      : (incoming.get(id) ?? []).some(emits)
    visiting.delete(id)
    memo.set(id, res)
    return res
  }
  return new Set(graph.nodes.filter((n) => emits(n.id)).map((n) => n.id))
}

/** Evaluate a config field's `showWhen` guard against a node's current config. */
function fieldVisible(node: RouteNode, field: ConfigField): boolean {
  if (!field.showWhen) return true
  return node.config[field.showWhen.key] === field.showWhen.equals
}

/* ───────────────────────────── Small UI primitives ───────────────────────────── */

function Toggle({ checked, onChange, label, danger }: { checked: boolean; onChange: () => void; label: string; danger?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={(e) => { e.stopPropagation(); onChange() }}
      className={cn(
        'group relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200',
        checked ? (danger ? 'bg-sell' : 'bg-accent') : 'bg-surface-elevated border border-border',
      )}
    >
      <span className={cn('pointer-events-none h-[14px] w-[14px] rounded-full shadow-sm transition-all duration-200',
        checked ? 'translate-x-[18px] bg-surface-base' : 'translate-x-[3px] bg-muted')} />
    </button>
  )
}

/* ───────────────────────────── Node icons ───────────────────────────── */

// One small line-icon per node type, drawn in the node's category colour. Shared
// by the canvas node header and the catalogue cards. Pure stroke paths on a
// 24×24 grid so they inherit `currentColor` + sizing from the wrapper.
const ICON: Record<string, React.ReactElement> = {
  timer: <><circle cx="12" cy="13" r="8" /><path d="M12 9.5V13l2.5 1.5" /><path d="M9.5 2.5h5" /><path d="M19 5.5l1.5-1.5" /></>,
  binance_price: <><path d="M3 17l5-5 4 3 6-7" /><path d="M15 8h4v4" /></>,
  binance_kline: <><path d="M8 4v3M8 14v3" /><rect x="6.5" y="7" width="3" height="7" rx="1" /><path d="M16 6v3M16 16v2" /><rect x="14.5" y="9" width="3" height="7" rx="1" /></>,
  binance_book: <path d="M4 6h9M4 10h6M4 14h8M4 18h4" />,
  binance_trade: <path d="M4 9h12l-3-3M20 15H8l3 3" />,
  binance_depth: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>,
  manual: <path d="M6 3l13 7-5.5 1.6L11 17z" />,
  system_startup: <><path d="M12 4v8" /><path d="M7.5 7.2a7 7 0 109 0" /></>,
  price_move: <><path d="M7 21V5M7 5L4 8M7 5l3 3" /><path d="M17 3v16M17 19l3-3M17 19l-3-3" /></>,
  holding_filter: <><rect x="3.5" y="8" width="17" height="11" rx="2" /><path d="M9 8V6a2 2 0 012-2h2a2 2 0 012 2v2" /><path d="M3.5 13h17" /></>,
  cooldown_gate: <><path d="M7 3h10M7 21h10" /><path d="M7 3c0 4.5 5 5 5 9s-5 4.5-5 9" /><path d="M17 3c0 4.5-5 5-5 9s5 4.5 5 9" /></>,
  change_24h: <><path d="M4.5 12a7.5 7.5 0 0112.8-5.3L20 9" /><path d="M19.5 12a7.5 7.5 0 01-12.8 5.3L4 15" /><path d="M20 4.5v4.5h-4.5M4 19.5V15h4.5" /></>,
  spread_filter: <><path d="M3 12h18" /><path d="M7 8l-4 4 4 4" /><path d="M17 8l4 4-4 4" /></>,
  trade_size: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v10" /><path d="M14.5 9.3c0-1.3-1.1-1.8-2.5-1.8s-2.5.6-2.5 1.9 1.1 1.6 2.5 1.6 2.5.4 2.5 1.7-1.1 1.8-2.5 1.8-2.5-.6-2.5-1.8" /></>,
  rsi_gate: <><path d="M3 9h18M3 15h18" opacity="0.4" /><path d="M4 12c2-4 4 4 6 0s4-4 6 0 4 2 4 2" /></>,
  price_cross: <><path d="M3 15h18" opacity="0.4" /><path d="M4 19l5-8 4 4 7-10" /></>,
  pnl_gate: <><path d="M19 5L5 19" /><circle cx="7.5" cy="7.5" r="2" /><circle cx="16.5" cy="16.5" r="2" /></>,
  time_window: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></>,
  minute_window: <><circle cx="12" cy="12" r="8.5" /><path d="M12 12V6.5" /><path d="M12 12l4.5 2.5" /><path d="M12 6.5a5.5 5.5 0 014.8 2.8" opacity="0.5" /></>,
  debug: <><rect x="8" y="8" width="8" height="11" rx="4" /><path d="M12 8V5" /><path d="M9 5a3 3 0 016 0" /><path d="M8 11H4M16 11h4M8 15H4.5M16 15h3.5M8.5 18l-2.5 2M15.5 18l2.5 2" /></>,
  module_pipeline: <path d="M6 4l13 8-13 8z" />,
  module_pipeline_coin: <><path d="M5 4l11 6.5L5 17z" /><circle cx="18.5" cy="6.5" r="2.5" /></>,
  module_monitor: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.5" /></>,
  module_discovery: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.5-4.5" /></>,
  module_summary: <><path d="M6.5 3h7L18 7.5V21H6.5z" /><path d="M13 3v5h5" /><path d="M9.5 13h5M9.5 16.5h5" /></>,
}
const ICON_FALLBACK = <circle cx="12" cy="12" r="7" />

function NodeIcon({ type, className }: { type: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {ICON[type] ?? ICON_FALLBACK}
    </svg>
  )
}

/* ── Cooldown maths ──
 * A node/edge is "cooling" when its last-fire + window is still in the future.
 * Returns null when not cooling, else the remaining + total span for the bar. */
interface Cooldown { remainingMs: number; totalMs: number }
function cooldownOf(last: number | undefined, windowSec: number, serverNow: number): Cooldown | null {
  if (!last || !(windowSec > 0)) return null
  const totalMs = windowSec * 1000
  const remainingMs = last + totalMs - serverNow
  return remainingMs > 0 ? { remainingMs, totalMs } : null
}
const fmtCountdown = (ms: number): string => {
  const s = Math.ceil(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** A compact depleting progress bar used for cooldown countdowns. */
function CooldownBar({ cd, className }: { cd: Cooldown; className?: string }) {
  const pct = Math.max(0, Math.min(100, (cd.remainingMs / cd.totalMs) * 100))
  return (
    <div className={cn('h-1.5 rounded-full bg-surface-elevated overflow-hidden', className)}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-200 ease-linear"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/* ───────────────────────────── Page ───────────────────────────── */

export default function RoutingGraph() {
  const [graph, setGraph] = useState<RoutingGraph | null>(null)
  const [catalog, setCatalog] = useState<NodeTypeMeta[]>([])
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)
  const [pendingFrom, setPendingFrom] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [pulses, setPulses] = useState<Record<string, number>>({})
  const [debugLogs, setDebugLogs] = useState<DebugRecord[]>([])
  const [debugOpen, setDebugOpen] = useState(true)
  const [debugExpanded, setDebugExpanded] = useState<number | null>(null)
  const [routeState, setRouteState] = useState<RoutingState | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())

  const graphRef = useRef<RoutingGraph | null>(null)
  graphRef.current = graph
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)

  /* ── Load ── */
  useEffect(() => {
    Promise.all([
      fetch('/api/routing/graph').then((r) => r.json()),
      fetch('/api/routing/catalog').then((r) => r.json()),
    ])
      .then(([g, c]: [RoutingGraph, { catalog: NodeTypeMeta[] }]) => {
        setGraph(g)
        setCatalog(c.catalog ?? [])
      })
      .catch(() => setSaveState('error'))
    fetch('/api/debug-logs?limit=200')
      .then((r) => r.json())
      .then((d: { logs: DebugRecord[] }) => setDebugLogs(d.logs ?? []))
      .catch(() => { /* none yet */ })
  }, [])

  /* ── Live guardrail state (cooldown timers) — poll + local interpolation ── */
  useEffect(() => {
    let alive = true
    const poll = () =>
      fetch('/api/routing/state')
        .then((r) => r.json())
        .then((s: Omit<RoutingState, 'fetchedAt'>) => { if (alive) setRouteState({ ...s, fetchedAt: Date.now() }) })
        .catch(() => { /* transient */ })
    poll()
    const pollId = setInterval(poll, 1500)
    // A faster local ticker drives the countdown re-render between polls.
    const tickId = setInterval(() => setNowTick(Date.now()), 200)
    return () => { alive = false; clearInterval(pollId); clearInterval(tickId) }
  }, [])

  // Server clock estimate, corrected for client/server skew at last fetch.
  const serverNow = routeState ? routeState.now + (nowTick - routeState.fetchedAt) : nowTick

  /* ── Live pulses from the routing engine ── */
  const onMessage = useCallback((event: string, data: unknown) => {
    if (event === 'debug_log') {
      const rec = data as DebugRecord
      setDebugLogs((prev) => [rec, ...prev].slice(0, DEBUG_MAX))
      return
    }
    if (event !== 'routing_pulse') return
    const p = data as { kind: string; id: string; reason?: string }
    const key = p.kind === 'blocked' ? `blocked:${p.id}` : p.id
    setPulses((prev) => ({ ...prev, [key]: Date.now() }))
    setTimeout(() => setPulses((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    }), PULSE_MS)
  }, [])
  useWebSocket(onMessage)

  /* ── Esc cancels a pending connection / clears selection ── */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setPendingFrom(null); setSelected(null); setPaletteOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ── Persistence ── */
  const persist = useCallback((next: RoutingGraph) => {
    setSaveState('saving')
    fetch('/api/routing/graph', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((saved: RoutingGraph) => { setGraph(saved); setSaveState('saved'); setTimeout(() => setSaveState('idle'), 1500) })
      .catch(() => setSaveState('error'))
  }, [])

  const scheduleSave = useCallback((next: RoutingGraph) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => persist(next), 500)
  }, [persist])

  // Apply a graph mutation locally, then debounce-save it.
  const commit = useCallback((next: RoutingGraph, immediate = false) => {
    setGraph(next)
    if (immediate) persist(next)
    else scheduleSave(next)
  }, [persist, scheduleSave])

  const mutateNode = (id: string, patch: Partial<RouteNode>) => {
    if (!graph) return
    commit({ ...graph, nodes: graph.nodes.map((n) => n.id === id ? { ...n, ...patch } : n) })
  }
  const mutateNodeConfig = (id: string, key: string, value: unknown) => {
    if (!graph) return
    commit({ ...graph, nodes: graph.nodes.map((n) => n.id === id ? { ...n, config: { ...n.config, [key]: value } } : n) })
  }
  const mutateEdge = (id: string, patch: Partial<RouteEdge>) => {
    if (!graph) return
    commit({ ...graph, edges: graph.edges.map((e) => e.id === id ? { ...e, ...patch } : e) })
  }
  const deleteNode = (id: string) => {
    if (!graph) return
    setSelected(null)
    commit({ enabled: graph.enabled, nodes: graph.nodes.filter((n) => n.id !== id), edges: graph.edges.filter((e) => e.from !== id && e.to !== id) }, true)
  }
  const deleteEdge = (id: string) => {
    if (!graph) return
    setSelected(null)
    commit({ ...graph, edges: graph.edges.filter((e) => e.id !== id) }, true)
  }

  /* ── Connect (click output port → click input port) ── */
  const tryConnect = (toId: string) => {
    if (!graph || !pendingFrom || pendingFrom === toId) { setPendingFrom(null); return }
    const from = graph.nodes.find((n) => n.id === pendingFrom)
    const to = graph.nodes.find((n) => n.id === toId)
    setPendingFrom(null)
    if (!from || !to) return
    if (to.kind === 'input') return // can't target an input
    if (from.kind === 'output') return // outputs are terminal
    if (graph.edges.some((e) => e.from === from.id && e.to === to.id)) return // dup
    const edge: RouteEdge = { id: `e.${Date.now().toString(36)}`, from: from.id, to: to.id, enabled: true }
    commit({ ...graph, edges: [...graph.edges, edge] }, true)
    setSelected({ kind: 'edge', id: edge.id })
  }

  /* ── Drag ── */
  useEffect(() => {
    function move(e: PointerEvent) {
      const d = dragRef.current
      const g = graphRef.current
      if (!d || !g) return
      const canvas = document.getElementById('routing-canvas')
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = Math.max(0, e.clientX - rect.left - d.dx)
      const y = Math.max(0, e.clientY - rect.top - d.dy)
      setGraph({ ...g, nodes: g.nodes.map((n) => n.id === d.id ? { ...n, position: { x, y } } : n) })
    }
    function up() {
      if (dragRef.current && graphRef.current) scheduleSave(graphRef.current)
      dragRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [scheduleSave])

  const startDrag = (e: React.PointerEvent, node: RouteNode) => {
    const canvas = document.getElementById('routing-canvas')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    dragRef.current = { id: node.id, dx: e.clientX - rect.left - node.position.x, dy: e.clientY - rect.top - node.position.y }
    setSelected({ kind: 'node', id: node.id })
  }

  /* ── Add node from palette ── */
  const addNode = (meta: NodeTypeMeta) => {
    if (!graph) return
    const id = `${meta.kind}.${meta.type}.${Date.now().toString(36)}`
    const colX = meta.kind === 'input' ? 60 : meta.kind === 'processor' ? 440 : 820
    const node: RouteNode = {
      id, kind: meta.kind, type: meta.type, label: meta.label, enabled: false,
      config: { ...meta.defaultConfig }, position: { x: colX, y: 60 + Math.random() * 360 },
    }
    commit({ ...graph, nodes: [...graph.nodes, node] }, true)
    setPaletteOpen(false)
    setSelected({ kind: 'node', id })
  }

  const canvasSize = useMemo(() => {
    if (!graph) return { w: 1100, h: 760 }
    let w = 1100, h = 760
    for (const n of graph.nodes) { w = Math.max(w, n.position.x + NODE_W + 80); h = Math.max(h, n.position.y + NODE_H + 80) }
    return { w, h }
  }, [graph])

  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])
  // Which nodes emit a data route (accent) vs a simple route (grey).
  const dataNodes = useMemo(() => graph ? computeDataNodes(graph) : new Set<string>(), [graph])

  if (!graph) {
    return <div className="text-muted text-sm py-16 text-center">Loading routing graph…</div>
  }

  const selNode = selected?.kind === 'node' ? graph.nodes.find((n) => n.id === selected.id) ?? null : null
  const selEdge = selected?.kind === 'edge' ? graph.edges.find((e) => e.id === selected.id) ?? null : null

  /* ───────────────────────────── Render ───────────────────────────── */
  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => commit({ ...graph, enabled: !graph.enabled }, true)}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors',
              graph.enabled ? 'text-buy bg-buy/10 border-buy/30' : 'text-sell bg-sell/10 border-sell/30',
            )}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full bg-current', graph.enabled && 'animate-pulse')} />
            {graph.enabled ? 'Routing ON' : 'Routing OFF (kill-switch)'}
          </button>
          <span className="text-xs text-muted font-mono">{graph.nodes.length} nodes · {graph.edges.length} routes</span>
          {pendingFrom && <span className="text-xs text-accent animate-pulse">Click a target node’s input port… (Esc to cancel)</span>}
        </div>

        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-medium',
            saveState === 'saving' ? 'text-warn' : saveState === 'saved' ? 'text-buy' : saveState === 'error' ? 'text-sell' : 'text-muted')}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : saveState === 'error' ? 'Save failed' : ''}
          </span>
          <button
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-foreground border border-border bg-surface-card hover:bg-surface-hover hover:border-accent/40 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add node
          </button>
        </div>
      </div>

      <div className="flex gap-4 items-start">
        {/* Canvas */}
        <div className="flex-1 min-w-0 rounded-2xl border border-border bg-surface-card/40 glass overflow-auto shadow-soft" style={{ maxHeight: 'calc(100vh - 13rem)' }}>
          <div
            id="routing-canvas"
            className="relative"
            style={{ width: canvasSize.w, height: canvasSize.h, minWidth: '100%' }}
            onClick={() => { setSelected(null); setPendingFrom(null) }}
          >
            {/* Column hints */}
            {['Inputs', 'Processors', 'Outputs'].map((lbl, i) => (
              <div key={lbl} className="absolute top-2 text-[10px] font-semibold tracking-[0.2em] text-muted/60 uppercase pointer-events-none"
                style={{ left: [60, 440, 820][i] }}>{lbl}</div>
            ))}

            {/* Edges */}
            <svg className="absolute inset-0 pointer-events-none" width={canvasSize.w} height={canvasSize.h}>
              {graph.edges.map((edge) => {
                const from = nodeById.get(edge.from); const to = nodeById.get(edge.to)
                if (!from || !to) return null
                const sx = from.position.x + NODE_W; const sy = from.position.y + NODE_H / 2
                const tx = to.position.x; const ty = to.position.y + NODE_H / 2
                const dx = Math.max(40, Math.abs(tx - sx) / 2)
                const d = `M ${sx},${sy} C ${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`
                const active = pulses[edge.id] != null
                const blocked = pulses[`blocked:${edge.id}`] != null
                const carriesData = dataNodes.has(edge.from)
                const baseStroke = carriesData ? DATA_STROKE : SIMPLE_STROKE
                const activeStroke = carriesData ? DATA_STROKE : SIMPLE_ACTIVE
                const sel = selected?.kind === 'edge' && selected.id === edge.id
                return (
                  <g key={edge.id}>
                    {/* hit area */}
                    <path d={d} stroke="transparent" strokeWidth={16} fill="none" className="pointer-events-auto cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'edge', id: edge.id }) }} />
                    <path
                      d={d} fill="none"
                      stroke={blocked ? 'rgb(var(--sell-rgb))' : active ? activeStroke : (edge.enabled ? baseStroke : 'transparent')}
                      strokeWidth={sel ? 3 : active ? 3 : 1.75}
                      strokeDasharray={edge.enabled ? undefined : '4 4'}
                      style={{
                        opacity: edge.enabled ? (active ? 1 : carriesData ? 0.7 : 0.5) : 0.35,
                        filter: active ? `drop-shadow(0 0 5px ${activeStroke})` : undefined,
                        transition: 'opacity .2s, stroke-width .2s',
                      }}
                      className={cn(!edge.enabled && 'stroke-border')}
                    />
                    {/* arrowhead */}
                    <circle cx={tx} cy={ty} r={active ? 4 : 3} fill={blocked ? 'rgb(var(--sell-rgb))' : active ? activeStroke : baseStroke}
                      style={{ opacity: edge.enabled ? 0.8 : 0.4 }} />
                  </g>
                )
              })}
            </svg>

            {/* Nodes */}
            {graph.nodes.map((node) => {
              const meta = catalog.find((m) => m.type === node.type)
              const s = catStyle(meta?.category ?? 'system')
              const fired = pulses[node.id] != null
              const blocked = pulses[`blocked:${node.id}`] != null
              const sel = selected?.kind === 'node' && selected.id === node.id
              const showInPort = node.kind !== 'input'
              const showOutPort = node.kind !== 'output'
              const cd = node.type === 'cooldown_gate'
                ? cooldownOf(routeState?.nodeCooldowns[node.id], Number(node.config.seconds) || 0, serverNow)
                : null
              return (
                <div
                  key={node.id}
                  className={cn(
                    'absolute rounded-xl border bg-surface-card/95 backdrop-blur-sm shadow-soft select-none transition-shadow',
                    sel ? 'ring-2 ' + s.ring + ' border-transparent' : 'border-border',
                    !node.enabled && 'opacity-55',
                  )}
                  style={{
                    left: node.position.x, top: node.position.y, width: NODE_W, height: NODE_H,
                    boxShadow: fired ? `0 0 0 1px ${s.stroke}, 0 0 18px -2px ${s.stroke}` : blocked ? '0 0 0 1px rgb(var(--sell-rgb)), 0 0 16px -4px rgb(var(--sell-rgb))' : undefined,
                  }}
                  onClick={(e) => { e.stopPropagation(); if (pendingFrom) tryConnect(node.id); else setSelected({ kind: 'node', id: node.id }) }}
                >
                  {/* header / drag handle */}
                  <div
                    className="flex items-center gap-2 px-2.5 pt-2 cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => startDrag(e, node)}
                  >
                    <span className={cn('shrink-0 grid place-items-center w-6 h-6 rounded-md ring-1 ring-inset ring-border bg-surface-base', s.text, fired && 'animate-pulse')}>
                      <NodeIcon type={node.type} className="w-3.5 h-3.5" />
                    </span>
                    <span className="text-[13px] font-semibold text-foreground truncate flex-1">{node.label}</span>
                    <Toggle checked={node.enabled} onChange={() => mutateNode(node.id, { enabled: !node.enabled })} label={`Enable ${node.label}`} />
                  </div>
                  <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={cn('text-[10px] font-mono tracking-wide truncate', s.text)}>{KIND_LABEL[node.kind]} · {node.type}{node.managed ? ' · managed' : ''}</span>
                      {isBinanceInput(node) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); mutateNodeConfig(node.id, 'dataMode', !emitsDataSignal(node)) }}
                          title="Switch between a per-coin data signal and a simple trigger"
                          className={cn('shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-bold tracking-wider transition-colors',
                            emitsDataSignal(node) ? 'bg-accent/15 text-accent' : 'bg-surface-elevated text-muted border border-border')}
                        >{emitsDataSignal(node) ? 'DATA' : 'SIMPLE'}</button>
                      )}
                    </div>
                    {cd ? (
                      <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/10 text-accent text-[10px] font-semibold tabular-nums" title="Cooling down — passes again when the timer ends">
                        <NodeIcon type="cooldown_gate" className="w-2.5 h-2.5" />
                        {fmtCountdown(cd.remainingMs)}
                      </span>
                    ) : (node.kind === 'input' || node.kind === 'output') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); fetch(`/api/routing/fire/${node.id}`, { method: 'POST' }) }}
                        className="shrink-0 text-[10px] font-semibold text-accent hover:underline"
                        title="Fire this node now"
                      >▶ fire</button>
                    )}
                  </div>

                  {/* cooldown depleting bar pinned to the node's bottom edge */}
                  {cd && (
                    <div className="absolute inset-x-0 bottom-0 h-[3px] bg-surface-elevated/60 rounded-b-xl overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-200 ease-linear"
                        style={{ width: `${Math.max(0, Math.min(100, (cd.remainingMs / cd.totalMs) * 100))}%` }}
                      />
                    </div>
                  )}

                  {/* ports */}
                  {showInPort && (
                    <button
                      onClick={(e) => { e.stopPropagation(); if (pendingFrom) tryConnect(node.id) }}
                      title="Input"
                      className={cn('absolute -left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-surface-card',
                        pendingFrom ? 'bg-accent animate-pulse' : 'bg-muted')}
                    />
                  )}
                  {showOutPort && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setPendingFrom(node.id) }}
                      title="Drag a connection from here"
                      className={cn('absolute -right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-surface-card transition-colors',
                        pendingFrom === node.id ? 'bg-accent ring-2 ring-accent/40' : 'bg-foreground/60 hover:bg-accent')}
                    />
                  )}
                </div>
              )
            })}

            {/* Edge guardrail overlay — cooldown countdown / max-per-hour chips at route midpoints */}
            {graph.edges.map((edge) => {
              const from = nodeById.get(edge.from); const to = nodeById.get(edge.to)
              if (!from || !to) return null
              const cd = cooldownOf(routeState?.edgeCooldowns[edge.id], Number(edge.cooldownSec) || 0, serverNow)
              const maxPerHour = Number(edge.maxPerHour) || 0
              const maxed = maxPerHour > 0 && (routeState?.edgeHourly[edge.id] ?? 0) >= maxPerHour
              if (!cd && !maxed) return null
              const mx = (from.position.x + NODE_W + to.position.x) / 2
              const my = (from.position.y + to.position.y) / 2 + NODE_H / 2
              return (
                <div key={`g.${edge.id}`} className="absolute z-10 -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={{ left: mx, top: my }}>
                  {cd ? (
                    <div className="flex flex-col items-center gap-0.5 px-1.5 py-1 rounded-lg bg-surface-card/95 backdrop-blur-sm border border-warn/40 shadow-soft">
                      <span className="inline-flex items-center gap-1 text-warn text-[10px] font-semibold tabular-nums">
                        <NodeIcon type="cooldown_gate" className="w-2.5 h-2.5" />
                        {fmtCountdown(cd.remainingMs)}
                      </span>
                      <CooldownBar cd={cd} className="w-12 h-1" />
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-sell/15 text-sell border border-sell/40 text-[10px] font-semibold whitespace-nowrap">
                      max/hr reached
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Inspector */}
        <div className="w-72 shrink-0">
          {selNode && <NodeInspector
            node={selNode} meta={catalog.find((m) => m.type === selNode.type)}
            cooldown={selNode.type === 'cooldown_gate'
              ? cooldownOf(routeState?.nodeCooldowns[selNode.id], Number(selNode.config.seconds) || 0, serverNow)
              : null}
            onLabel={(v) => mutateNode(selNode.id, { label: v })}
            onEnable={() => mutateNode(selNode.id, { enabled: !selNode.enabled })}
            onConfig={(k, v) => mutateNodeConfig(selNode.id, k, v)}
            onDelete={() => deleteNode(selNode.id)}
            onFire={() => fetch(`/api/routing/fire/${selNode.id}`, { method: 'POST' })}
          />}
          {selEdge && <EdgeInspector
            edge={selEdge}
            fromLabel={nodeById.get(selEdge.from)?.label ?? selEdge.from}
            toLabel={nodeById.get(selEdge.to)?.label ?? selEdge.to}
            carriesData={dataNodes.has(selEdge.from)}
            cooldown={cooldownOf(routeState?.edgeCooldowns[selEdge.id], Number(selEdge.cooldownSec) || 0, serverNow)}
            hourlyHits={routeState?.edgeHourly[selEdge.id] ?? 0}
            onEnable={() => mutateEdge(selEdge.id, { enabled: !selEdge.enabled })}
            onNum={(k, v) => mutateEdge(selEdge.id, { [k]: v })}
            onDelete={() => deleteEdge(selEdge.id)}
          />}
          {!selNode && !selEdge && (
            <div className="rounded-2xl border border-border bg-surface-card/60 glass p-4 text-xs text-muted leading-relaxed">
              <p className="font-semibold text-foreground mb-2">Event Routing</p>
              <p className="mb-2">Inputs (left) fire into the bus and flow through optional processor gates to outputs (right).</p>
              <p className="mb-1">• Click a node to edit it.</p>
              <p className="mb-1">• Drag the right-hand <span className="text-foreground">port</span> of a node, then click a target’s left port to wire a route.</p>
              <p className="mb-1">• Click a link to set its cooldown / max-per-hour.</p>
              <p className="mb-2">• The kill-switch halts all routing instantly.</p>
              <div className="border-t border-border pt-2">
                <p className="flex items-center gap-2 mb-1"><span className="inline-block w-6 h-0.5 rounded bg-accent" /> <span><span className="text-foreground">Data</span> route — carries a coin/price payload (only processors read it).</span></p>
                <p className="flex items-center gap-2"><span className="inline-block w-6 h-0.5 rounded bg-muted" /> <span><span className="text-foreground">Simple</span> route — a plain trigger, no coin.</span></p>
                <p className="mt-1">Flip a Binance input’s <span className="text-accent font-semibold">DATA</span>/<span className="font-semibold">SIMPLE</span> badge to switch what it emits.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Docked debug log panel */}
      <DebugPanel
        logs={debugLogs}
        open={debugOpen}
        onToggle={() => setDebugOpen((o) => !o)}
        expanded={debugExpanded}
        onExpand={(id) => setDebugExpanded((cur) => cur === id ? null : id)}
        onClear={() => { fetch('/api/debug-logs', { method: 'DELETE' }); setDebugLogs([]); setDebugExpanded(null) }}
      />

      {/* Node catalogue (modal) */}
      {paletteOpen && (
        <NodeCatalog
          catalog={catalog}
          existingTypes={new Set(graph.nodes.map((n) => n.type))}
          onAdd={addNode}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  )
}

/* ───────────────────────────── Node catalogue (modal) ───────────────────────────── */

function NodeCatalog({ catalog, existingTypes, onAdd, onClose }: {
  catalog: NodeTypeMeta[]
  existingTypes: Set<string>
  onAdd: (meta: NodeTypeMeta) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<NodeKind | 'all'>('all')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const q = query.trim().toLowerCase()
  const matches = (m: NodeTypeMeta) =>
    !q || m.label.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) ||
    m.type.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)

  const kinds: NodeKind[] = kindFilter === 'all' ? ['input', 'processor', 'output'] : [kindFilter]
  const sections = kinds
    .map((kind) => ({ kind, items: catalog.filter((m) => m.kind === kind && matches(m)) }))
    .filter((s) => s.items.length > 0)

  const FILTERS: { value: NodeKind | 'all'; label: string }[] = [
    { value: 'all', label: 'All' }, { value: 'input', label: 'Inputs' },
    { value: 'processor', label: 'Processors' }, { value: 'output', label: 'Outputs' },
  ]

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 sm:p-8 bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-border bg-surface-card shadow-2xl overflow-hidden animate-slide-down"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b border-border bg-surface-elevated/40">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Add a node</h2>
              <p className="text-[11px] text-muted">Inputs fire events · processors gate them · outputs run an engine.</p>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors" aria-label="Close">
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[12rem]">
              <svg viewBox="0 0 24 24" className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
              <input
                autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search nodes…"
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-surface-base border border-border text-xs text-foreground placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface-base border border-border">
              {FILTERS.map((f) => (
                <button
                  key={f.value} onClick={() => setKindFilter(f.value)}
                  className={cn('px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors',
                    kindFilter === f.value ? 'bg-accent/15 text-accent' : 'text-muted hover:text-foreground')}
                >{f.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4 space-y-5">
          {sections.length === 0 && (
            <div className="py-12 text-center text-sm text-muted">No nodes match “{query}”.</div>
          )}
          {sections.map((section) => (
            <div key={section.kind}>
              <div className="flex items-center gap-2 mb-2 px-0.5">
                <span className="text-[10px] font-semibold tracking-[0.18em] text-muted uppercase">{KIND_LABEL[section.kind]}</span>
                <span className="h-px flex-1 bg-border" />
                <span className="text-[10px] text-muted/70 font-mono">{section.items.length}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {section.items.map((m) => {
                  const exists = m.singleton && existingTypes.has(m.type)
                  const s = catStyle(m.category)
                  return (
                    <button
                      key={m.type}
                      disabled={exists}
                      onClick={() => { onAdd(m); onClose() }}
                      className={cn(
                        'group flex items-start gap-3 p-3 rounded-xl border text-left transition-all',
                        exists
                          ? 'opacity-45 cursor-not-allowed border-border bg-surface-base/40'
                          : 'border-border bg-surface-base hover:border-accent/40 hover:bg-surface-hover hover:-translate-y-0.5 hover:shadow-soft',
                      )}
                    >
                      <span className={cn('shrink-0 grid place-items-center w-9 h-9 rounded-lg ring-1 ring-inset ring-border bg-surface-card', s.text)}>
                        <NodeIcon type={m.type} className="w-[18px] h-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-foreground truncate">{m.label}</span>
                          {exists && <span className="text-[9px] font-bold text-muted uppercase tracking-wide">added</span>}
                        </span>
                        <span className="block text-[11px] text-muted leading-snug mt-0.5 line-clamp-2">{m.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DebugPanel({ logs, open, onToggle, expanded, onExpand, onClear }: {
  logs: DebugRecord[]; open: boolean; onToggle: () => void
  expanded: number | null; onExpand: (id: number) => void; onClear: () => void
}) {
  const time = (s: string) => (s?.length >= 19 ? s.slice(11, 19) : s)
  return (
    <div className="rounded-2xl border border-border bg-surface-card/60 glass overflow-hidden shadow-soft">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-surface-elevated/40">
        <button onClick={onToggle} className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <svg className={cn('w-3.5 h-3.5 text-muted transition-transform', open && 'rotate-90')} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Debug Log
        </button>
        <span className="text-[11px] text-muted font-mono">{logs.length}</span>
        <span className="flex-1" />
        {logs.length > 0 && (
          <button onClick={onClear} className="text-[11px] font-semibold text-muted hover:text-sell transition-colors">Clear</button>
        )}
      </div>
      {open && (
        <div className="max-h-72 overflow-y-auto font-mono text-[12px]">
          {logs.length === 0 ? (
            <div className="px-4 py-10 text-center text-muted text-sm">
              No debug records yet. Enable a <span className="text-foreground">Debug Tap</span> node and wire an input into it.
            </div>
          ) : logs.map((r) => {
            const isOpen = expanded === r.id
            return (
              <div key={r.id} className="border-b border-border/40 last:border-0">
                <button onClick={() => onExpand(r.id)} className="w-full flex items-center gap-3 px-4 py-1.5 text-left hover:bg-surface-hover/60 transition-colors">
                  <span className="text-muted shrink-0 tabular-nums">{time(r.created_at)}</span>
                  <span className="text-accent2 shrink-0 font-semibold w-32 truncate">{r.note || r.label}</span>
                  <span className="text-muted shrink-0 w-24 truncate">{r.symbol ?? r.trigger}</span>
                  <span className="text-foreground/80 truncate flex-1">{r.payload}</span>
                </button>
                {isOpen && (
                  <pre className="px-4 pb-3 pt-1 ml-4 text-[11px] text-muted whitespace-pre-wrap break-all border-l-2 border-border/60">
                    {prettyJson(r.payload)}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

/* ───────────────────────────── Inspectors ───────────────────────────── */

function Field({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    <label className="block mb-3">
      <span className="block text-[11px] font-medium text-muted mb-1">{label}</span>
      {children}
      {help && <span className="block text-[10px] text-muted/70 mt-1">{help}</span>}
    </label>
  )
}

const inputCls = 'w-full px-2.5 py-1.5 rounded-lg bg-surface-base border border-border text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40'

function NodeInspector({ node, meta, cooldown, onLabel, onEnable, onConfig, onDelete, onFire }: {
  node: RouteNode; meta?: NodeTypeMeta; cooldown: Cooldown | null
  onLabel: (v: string) => void; onEnable: () => void
  onConfig: (k: string, v: unknown) => void; onDelete: () => void; onFire: () => void
}) {
  const s = catStyle(meta?.category ?? 'system')
  return (
    <div className="rounded-2xl border border-border bg-surface-card/70 glass p-4 animate-slide-down">
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center gap-2 text-[10px] font-semibold tracking-wider text-muted uppercase">
          <span className={cn('grid place-items-center w-5 h-5 rounded-md ring-1 ring-inset ring-border bg-surface-base', s.text)}>
            <NodeIcon type={node.type} className="w-3 h-3" />
          </span>
          {KIND_LABEL[node.kind]} · {node.type}
        </span>
        <Toggle checked={node.enabled} onChange={onEnable} label="Enable node" />
      </div>

      {cooldown && (
        <div className="mb-3 p-2.5 rounded-xl border border-accent/30 bg-accent/5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent">
              <NodeIcon type="cooldown_gate" className="w-3 h-3" /> Cooling down
            </span>
            <span className="text-[11px] font-semibold text-accent tabular-nums">{fmtCountdown(cooldown.remainingMs)} left</span>
          </div>
          <CooldownBar cd={cooldown} />
        </div>
      )}

      <Field label="Label"><input className={inputCls} value={node.label} onChange={(e) => onLabel(e.target.value)} /></Field>

      {meta?.configFields.filter((f) => fieldVisible(node, f)).map((f) => {
        const val = node.config[f.key]
        if (f.type === 'select') return (
          <Field key={f.key} label={f.label} help={f.help}>
            <select className={inputCls} value={String(val ?? '')} onChange={(e) => onConfig(f.key, e.target.value)}>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        )
        if (f.type === 'boolean') return (
          <Field key={f.key} label={f.label} help={f.help}>
            <Toggle checked={val === true} onChange={() => onConfig(f.key, !(val === true))} label={f.label} />
          </Field>
        )
        return (
          <Field key={f.key} label={f.label} help={f.help}>
            <input
              className={cn(inputCls, f.type === 'cron' && 'font-mono')}
              type={f.type === 'number' ? 'number' : 'text'}
              placeholder={f.placeholder}
              value={val === undefined || val === null ? '' : String(val)}
              onChange={(e) => onConfig(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)}
            />
          </Field>
        )
      })}

      {meta && <p className="text-[11px] text-muted leading-snug mb-3">{meta.description}</p>}

      <div className="flex items-center gap-2">
        {(node.kind === 'input' || node.kind === 'output') && (
          <button onClick={onFire} className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-accent border border-accent/30 bg-accent/10 hover:bg-accent/20 transition-colors">▶ Fire now</button>
        )}
        {!node.managed && (
          <button onClick={onDelete} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-sell border border-sell/30 hover:bg-sell/10 transition-colors">Delete</button>
        )}
      </div>
      {node.managed && <p className="text-[10px] text-muted mt-2">Managed node — cron synced from Settings; cannot be deleted.</p>}
    </div>
  )
}

function EdgeInspector({ edge, fromLabel, toLabel, carriesData, cooldown, hourlyHits, onEnable, onNum, onDelete }: {
  edge: RouteEdge; fromLabel: string; toLabel: string; carriesData: boolean
  cooldown: Cooldown | null; hourlyHits: number
  onEnable: () => void; onNum: (k: 'cooldownSec' | 'maxPerHour', v: number) => void; onDelete: () => void
}) {
  const maxPerHour = Number(edge.maxPerHour) || 0
  const maxed = maxPerHour > 0 && hourlyHits >= maxPerHour
  return (
    <div className="rounded-2xl border border-border bg-surface-card/70 glass p-4 animate-slide-down">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-semibold tracking-wider text-muted uppercase">Route</span>
        <Toggle checked={edge.enabled} onChange={onEnable} label="Enable route" />
      </div>
      <div className="flex items-center gap-2 mb-3">
        <span className={cn('px-1.5 py-0.5 rounded-md text-[9px] font-bold tracking-wider',
          carriesData ? 'bg-accent/15 text-accent' : 'bg-surface-elevated text-muted border border-border')}>
          {carriesData ? 'DATA' : 'SIMPLE'}
        </span>
        <span className="text-[10px] text-muted">{carriesData ? 'carries a coin payload' : 'plain trigger'}</span>
      </div>
      <p className="text-xs text-foreground mb-3"><span className="text-muted">{fromLabel}</span> → <span className="text-muted">{toLabel}</span></p>

      {cooldown && (
        <div className="mb-3 p-2.5 rounded-xl border border-warn/30 bg-warn/5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-warn">
              <NodeIcon type="cooldown_gate" className="w-3 h-3" /> Route cooling
            </span>
            <span className="text-[11px] font-semibold text-warn tabular-nums">{fmtCountdown(cooldown.remainingMs)} left</span>
          </div>
          <CooldownBar cd={cooldown} />
        </div>
      )}

      <Field label="Cooldown (seconds)" help="Minimum gap between traversals of this route. 0 = none.">
        <input className={inputCls} type="number" min={0} value={edge.cooldownSec ?? 0} onChange={(e) => onNum('cooldownSec', Math.max(0, Number(e.target.value)))} />
      </Field>
      <Field label="Max fires / hour" help="Hard cap per rolling hour. 0 = unlimited.">
        <input className={inputCls} type="number" min={0} value={edge.maxPerHour ?? 0} onChange={(e) => onNum('maxPerHour', Math.max(0, Number(e.target.value)))} />
      </Field>
      {maxPerHour > 0 && (
        <p className={cn('text-[10px] mb-3 -mt-1', maxed ? 'text-sell font-semibold' : 'text-muted')}>
          {hourlyHits} / {maxPerHour} fired this hour{maxed ? ' — capped' : ''}
        </p>
      )}

      <button onClick={onDelete} className="w-full px-3 py-1.5 rounded-lg text-xs font-semibold text-sell border border-sell/30 hover:bg-sell/10 transition-colors">Delete route</button>
    </div>
  )
}
