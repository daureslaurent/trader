import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import * as priceCache from '../market/index.js'
import { getSettings } from '../db/index.js'
import { getMarketContext } from '../portfolio/index.js'
import { Signal, BotSettings, MarketContext } from '../types.js'
import { EntryBand, EntryIntent, EntryEvent, BandSnapshot, CancelReason, FillTrigger } from './types.js'
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

/**
 * Clamp a chosen TTL (minutes) to the global `entry_max_ttl_minutes` ceiling. Applied
 * to every TTL source — static band, Entry Agent, manual edit — so no intent can outlive
 * the cap regardless of who picked the band. A cap of 0 (or non-positive) disables it.
 */
function capTtl(ttlMinutes: number): number {
  const cap = getSettings().entry_max_ttl_minutes
  return cap > 0 ? Math.min(ttlMinutes, cap) : ttlMinutes
}

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
  /** The initial entry band — the static settings band (or an Agent-Signal-seeded band). The
   *  Entry Agent re-anchors this on its first/subsequent passes via applyAgentBand. */
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
  const ttlMinutes = capTtl(band.ttlMinutes)
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
    expiresAt: now + ttlMinutes * 60_000,
    armed: false,
    troughPrice: undefined,
    bandHistory: [],
  }
  intent.bandHistory = [{
    at: now, source: band.source, signalPrice,
    targetPrice: intent.targetPrice, invalidatePrice: intent.invalidatePrice, chaseCapPrice: intent.chaseCapPrice,
    ttlMinutes, reason: band.reason, market,
  }]

  intents.set(coin, intent)
  store.saveIntent(intent)
  priceCache.subscribe([coin]) // ensure the feed covers this coin even if off-watchlist
  logger.info('Entry intent registered', {
    coin, signalPrice, target: intent.targetPrice,
    invalidate: intent.invalidatePrice, chaseCap: intent.chaseCapPrice,
    expiresInMin: ttlMinutes, bandSource: band.source, planReason: band.reason,
  })
  recordEvent({ coin, type: 'registered', signalPrice, targetPrice: intent.targetPrice })
  broadcastIntents()
}

export interface ApplyBandResult {
  ok: boolean
  error?: string
  intent?: EntryIntent
}

/**
 * Apply an Entry-Agent-chosen band to an active intent, re-materializing its window
 * on the *current live price*. Used by the `set_entry_band` agent tool: the band's
 * percentages are re-anchored to the live price, ATR + TTL are refreshed, and a
 * `BandSnapshot` (source 'agent') is appended to the history. On any failure (no
 * active intent, no live price, market-data error) the intent is left untouched and
 * an error is returned, so a bad pass can never degrade a good band.
 *
 * Pass only the four percentages + a reason; this re-anchors to the live price (the
 * agent reasons in % relative to "now", exactly like the static band at registration).
 */
