import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import * as priceCache from '../market/index.js'
import { getSettings } from '../db/index.js'
import { Signal, BotSettings } from '../types.js'
import { EntryIntent, EntryEvent, CancelReason, FillTrigger } from './types.js'

// One active intent per coin. Short-lived (≤ entry_ttl_minutes) and in-memory —
// lost on restart, like pending approvals; the next cron cycle re-evaluates.
const intents = new Map<string, EntryIntent>()
// Recent activity (newest first), session-scoped for the Entry Desk feed.
const recentEvents: EntryEvent[] = []
const MAX_EVENTS = 100
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
  const event: EntryEvent = { ...ev, id: `${Date.now().toString(36)}-${ev.coin}-${ev.type}`, at: Date.now() }
  recentEvents.unshift(event)
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS
  broadcast('entry_event', event)
}

interface RegisterParams {
  signal: Signal
  signalPrice: number
  notionalUsdc: number
  atr: number
  settings: BotSettings
}

export function register({ signal, signalPrice, notionalUsdc, atr, settings }: RegisterParams): void {
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
    targetPrice: signalPrice * (1 - settings.entry_pullback_pct / 100),
    invalidatePrice: signalPrice * (1 - settings.entry_invalidate_pct / 100),
    chaseCapPrice: signalPrice * (1 + settings.entry_max_chase_pct / 100),
    notionalUsdc,
    atr,
    createdAt: now,
    expiresAt: now + settings.entry_ttl_minutes * 60_000,
  }

  intents.set(coin, intent)
  priceCache.subscribe([coin]) // ensure the feed covers this coin even if off-watchlist
  logger.info('Entry intent registered', {
    coin, signalPrice, target: intent.targetPrice,
    invalidate: intent.invalidatePrice, chaseCap: intent.chaseCapPrice,
    expiresInMin: settings.entry_ttl_minutes,
  })
  recordEvent({ coin, type: 'registered', signalPrice, targetPrice: intent.targetPrice })
  broadcastIntents()
}

export function cancel(coin: string, reason: CancelReason, price?: number): void {
  const intent = intents.get(coin)
  if (!intents.delete(coin)) return
  logger.info('Entry intent cancelled', { coin, reason, price })
  if (intent) {
    recordEvent({ coin, type: 'cancelled', reason, signalPrice: intent.signalPrice, targetPrice: intent.targetPrice, price })
  }
  broadcastIntents()
}

function broadcastIntents(): void {
  broadcast('entry_intent_update', { intents: getActiveIntents() })
}

function fire(intent: EntryIntent, price: number, trigger: FillTrigger): void {
  intents.delete(intent.coin)
  const quantity = price > 0 ? intent.notionalUsdc / price : 0
  const slippagePct = intent.signalPrice > 0 ? ((intent.signalPrice - price) / intent.signalPrice) * 100 : 0
  logger.info('Entry intent fired', { coin: intent.coin, trigger, price, quantity, slippagePct })
  recordEvent({ coin: intent.coin, type: 'filled', reason: trigger, signalPrice: intent.signalPrice, targetPrice: intent.targetPrice, price, slippagePct })
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

export function start(settings: BotSettings): void {
  if (timer) return
  const intervalMs = Math.max(1, settings.entry_poll_seconds) * 1000
  timer = setInterval(evaluate, intervalMs)
  logger.info('Entry timing engine started', { pollSeconds: settings.entry_poll_seconds })
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null }
  intents.clear()
}
