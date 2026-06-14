import { Router, Request, Response } from 'express'
import { queryAll, queryOne, runSQL } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { logger } from '../../core/logger.js'
import { Signal, PortfolioEntry } from '../../types.js'
import { getPendingApprovals } from '../../execution/index.js'
import { getActiveIntents, getRecentEvents } from '../../entry/index.js'
import { executeTrade, executeCoinTrade, fetchBalance } from '../../trader/index.js'
import {
  getOpenEntries, getUsdcEntry, updatePortfolioForTrade,
  cancelProtection, getOpenPositions,
} from '../../portfolio/index.js'
import { normalizeSymbol } from './helpers.js'

export const router = Router()

router.get('/trades', (_req: Request, res: Response) => {
  const trades = queryAll('SELECT * FROM trades ORDER BY created_at DESC LIMIT 50')
  res.json(trades)
})

router.delete('/trades/failed', (_req: Request, res: Response) => {
  const info = runSQL("DELETE FROM trades WHERE status = 'FAILED'")
  res.json({ ok: true, deleted: info.changes })
})

router.get('/approvals', (_req: Request, res: Response) => {
  res.json(getPendingApprovals())
})

router.get('/entry-intents', (_req: Request, res: Response) => {
  res.json(getActiveIntents())
})

router.get('/entry-events', (_req: Request, res: Response) => {
  res.json(getRecentEvents())
})

router.post('/trade/approve/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid trade ID' })
  const trade = queryOne("SELECT id FROM trades WHERE id = ? AND status = 'PENDING'", [id])
  if (!trade) return res.status(404).json({ error: 'Trade not found or not pending' })
  const hasPending = getPendingApprovals().some(a => a.tradeId === id)
  if (!hasPending) {
    logger.warn('Trade approval failed: in-memory state lost (server restarted)', { tradeId: id })
    return res.status(409).json({ error: 'Approval session expired — server was restarted. Please reject this trade and re-run the pipeline.' })
  }
  logger.info('Trade approved by user', { tradeId: id })
  bus.emit('trade_approved', id)
  res.json({ ok: true })
})

router.post('/trade/reject/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid trade ID' })
  const trade = queryOne("SELECT id FROM trades WHERE id = ? AND status = 'PENDING'", [id])
  if (!trade) return res.status(404).json({ error: 'Trade not found or not pending' })
  logger.info('Trade rejected by user', { tradeId: id })
  bus.emit('trade_rejected', id)
  res.json({ ok: true })
})

router.post('/trade/manual', async (req: Request, res: Response) => {
  const { coin, side, quantity } = req.body
  if (!coin || typeof coin !== 'string' || !coin.includes('/')) {
    return res.status(400).json({ error: 'Invalid coin symbol' })
  }
  if (!['BUY', 'SELL'].includes(side)) {
    return res.status(400).json({ error: 'side must be BUY or SELL' })
  }
  if (typeof quantity !== 'number' || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' })
  }
  try {
    const signal: Signal = { coin, action: side, quantity, reason: 'Manual', confidence: 1 }
    const result = await executeTrade(signal)
    const info = runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, 0, 'BNB', 'EXECUTED', 1)",
      [coin, side, quantity, result.price, result.cost]
    )
    res.json({ ok: true, id: info.lastInsertRowid })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/trade/execute', async (req: Request, res: Response) => {
  const { from, to, amount } = req.body
  if (!from || typeof from !== 'string') return res.status(400).json({ error: 'from coin required' })
  if (!to || typeof to !== 'string') return res.status(400).json({ error: 'to coin required' })
  if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' })

  const fromSymbol = normalizeSymbol(from)
  const toSymbol = normalizeSymbol(to)
  if (fromSymbol === toSymbol) return res.status(400).json({ error: 'from and to must be different coins' })
  if (fromSymbol !== 'USDC' && toSymbol !== 'USDC') return res.status(400).json({ error: 'one of from/to must be USDC' })

  // Pre-flight balance check (informational — updatePortfolioForTrade re-checks atomically)
  const preCheck = fromSymbol === 'USDC' ? getUsdcEntry() : (getOpenEntries() as unknown as PortfolioEntry[]).find(e => e.coin === fromSymbol) ?? null
  if (!preCheck) return res.status(400).json({ error: `No open position for ${fromSymbol}` })
  if (preCheck.quantity < amount) return res.status(400).json({ error: `Insufficient balance: have ${preCheck.quantity}, need ${amount}` })

  try {
    // For sells: cap quantity to actual Binance free balance in case buy fees
    // were taken in the base currency (actual < recorded by ~0.1 %).
    let sellQty = amount
    if (toSymbol === 'USDC') {
      const openPos = getOpenPositions().find(p => p.coin === fromSymbol)
      if (openPos) await cancelProtection(openPos.id)

      const base = fromSymbol.split('/')[0]
      const bal = await fetchBalance()
      const actualFree = bal[base]?.free ?? 0
      if (actualFree < sellQty && actualFree >= sellQty * 0.98) {
        logger.info('Sell qty capped to actual Binance free balance (fee adjustment)', {
          coin: fromSymbol, recorded: sellQty, actual: actualFree,
        })
        sellQty = actualFree
      }
    }

    const result = await executeCoinTrade(fromSymbol, toSymbol, sellQty)

    let tradeInfo: ReturnType<typeof runSQL>
    if (toSymbol === 'USDC') {
      tradeInfo = runSQL(
        "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, 0, 'BNB', 'EXECUTED', 1)",
        [fromSymbol, 'SELL', sellQty, result.fromPrice, sellQty * result.fromPrice]
      )
    } else {
      tradeInfo = runSQL(
        "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, 0, 'BNB', 'EXECUTED', 1)",
        [toSymbol, 'BUY', result.toAmount, result.toPrice, result.toAmount * result.toPrice]
      )
    }

    // Use the original `amount` (the full recorded entry quantity) for the local
    // ledger so fee-adjusted sells don't leave dust in portfolio_entries.
    // The USDC credit still uses result.toAmount (actual fill).
    updatePortfolioForTrade(fromSymbol, amount, toSymbol, result.toAmount, result.toPrice, tradeInfo.lastInsertRowid)

    res.json({
      ok: true,
      tradeId: tradeInfo.lastInsertRowid,
      fromSymbol,
      toSymbol,
      fromAmount: sellQty,
      toAmount: result.toAmount,
      fromPrice: result.fromPrice,
      toPrice: result.toPrice,
    })
  } catch (err) {
    logger.error('Trade execute failed', { from, to, amount, error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
