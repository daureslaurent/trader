import { Router, Request, Response } from 'express'
import { queryAll, queryOne } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { resolveLLM } from '../../config/llm.js'
import { getReviews, getNotes as getMonitorNotes, isRunning as isMonitorRunning, getActiveMonitorModel } from '../../monitor/index.js'

export const router = Router()

router.get('/monitor', (_req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((_req.query.limit as string) || '100', 10), 1), 500)
    const reviews = getReviews(limit)
    res.json({ running: isMonitorRunning(), reviews, notes: getMonitorNotes() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Exposes the two configured monitor LLM slots and which one is active, so the UI
// can label the Settings toggle and badge the active model on the Monitor page.
router.get('/monitor/models', (_req: Request, res: Response) => {
  const a = resolveLLM('monitorA')
  const b = resolveLLM('monitorB')
  res.json({
    active: getActiveMonitorModel().slot,
    a: { model: a.model, baseURL: a.baseURL },
    b: { model: b.model, baseURL: b.baseURL },
  })
})

router.post('/monitor/run', (_req: Request, res: Response) => {
  const cycleId = `${Date.now().toString(36)}-monitor`
  bus.emit('monitor_run_requested', { cycle_id: cycleId })
  res.json({ ok: true, cycle_id: cycleId })
})

router.get('/monitor/reviews/:coin', (req: Request, res: Response) => {
  try {
    const raw = decodeURIComponent(req.params.coin).trim().toUpperCase()
    const coin = raw.includes('/') ? raw : `${raw}/USDC`
    const reviews = queryAll(
      `SELECT id, coin, action, confidence, reasoning, created_at
       FROM position_reviews WHERE coin = ? ORDER BY created_at DESC LIMIT 200`,
      [coin],
    )
    res.json(reviews)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── Position SL/TP adjustments ──────────────────────────────────────────────

router.get('/adjustments', (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '50', 10), 1), 200)
    const status = req.query.status as string | undefined
    let sql = 'SELECT * FROM position_adjustments'
    const params: (string | number)[] = []
    if (status) { sql += ' WHERE status = ?'; params.push(status.toUpperCase()) }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)
    res.json(queryAll(sql, params))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/adjustment/approve/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const row = queryOne("SELECT id FROM position_adjustments WHERE id = ? AND status = 'PENDING'", [id])
  if (!row) return res.status(404).json({ error: 'Adjustment not found or not pending' })
  bus.emit('adjustment_approved', id)
  res.json({ ok: true })
})

router.post('/adjustment/reject/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const row = queryOne("SELECT id FROM position_adjustments WHERE id = ? AND status = 'PENDING'", [id])
  if (!row) return res.status(404).json({ error: 'Adjustment not found or not pending' })
  bus.emit('adjustment_rejected', id)
  res.json({ ok: true })
})
