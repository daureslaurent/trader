// The Agent's tool belt. Each tool exposes an OpenAI function schema (so the model
// can call it natively) plus a handler that reads — or, for the few `readOnly: false`
// tools, safely acts on — the running app. There are NO destructive tools here: the
// agent can never place a trade, change risk settings, or close a position. The most
// it can mutate is the watchlist and kicking off the engines that already run on crons.
import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { getSettings, updateSetting, nowSql, trades, decisions, llmCalls, entryEvents, monitorNotes, agentSignalMemory, agentSignalRuns } from '../db/index.js'
import type { SignalMemory } from '../types.js'
import { isTradeable } from '../core/tradeable.js'
import * as priceCache from '../market/index.js'
import { fetchMarketData } from '../trader/index.js'
import {
  getCoinEntries, getUsdcEntry, getOpenPositions,
  getMarketContext, classifyRegime,
} from '../portfolio/index.js'
import { getDiscoveries } from '../discoverer/index.js'
import { researchCoin } from '../researcher/index.js'
import { extractResearch } from '../extractor/index.js'
import { getReviews } from '../monitor/index.js'
import { getLatestSummary } from '../summary/index.js'
import { getActiveIntents, applyAgentBand, fireNow as fireEntryIntent, cancel as cancelEntryIntent } from '../entry/index.js'

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

