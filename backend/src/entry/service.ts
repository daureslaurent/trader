import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import * as priceCache from '../market/index.js'
import { getSettings } from '../db/index.js'
import { getMarketContext } from '../portfolio/index.js'
import { Signal, BotSettings, MarketContext } from '../types.js'
import { EntryBand, planEntry, resolveEntryBand } from '../entryPlanner/index.js'
import { EntryIntent, EntryEvent, BandSnapshot, CancelReason, FillTrigger } from './types.js'
import * as store from './store.js'

// One active intent per coin. Short-lived (≤ entry_ttl_minutes). Mirrored to the
// entry_intents table and rehydrated on startup, so a restart resumes watching
// rather than dropping the deferred BUY.
const intents = new Map<string, EntryIntent>()
// Recent activity (newest first), backing the Entry Desk feed. Persisted to
// entry_events and reloaded on startup; this is an in-session cache of that log.
const recentEvents: EntryEvent[] = []
const MAX_EVENTS = 100
// Caps unbounded growth from repeated "Refresh LLM" clicks on a long-lived intent.
const MAX_BAND_HISTORY = 20
let timer: ReturnType<typeof setInterval> | null = null

export function hasActiveIntent(coin: string): boolean {
  return intents.has(coin)
}

export function getActiveIntents(): EntryIntent[] {
  return [...intents.values()]
}

export function getRecentEvents(): EntryEvent[] {
  return recentEvents
}

function recordEvent(ev: Omit<EntryEvent, 'id' | 'at'>): void {
  const now = Date.now()
  // Random suffix keeps the id unique (it's the PK) even for same-coin/-type/-ms events.
  const id = `${now.toString(36)}-${ev.coin}-${ev.type}-${Math.random().toString(36).slice(2, 6)}`
  const event: EntryEvent = { ...ev, id, at: now }
  recentEvents.unshift(event)
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS
  store.saveEvent(event)
  broadcast('entry_event', event)
}

interface RegisterParams {
  signal: Signal
  signalPrice: number
  notionalUsdc: number
  atr: number
  /** The resolved entry band (LLM plan or static settings) — see resolveEntryBand. */
  band: EntryBand
  /** Market context the band decision was made from, kept on the intent for the Entry Desk detail view. */
  market: MarketContext
}

export function register({ signal, signalPrice, notionalUsdc, atr, band, market }: RegisterParams): void {
  const coin = signal.coin
  if (intents.has(coin)) {
    logger.debug('Entry intent already active, skipping register', { coin })
    return
  }

  const now = Date.now()
  const intent: EntryIntent = {
    id: `${now.toString(36)}-${coin}`,
    coin,
    signal,
    signalPrice,
    targetPrice: signalPrice * (1 - band.pullbackPct / 100),
    invalidatePrice: signalPrice * (1 - band.invalidatePct / 100),
    chaseCapPrice: signalPrice * (1 + band.chaseCapPct / 100),
    notionalUsdc,
    atr,
    bandSource: band.source,
    planReason: band.reason,
    createdAt: now,
    expiresAt: now + band.ttlMinutes * 60_000,
    bandHistory: [],
  }
  intent.bandHistory = [{
    at: now, source: band.source, signalPrice,
    targetPrice: intent.targetPrice, invalidatePrice: intent.invalidatePrice, chaseCapPrice: intent.chaseCapPrice,
    ttlMinutes: band.ttlMinutes, reason: band.reason, market,
  }]

  intents.set(coin, intent)
  store.saveIntent(intent)
  priceCache.subscribe([coin]) // ensure the feed covers this coin even if off-watchlist
  logger.info('Entry intent registered', {
    coin, signalPrice, target: intent.targetPrice,
    invalidate: intent.invalidatePrice, chaseCap: intent.chaseCapPrice,
    expiresInMin: band.ttlMinutes, bandSource: band.source, planReason: band.reason,
  })
  recordEvent({ coin, type: 'registered', signalPrice, targetPrice: intent.targetPrice })
  broadcastIntents()
}

export interface ReplanResult {
  ok: boolean
  error?: string
  intent?: EntryIntent
}

/**
 * Re-run the Entry Planner LLM for an active intent and re-materialize its band
 * on the *current live price* (the Entry Desk "Refresh LLM" button). The new plan
 * fully replaces the window — levels are re-anchored to the live price and the
 * TTL is reset. On any failure (planner disabled, no live price, market-data or
 * LLM error, unusable output) the existing intent is left untouched and an error
 * is returned, so a refresh can never degrade a good band into the static one.
 */
