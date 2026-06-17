import { Router, Request, Response } from 'express'
import { eventBuffer } from '../../core/eventBuffer.js'

export const router = Router()

// Snapshot of the reactive system-event ring buffer. The Event Stream page
// fetches this once on mount to seed its feed, then keeps current via the
// `EVENT_STREAM_TICK` WebSocket frames. `lastSeq` is the resync cursor.
router.get('/events/history', (_req: Request, res: Response) => {
  res.json({
    events: eventBuffer.snapshot(),
    lastSeq: eventBuffer.lastSeq,
  })
})