// Trim long text to a readable preview for list views (full text via a detail tool).
function snippet(raw: unknown, max = 280): string | null {
  if (raw == null) return null
  const s = String(raw).replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function pctDiff(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null
  return Number((((to - from) / from) * 100).toFixed(2))
}

// ── read tools ─────────────────────────────────────────────────────────────

async function getPortfolio(): Promise<unknown> {
  const usdc = await getUsdcEntry()
  const usdcBalance = usdc ? usdc.quantity : 0
  const entries = await getCoinEntries()

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

async function listOpenPositions(): Promise<unknown> {
  const positions = await getOpenPositions()
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

async function listRecentTrades(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 15, 100)
  const coin = args.coin ? normalizeCoin(args.coin) : null
  const filter: Record<string, unknown> = { status: 'EXECUTED', ...(coin ? { coin } : {}) }
  const rows = await trades.find(filter, {
    sort: { created_at: -1 }, limit,
    projection: { _id: 0, side: 1, coin: 1, quantity: 1, price: 1, total: 1, fee_cost: 1, created_at: 1 },
  })
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

async function listRecentSignals(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 10, 50)
  const coin = args.coin ? normalizeCoin(args.coin) : null
  const rows = await decisions.find(coin ? { coin } : {}, {
    sort: { created_at: -1 }, limit,
    projection: { _id: 0, coin: 1, action: 1, reason: 1, confidence: 1, created_at: 1 },
  })
  return { count: rows.length, signals: rows }
}

async function listDiscoveries(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 15, 50)
  return { discoveries: await getDiscoveries(limit) }
}

async function getPortfolioSummary(): Promise<unknown> {
  const latest = await getLatestSummary()
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

async function listPositionReviews(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 12, 50)
  return { reviews: await getReviews(limit) }
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

// ── LLM debug tools ──────────────────────────────────────────────────────────

async function listLlmCalls(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 15, 50)
  const filter: Record<string, unknown> = {}
  if (args.module) filter.module = String(args.module).trim().toLowerCase()
  if (args.coin) filter.coin = normalizeCoin(args.coin)
  if (args.errors_only === true) filter.error = { $ne: null }

  const rows = await llmCalls.find(filter, {
    sort: { created_at: -1 }, limit,
    projection: {
      _id: 0, id: 1, module: 1, model: 1, base_url: 1, coin: 1, cycle_id: 1,
      response: 1, error: 1, tool_calls: 1, prompt_tokens: 1, completion_tokens: 1,
      thinking_tokens: 1, duration_ms: 1, queue_ms: 1, created_at: 1,
    },
  })
  return {
    count: rows.length,
    note: 'Prompts/responses are truncated here. Use get_llm_call with an id for the full prompt, response and reasoning.',
    calls: rows.map(r => ({
      id: r.id,
      module: r.module,
      model: r.model,
      base_url: r.base_url,
      coin: r.coin ?? null,
      cycle_id: r.cycle_id ?? null,
      ok: !r.error,
      error: snippet(r.error, 200),
      responsePreview: snippet(r.response),
      hasToolCalls: !!r.tool_calls,
      promptTokens: r.prompt_tokens ?? null,
      completionTokens: r.completion_tokens ?? null,
      thinkingTokens: r.thinking_tokens ?? null,
      durationMs: r.duration_ms ?? null,
      queueMs: r.queue_ms ?? null,
      created_at: r.created_at,
    })),
  }
}

async function getLlmCall(args: Record<string, unknown>): Promise<unknown> {
  const id = typeof args.id === 'number' ? args.id : parseInt(String(args.id ?? ''), 10)
  if (!Number.isFinite(id)) return { error: 'Provide a numeric LLM call id (from list_llm_calls).' }
  const r = await llmCalls.findById(id)
  if (!r) return { error: `No LLM call found with id ${id}.` }
  return {
    id: r.id,
    module: r.module,
    model: r.model,
    base_url: r.base_url,
    coin: r.coin ?? null,
    cycle_id: r.cycle_id ?? null,
    ok: !r.error,
    error: r.error ?? null,
    system_prompt: r.system_prompt ?? null,
    user_prompt: r.user_prompt ?? null,
    response: r.response ?? null,
    reasoning_content: r.reasoning_content ?? null,
    tool_calls: r.tool_calls ? safeJson(r.tool_calls as string) : null,
    promptTokens: r.prompt_tokens ?? null,
    completionTokens: r.completion_tokens ?? null,
    thinkingTokens: r.thinking_tokens ?? null,
    durationMs: r.duration_ms ?? null,
    queueMs: r.queue_ms ?? null,
    created_at: r.created_at,
  }
}

// ── entry-desk tools ─────────────────────────────────────────────────────────

function getEntryIntents(): unknown {
  const intents = getActiveIntents()
  if (!intents.length) {
    return {
      count: 0,
      entry_timing_enabled: getSettings().entry_timing_enabled,
      note: 'No active entry intents. Deferred BUYs appear here while the engine waits for a good fill (only when entry timing is enabled).',
    }
  }
  const coins = intents.map(i => i.coin)
  priceCache.subscribe(coins)
  const now = Date.now()
  return {
    count: intents.length,
    intents: intents.map(i => {
      const current = priceFor(i.coin)
      return {
        coin: i.coin,
        notionalUsdc: i.notionalUsdc,
        signalPrice: i.signalPrice,
        currentPrice: current,
        targetPrice: i.targetPrice,
        invalidatePrice: i.invalidatePrice,
        chaseCapPrice: i.chaseCapPrice,
        // % the live price must still move to hit each level (negative = below current).
        toTargetPct: current != null ? pctDiff(current, i.targetPrice) : null,
        toInvalidatePct: current != null ? pctDiff(current, i.invalidatePrice) : null,
        toChaseCapPct: current != null ? pctDiff(current, i.chaseCapPrice) : null,
        confidence: i.signal?.confidence ?? null,
        ageMinutes: Number(((now - i.createdAt) / 60000).toFixed(1)),
        ttlMinutesLeft: Number(Math.max(0, (i.expiresAt - now) / 60000).toFixed(1)),
      }
    }),
  }
}

async function listEntryEvents(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 20, 100)
  const filter: Record<string, unknown> = {}
  if (args.coin) filter.coin = normalizeCoin(args.coin)
  const type = args.type ? String(args.type).trim().toLowerCase() : null
  if (type && ['registered', 'filled', 'cancelled'].includes(type)) filter.type = type

  const rows = await entryEvents.find(filter, { sort: { created_at: -1 }, limit })
  return {
    count: rows.length,
    events: rows.map(r => ({
      coin: r.coin,
      type: r.type,
      reason: r.reason ?? null,
      signalPrice: r.signal_price,
      targetPrice: r.target_price,
      price: r.price ?? null,
      // positive = filled below the signal price (favorable slippage).
      slippagePct: r.slippage_pct ?? null,
      at: new Date(r.created_at as number).toISOString(),
    })),
  }
}

