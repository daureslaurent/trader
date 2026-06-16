import { Router, Request, Response } from 'express'
import { decisions as decisionsRepo, pipelineEvents, getSettings } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { isPipelineRunning } from '../../pipeline/index.js'
import { isTradeable } from '../../core/tradeable.js'

export const router = Router()

router.get('/decisions', async (_req: Request, res: Response) => {
  const decisions = await decisionsRepo.find({}, { sort: { created_at: -1 }, limit: 50 })
  res.json(decisions)
})

// Per-coin decision history for the candle-chart signal markers. Capped by the
// chart_marker_limit setting so a single coin's signals aren't crowded out by the
// global /decisions feed (which only returns the latest 50 across all coins).
router.get('/decisions/:coin', async (req: Request, res: Response) => {
  try {
    const raw = decodeURIComponent(req.params.coin).trim().toUpperCase()
    const coin = raw.includes('/') ? raw : `${raw}/USDC`
    const cap = Math.max(1, getSettings().chart_marker_limit || 200)
    const limit = Math.min(parseInt((req.query.limit as string) || String(cap), 10) || cap, 1000)
    const rows = await decisionsRepo.find({ coin }, { sort: { created_at: -1 }, limit })
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/chart', async (_req: Request, res: Response) => {
  const rows = (await decisionsRepo.find(
    {}, { sort: { created_at: 1 }, projection: { _id: 0, coin: 1, action: 1, confidence: 1, created_at: 1 } },
  )) as unknown as { coin: string; action: string; confidence: number; created_at: string }[]
  const data = rows.map((r) => ({
    coin: r.coin,
    action: r.action,
    confidence: r.confidence,
    value: r.confidence * (r.action === 'BUY' ? 1 : r.action === 'SELL' ? -1 : 0),
    created_at: r.created_at,
  }))
  res.json(data)
})

router.get('/pipeline/status', (_req: Request, res: Response) => {
  res.json({ running: isPipelineRunning() })
})

router.post('/pipeline/run-all', (_req: Request, res: Response) => {
  if (isPipelineRunning()) return res.status(409).json({ error: 'Pipeline already running' })
  bus.emit('pipeline_run_all_requested', {})
  res.json({ ok: true })
})

router.post('/pipeline/run', (req: Request, res: Response) => {
  const { coin } = req.body
  if (!coin || typeof coin !== 'string') return res.status(400).json({ error: 'coin required' })
  const raw = coin.trim().toUpperCase()
  const symbol = raw.includes('/') ? raw : `${raw}/USDC`
  if (!isTradeable(symbol)) return res.status(400).json({ error: `Cannot run pipeline for ${symbol} — fiat/stablecoin` })
  const cycleId = `${Date.now().toString(36)}-manual`
  bus.emit('pipeline_run_requested', { symbol, cycle_id: cycleId })
  res.json({ ok: true, cycle_id: cycleId })
})

router.post('/pipeline/simulate', (req: Request, res: Response) => {
  const { coin, action, confidence, reason } = req.body
  if (!coin || typeof coin !== 'string') return res.status(400).json({ error: 'coin required' })
  if (!['BUY', 'SELL'].includes(action)) return res.status(400).json({ error: 'action must be BUY or SELL' })
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return res.status(400).json({ error: 'confidence must be 0–1' })
  const raw = coin.trim().toUpperCase()
  const symbol = raw.includes('/') ? raw : `${raw}/USDC`
  if (!isTradeable(symbol)) return res.status(400).json({ error: `Cannot simulate signal for ${symbol} — fiat/stablecoin` })
  const cycleId = `${Date.now().toString(36)}-sim`
  bus.emit('trade_signal_simulated', {
    symbol,
    action: action as 'BUY' | 'SELL',
    confidence,
    reason: reason || `Simulated ${action}`,
    cycle_id: cycleId,
  })
  res.json({ ok: true, cycle_id: cycleId })
})

router.post('/pipeline/cancel/:cycleId', (req: Request, res: Response) => {
  const { cycleId } = req.params
  if (!cycleId) return res.status(400).json({ error: 'cycleId required' })
  bus.emit('pipeline_cancel_requested', { cycle_id: cycleId })
  res.json({ ok: true })
})

router.post('/pipeline/rerun', async (req: Request, res: Response) => {
  const { cycle_id } = req.body
  if (!cycle_id || typeof cycle_id !== 'string') return res.status(400).json({ error: 'cycle_id required' })
  const row = (await pipelineEvents.findOne({ cycle_id }, { projection: { coin: 1 } })) as { coin: string } | null
  if (!row) return res.status(404).json({ error: 'Cycle not found' })
  const symbol = row.coin.includes('/') ? row.coin : `${row.coin}/USDC`
  const newCycleId = `${Date.now().toString(36)}-manual`
  bus.emit('pipeline_run_requested', { symbol, cycle_id: newCycleId })
  res.json({ ok: true, cycle_id: newCycleId })
})

router.get('/pipeline-events', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Math.floor(parseFloat(req.query.limit as string)) || 100, 1), 500)
  const coin = req.query.coin as string | undefined
  const cycleId = req.query.cycle_id as string | undefined

  const filter: Record<string, unknown> = {}
  if (coin) filter.coin = coin
  if (cycleId) filter.cycle_id = cycleId
  // stage LIKE 'prefix%' → anchored prefix regex
  if (req.query.stage) filter.stage = { $regex: `^${String(req.query.stage).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }

  const events = await pipelineEvents.find(filter, { sort: { created_at: -1 }, limit })
  res.json(events)
})
