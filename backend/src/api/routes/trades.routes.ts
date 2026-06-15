import { Router, Request, Response } from 'express'
import { trades as tradesRepo, nowSql } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { logger } from '../../core/logger.js'
import { Signal, PortfolioEntry } from '../../types.js'
import { getPendingApprovals } from '../../execution/index.js'
import { getActiveIntents, getRecentEvents, hasActiveIntent, cancel as cancelEntryIntent, replan as replanEntryIntent } from '../../entry/index.js'
import { stageManualEntry } from '../../pipeline/index.js'
import { executeTrade, executeCoinTrade, fetchBalance } from '../../trader/index.js'
import {
  getOpenEntries, getUsdcEntry, updatePortfolioForTrade,
  cancelProtection, getOpenPositions,
} from '../../portfolio/index.js'
import { normalizeSymbol } from './helpers.js'

export const router = Router()

// Record an already-filled trade (manual / coin-swap paths). Fees on these go to
// BNB and aren't itemized here. Returns the new trade id.
async function recordExecuted(coin: string, side: 'BUY' | 'SELL', quantity: number, price: number, total: number): Promise<number> {
  return Number(await tradesRepo.insert({
    coin, side, quantity, price, total, fee_cost: 0, fee_currency: 'BNB',
    signal_id: null, status: 'EXECUTED', approved: 1, error: null, created_at: nowSql(),
  }))
}

router.get('/trades', async (_req: Request, res: Response) => {
  const trades = await tradesRepo.find({}, { sort: { created_at: -1 }, limit: 50 })
  res.json(trades)
})

router.delete('/trades/failed', async (_req: Request, res: Response) => {
  const deleted = await tradesRepo.deleteMany({ status: 'FAILED' })
  res.json({ ok: true, deleted })
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

// Manually cancel a pending entry intent (deferred BUY) from the Entry Desk.
// The coin carries a slash (e.g. BTC/USDC), so it's passed in the body rather
// than the path. Discards the watch — it does NOT place a trade.
router.post('/entry-intents/cancel', (req: Request, res: Response) => {
  const { coin } = req.body
  if (!coin || typeof coin !== 'string') {
    return res.status(400).json({ error: 'coin required' })
  }
  if (!hasActiveIntent(coin)) {
    return res.status(404).json({ error: 'No active entry intent for this coin' })
  }
  logger.info('Entry intent cancelled by user', { coin })
  cancelEntryIntent(coin, 'manual')
  res.json({ ok: true })
})

// Re-run the Entry Planner LLM for an active intent, re-anchoring its band on the
// current live price and resetting the TTL. Leaves the intent untouched on any
// failure (returns the reason). Like cancel, the slashed coin goes in the body.
router.post('/entry-intents/replan', async (req: Request, res: Response) => {
  const { coin } = req.body
  if (!coin || typeof coin !== 'string') {
    return res.status(400).json({ error: 'coin required' })
  }
  const result = await replanEntryIntent(coin)
  if (!result.ok) {
    const status = result.error?.startsWith('No active entry intent') ? 404 : 400
    return res.status(status).json({ error: result.error })
  }
  res.json({ ok: true, intent: result.intent })
})

// Manually stage a coin onto the Entry Desk (a deferred BUY). Skips the
// research/analyst pipeline — a synthetic BUY runs the usual gauntlet, then the
// Entry Planner LLM picks the entry window, exactly like a pipeline BUY. Optional
// `notional` (USDC) overrides auto position sizing. Awaited so validation errors
// (already held, insufficient USDC, fee-edge, …) come straight back to the form.
router.post('/entry-intents/manual', async (req: Request, res: Response) => {
  const { coin, notional } = req.body
  if (!coin || typeof coin !== 'string') return res.status(400).json({ error: 'coin required' })
  const raw = coin.trim().toUpperCase()
  const symbol = raw.includes('/') ? raw : `${raw}/USDC`

  let notionalUsdc: number | undefined
  if (notional != null && notional !== '') {
    const n = Number(notional)
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'notional must be a positive number' })
    notionalUsdc = n
  }

  try {
    const result = await stageManualEntry({ symbol, notionalUsdc })
    if (!result.ok) return res.status(400).json({ error: result.error })
    logger.info('Manual entry staged by user', { coin: symbol, notionalUsdc })
    res.json({ ok: true, coin: result.coin })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/trade/approve/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid trade ID' })
  const trade = await tradesRepo.findOne({ _id: id, status: 'PENDING' }, { projection: { id: 1 } })
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

router.post('/trade/reject/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid trade ID' })
  const trade = await tradesRepo.findOne({ _id: id, status: 'PENDING' }, { projection: { id: 1 } })
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
    const id = await recordExecuted(coin, side, quantity, result.price, result.cost)
    res.json({ ok: true, id })
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
  const preCheck = fromSymbol === 'USDC' ? await getUsdcEntry() : ((await getOpenEntries()) as unknown as PortfolioEntry[]).find(e => e.coin === fromSymbol) ?? null
  if (!preCheck) return res.status(400).json({ error: `No open position for ${fromSymbol}` })
  if (preCheck.quantity < amount) return res.status(400).json({ error: `Insufficient balance: have ${preCheck.quantity}, need ${amount}` })

  try {
    // For sells: cap quantity to actual Binance free balance in case buy fees
    // were taken in the base currency (actual < recorded by ~0.1 %).
    let sellQty = amount
    if (toSymbol === 'USDC') {
      const openPos = (await getOpenPositions()).find(p => p.coin === fromSymbol)
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

    const tradeId = toSymbol === 'USDC'
      ? await recordExecuted(fromSymbol, 'SELL', sellQty, result.fromPrice, sellQty * result.fromPrice)
      : await recordExecuted(toSymbol, 'BUY', result.toAmount, result.toPrice, result.toAmount * result.toPrice)

    // Use the original `amount` (the full recorded entry quantity) for the local
    // ledger so fee-adjusted sells don't leave dust in portfolio_entries.
    // The USDC credit still uses result.toAmount (actual fill).
    await updatePortfolioForTrade(fromSymbol, amount, toSymbol, result.toAmount, result.toPrice, tradeId)

    res.json({
      ok: true,
      tradeId,
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