// ── Entry Agent tools ─────────────────────────────────────────────────────────
// Read + action tools for the agentic per-coin entry engine (agent/entryAgent.ts). The
// read gives the agent its current intent state; the three action tools let it adapt the
// band, fire, or cancel. Registered on the shared belt but granted only to `entryAgent`.

// The single active entry intent for a coin, in the agent's reasoning frame: current band
// (target/invalidate/chase-cap as both prices and % from the live price), the original BUY
// thesis, age/TTL, current band source, and the full band-change history.
function getEntryIntent(args: Record<string, unknown>): unknown {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  const intent = getActiveIntents().find(i => i.coin === coin)
  if (!intent) return { coin, active: false, note: 'No active entry intent for this coin.' }

  priceCache.subscribe([coin])
  const now = Date.now()
  const current = priceFor(coin)
  return {
    coin,
    active: true,
    notionalUsdc: intent.notionalUsdc,
    signalPrice: intent.signalPrice,
    currentPrice: current,
    bandSource: intent.bandSource,
    planReason: intent.planReason ?? null,
    targetPrice: intent.targetPrice,
    invalidatePrice: intent.invalidatePrice,
    chaseCapPrice: intent.chaseCapPrice,
    // % the live price must still move to reach each level (negative = below current).
    toTargetPct: current != null ? pctDiff(current, intent.targetPrice) : null,
    toInvalidatePct: current != null ? pctDiff(current, intent.invalidatePrice) : null,
    toChaseCapPct: current != null ? pctDiff(current, intent.chaseCapPrice) : null,
    ageMinutes: Number(((now - intent.createdAt) / 60000).toFixed(1)),
    ttlMinutesLeft: Number(Math.max(0, (intent.expiresAt - now) / 60000).toFixed(1)),
    signal: {
      action: intent.signal.action,
      reason: intent.signal.reason,
      confidence: intent.signal.confidence ?? null,
      stop_loss_pct: intent.signal.stop_loss_pct ?? null,
      take_profit_pct: intent.signal.take_profit_pct ?? null,
    },
    bandHistory: intent.bandHistory.map(b => ({
      at: new Date(b.at).toISOString(), source: b.source, reason: b.reason ?? null,
      signalPrice: b.signalPrice, targetPrice: b.targetPrice,
      invalidatePrice: b.invalidatePrice, chaseCapPrice: b.chaseCapPrice, ttlMinutes: b.ttlMinutes,
    })),
  }
}

// Set/replace the entry band for an active intent. Percentages are relative to the LIVE
// price at apply time (re-anchored), and the TTL clock resets. This is how the agent
// "waits for a better price" or widens/tightens the window as the setup evolves.
async function setEntryBand(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  const n = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v ?? '')))
  const res = await applyAgentBand(coin, {
    pullbackPct: n(args.pullback_pct),
    invalidatePct: n(args.invalidate_pct),
    chaseCapPct: n(args.chase_cap_pct),
    ttlMinutes: n(args.ttl_minutes),
    reason: typeof args.reason === 'string' ? args.reason : undefined,
  })
  if (!res.ok) return { ok: false, error: res.error }
  const i = res.intent!
  return {
    ok: true, coin,
    band: { targetPrice: i.targetPrice, invalidatePrice: i.invalidatePrice, chaseCapPrice: i.chaseCapPrice, signalPrice: i.signalPrice },
    note: 'Band re-anchored to the live price; the watch loop now fires/cancels against these levels.',
  }
}

// Fire the deferred BUY NOW at the live price, skipping the pullback wait. Still flows
// through the normal entry_fire path, so the live gates (already-held, max positions,
// min/available USDC, fee-edge) and the approval setting are re-checked.
function fireEntryNow(args: Record<string, unknown>): unknown {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  const res = fireEntryIntent(coin)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, coin, note: 'Entry fired at market — execution re-checks all live gates and honors the approval setting.' }
}

// Abandon the deferred BUY: drop the intent and stop watching. Use when the thesis is
// broken or the setup is no longer attractive.
function cancelEntry(args: Record<string, unknown>): unknown {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  if (!getActiveIntents().some(i => i.coin === coin)) return { ok: false, error: 'No active entry intent for this coin' }
  cancelEntryIntent(coin, 'agent')
  return { ok: true, coin, note: 'Entry intent cancelled.' }
}

