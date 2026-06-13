import { Router, Request, Response } from 'express'
import { bus } from '../../core/events.js'
import { getSummaries, getLatestSummary, isRunning as isSummaryRunning, getActiveSummaryModel } from '../../summary/index.js'

export const router = Router()

router.get('/summary', (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '50', 10), 1), 200)
    const active = getActiveSummaryModel()
    res.json({
      running: isSummaryRunning(),
      latest: getLatestSummary(),
      history: getSummaries(limit),
      model: { model: active.model, baseURL: active.baseURL },
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/summary/run', (_req: Request, res: Response) => {
  if (isSummaryRunning()) return res.status(409).json({ error: 'A summary run is already in progress' })
  const cycleId = `${Date.now().toString(36)}-summary`
  bus.emit('summary_run_requested', { cycle_id: cycleId })
  res.json({ ok: true, cycle_id: cycleId })
})
