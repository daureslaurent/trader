import { Router, Request, Response } from 'express'
import { coinDiscoveries } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { getExchange } from '../../trader/service.js'
import { getDiscoveries, approveDiscovery, rejectDiscovery, deleteDiscovery, isRunning } from '../../discoverer/index.js'

export const router = Router()

router.get('/discover', async (_req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((_req.query.limit as string) || '50', 10), 1), 200)
    const discoveries = await getDiscoveries(limit)
    res.json({ running: isRunning(), discoveries })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/discover/run', (_req: Request, res: Response) => {
  const cycleId = `${Date.now().toString(36)}-discovery`
  bus.emit('discovery_run_requested', { cycle_id: cycleId })
  res.json({ ok: true, cycle_id: cycleId })
})

router.post('/discover/approve/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })

  // Verify the symbol is actually listed on Binance before adding to watchlist
  const discovery = (await coinDiscoveries.findById(id, {})) as { coin: string } | null
  if (!discovery) return res.status(404).json({ error: 'Discovery not found' })

  try {
    const ticker = await getExchange().fetchTicker(discovery.coin)
    if (!ticker?.last || ticker.last === 0) {
      return res.status(400).json({ error: `${discovery.coin} has no price on Binance — may not be a valid USDC pair` })
    }
  } catch {
    return res.status(400).json({ error: `${discovery.coin} is not tradeable on Binance as a USDC pair` })
  }

  const result = await approveDiscovery(id)
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json({ ok: true })
})

router.post('/discover/reject/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const result = await rejectDiscovery(id)
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json({ ok: true })
})

router.delete('/discover/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  await deleteDiscovery(id)
  res.json({ ok: true })
})