// ── Type D position-monitor tools ─────────────────────────────────────────────
// Added for the agentic Type D monitor (agent/monitorD.ts), but registered on the
// shared belt so the chat agent can call them too. All read-only.

// Recent OHLCV candles. Cache-first by design: getOHLCV reads the local `ohlcv_cache`
// collection and only backfills the gap from the exchange API when a bar is missing
// or stale, then persists it — so repeated calls within a candle don't re-hit Binance.
async function getCandleData(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  if (!isTradeable(coin)) return { error: `${coin} is not a tradeable market.` }

  const tfRaw = String(args.timeframe ?? '1h')
  const tf = priceCache.isTimeframe(tfRaw) ? tfRaw : '1h'
  const limit = clampLimit(args.limit, 50, 200)

  try {
    // STUB-SHAPED but real: getOHLCV is the single cache-first/backfill choke point.
    //   1. look up `ohlcv_cache` for (coin, tf) locally
    //   2. if absent/stale → fetch the missing window from the exchange and upsert it
    //   3. return the merged series
    const candles = await priceCache.getOHLCV(coin, tf, limit)
    if (!candles.length) return { coin, timeframe: tf, error: 'No candle data available yet.' }
    return {
      coin,
      timeframe: tf,
      count: candles.length,
      // [openTime, open, high, low, close, volume] tuples, oldest → newest.
      candles: candles.map(c => ({
        t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
      })),
      source: 'cache-first (local ohlcv_cache, backfilled from exchange on miss)',
    }
  } catch (err) {
    return { coin, timeframe: tf, error: `Candle fetch failed: ${(err as Error).message}` }
  }
}

// Past performance for one coin: realized PnL across executed trades plus the recent
// monitor verdict history, so Type D can judge how this position has been managed.
async function getPositionHistory(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }

  const tradeRows = await trades.find(
    { coin, status: 'EXECUTED' },
    { sort: { created_at: -1 }, limit: 50, projection: { _id: 0, side: 1, quantity: 1, price: 1, total: 1, fee_cost: 1, created_at: 1 } },
  ) as { side: string; quantity: number; price: number; total: number; fee_cost: number | null; created_at: string }[]

  // Simple fee-aware realized tally: SELL proceeds − BUY cost − fees. A coarse proxy
  // for "has trading this coin made money?", not the per-lot netRealizedPnl ledger.
  let buyCost = 0, sellProceeds = 0, fees = 0
  for (const t of tradeRows) {
    if (t.side === 'BUY') buyCost += t.total
    else if (t.side === 'SELL') sellProceeds += t.total
    fees += t.fee_cost ?? 0
  }
  const realizedPnl = Number((sellProceeds - buyCost - fees).toFixed(2))

  const reviews = (await getReviews(8)).filter(r => r.coin === coin)
  return {
    coin,
    tradeCount: tradeRows.length,
    realizedPnlUsd: realizedPnl,
    feesPaidUsd: Number(fees.toFixed(2)),
    recentTrades: tradeRows.slice(0, 10),
    recentReviews: reviews.map(r => ({ action: r.action, confidence: r.confidence, reasoning: snippet(r.reasoning, 200), at: r.created_at })),
  }
}

// The persistent per-coin monitor note — the position monitor's own memory across
// reviews (what it decided last time and why, what it's watching for). Gives Type D
// continuity so it doesn't re-reason from scratch or flip-flop versus its past self.
async function getCoinNotes(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  const row = await monitorNotes.findOne({ _id: coin }, { projection: { notes: 1, updated_at: 1 } }) as { notes?: string; updated_at?: string } | null
  if (!row?.notes) return { coin, notes: null, note: 'No stored note for this coin yet.' }
  return { coin, notes: row.notes, updated_at: row.updated_at ?? null }
}

