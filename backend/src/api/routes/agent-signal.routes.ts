import { Router, Request, Response } from 'express'
import { getSettings, agentSignalMemory } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { getSignalRuns, getActiveSignalReviews, isRunningSignal } from '../../agent/index.js'
import type { SignalMemory } from '../../types.js'

export const router = Router()

// Recent persisted Agent Signal runs — verdict + transcript per coin per cycle — plus any
// in-flight reviews of the current cycle, so the Agent Signal page rehydrates fully after a
// reload (including a run that is mid-flight).
router.get('/agent-signal/runs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '100', 10), 1), 500)
    res.json({
      running: isRunningSignal(),
      mode: getSettings().signal_model,
      runs: await getSignalRuns(limit),
      live: getActiveSignalReviews(),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// The agent's long-term per-coin memory (thesis / conviction / levels / notes log), newest first.
router.get('/agent-signal/memory', async (_req: Request, res: Response) => {
  try {
    const rows = await agentSignalMemory.find({}, { sort: { updated_at: -1 }, projection: { _id: 0 } }) as unknown as SignalMemory[]
    res.json({ memory: rows })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Run the Agent Signal engine now over the full watchlist. Emits the shared pipeline trigger,
// which dispatchPipelineRun routes to the agent engine when signal_model === 'agent'.
router.post('/agent-signal/run', (_req: Request, res: Response) => {
  bus.emit('pipeline_run_all_requested', {})
  res.json({ ok: true })
})
