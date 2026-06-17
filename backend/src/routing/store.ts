import { getRawSetting, updateSetting, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { BotSettings } from '../types.js'
import { RoutingGraph, RouteNode, RouteEdge } from './types.js'
import { defaultGraph, MANAGED_TIMERS } from './defaults.js'
import { setGraph, getGraph } from './engine.js'
import { rescheduleTimers } from './scheduler.js'

const SETTING_KEY = 'routing_graph'

/** Parse + defensively validate a persisted graph. Returns null if unusable. */
function parseGraph(raw: string | undefined): RoutingGraph | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Partial<RoutingGraph>
    if (!obj || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return null
    const nodes: RouteNode[] = obj.nodes
      .filter((n): n is RouteNode => !!n && typeof n.id === 'string' && typeof n.type === 'string')
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        type: n.type,
        label: String(n.label ?? n.type),
        enabled: n.enabled !== false,
        config: (n.config && typeof n.config === 'object') ? n.config : {},
        position: n.position && typeof n.position === 'object' ? n.position : { x: 0, y: 0 },
        ...(n.managed ? { managed: true } : {}),
      }))
    const nodeIds = new Set(nodes.map((n) => n.id))
    const edges: RouteEdge[] = obj.edges
      .filter((e): e is RouteEdge => !!e && typeof e.from === 'string' && typeof e.to === 'string')
      // Drop dangling edges referencing deleted nodes.
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => ({
        id: String(e.id ?? `${e.from}->${e.to}`),
        from: e.from,
        to: e.to,
        enabled: e.enabled !== false,
        cooldownSec: Math.max(0, Number(e.cooldownSec ?? 0)) || 0,
        maxPerHour: Math.max(0, Number(e.maxPerHour ?? 0)) || 0,
      }))
    return { enabled: obj.enabled !== false, nodes, edges }
  } catch (err) {
    logger.warn('Failed to parse routing_graph, falling back to default', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

async function persist(graph: RoutingGraph): Promise<void> {
  await updateSetting(SETTING_KEY, JSON.stringify(graph))
}

function apply(graph: RoutingGraph): void {
  setGraph(graph)
  rescheduleTimers(graph)
}

/** Load (or seed) the graph at startup and activate it. */
export async function loadGraph(): Promise<void> {
  const settings = getSettings()
  let graph = parseGraph(getRawSetting(SETTING_KEY))
  if (!graph) {
    graph = defaultGraph(settings)
    await persist(graph)
    logger.info('Seeded default routing graph', { nodes: graph.nodes.length, edges: graph.edges.length })
  } else {
    // The cron text of managed engine timers stays authoritative from settings
    // (.env seeds those), so refresh it on load without touching user wiring.
    refreshManagedCron(graph, settings)
  }
  apply(graph)
}

function refreshManagedCron(graph: RoutingGraph, settings: BotSettings): void {
  for (const m of MANAGED_TIMERS) {
    const node = graph.nodes.find((n) => n.id === m.id)
    if (node) node.config = { ...node.config, cron: String(settings[m.cronKey]) }
  }
}

/** Persist + activate a user-edited graph (from the flow-graph UI). */
export async function saveGraph(next: RoutingGraph): Promise<RoutingGraph> {
  const clean = parseGraph(JSON.stringify(next))
  if (!clean) throw new Error('Invalid routing graph')
  await persist(clean)
  apply(clean)
  return clean
}

/**
 * Keep the managed engine timers in sync when the Settings page changes a cron
 * or an auto-run flag — preserves the existing Settings UX as a second surface.
 */
export async function syncFromSettings(settings: BotSettings): Promise<void> {
  const graph: RoutingGraph = JSON.parse(JSON.stringify(getGraph()))
  for (const m of MANAGED_TIMERS) {
    const node = graph.nodes.find((n) => n.id === m.id)
    if (!node) continue
    node.config = { ...node.config, cron: String(settings[m.cronKey]) }
    if (m.enabledKey) node.enabled = settings[m.enabledKey] === true
  }
  await saveGraph(graph)
}

/** Flip the global kill-switch. */
export async function setGlobalEnabled(enabled: boolean): Promise<RoutingGraph> {
  const graph: RoutingGraph = JSON.parse(JSON.stringify(getGraph()))
  graph.enabled = enabled
  return saveGraph(graph)
}