// Recent news / market sentiment for a coin. Runs the SAME researcher (Puppeteer/
// DuckDuckGo) → extractor (LLM sentiment compression) chain the entry pipeline uses, so
// the agent gets live, article-level sentiment. This is a heavy multi-second crawl + LLM
// pass (per-URL extraction is cached in extraction_cache, so repeats are cheaper).
async function getCoinSentiment(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  if (!isTradeable(coin)) return { error: `${coin} is a fiat/stablecoin, not a tradeable market.` }

  try {
    const raw = await researchCoin(coin)
    const extracted = await extractResearch(raw)
    const articles = extracted.articles.filter(a => !a.skip_reason)
    if (!articles.length) {
      return { coin, aggregated_sentiment: extracted.aggregated_sentiment, article_count: 0, note: 'No usable articles found in this crawl.' }
    }
    return {
      coin,
      aggregated_sentiment: extracted.aggregated_sentiment,
      article_count: articles.length,
      top_headlines: extracted.top_headlines.slice(0, 8),
      articles: articles
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, 6)
        .map(a => ({
          title: a.title,
          sentiment: a.sentiment,
          relevance: a.relevance_score,
          signal: a.preliminary_signal ?? null,
          summary: snippet(a.summary, 240),
          key_points: (a.key_points ?? []).slice(0, 3),
        })),
    }
  } catch (err) {
    logger.warn('Agent get_coin_sentiment crawl failed', { coin, error: (err as Error).message })
    return { coin, error: `Sentiment crawl failed: ${(err as Error).message}` }
  }
}

// ── Agent Signal long-term per-coin memory ─────────────────────────────────────
// The Agent Signal engine keeps one memory doc per coin (_id = coin): structured fields
// (thesis / conviction % / key levels / last verdict) it rewrites each run, plus a freeform
// notes log it appends to. This upsert is shared by the `remember_signal` tool AND the engine
// itself (so memory persists even if the model never calls the tool). Newest notes last.
const SIGNAL_NOTES_CAP = 50

export async function upsertSignalMemory(coin: string, patch: {
  thesis?: string | null
  conviction?: number | null
  support?: number | null
  resistance?: number | null
  last_action?: 'BUY' | 'HOLD' | null
  note?: string | null
}): Promise<SignalMemory> {
  const now = nowSql()
  const existing = await agentSignalMemory.findOne({ _id: coin }) as Partial<SignalMemory> | null
  const notes = Array.isArray(existing?.notes) ? [...existing!.notes!] : []
  const trimmedNote = typeof patch.note === 'string' ? patch.note.trim().slice(0, 500) : ''
  if (trimmedNote) {
    notes.push({ at: now, text: trimmedNote })
    if (notes.length > SIGNAL_NOTES_CAP) notes.splice(0, notes.length - SIGNAL_NOTES_CAP)
  }
  // Only overwrite a structured field when the caller supplied it (undefined = keep prior).
  const keep = <T>(next: T | undefined, prev: T | null | undefined): T | null =>
    next !== undefined ? next : (prev ?? null)
  const doc: SignalMemory = {
    coin,
    thesis: keep(patch.thesis, existing?.thesis),
    conviction: keep(patch.conviction, existing?.conviction),
    support: keep(patch.support, existing?.support),
    resistance: keep(patch.resistance, existing?.resistance),
    last_action: keep(patch.last_action, existing?.last_action),
    last_reviewed_at: patch.last_action !== undefined ? now : (existing?.last_reviewed_at ?? null),
    notes,
    updated_at: now,
  }
  await agentSignalMemory.upsert(coin, doc)
  return doc
}

// Read the agent's long-term memory for one coin (its own thesis/conviction/levels/notes).
async function recallSignalMemory(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  const row = await agentSignalMemory.findOne({ _id: coin }, { projection: { _id: 0 } }) as SignalMemory | null
  if (!row) return { coin, memory: null, note: 'No stored memory for this coin yet — this is your first review of it.' }
  return {
    coin,
    thesis: row.thesis ?? null,
    conviction: row.conviction ?? null,
    support: row.support ?? null,
    resistance: row.resistance ?? null,
    last_action: row.last_action ?? null,
    last_reviewed_at: row.last_reviewed_at ?? null,
    recent_notes: (row.notes ?? []).slice(-8),
  }
}

// Write/append to the agent's long-term memory for one coin.
async function rememberSignal(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  const toNum = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : undefined
  }
  const toStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const saved = await upsertSignalMemory(coin, {
    thesis: toStr(args.thesis),
    conviction: toNum(args.conviction),
    support: toNum(args.support),
    resistance: toNum(args.resistance),
    note: toStr(args.note),
  })
  logger.info('Agent Signal memory updated via tool', { coin })
  return { saved: true, coin, thesis: saved.thesis, conviction: saved.conviction, notes_count: saved.notes.length }
}

