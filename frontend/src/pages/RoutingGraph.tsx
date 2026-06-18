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
          <div className="relative">
            <button
              onClick={() => setPaletteOpen((o) => !o)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-foreground border border-border bg-surface-card hover:bg-surface-hover transition-colors"
            >
              + Add node
            </button>
            {paletteOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 max-h-[28rem] overflow-y-auto bg-surface-card border border-border rounded-2xl shadow-xl p-2 z-50 animate-slide-down">
                {(['input', 'processor', 'output'] as NodeKind[]).map((kind) => (
                  <div key={kind} className="mb-2">
                    <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-muted uppercase">{KIND_LABEL[kind]}</div>
                    {catalog.filter((m) => m.kind === kind).map((m) => {
                      const exists = m.singleton && graph.nodes.some((n) => n.type === m.type)
                      const s = catStyle(m.category)
                      return (
                        <button
                          key={m.type}
                          disabled={exists}
                          onClick={() => addNode(m)}
                          className={cn('w-full flex items-start gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                            exists ? 'opacity-40 cursor-not-allowed' : 'hover:bg-surface-hover')}
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', s.dot)} />
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-foreground">{m.label}{exists && ' (added)'}</span>
                            <span className="block text-[11px] text-muted leading-tight">{m.description}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
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
                    <span className={cn('w-2 h-2 rounded-full shrink-0', s.dot, fired && 'animate-pulse')} />
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
                    {(node.kind === 'input' || node.kind === 'output') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); fetch(`/api/routing/fire/${node.id}`, { method: 'POST' }) }}
                        className="shrink-0 text-[10px] font-semibold text-accent hover:underline"
                        title="Fire this node now"
                      >▶ fire</button>
                    )}
                  </div>

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
          </div>
        </div>

        {/* Inspector */}
        <div className="w-72 shrink-0">
          {selNode && <NodeInspector
            node={selNode} meta={catalog.find((m) => m.type === selNode.type)}
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

function NodeInspector({ node, meta, onLabel, onEnable, onConfig, onDelete, onFire }: {
  node: RouteNode; meta?: NodeTypeMeta
  onLabel: (v: string) => void; onEnable: () => void
  onConfig: (k: string, v: unknown) => void; onDelete: () => void; onFire: () => void
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface-card/70 glass p-4 animate-slide-down">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-semibold tracking-wider text-muted uppercase">{KIND_LABEL[node.kind]} · {node.type}</span>
        <Toggle checked={node.enabled} onChange={onEnable} label="Enable node" />
      </div>

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

function EdgeInspector({ edge, fromLabel, toLabel, carriesData, onEnable, onNum, onDelete }: {
  edge: RouteEdge; fromLabel: string; toLabel: string; carriesData: boolean
  onEnable: () => void; onNum: (k: 'cooldownSec' | 'maxPerHour', v: number) => void; onDelete: () => void
}) {
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

      <Field label="Cooldown (seconds)" help="Minimum gap between traversals of this route. 0 = none.">
        <input className={inputCls} type="number" min={0} value={edge.cooldownSec ?? 0} onChange={(e) => onNum('cooldownSec', Math.max(0, Number(e.target.value)))} />
      </Field>
      <Field label="Max fires / hour" help="Hard cap per rolling hour. 0 = unlimited.">
        <input className={inputCls} type="number" min={0} value={edge.maxPerHour ?? 0} onChange={(e) => onNum('maxPerHour', Math.max(0, Number(e.target.value)))} />
      </Field>

      <button onClick={onDelete} className="w-full px-3 py-1.5 rounded-lg text-xs font-semibold text-sell border border-sell/30 hover:bg-sell/10 transition-colors">Delete route</button>
    </div>
  )
}
