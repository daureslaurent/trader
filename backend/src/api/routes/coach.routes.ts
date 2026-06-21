import { Router, Request, Response } from 'express'
import { bus } from '../../core/events.js'
import { getCoachRuns, getActiveCoachReview, isRunningCoach, getCoachMemory } from '../../agent/index.js'

export const router = Router()

// Recent persisted Coach runs — assessment + findings + corrections + transcript — plus any
// in-flight audit, so the Coach Agent page rehydrates fully after a reload (including a pass
// that is mid-flight).
router.get('/coach/runs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '50', 10), 1), 200)
    const active = getActiveCoachReview()
    res.json({
      running: isRunningCoach(),
      runs: await getCoachRuns(limit),
      live: active ? [active] : [],
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// The global coach-memory log (the running list of system-wide lessons, also injected into the
// Monitor + Analyst prompts).
router.get('/coach/memory', async (_req: Request, res: Response) => {
  try {
    res.json({ notes: await getCoachMemory() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Run a Coach audit now (the Coach Agent page "Run audit now" button). The engine gates on the
// minimum closed-trade sample and skips in offline mode.
router.post('/coach/run', (_req: Request, res: Response) => {
  const cycleId = `${Date.now().toString(36)}-coach-manual`
  bus.emit('coach_run_requested', { cycle_id: cycleId })
  res.json({ ok: true, cycle_id: cycleId })
})