// The agent's own recent BUY/HOLD verdicts for a coin (from agent_signal_runs), for continuity.
async function getCoinSignalHistory(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "BTC".' }
  const limit = clampLimit(args.limit, 8, 30)
  const rows = await agentSignalRuns.find(
    { coin },
    { sort: { id: -1 }, limit, projection: { _id: 0, action: 1, confidence: 1, conviction: 1, thesis: 1, reasoning: 1, rejected: 1, created_at: 1 } },
  ) as Record<string, unknown>[]
  return {
    coin,
    count: rows.length,
    runs: rows.map(r => ({
      action: r.action,
      confidence: r.confidence,
      conviction: r.conviction ?? null,
      thesis: snippet(r.thesis, 200),
      reasoning: snippet(r.reasoning, 200),
      rejected: !!r.rejected,
      at: r.created_at,
    })),
  }
}

// ── safe-action tools ────────────────────────────────────────────────────────

async function addToWatchlist(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin, e.g. "SOL".' }
  if (!isTradeable(coin)) return { error: `${coin} is a fiat/stablecoin and can't be watched.` }
  const s = getSettings()
  if (s.watchlist.includes(coin)) return { added: false, reason: 'already on watchlist', watchlist: s.watchlist }
  const next = [...s.watchlist, coin]
  await updateSetting('watchlist', JSON.stringify(next))
  priceCache.subscribe([coin])
  bus.emit('settings_updated', getSettings())
  logger.info('Agent added coin to watchlist', { coin })
  return { added: true, coin, watchlist: next }
}

