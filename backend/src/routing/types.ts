/**
 * The event-routing graph: a directed graph that wires input sources to output
 * modules, optionally through processor nodes that evaluate conditions.
 *
 *   input  → (processor → …) → output
 *
 * - inputs    : sources that fire (timer/cron, Binance ticks, manual, system).
 * - processors: consume a fire, evaluate logic (price move %, only-when-holding,
 *               …) and propagate only if the condition passes — this is how
 *               "conditional triggers" are expressed without a special input type.
 * - outputs   : trigger an engine (pipeline / monitor / discovery / summary).
 *
 * The whole graph is persisted as one JSON blob in settings (`routing_graph`)
 * and is the single source of truth for what triggers what.
 */

export type NodeKind = 'input' | 'processor' | 'output'

export interface RouteNode {
  /** Stable id. Managed defaults use readable ids (e.g. `timer.pipeline`). */
  id: string
  kind: NodeKind
  /** Behaviour key into the node-type registry (e.g. `timer`, `price_move`). */
  type: string
  label: string
  enabled: boolean
  /** Type-specific config (timer: { cron }, price_move: { pct, windowSec }, …). */
  config: Record<string, unknown>
  /** Canvas position for the flow-graph layout. */
  position: { x: number; y: number }
  /**
   * Managed nodes mirror a core setting (the four engine timers) — their cron
   * stays in sync with the Settings page. The UI marks them and forbids delete.
   */
  managed?: boolean
}

export interface RouteEdge {
  id: string
  from: string
  to: string
  enabled: boolean
  /** Guardrail: minimum seconds between traversals of THIS edge (0 = none). */
  cooldownSec?: number
  /** Guardrail: hard cap on traversals per rolling hour (0 = none). */
  maxPerHour?: number
}

export interface RoutingGraph {
  /** Global kill-switch — false halts ALL routing instantly (crons included). */
  enabled: boolean
  nodes: RouteNode[]
  edges: RouteEdge[]
}

/** Context threaded through a fire — carries the originating event's data. */
export interface FireContext {
  /** What kicked off this propagation (timer id, 'manual', 'binance', …). */
  trigger: string
  symbol?: string
  price?: number
  changePct?: number
  /** Arbitrary extra payload from the source event. */
  [key: string]: unknown
}

/** A config field descriptor the frontend uses to render a node's settings. */
export interface ConfigField {
  key: string
  label: string
  type: 'cron' | 'number' | 'text' | 'select' | 'boolean'
  placeholder?: string
  options?: { value: string; label: string }[]
  help?: string
}

/** Serializable node-type definition shipped to the frontend palette. */
export interface NodeTypeMeta {
  type: string
  kind: NodeKind
  label: string
  description: string
  /** Theme-token category for colouring (reuses the Event Stream palette). */
  category: string
  configFields: ConfigField[]
  /** Default config applied when a fresh node of this type is created. */
  defaultConfig: Record<string, unknown>
  /** Managed types can't be created/deleted by the user (the engine timers). */
  singleton?: boolean
}
