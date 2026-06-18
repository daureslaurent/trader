import { logger } from '../core/logger.js'
import { getOpenPositions } from '../portfolio/index.js'
import { getPrice, getOHLCV, isTimeframe } from '../market/index.js'
import { getSettings } from '../db/index.js'
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

// Per-(node, symbol) last price for the edge-triggered price_cross gate.
const lastCrossPrice = new Map<string, number>()

const num = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Wilder's RSI over a series of closes. Returns null if not enough data. */
function computeRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d; else loss -= d
  }
  let avgGain = gain / period, avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
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

  // 24h ticker change beyond a threshold (authoritative 24h from the price cache,
  // regardless of which input fed this node).
  change_24h: async (node, ctx) => {
    if (!ctx.symbol) return false
    const snap = getPrice(ctx.symbol)
    if (!snap) return false
    const pct = num(node.config.pct, 5)
    const direction = String(node.config.direction ?? 'any')
    const chg = snap.change24h
    if (direction === 'up') return chg >= pct
    if (direction === 'down') return chg <= -pct
    return Math.abs(chg) >= pct
  },

  // Bid/ask spread tight enough (from a Best Bid/Ask input).
  spread_filter: async (node, ctx) => {
    const bid = Number(ctx.bid), ask = Number(ctx.ask)
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return false
    const mid = (bid + ask) / 2
    const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : Infinity
    return spreadPct <= num(node.config.maxSpreadPct, 0.1)
  },

  // Large trades by notional USD + aggressor side (from a Trades input).
  trade_size: async (node, ctx) => {
    const qty = Number(ctx.qty), price = Number(ctx.price)
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return false
    const side = String(node.config.side ?? 'any')
    if (side !== 'any' && String(ctx.side) !== side) return false
    return qty * price >= num(node.config.minUsd, 10000)
  },

  // RSI oversold/overbought gate. Fetches (cached) candles, so wire after a
  // low-frequency input such as a kline close.
  rsi_gate: async (node, ctx) => {
    if (!ctx.symbol) return false
    const tf = String(node.config.tf ?? '1h')
    if (!isTimeframe(tf)) return false
    const period = Math.max(2, Math.floor(num(node.config.period, 14)))
    try {
      const candles = await getOHLCV(ctx.symbol, tf, period * 4 + 1)
      const rsi = computeRSI(candles.map((c) => c.close), period)
      if (rsi === null) return false
      return String(node.config.op ?? 'below') === 'above' ? rsi >= num(node.config.value, 70) : rsi <= num(node.config.value, 30)
    } catch (err) {
      logger.warn('rsi_gate fetch failed', { symbol: ctx.symbol, error: err instanceof Error ? err.message : String(err) })
      return false
    }
  },

  // Edge-triggered price-level cross (per symbol).
  price_cross: async (node, ctx) => {
    const symbol = ctx.symbol
    const price = Number(ctx.price)
    const level = num(node.config.level, 0)
    if (!symbol || !Number.isFinite(price) || level <= 0) return false
    const key = `${node.id}:${symbol}`
    const prev = lastCrossPrice.get(key)
    lastCrossPrice.set(key, price)
    if (prev === undefined) return false
    const dir = String(node.config.direction ?? 'above')
    const up = prev < level && price >= level
    const down = prev > level && price <= level
    if (dir === 'above') return up
    if (dir === 'below') return down
    return up || down
  },

  // Gate on the unrealized PnL% of the held position for this symbol.
  pnl_gate: async (node, ctx) => {
    if (!ctx.symbol) return false
    let price = Number(ctx.price)
    if (!Number.isFinite(price)) price = getPrice(ctx.symbol)?.price ?? NaN
    if (!Number.isFinite(price)) return false
    try {
      const positions = (await getOpenPositions()) as unknown as { coin: string; entry_price: number }[]
      const pos = positions.find((p) => p.coin === ctx.symbol)
      if (!pos || !(pos.entry_price > 0)) return false
      const pnlPct = ((price - pos.entry_price) / pos.entry_price) * 100
      return String(node.config.direction ?? 'above') === 'below' ? pnlPct <= num(node.config.pct, 5) : pnlPct >= num(node.config.pct, 5)
    } catch (err) {
      logger.warn('pnl_gate could not read positions', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  },

  // Hour-of-day window in the app's configured local time (UTC + offset).
  time_window: async (node) => {
    const startH = num(node.config.startHour, 0)
    const endH = num(node.config.endHour, 24)
    const offset = getSettings().utc_offset_hours || 0
    const d = new Date(Date.now() + offset * 3600_000)
    const h = d.getUTCHours() + d.getUTCMinutes() / 60
    return startH <= endH ? h >= startH && h < endH : h >= startH || h < endH
  },

  // Minute-of-hour window — passes during a slice of every hour regardless of the
  // hour (e.g. start 25, end 35 → fires between :25 and :35 each hour). Wraps
  // across the top of the hour when start > end (e.g. 55 → 5). Sub-minute precise.
  minute_window: async (node) => {
    const start = num(node.config.startMinute, 0)
    const end = num(node.config.endMinute, 60)
    const offset = getSettings().utc_offset_hours || 0
    const d = new Date(Date.now() + offset * 3600_000)
    const m = d.getUTCMinutes() + d.getUTCSeconds() / 60
    return start <= end ? m >= start && m < end : m >= start || m < end
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

/**
 * Last-pass epoch (ms) for every cooldown_gate node that has fired at least once,
 * so the UI can render a live "cooling — Ns left" countdown. The node's own
 * `seconds` config (read from the graph) determines when the cooldown ends.
 */
export function getNodeCooldowns(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, t] of lastPass) out[id] = t
  return out
}