async function removeFromWatchlist(args: Record<string, unknown>): Promise<unknown> {
  const coin = normalizeCoin(args.coin)
  if (!coin) return { error: 'Provide a coin to remove.' }
  const s = getSettings()
  if (!s.watchlist.includes(coin)) return { removed: false, reason: 'not on watchlist', watchlist: s.watchlist }
  const next = s.watchlist.filter(c => c !== coin)
  await updateSetting('watchlist', JSON.stringify(next))
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
    name: 'list_llm_calls',
    description: 'Inspect recent LLM calls for debugging (newest first): which module/model/endpoint ran, token counts, duration, queue wait, whether it errored or made tool calls, and a truncated response. Filter by module (e.g. "analyst", "extractor", "monitor", "discoverer", "summary", "agent"), coin, or errors only. Use get_llm_call for the full prompt/response.',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Optional module filter, e.g. "analyst" or "monitor".' },
        coin: { type: 'string', description: 'Optional coin filter, e.g. "BTC".' },
        errors_only: { type: 'boolean', description: 'If true, only return calls that errored.' },
        limit: { type: 'number', description: 'How many (default 15, max 50).' },
      },
      required: [],
    },
    readOnly: true,
    handler: listLlmCalls,
  },
  {
    name: 'get_llm_call',
    description: 'Get the full detail of a single LLM call by its id (from list_llm_calls): system prompt, user prompt, full response, reasoning/thinking content, tool calls, error and token/timing metrics. Use this to debug exactly what an engine asked the model and what it answered.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The LLM call id from list_llm_calls.' } },
      required: ['id'],
    },
    readOnly: true,
    handler: getLlmCall,
  },
  {
    name: 'get_entry_intents',
    description: 'List the Entry Desk\'s currently active entry intents: deferred BUYs the entry-timing engine is watching, with the notional, signal/current/target/invalidate/chase-cap prices, how far price must move to each level, confidence, age and TTL remaining.',
    parameters: NO_ARGS,
    readOnly: true,
    handler: getEntryIntents,
  },
  {
    name: 'list_entry_events',
    description: 'List Entry Desk history (newest first): registered / filled / cancelled entry-intent events with the reason (pullback, expiry-market, falling_knife, ran_away, expired, manual), signal/target/fill prices and slippage %. Optionally filter by coin or event type.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Optional coin filter, e.g. "SOL".' },
        type: { type: 'string', description: 'Optional event type: "registered", "filled" or "cancelled".' },
        limit: { type: 'number', description: 'How many (default 20, max 100).' },
      },
      required: [],
    },
    readOnly: true,
    handler: listEntryEvents,
  },
  {
    name: 'get_entry_intent',
    description: "Get the single active entry intent for a coin in the Entry Agent's working frame: the current band (target/invalidate/chase-cap as prices AND % from the live price), the original BUY thesis, notional, age, TTL remaining, current band source, and the full band-change history. Call this FIRST so you adapt the existing window instead of starting blind.",
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' } },
      required: ['coin'],
    },
    readOnly: true,
    handler: getEntryIntent,
  },
  {
    name: 'set_entry_band',
    description: 'Set/replace the entry band for an active intent. All four percentages are relative to the LIVE price at apply time (the levels re-anchor to "now") and the TTL clock resets. invalidate_pct must be greater than pullback_pct. Use to wait for a deeper dip, tighten/loosen the window, or extend the TTL as the setup evolves. Returns the resolved prices.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' },
        pullback_pct: { type: 'number', description: 'Buy target as % BELOW the live price (0 = buy at market).' },
        invalidate_pct: { type: 'number', description: 'Cancel if price drops this % below the live price (must be > pullback_pct).' },
        chase_cap_pct: { type: 'number', description: 'Cancel if price runs this % above the live price.' },
        ttl_minutes: { type: 'number', description: 'How long the intent stays live before expiry, in minutes.' },
        reason: { type: 'string', description: 'One-line rationale for these levels (shown on the Entry Desk).' },
      },
      required: ['coin', 'pullback_pct', 'invalidate_pct', 'chase_cap_pct', 'ttl_minutes'],
    },
    readOnly: false,
    handler: setEntryBand,
  },
  {
    name: 'fire_entry_now',
    description: 'Fire the deferred BUY NOW at the live price, skipping the pullback wait. Use when the entry is good right now (e.g. a strong breakout you should not wait to dip-buy). Execution re-checks all live gates and honors the approval setting. This consumes the intent.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' },
        reason: { type: 'string', description: 'Why fire now (for the transcript).' },
      },
      required: ['coin'],
    },
    readOnly: false,
    handler: fireEntryNow,
  },
  {
    name: 'cancel_entry',
    description: 'Abandon the deferred BUY: drop the intent and stop watching. Use when the thesis is broken or the setup is no longer attractive (don\'t force a trade). This consumes the intent.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' },
        reason: { type: 'string', description: 'Why cancel (for the transcript).' },
      },
      required: ['coin'],
    },
    readOnly: false,
    handler: cancelEntry,
  },
  {
    name: 'get_candle_data',
    description: 'Fetch recent OHLCV candles for one coin (cache-first: reads the local candle store and only backfills missing bars from the exchange). Returns oldest→newest tuples. Use to read price structure, momentum and volatility for a position.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Coin symbol, e.g. "BTC" or "BTC/USDC".' },
        timeframe: { type: 'string', description: 'Candle timeframe, e.g. "5m", "15m", "1h", "4h", "1d" (default "1h").' },
        limit: { type: 'number', description: 'How many candles (default 50, max 200).' },
      },
      required: ['coin'],
    },
    readOnly: true,
    handler: getCandleData,
  },
  {
    name: 'get_position_history',
    description: "Get a coin's past performance: realized P&L and fees across executed trades, recent trades, and recent monitor verdicts. Use to judge how this position has been managed before deciding to hold/adjust/close.",
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' } },
      required: ['coin'],
    },
    readOnly: true,
    handler: getPositionHistory,
  },
  {
    name: 'get_coin_sentiment',
    description: 'Gather LIVE news & market sentiment for a coin: crawls the web (DuckDuckGo) and runs LLM extraction to return an aggregated sentiment, top headlines, and per-article sentiment/relevance/summary. Heavy (several seconds); call once per coin. Use to weigh narrative/news risk against the chart.',
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' } },
      required: ['coin'],
    },
    readOnly: true,
    handler: getCoinSentiment,
  },
  {
    name: 'get_coin_notes',
    description: "Read the position monitor's persistent note for a coin — its own memory from prior reviews (what it decided and why, what it's watching). Use for continuity and to avoid flip-flopping against past decisions.",
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' } },
      required: ['coin'],
    },
    readOnly: true,
    handler: getCoinNotes,
  },
  {
    name: 'recall_signal_memory',
    description: "Read the Agent Signal engine's long-term memory for a coin: its latest thesis, conviction % (0–100), key support/resistance levels, last verdict, and a log of recent notes-to-self. Call this FIRST so you build on your past reasoning instead of starting from scratch.",
    parameters: {
      type: 'object',
      properties: { coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' } },
      required: ['coin'],
    },
    readOnly: true,
    handler: recallSignalMemory,
  },
  {
    name: 'remember_signal',
    description: 'Persist or update your long-term memory for a coin: set the thesis, conviction (0–100), and key support/resistance price levels, and/or append a short note to your future self. Call before committing your verdict so the next review has continuity. Safe, non-trading action.',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' },
        thesis: { type: 'string', description: 'One-paragraph thesis / strategy for this coin.' },
        conviction: { type: 'number', description: 'Conviction in the thesis, 0–100.' },
        support: { type: 'number', description: 'Key support price level.' },
        resistance: { type: 'number', description: 'Key resistance price level.' },
        note: { type: 'string', description: 'Short memo (≤500 chars) appended to the running notes log.' },
      },
      required: ['coin'],
    },
    readOnly: false,
    handler: rememberSignal,
  },
  {
    name: 'get_coin_signal_history',
    description: "List your own recent BUY/HOLD verdicts for a coin (the Agent Signal engine's past runs) with thesis and confidence, so you can see how your read has evolved and avoid flip-flopping against your past self.",
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Coin symbol, e.g. "BTC".' },
        limit: { type: 'number', description: 'How many (default 8, max 30).' },
      },
      required: ['coin'],
    },
    readOnly: true,
    handler: getCoinSignalHistory,
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

