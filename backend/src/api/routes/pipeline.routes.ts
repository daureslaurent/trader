import { Router, Request, Response } from 'express'
import { queryAll, queryOne } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { isPipelineRunning } from '../../pipeline/index.js'
import { isTradeable } from '../../core/tradeable.js'

export const router = Router()

router.get('/decisions', (_req: Request, res: Response) => {
  const decisions = queryAll('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 50')
  res.json(decisions)
})

router.get('/chart', (_req: Request, res: Response) => {
  const rows = queryAll(
    'SELECT coin, action, confidence, created_at FROM decisions ORDER BY created_at ASC'
  ) as { coin: string; action: string; confidence: number; created_at: string }[]
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

router.post('/pipeline/rerun', (req: Request, res: Response) => {
  const { cycle_id } = req.body
  if (!cycle_id || typeof cycle_id !== 'string') return res.status(400).json({ error: 'cycle_id required' })
  const row = queryOne('SELECT coin FROM pipeline_events WHERE cycle_id = ? LIMIT 1', [cycle_id]) as { coin: string } | undefined
  if (!row) return res.status(404).json({ error: 'Cycle not found' })
  const symbol = row.coin.includes('/') ? row.coin : `${row.coin}/USDC`
  const newCycleId = `${Date.now().toString(36)}-manual`
  bus.emit('pipeline_run_requested', { symbol, cycle_id: newCycleId })
  res.json({ ok: true, cycle_id: newCycleId })
})

router.get('/pipeline-events', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Math.floor(parseFloat(req.query.limit as string)) || 100, 1), 500)
  const coin = req.query.coin as string | undefined
  const cycleId = req.query.cycle_id as string | undefined

  let sql = 'SELECT * FROM pipeline_events'
  const params: (string | number)[] = []
  const conditions: string[] = []

  if (coin) {
    conditions.push('coin = ?')
    params.push(coin)
  }
  if (cycleId) {
    conditions.push('cycle_id = ?')
    params.push(cycleId)
  }
  if (req.query.stage) {
    conditions.push('stage LIKE ?')
    params.push(`${req.query.stage as string}%`)
  }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const events = queryAll(sql, params)
  res.json(events)
})
