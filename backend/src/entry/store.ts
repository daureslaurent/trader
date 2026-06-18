import { entryIntents, entryEvents } from '../db/index.js'
import { logger } from '../core/logger.js'
import { Signal } from '../types.js'
import { EntryIntent, EntryEvent } from './types.js'

// DB persistence for the entry-timing engine. Internal to the module — the
// service owns the in-memory state and calls these to mirror it to disk.

const MAX_EVENTS = 100

/* --------------------------------- intents --------------------------------- */

function rowToIntent(r: Record<string, unknown>): EntryIntent {
  return {
    id: r.id as string,
    coin: r.coin as string,
    signal: JSON.parse(r.signal as string) as Signal,
    signalPrice: r.signal_price as number,
    targetPrice: r.target_price as number,
    invalidatePrice: r.invalidate_price as number,
    chaseCapPrice: r.chase_cap_price as number,
    notionalUsdc: r.notional_usdc as number,
    atr: r.atr as number,
    // Older persisted intents predate the planner — default to 'static'.
    bandSource: (r.band_source === 'llm' ? 'llm' : 'static'),
    planReason: (r.plan_reason as string) || undefined,
    createdAt: r.created_at as number,
    expiresAt: r.expires_at as number,
    // Older persisted intents predate band history — default to an empty list.
    bandHistory: r.band_history ? (JSON.parse(r.band_history as string) as EntryIntent['bandHistory']) : [],
  }
}

export async function loadIntents(): Promise<EntryIntent[]> {
  try {
    return (await entryIntents.find()).map(rowToIntent)
  } catch (err) {
    logger.error('Failed to load entry intents from DB', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export async function saveIntent(intent: EntryIntent): Promise<void> {
  // Upsert keyed on the intent id; coin is also UNIQUE so the one-per-coin
  // invariant is enforced by the index as well as the service's Map.
  // Best-effort: callers fire-and-forget, so never reject (in-memory state is source of truth).
  try {
    await entryIntents.upsert(intent.id, {
      id: intent.id,
      coin: intent.coin,
      signal: JSON.stringify(intent.signal),
      signal_price: intent.signalPrice,
      target_price: intent.targetPrice,
      invalidate_price: intent.invalidatePrice,
      chase_cap_price: intent.chaseCapPrice,
      notional_usdc: intent.notionalUsdc,
      atr: intent.atr,
      band_source: intent.bandSource,
      plan_reason: intent.planReason ?? null,
      created_at: intent.createdAt,
      expires_at: intent.expiresAt,
      band_history: JSON.stringify(intent.bandHistory),
    })
  } catch (err) {
    logger.error('Failed to persist entry intent', { coin: intent.coin, error: err instanceof Error ? err.message : String(err) })
  }
}

export async function deleteIntent(coin: string): Promise<void> {
  try {
    await entryIntents.deleteMany({ coin })
  } catch (err) {
    logger.error('Failed to delete entry intent', { coin, error: err instanceof Error ? err.message : String(err) })
  }
}

/* ---------------------------------- events --------------------------------- */

function rowToEvent(r: Record<string, unknown>): EntryEvent {
  return {
    id: r.id as string,
    coin: r.coin as string,
    type: r.type as EntryEvent['type'],
    reason: (r.reason as EntryEvent['reason']) ?? undefined,
    signalPrice: r.signal_price as number,
    targetPrice: r.target_price as number,
    price: (r.price as number | null) ?? undefined,
    slippagePct: (r.slippage_pct as number | null) ?? undefined,
    at: r.created_at as number,
    signal: r.signal ? (JSON.parse(r.signal as string) as Signal) : undefined,
    bandHistory: r.band_history ? (JSON.parse(r.band_history as string) as EntryEvent['bandHistory']) : undefined,
  }
}

export async function loadRecentEvents(): Promise<EntryEvent[]> {
  try {
    return (await entryEvents.find({}, { sort: { created_at: -1 }, limit: MAX_EVENTS })).map(rowToEvent)
  } catch (err) {
    logger.error('Failed to load entry events from DB', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export async function saveEvent(event: EntryEvent): Promise<void> {
  try {
    await entryEvents.upsert(event.id, {
      id: event.id,
      coin: event.coin,
      type: event.type,
      reason: event.reason ?? null,
      signal_price: event.signalPrice,
      target_price: event.targetPrice,
      price: event.price ?? null,
      slippage_pct: event.slippagePct ?? null,
      created_at: event.at,
      signal: event.signal ? JSON.stringify(event.signal) : null,
      band_history: event.bandHistory ? JSON.stringify(event.bandHistory) : null,
    })
  } catch (err) {
    logger.error('Failed to persist entry event', { coin: event.coin, error: err instanceof Error ? err.message : String(err) })
  }
}
