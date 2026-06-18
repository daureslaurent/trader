import { logger } from '../core/logger.js'
import { broadcast } from '../api/ws.js'
import { systemBus, SystemEvent } from '../core/bus.js'
import { RoutingGraph, RouteNode, RouteEdge, FireContext } from './types.js'
import { runProcessor } from './processors.js'
import { runOutput } from './outputs.js'

/**
 * The routing engine. Holds the active graph and propagates a fire from an input
 * node through processors to outputs, applying per-edge guardrails (cooldown,
 * max/hour) and the per-output skip-if-running guard.
 *
 * Two telemetry channels are emitted on every step:
 *   - `routing_pulse` WS frames (node/edge ids) — drive the live flow-graph
 *     animation, off the coalesced Event Stream path so they're never dropped.
 *   - `systemBus` ROUTING.* events — surface meaningful steps (input/output
 *     fired, blocked) on the Event Stream feed.
 */

let graph: RoutingGraph = { enabled: true, nodes: [], edges: [] }
let nodeById = new Map<string, RouteNode>()
let outgoing = new Map<string, RouteEdge[]>()

// Per-edge guardrail state.
const edgeLastFired = new Map<string, number>()
const edgeHourly = new Map<string, number[]>()

export function setGraph(next: RoutingGraph): void {
  graph = next
  nodeById = new Map(next.nodes.map((n) => [n.id, n]))
  outgoing = new Map()
  for (const e of next.edges) {
    const list = outgoing.get(e.from) ?? []
    list.push(e)
    outgoing.set(e.from, list)
  }
}

export function getGraph(): RoutingGraph {
  return graph
}

export function isRoutingEnabled(): boolean {
  return graph.enabled
}

function pulse(kind: 'node' | 'edge' | 'blocked', id: string, reason?: string): void {
  broadcast('routing_pulse', { kind, id, reason, t: Date.now() })
}

/** Edge guardrails: cooldown + rolling-hour cap. Returns true if the edge may fire. */
function edgeAllowed(edge: RouteEdge): { ok: boolean; reason?: string } {
  const now = Date.now()

  const cooldownSec = Number(edge.cooldownSec ?? 0)
  if (cooldownSec > 0) {
    const last = edgeLastFired.get(edge.id) ?? 0
    if (now - last < cooldownSec * 1000) return { ok: false, reason: 'cooldown' }
  }

  const maxPerHour = Number(edge.maxPerHour ?? 0)
  if (maxPerHour > 0) {
    const hourAgo = now - 3600_000
    const hits = (edgeHourly.get(edge.id) ?? []).filter((t) => t >= hourAgo)
    if (hits.length >= maxPerHour) {
      edgeHourly.set(edge.id, hits)
      return { ok: false, reason: 'max_per_hour' }
    }
  }
  return { ok: true }
}

/**
 * Live guardrail state for the UI: per-edge last-fired epoch (ms) for the
 * cooldown countdown, plus the rolling-hour hit count for the max/hour badge.
 */
export function getEdgeGuardrailState(): { lastFired: Record<string, number>; hourly: Record<string, number> } {
  const now = Date.now()
  const hourAgo = now - 3600_000
  const lastFired: Record<string, number> = {}
  for (const [id, t] of edgeLastFired) lastFired[id] = t
  const hourly: Record<string, number> = {}
  for (const [id, arr] of edgeHourly) {
    const hits = arr.filter((t) => t >= hourAgo).length
    if (hits > 0) hourly[id] = hits
  }
  return { lastFired, hourly }
}

function commitEdge(edge: RouteEdge): void {
  const now = Date.now()
  edgeLastFired.set(edge.id, now)
  const hourAgo = now - 3600_000
  const hits = (edgeHourly.get(edge.id) ?? []).filter((t) => t >= hourAgo)
  hits.push(now)
  edgeHourly.set(edge.id, hits)
}

/**
 * Fire a node and propagate. Entry point for every input source (timers,
 * Binance ticks, manual, startup). `visited` guards against cycles.
 */
export async function fireNode(nodeId: string, ctx: FireContext, visited = new Set<string>()): Promise<void> {
  if (!graph.enabled) return // global kill-switch
  const node = nodeById.get(nodeId)
  if (!node || !node.enabled) return
  if (visited.has(nodeId)) return
  visited.add(nodeId)

  // ── Node behaviour ─────────────────────────────────────────────────────────
  if (node.kind === 'processor') {
    pulse('node', node.id)
    let pass = false
    try {
      pass = await runProcessor(node, ctx)
    } catch (err) {
      logger.warn('Processor threw', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) })
    }
    if (!pass) {
      pulse('blocked', node.id, 'condition')
      return
    }
  } else if (node.kind === 'output') {
    pulse('node', node.id)
    const res = runOutput(node, ctx)
    if (res.ran) {
      systemBus.emitEvent(SystemEvent.ROUTING_OUTPUT_FIRED, { nodeId: node.id, module: node.type, trigger: ctx.trigger })
    } else {
      pulse('blocked', node.id, res.skippedReason)
      systemBus.emitEvent(SystemEvent.ROUTING_BLOCKED, { target: node.label, reason: res.skippedReason ?? 'skipped' })
    }
    return // outputs are terminal sinks
  } else {
    // input
    pulse('node', node.id)
    systemBus.emitEvent(SystemEvent.ROUTING_INPUT_FIRED, { nodeId: node.id, label: node.label, trigger: ctx.trigger })
  }

  // ── Propagate along outgoing edges ──────────────────────────────────────────
  for (const edge of outgoing.get(node.id) ?? []) {
    if (!edge.enabled) continue
    const target = nodeById.get(edge.to)
    if (!target || !target.enabled) continue

    const gate = edgeAllowed(edge)
    if (!gate.ok) {
      pulse('blocked', edge.id, gate.reason)
      systemBus.emitEvent(SystemEvent.ROUTING_BLOCKED, { target: target.label, reason: gate.reason ?? 'blocked', detail: edge.id })
      continue
    }
    commitEdge(edge)
    pulse('edge', edge.id)
    await fireNode(edge.to, ctx, visited)
  }
}

/** Fire every enabled input node of a given type (used by shared sources). */
export async function fireInputsOfType(type: string, ctx: FireContext, match?: (n: RouteNode) => boolean): Promise<void> {
  if (!graph.enabled) return
  const targets = graph.nodes.filter((n) => n.kind === 'input' && n.type === type && n.enabled && (!match || match(n)))
  for (const n of targets) await fireNode(n.id, { ...ctx }, new Set())
}