export async function applyAgentBand(
  coin: string,
  band: { pullbackPct: number; invalidatePct: number; chaseCapPct: number; ttlMinutes: number; reason?: string },
): Promise<ApplyBandResult> {
  const intent = intents.get(coin)
  if (!intent) return { ok: false, error: 'No active entry intent for this coin' }

  if (!(band.pullbackPct >= 0)) return { ok: false, error: 'pullback_pct must be >= 0' }
  if (!(band.invalidatePct > band.pullbackPct)) return { ok: false, error: 'invalidate_pct must be greater than pullback_pct' }
  if (!(band.chaseCapPct > 0)) return { ok: false, error: 'chase_cap_pct must be > 0' }
  if (!(band.ttlMinutes > 0)) return { ok: false, error: 'ttl_minutes must be > 0' }

  const snap = priceCache.getPrice(coin)
  if (!snap || !(snap.price > 0)) {
    return { ok: false, error: 'No live price available for this coin yet' }
  }
  const livePrice = snap.price

  let market: MarketContext
  try {
    market = await getMarketContext(coin, livePrice)
  } catch (err) {
    logger.warn('Entry applyAgentBand: failed to build market context', { coin, error: (err as Error).message })
    return { ok: false, error: 'Failed to fetch live market data' }
  }

  const now = Date.now()
  const ttlMinutes = capTtl(band.ttlMinutes)
  const reason = band.reason?.slice(0, 200) || 'Entry Agent band'
  const targetPrice = livePrice * (1 - band.pullbackPct / 100)
  const invalidatePrice = livePrice * (1 - band.invalidatePct / 100)
  const chaseCapPrice = livePrice * (1 + band.chaseCapPct / 100)
  const snapshot: BandSnapshot = {
    at: now, source: 'agent', signalPrice: livePrice,
    targetPrice, invalidatePrice, chaseCapPrice,
    ttlMinutes, reason, market,
  }
  const updated: EntryIntent = {
    ...intent,
    signalPrice: livePrice,
    targetPrice,
    invalidatePrice,
    chaseCapPrice,
    atr: market.atr14, // refresh ATR too — it feeds SL/TP sizing at fill
    bandSource: 'agent',
    planReason: reason,
    expiresAt: now + ttlMinutes * 60_000,
    // New levels → restart the rebound-confirmation window against them.
    armed: false,
    troughPrice: undefined,
    bandHistory: [...intent.bandHistory, snapshot].slice(-MAX_BAND_HISTORY),
  }

  intents.set(coin, updated)
  store.saveIntent(updated)
  logger.info('Entry intent band set by agent', {
    coin, signalPrice: livePrice, target: updated.targetPrice,
    invalidate: updated.invalidatePrice, chaseCap: updated.chaseCapPrice,
    ttlMinutes, reason,
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
    const cap = getSettings().entry_max_ttl_minutes
    if (cap > 0 && edit.ttlMinutes > cap) {
      return { ok: false, error: `TTL must not exceed the ${cap}-minute cap (Settings → Entry timing)` }
    }
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
    // New levels → restart the rebound-confirmation window against them.
    armed: false,
    troughPrice: undefined,
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

    // Hard boundaries first, ordered so a gap-down past target is caught as a crash, not bought:
    // the invalidate floor and the chase cap both end the intent regardless of arm state.
    if (price <= intent.invalidatePrice) {
      cancel(intent.coin, 'falling_knife', price)
      continue
    }
    if (price >= intent.chaseCapPrice) {
      cancel(intent.coin, 'ran_away', price)
      continue
    }

    if (settings.entry_confirm_rebound) {
      // Trailing rebound entry: don't buy while price is still falling. Arm on entering the buy
      // zone, track the running low, and fire only once price bounces entry_rebound_pct off that
      // low. A continued drop lowers the trough (and thus the trigger) rather than filling — until
      // it hits the invalidate floor above and cancels as a falling knife.
      if (!intent.armed && price <= intent.targetPrice) {
        // Entered the buy zone — arm and seed the trough. Live card flips to "Confirming rebound".
        intent.armed = true
        intent.troughPrice = price
        store.saveIntent(intent)
        logger.info('Entry intent armed — confirming rebound', { coin: intent.coin, price, target: intent.targetPrice })
        broadcastIntents()
      } else if (intent.armed && intent.troughPrice != null && price < intent.troughPrice) {
        // New low — trail the anchor down. Persist + broadcast so the desk shows the trough moving.
        intent.troughPrice = price
        store.saveIntent(intent)
        broadcastIntents()
      }
      if (intent.armed && intent.troughPrice != null) {
        const fireTrigger = intent.troughPrice * (1 + settings.entry_rebound_pct / 100)
        if (price >= fireTrigger) {
          fire(intent, price, 'rebound')
          continue
        }
      }
    } else if (price <= intent.targetPrice) {
      // Legacy behavior (rebound confirmation off): fill immediately at the target.
      fire(intent, price, 'pullback')
      continue
    }

    if (now >= intent.expiresAt) {
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