export async function replan(coin: string): Promise<ReplanResult> {
  const intent = intents.get(coin)
  if (!intent) return { ok: false, error: 'No active entry intent for this coin' }

  const settings = getSettings()
  if (!settings.entry_planner_enabled) {
    return { ok: false, error: 'Entry Planner is disabled — enable LLM-decided entry levels in Settings' }
  }

  const snap = priceCache.getPrice(coin)
  if (!snap || !(snap.price > 0)) {
    return { ok: false, error: 'No live price available for this coin yet' }
  }
  const livePrice = snap.price

  let market
  try {
    market = await getMarketContext(coin, livePrice)
  } catch (err) {
    logger.warn('Entry replan: failed to build market context', { coin, error: (err as Error).message })
    return { ok: false, error: 'Failed to fetch live market data' }
  }

  const plan = await planEntry({
    coin, price: livePrice, market, signal: intent.signal,
    candleTf: settings.entry_planner_candle_tf, candleCount: settings.entry_planner_candle_count,
  })
  if (!plan) {
    return { ok: false, error: 'Entry Planner returned no usable levels — try again' }
  }

  // plan is non-null, so resolveEntryBand yields an 'llm' band.
  const band = resolveEntryBand(plan, settings)
  const now = Date.now()
  const targetPrice = livePrice * (1 - band.pullbackPct / 100)
  const invalidatePrice = livePrice * (1 - band.invalidatePct / 100)
  const chaseCapPrice = livePrice * (1 + band.chaseCapPct / 100)
  const snapshot: BandSnapshot = {
    at: now, source: band.source, signalPrice: livePrice,
    targetPrice, invalidatePrice, chaseCapPrice,
    ttlMinutes: band.ttlMinutes, reason: band.reason, market,
  }
  const updated: EntryIntent = {
    ...intent,
    signalPrice: livePrice,
    targetPrice,
    invalidatePrice,
    chaseCapPrice,
    atr: market.atr14, // refresh ATR too — it feeds SL/TP sizing at fill
    bandSource: band.source,
    planReason: band.reason,
    expiresAt: now + band.ttlMinutes * 60_000,
    bandHistory: [...intent.bandHistory, snapshot].slice(-MAX_BAND_HISTORY),
  }

  intents.set(coin, updated)
  store.saveIntent(updated)
  logger.info('Entry intent re-planned by user', {
    coin, signalPrice: livePrice, target: updated.targetPrice,
    invalidate: updated.invalidatePrice, chaseCap: updated.chaseCapPrice,
    ttlMinutes: band.ttlMinutes, planReason: band.reason,
  })
  broadcastIntents()
  return { ok: true, intent: updated }
}

/**
 * User clicked "Validate & open position" on the Entry Desk: stop waiting for a
 * pullback and fire the deferred BUY *now* at the current live price. Execution
 * still flows through the normal entry_fire path, so the live gates (already-held,
 * max positions, min/available USDC, fee-edge) are re-checked and the approval
 * setting is honored — this only skips the band-watching, not the safety net.
 */
export function fireNow(coin: string): { ok: boolean; error?: string } {
  const intent = intents.get(coin)
  if (!intent) return { ok: false, error: 'No active entry intent for this coin' }

  const snap = priceCache.getPrice(coin)
  if (!snap || !(snap.price > 0)) {
    return { ok: false, error: 'No live price available for this coin yet' }
  }

  logger.info('Entry intent validated by user — firing now', { coin, price: snap.price })
  fire(intent, snap.price, 'manual')
  return { ok: true }
}

export interface IntentEdit {
  targetPrice?: number
  invalidatePrice?: number
  chaseCapPrice?: number
  /** New time-to-live in minutes, measured from now (resets the expiry clock). */
  ttlMinutes?: number
  notionalUsdc?: number
}

/**
 * Manually override an active intent's entry window from the Entry Desk. Levels
 * are absolute prices; any omitted field keeps its current value. Validates the
 * band ordering (invalidate < target < chase cap) and positivity, then flags the
 * band as user-set ('manual') and re-broadcasts. The next evaluate() tick acts on
 * the new levels — e.g. a target at/above the live price fills immediately.
 */
