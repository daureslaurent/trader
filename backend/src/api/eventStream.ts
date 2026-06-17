/**
 * The bridge between the reactive system bus and the frontend.
 *
 * Every emitted SystemEvent is appended to the ring buffer (for history +
 * backfill) and queued for WebSocket fan-out as an `EVENT_STREAM_TICK`. To stay
 * alive through a flash-crash event storm the wire path is load-shed:
 *
 *   - Drop-oldest    : the ring buffer overwrites its oldest slot (its nature).
 *   - Batched flush  : queued events are flushed at most every FLUSH_MS, so a
 *                      thousand ticks a second become ~10 socket frames.
 *   - Coalesced      : within a pending batch, high-frequency MARKET.* events
 *                      collapse to the latest per (event, symbol) — the UI only
 *                      ever needs the freshest price.
 *   - Critical bypass: EXECUTION_FAILED / RISK stops flush immediately so a fill
 *                      or a blown stop is never delayed behind a market storm.
 */

import { systemBus, EventCategory } from '../core/bus.js'
import { eventBuffer, BufferedEvent } from '../core/eventBuffer.js'
import { broadcast } from './ws.js'
import { logger } from '../core/logger.js'

const FLUSH_MS = 100

/** Pending batch, newest-wins for coalescable keys. Flushed on a timer. */
let pending: BufferedEvent[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null

function coalesceKey(record: BufferedEvent): string | null {
  if (record.category !== EventCategory.Market) return null
  const symbol = (record.payload as { symbol?: string })?.symbol ?? ''
  return `${record.event}:${symbol}`
}

function enqueue(record: BufferedEvent): void {
  const key = coalesceKey(record)
  if (key) {
    // Replace any pending market event for the same symbol with this fresher one.
    const idx = pending.findIndex((p) => coalesceKey(p) === key)
    if (idx >= 0) {
      pending[idx] = record
      return
    }
  }
  pending.push(record)
}

function flush(): void {
  if (pending.length === 0) return
  // Oldest → newest by seq, so the UI prepends in the correct order.
  const batch = pending.sort((a, b) => a.seq - b.seq)
  pending = []
  broadcast('EVENT_STREAM_TICK', { events: batch, lastSeq: eventBuffer.lastSeq })
}

/** Wire the bus to the buffer + WS. Idempotent; safe to call once at startup. */
export function initEventStream(): void {
  if (flushTimer) return

  systemBus.onAny(({ event, category, payload }) => {
    const record = eventBuffer.push(event, category, payload)
    enqueue(record)
    // Critical events jump the queue — flush the whole pending batch now so
    // ordering is preserved and the fill/stop lands on the UI immediately.
    if (category === EventCategory.Critical) flush()
  })

  flushTimer = setInterval(flush, FLUSH_MS)
  // Don't let the flush timer keep the process alive on shutdown.
  if (typeof flushTimer.unref === 'function') flushTimer.unref()

  logger.info('Event stream bridge initialized', { flushMs: FLUSH_MS })
}

export function stopEventStream(): void {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  pending = []
}
