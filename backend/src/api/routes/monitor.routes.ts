import { Router, Request, Response } from 'express'
import { positionReviews, positionAdjustments, getSettings } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { resolveLLM } from '../../config/llm.js'
import { getReviews, getNotes as getMonitorNotes, isRunning as isMonitorRunning, getActiveMonitorModel } from '../../monitor/index.js'
import { getMonitorDRuns, getActiveReviews, isRunningD } from '../../agent/index.js'

export const router = Router()

// Recent persisted Type D (agentic monitor) runs — verdict + transcript per coin per
// cycle — plus any in-flight reviews of the current cycle, so the Agent Monitor page
// rehydrates fully after a reload (including a run that is mid-flight).
router.get('/monitor-d/runs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '100', 10), 1), 500)
    res.json({
      running: isRunningD(),
      mode: getSettings().monitor_model,
      runs: await getMonitorDRuns(limit),
      live: getActiveReviews(),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/monitor', async (_req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((_req.query.limit as string) || '100', 10), 1), 500)
    const reviews = await getReviews(limit)
    // `running` reflects whichever monitor engine is active — the classic ensemble OR
    // the Type D agentic monitor (monitor_model === 'd') — since both feed position_reviews.
    res.json({ running: isMonitorRunning() || isRunningD(), reviews, notes: await getMonitorNotes() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Exposes the configured monitor LLM slots (A/B voters + the C synthesizer), the
// selected mode, and which slot is the representative active one, so the Settings UI
// can label each mode card and badge the model on the Monitor page.
router.get('/monitor/models', (_req: Request, res: Response) => {
  const a = resolveLLM('monitorA')
  const b = resolveLLM('monitorB')
  const c = resolveLLM('monitorC')
  res.json({
    active: getActiveMonitorModel().slot,
    mode: getSettings().monitor_model,
    a: { model: a.model, baseURL: a.baseURL },
    b: { model: b.model, baseURL: b.baseURL },
    c: { model: c.model, baseURL: c.baseURL },
  })
})

router.post('/monitor/run', (_req: Request, res: Response) => {
  const cycleId = `${Date.now().toString(36)}-monitor`
  bus.emit('monitor_run_requested', { cycle_id: cycleId })
  res.json({ ok: true, cycle_id: cycleId })
})

router.get('/monitor/reviews/:coin', async (req: Request, res: Response) => {
  try {
    const raw = decodeURIComponent(req.params.coin).trim().toUpperCase()
    const coin = raw.includes('/') ? raw : `${raw}/USDC`
    const limit = Math.min(Math.max(getSettings().chart_marker_limit || 200, 1), 1000)
    const reviews = await positionReviews.find(
      { coin },
      { sort: { created_at: -1 }, limit, projection: { _id: 0, id: 1, coin: 1, action: 1, confidence: 1, reasoning: 1, created_at: 1 } },
    )
    res.json(reviews)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── Position SL/TP adjustments ──────────────────────────────────────────────

router.get('/adjustments', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '50', 10), 1), 200)
    const status = req.query.status as string | undefined
    const filter = status ? { status: status.toUpperCase() } : {}
    res.json(await positionAdjustments.find(filter, { sort: { created_at: -1 }, limit }))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/adjustment/approve/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const row = await positionAdjustments.findOne({ _id: id, status: 'PENDING' }, { projection: { id: 1 } })
  if (!row) return res.status(404).json({ error: 'Adjustment not found or not pending' })
  bus.emit('adjustment_approved', id)
  res.json({ ok: true })
})

router.post('/adjustment/reject/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const row = await positionAdjustments.findOne({ _id: id, status: 'PENDING' }, { projection: { id: 1 } })
  if (!row) return res.status(404).json({ error: 'Adjustment not found or not pending' })
  bus.emit('adjustment_rejected', id)
  res.json({ ok: true })
})