// The curated belt the Type D agentic monitor exposes to its model: only the
// position-evaluation reads it needs to reach a Hold/Adjust/Close verdict. It is
// deliberately a SUBSET — Type D must never trigger engines or mutate the watchlist
// mid-review, so the trigger_*/watchlist tools are excluded.
export const MONITOR_D_TOOL_NAMES = [
  'get_portfolio', 'list_open_positions', 'get_market', 'get_candle_data',
  'get_position_history', 'get_coin_sentiment', 'get_coin_notes', 'list_position_reviews',
  'list_recent_trades', 'list_recent_signals',
] as const

// The curated belt the Agent Signal engine exposes per coin: the evidence reads it needs to
// decide BUY/HOLD plus its own long-term memory (read + write). Deliberately coin-scoped —
// it must never trigger engines or mutate the watchlist mid-review, so those tools are excluded.
export const AGENT_SIGNAL_TOOL_NAMES = [
  'get_market', 'get_candle_data', 'get_coin_sentiment', 'get_position_history',
  'list_recent_signals', 'recall_signal_memory', 'remember_signal', 'get_coin_signal_history',
] as const

// The curated belt the Entry Agent exposes per active intent: the live-market reads it needs
// to time an entry, the Agent Signal thesis/memory for the coin, this intent's own state — plus
// the three ACTION tools (set band / fire / cancel) that let it drive the deferred BUY. It must
// never trigger engines or mutate the watchlist mid-pass, so those tools are excluded.
export const ENTRY_AGENT_TOOL_NAMES = [
  'get_entry_intent', 'get_market', 'get_candle_data', 'get_coin_sentiment',
  'recall_signal_memory', 'get_coin_signal_history', 'list_recent_signals', 'list_entry_events',
  'set_entry_band', 'fire_entry_now', 'cancel_entry',
] as const

export function isReadOnlyTool(name: string): boolean {
  return TOOL_MAP.get(name)?.readOnly ?? true
}

/** OpenAI `tools` array built from the registry. Pass `only` to expose a subset
 *  (e.g. the Type D monitor belt); omit it for the full chat-agent belt. */
export function getToolSchemas(only?: readonly string[]): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}[] {
  const set = only ? new Set(only) : null
  return TOOLS.filter(t => !set || set.has(t.name)).map(t => ({
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
