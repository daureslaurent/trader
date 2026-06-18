import { Router, Request, Response } from 'express'
import { getSettings } from '../../db/index.js'
import { getEntryAgentRuns, getActiveEntryReviews, isRunningEntry, runEntryAgent, runEntryAgentCoin } from '../../agent/index.js'

export const router = Router()

// Recent persisted Entry Agent runs — verdict + transcript per intent per pass — plus any
// in-flight passes, so the Entry Agent page rehydrates fully after a reload (including a pass
// that is mid-flight).
router.get('/entry-agent/runs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '100', 10), 1), 500)
    res.json({
      running: isRunningEntry(),
      mode: getSettings().entry_model,
      runs: await getEntryAgentRuns(limit),
      live: getActiveEntryReviews(),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Run an Entry Agent pass now. With a `coin` in the body, runs a single-intent pass (the
// Entry Desk "Re-run agent" button); without it, a full pass over every active intent. The
// slashed coin (e.g. "BTC/USDC") goes in the body so it can't break URL routing. No-ops in
// the engine unless entry_model === 'agent'.
router.post('/entry-agent/run', (req: Request, res: Response) => {
  const cycleId = `${Date.now().toString(36)}-entry-manual`
  const coin = typeof req.body?.coin === 'string' && req.body.coin.trim() ? req.body.coin.trim() : null
  const run = coin ? runEntryAgentCoin(coin, cycleId) : runEntryAgent(cycleId)
  run.catch(() => { /* errors are logged + broadcast inside the engine */ })
  res.json({ ok: true })
})
