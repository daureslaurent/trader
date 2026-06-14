import { queryAll, runSQL } from '../db/index.js'
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
    createdAt: r.created_at as number,
    expiresAt: r.expires_at as number,
  }
}

export function loadIntents(): EntryIntent[] {
  try {
    return queryAll('SELECT * FROM entry_intents').map(rowToIntent)
  } catch (err) {
    logger.error('Failed to load entry intents from DB', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export function saveIntent(intent: EntryIntent): void {
  // INSERT OR REPLACE keyed on the PK; coin is also UNIQUE so the one-per-coin
  // invariant is enforced by the schema as well as the service's Map.
  runSQL(
    `INSERT OR REPLACE INTO entry_intents
       (id, coin, signal, signal_price, target_price, invalidate_price, chase_cap_price, notional_usdc, atr, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      intent.id, intent.coin, JSON.stringify(intent.signal),
      intent.signalPrice, intent.targetPrice, intent.invalidatePrice, intent.chaseCapPrice,
      intent.notionalUsdc, intent.atr, intent.createdAt, intent.expiresAt,
    ],
  )
}

export function deleteIntent(coin: string): void {
  runSQL('DELETE FROM entry_intents WHERE coin = ?', [coin])
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
  }
}

export function loadRecentEvents(): EntryEvent[] {
  try {
    return queryAll('SELECT * FROM entry_events ORDER BY created_at DESC LIMIT ?', [MAX_EVENTS]).map(rowToEvent)
  } catch (err) {
    logger.error('Failed to load entry events from DB', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export function saveEvent(event: EntryEvent): void {
  runSQL(
    `INSERT OR REPLACE INTO entry_events
       (id, coin, type, reason, signal_price, target_price, price, slippage_pct, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id, event.coin, event.type, event.reason ?? null,
      event.signalPrice, event.targetPrice, event.price ?? null, event.slippagePct ?? null, event.at,
    ],
  )
}
