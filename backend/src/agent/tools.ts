// The Agent's tool belt. Each tool exposes an OpenAI function schema (so the model
// can call it natively) plus a handler that reads — or, for the few `readOnly: false`
// tools, safely acts on — the running app. There are NO destructive tools here: the
// agent can never place a trade, change risk settings, or close a position. The most
// it can mutate is the watchlist and kicking off the engines that already run on crons.
import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { getSettings, updateSetting, queryAll } from '../db/index.js'
import { isTradeable } from '../core/tradeable.js'
import * as priceCache from '../market/index.js'
import { fetchMarketData } from '../trader/index.js'
import {
  getCoinEntries, getUsdcEntry, getOpenPositions,
  getMarketContext, classifyRegime,
} from '../portfolio/index.js'
import { getDiscoveries } from '../discoverer/index.js'
import { getReviews } from '../monitor/index.js'
import { getLatestSummary } from '../summary/index.js'

export interface AgentTool {
  name: string
  description: string
  /** JSON-schema object describing the tool's arguments. */
  parameters: Record<string, unknown>
  /** false = the tool can change app state (watchlist / triggers). Surfaced in the UI. */
  readOnly: boolean
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

const NO_ARGS = { type: 'object', properties: {}, required: [] as string[] }

// ── helpers ──────────────────────────────────────────────────────────────────

// Accepts 'btc', 'BTC', 'BTCUSDC', 'BTC/USDC' → canonical 'BTC/USDC' used everywhere.
function normalizeCoin(input: unknown): string {
  const raw = String(input ?? '').trim().toUpperCase()
  if (!raw) return ''
  if (raw.includes('/')) return raw
  const base = raw.replace(/USDC$/, '').replace(/USDT$/, '')
  return base ? `${base}/USDC` : ''
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return def
  return Math.min(Math.max(Math.floor(n), 1), max)
}

function priceFor(coin: string): number | null {
  if (coin === 'USDC') return 1
  return priceCache.getPrice(coin)?.price ?? null
}

function newCycleId(tag: string): string {
  return `${Date.now().toString(36)}-${tag}`
}

// ── read tools ─────────────────────────────────────────────────────────────

async function getPortfolio(): Promise<unknown> {
  const usdc = getUsdcEntry()
  const usdcBalance = usdc ? usdc.quantity : 0
  const entries = getCoinEntries()

  // Group multiple OPEN entries per coin into one holding line.
  const byCoin = new Map<string, { quantity: number; cost: number }>()
  for (const e of entries) {
    const cur = byCoin.get(e.coin) ?? { quantity: 0, cost: 0 }
    cur.quantity += e.quantity
    cur.cost += e.quantity * e.buy_price
    byCoin.set(e.coin, cur)
  }
  const coins = [...byCoin.keys()]
  if (coins.length) priceCache.subscribe(coins)

  const holdings = coins.map(coin => {
    const g = byCoin.get(coin)!
    const avgBuyPrice = g.quantity > 0 ? g.cost / g.quantity : null
    const current = priceFor(coin) ?? avgBuyPrice ?? 0
    const valueUsd = g.quantity * current
    const pnlPct = avgBuyPrice && avgBuyPrice > 0 ? ((current - avgBuyPrice) / avgBuyPrice) * 100 : null
    return {
      coin,
      quantity: Number(g.quantity.toFixed(8)),
      avgBuyPrice,
      currentPrice: current,
      valueUsd: Number(valueUsd.toFixed(2)),
      unrealizedPnlPct: pnlPct != null ? Number(pnlPct.toFixed(2)) : null,
    }
  })
  const totalValueUsd = usdcBalance + holdings.reduce((s, h) => s + h.valueUsd, 0)
  for (const h of holdings) {
    ;(h as { allocationPct?: number }).allocationPct =
      totalValueUsd > 0 ? Number(((h.valueUsd / totalValueUsd) * 100).toFixed(2)) : 0
  }
  holdings.sort((a, b) => b.valueUsd - a.valueUsd)

  return {
    totalValueUsd: Number(totalValueUsd.toFixed(2)),
    usdcBalance: Number(usdcBalance.toFixed(2)),
    usdcPct: totalValueUsd > 0 ? Number(((usdcBalance / totalValueUsd) * 100).toFixed(2)) : 100,
    holdingsCount: holdings.length,
    holdings,
    note: coins.some(c => priceFor(c) == null)
      ? 'Some prices may be momentarily unavailable (price feed warming up).'
      : undefined,
  }
}

function listOpenPositions(): unknown {
  const positions = getOpenPositions()
  return {
    count: positions.length,
    maxOpenPositions: getSettings().max_open_positions,
    positions: positions.map(p => {
      const current = priceFor(p.coin)
      const pnlPct = current != null && p.entry_price > 0
        ? Number((((current - p.entry_price) / p.entry_price) * 100).toFixed(2))
        : null
      return {
        coin: p.coin,
        quantity: p.quantity,
        entryPrice: p.entry_price,
        currentPrice: current,
        unrealizedPnlPct: pnlPct,
        stopLoss: p.stop_loss,
        takeProfit: p.take_profit,
        horizon: p.horizon,
        ocoStatus: p.oco_status,
        openedAt: p.created_at,
      }
    }),
  }
}

function listRecentTrades(args: Record<string, unknown>): unknown {
  const limit = clampLimit(args.limit, 15, 100)
  const coin = args.coin ? normalizeCoin(args.coin) : null
  const where = coin ? 'WHERE status = ? AND coin = ?' : 'WHERE status = ?'
  const params = coin ? ['EXECUTED', coin, limit] : ['EXECUTED', limit]
  const rows = queryAll(
    `SELECT side, coin, quantity, price, total, fee_cost, created_at
     FROM trades ${where} ORDER BY created_at DESC LIMIT ?`,
    params as (string | number)[],
  )
  return { count: rows.length, trades: rows }
}

function getWatchlist(): unknown {
  return { watchlist: getSettings().watchlist }
}

async function getMarket(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  if (!isTradeable(coin)) return { error: `${coin} is a fiat/stablecoin, not a tradeable market.` }

  priceCache.subscribe([coin])
  let price = priceFor(coin)
  if (price == null) {
    try {
      const md = await fetchMarketData([coin])
      price = md[0]?.price ?? null
    } catch (err) {
      logger.warn('Agent get_market: fetchMarketData failed', { coin, error: (err as Error).message })
    }
  }
  if (price == null) return { coin, error: 'Live price unavailable right now. Try again shortly.' }

  try {
    const mc = await getMarketContext(coin, price)
    const regime = classifyRegime(mc)
    return {
      coin,
      price,
      change24h: Number(mc.change24h.toFixed(2)),
      rsi14: Number(mc.rsi14.toFixed(1)),
      trend: mc.trend,
      volatility: mc.volatility,
      perf7d: Number(mc.perf7d.toFixed(2)),
      atr14: mc.atr14,
      regime: regime.summary,
    }
  } catch (err) {
    return { coin, price, error: `Indicators unavailable: ${(err as Error).message}` }
  }
}

function listRecentSignals(args: Record<string, unknown>): unknown {
  const limit = clampLimit(args.limit, 10, 50)
  const coin = args.coin ? normalizeCoin(args.coin) : null
  const where = coin ? 'WHERE coin = ?' : ''
  const params = coin ? [coin, limit] : [limit]
  const rows = queryAll(
    `SELECT coin, action, reason, confidence, created_at
     FROM decisions ${where} ORDER BY created_at DESC LIMIT ?`,
    params as (string | number)[],
  )
  return { count: rows.length, signals: rows }
}

function listDiscoveries(args: Record<string, unknown>): unknown {
  const limit = clampLimit(args.limit, 15, 50)
  return { discoveries: getDiscoveries(limit) }
}

function getPortfolioSummary(): unknown {
  const latest = getLatestSummary()
  if (!latest) return { note: 'No portfolio summary generated yet. You can trigger one with trigger_summary.' }
  return {
    summary: latest.summary,
    what_happened: latest.what_happened,
    health: latest.health,
    risk_level: latest.risk_level,
    observations: latest.observations ? safeJson(latest.observations) : null,
    suggestions: latest.suggestions ? safeJson(latest.suggestions) : null,
    created_at: latest.created_at,
  }
}

function listPositionReviews(args: Record<string, unknown>): unknown {
  const limit = clampLimit(args.limit, 12, 50)
  return { reviews: getReviews(limit) }
}

function getTradingSettings(): unknown {
  const s = getSettings()
  // A safe, read-only subset — never expose endpoints/keys.
  return {
    pipeline_cron: s.pipeline_cron,
    default_horizon: s.default_horizon,
    min_confidence: s.min_confidence,
    max_position_size_usd: s.max_position_size_usd,
    max_open_positions: s.max_open_positions,
    min_trade_usdc: s.min_trade_usdc,
    fee_rate: s.fee_rate,
    approval_required: s.approval_required,
    entry_timing_enabled: s.entry_timing_enabled,
    monitor_auto_run: s.monitor_auto_run,
    discover_auto_add: s.discover_auto_add,
    summary_auto_run: s.summary_auto_run,
    watchlist_size: s.watchlist.length,
  }
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

// ── safe-action tools ────────────────────────────────────────────────────────

function addToWatchlist(args: Record<string, unknown>): unknown {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "SOL".' }
  if (!isTradeable(coin)) return { error: `${coin} is a fiat/stablecoin and can't be watched.` }
  const s = getSettings()
  if (s.watchlist.includes(coin)) return { added: false, reason: 'already on watchlist', watchlist: s.watchlist }
  const next = [...s.watchlist, coin]
  updateSetting('watchlist', JSON.stringify(next))
  priceCache.subscribe([coin])
  bus.emit('settings_updated', getSettings())
  logger.info('Agent added coin to watchlist', { coin })
  return { added: true, coin, watchlist: next }
}

function removeFromWatchlist(args: Record<string, unknown>): unknown {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin to remove.' }
  const s = getSettings()
  if (!s.watchlist.includes(coin)) return { removed: false, reason: 'not on watchlist', watchlist: s.watchlist }
  const next = s.watchlist.filter(c => c !== coin)
  updateSetting('watchlist', JSON.stringify(next))
  bus.emit('settings_updated', getSettings())
  logger.info('Agent removed coin from watchlist', { coin })
  return { removed: true, coin, watchlist: next }
}

function triggerPipeline(args: Record<string, unknown>): unknown {
  const coin = args.coin ? normalizeCoin(args.coin) : null
  const cycleId = newCycleId(coin ? 'agent-pipe' : 'agent-pipe-all')
  if (coin) {
    if (!isTradeable(coin)) return { error: `${coin} is not a tradeable market.` }
    bus.emit('pipeline_run_requested', { symbol: coin, cycle_id: cycleId })
    return { started: true, scope: coin, cycle_id: cycleId, note: 'Pipeline run started in the background. Check the Pipeline page or ask again shortly.' }
  }
  bus.emit('pipeline_run_all_requested', {})
  return { started: true, scope: 'all watched/held coins', note: 'Full pipeline run started in the background.' }
}

function triggerDiscovery(): unknown {
  const cycleId = newCycleId('agent-disc')
  bus.emit('discovery_run_requested', { cycle_id: cycleId })
  return { started: true, cycle_id: cycleId, note: 'Coin discovery started in the background.' }
}

function triggerSummary(): unknown {
  const cycleId = newCycleId('agent-summary')
  bus.emit('summary_run_requested', { cycle_id: cycleId })
  return { started: true, cycle_id: cycleId, note: 'Portfolio summary generation started. Read it with get_portfolio_summary in ~30s.' }
}

function triggerMonitor(): unknown {
  const cycleId = newCycleId('agent-monitor')
  bus.emit('monitor_run_requested', { cycle_id: cycleId })
  return { started: true, cycle_id: cycleId, note: 'Position monitor review started in the background.' }
}

// ── registry ──────────────────────────────────────────────────────────────

export const TOOLS: AgentTool[] = [
  {
    name: 'get_portfolio',
    description: 'Get the current portfolio: total USD value, USDC cash balance, and every coin holding with quantity, average buy price, live price, value, allocation % and unrealized P&L %.',
    parameters: NO_ARGS,
    readOnly: true,
    handler: getPortfolio,
  },
  {
    name: 'list_open_positions',
    description: 'List bot-managed open positions with entry price, live price, unrealized P&L %, stop-loss, take-profit, horizon and exchange OCO status.',
    parameters: NO_ARGS,
    readOnly: true,
    handler: listOpenPositions,
  },
  {
    name: 'list_recent_trades',
    description: 'List recently EXECUTED trades (most recent first). Optionally filter by coin.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Optional coin filter, e.g. "BTC".' },
        limit: { type: 'number', description: 'How many trades (default 15, max 100).' },
      },
      required: [],
    },
    readOnly: true,
    handler: listRecentTrades,
  },
  {
    name: 'get_watchlist',
    description: 'Get the list of coins currently on the watchlist (the coins the entry pipeline analyzes).',
    parameters: NO_ARGS,
    readOnly: true,
    handler: getWatchlist,
  },
  {
    name: 'get_market',
    description: 'Get live market context for one coin: price, 24h change, RSI(14), trend, volatility, 7d performance, ATR and a regime summary.',
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin symbol, e.g. "ETH" or "ETH/USDC".' } },
      required: ['coin'],
    },
    readOnly: true,
    handler: getMarket,
  },
  {
    name: 'list_recent_signals',
    description: 'List recent analyst decisions/signals (BUY/SELL/HOLD with reason and confidence). Optionally filter by coin.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Optional coin filter.' },
        limit: { type: 'number', description: 'How many (default 10, max 50).' },
      },
      required: [],
    },
    readOnly: true,
    handler: listRecentSignals,
  },
  {
    name: 'list_discoveries',
    description: 'List recently discovered candidate coins (LLM-scored) with score, reasoning and status.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many (default 15, max 50).' } },
      required: [],
    },
    readOnly: true,
    handler: listDiscoveries,
  },
  {
    name: 'get_portfolio_summary',
    description: "Get the latest LLM portfolio summary: narrative, what changed, health & risk labels, observations and suggestions.",
    parameters: NO_ARGS,
    readOnly: true,
    handler: getPortfolioSummary,
  },
  {
    name: 'list_position_reviews',
    description: 'List recent position-monitor reviews (HOLD/CLOSE/REDUCE/ADJUST proposals) with reasoning and confidence.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many (default 12, max 50).' } },
      required: [],
    },
    readOnly: true,
    handler: listPositionReviews,
  },
  {
    name: 'get_trading_settings',
    description: 'Get a safe read-only overview of the bot trading configuration (crons, confidence/size limits, fee rate, auto-run flags). Never exposes API keys or LLM endpoints.',
    parameters: NO_ARGS,
    readOnly: true,
    handler: getTradingSettings,
  },
  {
    name: 'add_to_watchlist',
    description: 'Add a coin to the watchlist so the entry pipeline starts analyzing it. Safe, non-trading action.',
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin to add, e.g. "SOL".' } },
      required: ['coin'],
    },
    readOnly: false,
    handler: addToWatchlist,
  },
  {
    name: 'remove_from_watchlist',
    description: 'Remove a coin from the watchlist. Does not touch any open position — only stops new analysis. Safe, non-trading action.',
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin to remove.' } },
      required: ['coin'],
    },
    readOnly: false,
    handler: removeFromWatchlist,
  },
  {
    name: 'trigger_pipeline',
    description: 'Kick off the entry pipeline (research → analyst → BUY gauntlet) now, for one coin or for all watched/held coins. It runs in the background and may place trades subject to the normal gates/approval. Safe to call; does not bypass any trade gate.',
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Optional single coin; omit to run all watched/held coins.' } },
      required: [],
    },
    readOnly: false,
    handler: triggerPipeline,
  },
  {
    name: 'trigger_discovery',
    description: 'Kick off the coin-discovery engine now (LLM-scored search for new candidates). Runs in the background.',
    parameters: NO_ARGS,
    readOnly: false,
    handler: triggerDiscovery,
  },
  {
    name: 'trigger_summary',
    description: 'Generate a fresh portfolio summary now. Runs in the background; read the result with get_portfolio_summary shortly after.',
    parameters: NO_ARGS,
    readOnly: false,
    handler: triggerSummary,
  },
  {
    name: 'trigger_monitor',
    description: 'Run the position monitor now to review open positions (it may propose SL/TP changes or exits subject to your approval settings). Runs in the background.',
    parameters: NO_ARGS,
    readOnly: false,
    handler: triggerMonitor,
  },
]

const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]))

export function isReadOnlyTool(name: string): boolean {
  return TOOL_MAP.get(name)?.readOnly ?? true
}

/** OpenAI `tools` array built from the registry. */
export function getToolSchemas(): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}[] {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/** Run a tool by name, always resolving to a JSON-serializable result (never throws). */
export async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TOOL_MAP.get(name)
  if (!tool) return { error: `Unknown tool: ${name}` }
  try {
    return await tool.handler(args ?? {})
  } catch (err) {
    logger.warn('Agent tool failed', { tool: name, error: (err as Error).message })
    return { error: `Tool "${name}" failed: ${(err as Error).message}` }
  }
}