export function updateIntent(coin: string, edit: IntentEdit): { ok: boolean; error?: string; intent?: EntryIntent } {
  const intent = intents.get(coin)
  if (!intent) return { ok: false, error: 'No active entry intent for this coin' }

  const target = edit.targetPrice ?? intent.targetPrice
  const invalidate = edit.invalidatePrice ?? intent.invalidatePrice
  const chaseCap = edit.chaseCapPrice ?? intent.chaseCapPrice
  if (!(target > 0) || !(invalidate > 0) || !(chaseCap > 0)) {
    return { ok: false, error: 'Prices must be positive numbers' }
  }
  if (!(invalidate < target)) return { ok: false, error: 'Invalidate price must be below the buy target' }
  if (!(chaseCap > target)) return { ok: false, error: 'Chase cap must be above the buy target' }

  let notionalUsdc = intent.notionalUsdc
  if (edit.notionalUsdc != null) {
    if (!(edit.notionalUsdc > 0)) return { ok: false, error: 'Notional must be a positive number' }
    notionalUsdc = edit.notionalUsdc
  }

  let expiresAt = intent.expiresAt
  if (edit.ttlMinutes != null) {
    if (!(edit.ttlMinutes > 0)) return { ok: false, error: 'TTL must be a positive number of minutes' }
    expiresAt = Date.now() + edit.ttlMinutes * 60_000
  }

  const now = Date.now()
  const snapshot: BandSnapshot = {
    at: now, source: 'manual', signalPrice: intent.signalPrice,
    targetPrice: target, invalidatePrice: invalidate, chaseCapPrice: chaseCap,
    ttlMinutes: Math.max(0, (expiresAt - now) / 60_000),
  }
  const updated: EntryIntent = {
    ...intent,
    targetPrice: target,
    invalidatePrice: invalidate,
    chaseCapPrice: chaseCap,
    notionalUsdc,
    expiresAt,
    bandSource: 'manual',
    planReason: undefined,
    bandHistory: [...intent.bandHistory, snapshot].slice(-MAX_BAND_HISTORY),
  }

  intents.set(coin, updated)
  store.saveIntent(updated)
  logger.info('Entry intent edited by user', {
    coin, target, invalidate, chaseCap, notionalUsdc, expiresAt,
  })
  broadcastIntents()
  return { ok: true, intent: updated }
}

export function cancel(coin: string, reason: CancelReason, price?: number): void {
  const intent = intents.get(coin)
  if (!intents.delete(coin)) return
  store.deleteIntent(coin)
  logger.info('Entry intent cancelled', { coin, reason, price })
  if (intent) {
    recordEvent({
      coin, type: 'cancelled', reason, signalPrice: intent.signalPrice, targetPrice: intent.targetPrice, price,
      signal: intent.signal, bandHistory: intent.bandHistory,
    })
  }
  broadcastIntents()
}

function broadcastIntents(): void {
  broadcast('entry_intent_update', { intents: getActiveIntents() })
}

function fire(intent: EntryIntent, price: number, trigger: FillTrigger): void {
  intents.delete(intent.coin)
  store.deleteIntent(intent.coin)
  const quantity = price > 0 ? intent.notionalUsdc / price : 0
  const slippagePct = intent.signalPrice > 0 ? ((intent.signalPrice - price) / intent.signalPrice) * 100 : 0
  logger.info('Entry intent fired', { coin: intent.coin, trigger, price, quantity, slippagePct })
  recordEvent({
    coin: intent.coin, type: 'filled', reason: trigger, signalPrice: intent.signalPrice, targetPrice: intent.targetPrice, price, slippagePct,
    signal: intent.signal, bandHistory: intent.bandHistory,
  })
  // Execution stays in index.ts (the single trade chokepoint) — it re-checks live
  // gates and honors the approval setting.
  bus.emit('entry_fire', { signal: { ...intent.signal, quantity }, price, atr: intent.atr })
  broadcastIntents()
}

function evaluate(): void {
  if (intents.size === 0) return
  const now = Date.now()
  const settings = getSettings()

  for (const intent of [...intents.values()]) {
    const snap = priceCache.getPrice(intent.coin)
    if (!snap) continue
    const price = snap.price

    // Ordered so a gap-down past target is caught as a crash, not bought.
    if (price <= intent.invalidatePrice) {
      cancel(intent.coin, 'falling_knife', price)
    } else if (price <= intent.targetPrice) {
      fire(intent, price, 'pullback')
    } else if (price >= intent.chaseCapPrice) {
      cancel(intent.coin, 'ran_away', price)
    } else if (now >= intent.expiresAt) {
      if (settings.entry_on_expiry === 'market') fire(intent, price, 'expiry-market')
      else cancel(intent.coin, 'expired', price)
    }
  }
}

export async function start(settings: BotSettings): Promise<void> {
  if (timer) return

  // Rehydrate from disk so a restart resumes where it left off. The activity feed
  // is reloaded for the Entry Desk; persisted intents go back into the watch Map
  // and re-subscribe the price feed. evaluate() reconciles each on the next tick —
  // a window that lapsed during downtime is handled by the normal expiry rule.
  recentEvents.length = 0
  recentEvents.push(...(await store.loadRecentEvents()))

  const persisted = await store.loadIntents()
  if (persisted.length > 0) {
    for (const intent of persisted) intents.set(intent.coin, intent)
    priceCache.subscribe(persisted.map(i => i.coin))
    broadcastIntents()
    logger.info('Entry intents rehydrated', { count: persisted.length, coins: persisted.map(i => i.coin) })
  }

  const intervalMs = Math.max(1, settings.entry_poll_seconds) * 1000
  timer = setInterval(evaluate, intervalMs)
  logger.info('Entry timing engine started', { pollSeconds: settings.entry_poll_seconds })
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null }
  intents.clear()
}
