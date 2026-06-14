import { Router, Request, Response } from 'express'
import { positions as positionsRepo, getSettings } from '../../db/index.js'
import * as priceCache from '../../market/index.js'
import { cancelProtection, closePositionFromExit } from '../../portfolio/index.js'

export const router = Router()

router.get('/positions', async (_req: Request, res: Response) => {
  try {
    const positions = await positionsRepo.find({ status: 'OPEN' }, { sort: { created_at: 1 } }) as Record<string, unknown>[]
    if (positions.length === 0) return res.json([])
    const coins = [...new Set(positions.map(p => p.coin as string))]
    priceCache.subscribe(coins)
    const allPrices = priceCache.getAll()
    // Round-trip fee as a fraction of notional: charged on both the entry and exit
    // leg. The price at which a close nets exactly zero P&L is entry × (1 + 2·feeRate).
    const roundTripFee = getSettings().fee_rate * 2
    const enriched = positions.map((pos) => {
      const snap = allPrices.get(pos.coin as string)
      const currentPrice = snap?.price || (pos.entry_price as number)
      const entryPrice = pos.entry_price as number
      const pnl = (pos.quantity as number) * (currentPrice - entryPrice)
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100
      const distanceToSlPct = pos.stop_loss ? ((currentPrice - (pos.stop_loss as number)) / currentPrice) * 100 : null
      const distanceToTpPct = pos.take_profit ? (((pos.take_profit as number) - currentPrice) / currentPrice) * 100 : null
      const breakEvenPrice = entryPrice * (1 + roundTripFee)
      return {
        id: pos.id,
        coin: pos.coin,
        quantity: pos.quantity,
        entry_price: pos.entry_price,
        current_price: snap?.price ?? null,
        pnl: snap ? pnl : null,
        pnl_pct: snap ? Math.round(pnlPct * 100) / 100 : null,
        stop_loss: pos.stop_loss,
        take_profit: pos.take_profit,
        distance_to_sl_pct: (snap && distanceToSlPct !== null) ? Math.round(distanceToSlPct * 100) / 100 : null,
        distance_to_tp_pct: (snap && distanceToTpPct !== null) ? Math.round(distanceToTpPct * 100) / 100 : null,
        break_even_price: breakEvenPrice,
        // True once the live price clears the fee-adjusted break-even — i.e. closing now
        // would lock in a net gain after round-trip fees.
        past_break_even: snap ? snap.price >= breakEvenPrice : false,
        status: pos.status,
        horizon: pos.horizon ?? 'medium',
        oco_status: pos.oco_status ?? 'NONE',
        created_at: pos.created_at,
      }
    })
    res.json(enriched)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.patch('/positions/:id/horizon', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const { horizon } = req.body as { horizon?: string }
    if (!['short', 'medium', 'long', 'disabled', 'llm'].includes(horizon ?? '')) {
      return res.status(400).json({ error: 'horizon must be short, medium, long, disabled, or llm' })
    }
    const pos = await positionsRepo.findOne({ _id: id, status: 'OPEN' }, { projection: { id: 1 } })
    if (!pos) return res.status(404).json({ error: 'Position not found' })
    await positionsRepo.update({ _id: id }, { horizon: horizon! })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Mark a position as closed without executing a trade — for positions already sold
// manually on Binance. Cancels the OCO if active, then reconciles the DB.
router.post('/positions/:id/close', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })

    const pos = await positionsRepo.findOne({ _id: id, status: 'OPEN' }) as Record<string, unknown> | null
    if (!pos) return res.status(404).json({ error: 'Position not found or already closed' })

    const coin = pos.coin as string
    const quantity = pos.quantity as number

    // Cancel OCO on Binance so the hanging orders are cleaned up.
    await cancelProtection(id)

    // Use caller-supplied fill price, or fall back to latest cached price.
    let fillPrice = typeof req.body?.fill_price === 'number' ? req.body.fill_price : null
    if (!fillPrice) {
      priceCache.subscribe([coin])
      fillPrice = priceCache.getAll().get(coin)?.price ?? (pos.entry_price as number)
    }

    const closed = await closePositionFromExit({
      positionId: id,
      coin,
      status: 'CLOSED',
      fillPrice,
      fillQty: quantity,
      reason: 'Manual close (already sold on Binance)',
    })

    if (!closed) return res.status(409).json({ error: 'Position was already closed by a concurrent operation' })

    res.json({ ok: true, coin, fillPrice })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
