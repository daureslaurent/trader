import { logger } from '../core/logger.js'
import { getOpenPositions } from '../portfolio/index.js'
import { RouteNode, FireContext } from './types.js'
import { recordDebug } from './debugLog.js'

/**
 * Processor handlers — conditional gates. Each returns true to propagate the
 * event onward to the node's outgoing edges, or false to stop it here. This is
 * how "conditional triggers" compose: a source fires a processor, and only a
 * passing condition reaches the output.
 */

type ProcessorHandler = (node: RouteNode, ctx: FireContext) => Promise<boolean>

// Per-symbol short-window price history for the price_move gate. Bounded by the
// prune step, so it can't grow without limit.
const priceHistory = new Map<string, { t: number; price: number }[]>()

// Per-node last-pass timestamp for the cooldown gate.
const lastPass = new Map<string, number>()

const num = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const HANDLERS: Record<string, ProcessorHandler> = {
  price_move: async (node, ctx) => {
    const symbol = ctx.symbol
    const price = ctx.price
    if (!symbol || typeof price !== 'number') return false

    const pct = num(node.config.pct, 2)
    const windowSec = num(node.config.windowSec, 300)
    const direction = String(node.config.direction ?? 'any')

    const now = Date.now()
    const hist = priceHistory.get(symbol) ?? []
    hist.push({ t: now, price })
    // Keep a little beyond the window so the oldest in-window sample is available.
    const cutoff = now - windowSec * 1000 * 1.2
    const pruned = hist.filter((h) => h.t >= cutoff)
    priceHistory.set(symbol, pruned)

    const windowStart = now - windowSec * 1000
    const ref = pruned.find((h) => h.t >= windowStart) ?? pruned[0]
    if (!ref || ref.price <= 0) return false

    const movePct = ((price - ref.price) / ref.price) * 100
    if (direction === 'up') return movePct >= pct
    if (direction === 'down') return movePct <= -pct
    return Math.abs(movePct) >= pct
  },

  holding_filter: async (node) => {
    const mode = String(node.config.mode ?? 'has_positions')
    try {
      const positions = (await getOpenPositions()) as unknown as { coin: string }[]
      const held = positions.filter((p) => p.coin !== 'USDC').length
      return mode === 'no_positions' ? held === 0 : held > 0
    } catch (err) {
      logger.warn('holding_filter could not read positions', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  },

  cooldown_gate: async (node) => {
    const seconds = num(node.config.seconds, 60)
    const now = Date.now()
    const last = lastPass.get(node.id) ?? 0
    if (now - last < seconds * 1000) return false
    lastPass.set(node.id, now)
    return true
  },

  // Records what flows through it. Pass-through (default) propagates onward so it
  // can be dropped inline as a transparent tap; sink mode stops the chain here.
  debug: async (node, ctx) => {
    await recordDebug(node, ctx)
    return node.config.passThrough !== false
  },
}

export async function runProcessor(node: RouteNode, ctx: FireContext): Promise<boolean> {
  const handler = HANDLERS[node.type]
  if (!handler) {
    logger.warn('Unknown processor node type', { type: node.type, nodeId: node.id })
    return false
  }
  return handler(node, ctx)
}
