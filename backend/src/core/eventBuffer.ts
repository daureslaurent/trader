/**
 * In-memory ring buffer of recent system events.
 *
 * Backs two things:
 *   1. `GET /api/events/history` — the initial snapshot the Event Stream page
 *      loads on mount.
 *   2. Seq-cursor backfill — when a WebSocket client (re)connects it sends the
 *      last `seq` it saw; we replay only the gap from here (no dupes, no gaps
 *      within the retained window).
 *
 * It is a true ring: at capacity the oldest entry is overwritten (drop-oldest),
 * so a flash-crash event storm can never grow memory without bound. `seq` is a
 * process-monotonic counter that keeps increasing past the capacity, so cursor
 * math stays correct even after the physical slot has been recycled.
 */

export interface BufferedEvent {
  /** Stable string id (stringified seq) — satisfies the UI row key. */
  id: string
  /** Monotonic sequence number; the cursor used for reconnection backfill. */
  seq: number
  /** Routing key, e.g. "EXECUTION.ORDER_FILLED". */
  event: string
  /** Coarse class for UI colouring / coalescing — see core/bus.ts. */
  category: string
  /** Epoch milliseconds the event was recorded. */
  timestamp: number
  /** Arbitrary structured payload. */
  payload: unknown
}

const CAPACITY = 200

class EventBuffer {
  private readonly capacity: number
  private buf: BufferedEvent[] = []
  private seqCounter = 0

  constructor(capacity = CAPACITY) {
    this.capacity = capacity
  }

  /** Append an event, assigning it the next seq. Returns the stored record. */
  push(event: string, category: string, payload: unknown): BufferedEvent {
    const seq = ++this.seqCounter
    const record: BufferedEvent = {
      id: String(seq),
      seq,
      event,
      category,
      timestamp: Date.now(),
      payload,
    }
    this.buf.push(record)
    // Drop-oldest: keep only the most recent `capacity` records.
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity)
    }
    return record
  }

  /** Full snapshot, oldest → newest. Served by the history endpoint. */
  snapshot(): BufferedEvent[] {
    return this.buf.slice()
  }

  /**
   * Events strictly after `afterSeq`, oldest → newest. Used for reconnection
   * backfill. If the cursor is older than anything we still hold (the client
   * was gone long enough that the gap fell out of the ring) we return the whole
   * snapshot so the client resynchronises rather than silently missing events.
   */
  since(afterSeq: number): BufferedEvent[] {
    if (this.buf.length === 0) return []
    const oldestSeq = this.buf[0].seq
    if (afterSeq < oldestSeq - 1) return this.buf.slice()
    return this.buf.filter((e) => e.seq > afterSeq)
  }

  /** The highest seq emitted so far (0 before any event). */
  get lastSeq(): number {
    return this.seqCounter
  }

  /** Current number of retained events. */
  get size(): number {
    return this.buf.length
  }
}

export const eventBuffer = new EventBuffer()
