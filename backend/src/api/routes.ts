import { Router, Request, Response } from 'express'
import { queryAll, queryOne, runSQL, getSettings, updateSetting } from '../db/index.js'
import { getRunningLLMCalls } from '../core/llm.js'
import { executeTrade, executeCoinTrade, fetchBalance } from '../trader/index.js'
import { getExchange } from '../trader/service.js'
import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { Signal, PortfolioEntry } from '../types.js'
import * as priceCache from '../market/index.js'
import { getDiscoveries, approveDiscovery, rejectDiscovery, deleteDiscovery, isRunning } from '../discoverer/index.js'
import { getReviews, getNotes as getMonitorNotes, isRunning as isMonitorRunning } from '../monitor/index.js'
import { isPipelineRunning, getPendingApprovals } from '../index.js'
import { isTradeable } from '../core/tradeable.js'

import { getOpenEntries, getAllEntries, getEntryById, addEntry, updateEntry, removeEntry, closeEntry, reduceEntryQuantity, enrichPortfolioEntriesWithPrices, depositUsdt, withdrawUsdt, getUsdtEntry, updatePortfolioForTrade, getSlTpHistory, cancelProtection, getOpenPositions, closePositionFromExit } from '../portfolio/index.js'

function normalizeSymbol(coin: string): string {
  const upper = coin.trim().toUpperCase()
  if (upper === 'USDC') return 'USDC'
  return upper.includes('/') ? upper : `${upper}/USDC`
}

export const router = Router()

router.get('/portfolio', async (_req: Request, res: Response) => {
  try {
    const entries = getOpenEntries() as unknown as PortfolioEntry[]
    const symbols = entries.filter(e => e.coin !== 'USDC').map(e => e.coin)
    priceCache.subscribe(symbols)
    const allPrices = priceCache.getAll()
    const marketData = symbols.map(s => {
      const snap = allPrices.get(s)
      return { symbol: s, price: snap?.price ?? 0, change24h: snap?.change24h ?? 0, volume: snap?.volume ?? 0 }
    })
    const enriched = enrichPortfolioEntriesWithPrices(entries, marketData)
    const totalValue = enriched.reduce((sum, e) => sum + ((e.current_price ?? 0) * e.quantity), 0)
    const settings = getSettings()

    let binanceUsdc: number | null = null
    try {
      const exchange = getExchange()
      const bal = await exchange.fetchBalance()
      binanceUsdc = (bal.free as unknown as Record<string, number>)['USDC'] ?? 0
    } catch {
      // Binance unavailable — leave null
    }

    const localUsdc = entries.find(e => e.coin === 'USDC')?.quantity ?? 0

    const botPositionCount = (queryAll("SELECT COUNT(*) AS cnt FROM positions WHERE status = 'OPEN'")[0]?.cnt as number) ?? 0

    res.json({
      total_value: Math.round(totalValue * 100) / 100,
      entries: enriched,
      open_position_count: botPositionCount,
      holdings_count: enriched.filter(e => e.coin !== 'USDC').length,
      max_open_positions: settings.max_open_positions,
      binance_usdc: binanceUsdc,
      available_usdc: binanceUsdc !== null ? Math.max(0, binanceUsdc - localUsdc) : null,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/portfolio/entry', (req: Request, res: Response) => {
  const { coin, quantity, buy_price, buy_date, source } = req.body
  if (!coin || typeof coin !== 'string') return res.status(400).json({ error: 'coin required' })
  if (typeof quantity !== 'number' || quantity <= 0) return res.status(400).json({ error: 'quantity must be positive number' })
  if (typeof buy_price !== 'number' || buy_price <= 0) return res.status(400).json({ error: 'buy_price must be positive number' })
  const date = buy_date || new Date().toISOString().split('T')[0]
  const id = addEntry(coin, quantity, buy_price, date, source || 'manual')
  res.json({ ok: true, id })
})

router.patch('/portfolio/entry/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const entry = getEntryById(id)
  if (!entry) return res.status(404).json({ error: 'Entry not found' })
  const { quantity, buy_price, buy_date } = req.body
  updateEntry(id, { quantity, buy_price, buy_date })
  res.json({ ok: true })
})

router.post('/portfolio/usdc/deposit', async (req: Request, res: Response) => {
  const { amount } = req.body
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' })
  }

  try {
    const exchange = getExchange()
    logger.info('🛸 Binance fetchBalance')
    const bal = await exchange.fetchBalance()
    const binanceUsdc = (bal.free as unknown as Record<string, number>)['USDC'] ?? 0
    if (binanceUsdc < amount) {
      return res.status(400).json({
        error: `Insufficient Binance balance: ${binanceUsdc.toFixed(2)} USDC available`,
        binance_balance: binanceUsdc,
      })
    }
  } catch (err) {
    return res.status(502).json({ error: 'Could not verify Binance balance: ' + (err instanceof Error ? err.message : String(err)) })
  }

  const balance = depositUsdt(amount)
  res.json({ ok: true, balance })
})

router.post('/portfolio/usdc/withdraw', async (req: Request, res: Response) => {
  const { amount } = req.body
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' })
  }

  try {
    const exchange = getExchange()
    logger.info('🛸 Binance fetchBalance')
    const bal = await exchange.fetchBalance()
    const binanceUsdt = (bal.free as unknown as Record<string, number>)['USDC'] ?? 0
    if (binanceUsdt < amount) {
      return res.status(400).json({
        error: `Insufficient Binance balance: ${binanceUsdt.toFixed(2)} USDC available`,
        binance_balance: binanceUsdt,
      })
    }
  } catch (err) {
    return res.status(502).json({ error: 'Could not verify Binance balance: ' + (err instanceof Error ? err.message : String(err)) })
  }

  const result = withdrawUsdt(amount)
  if (!result.ok) return res.status(400).json({ error: result.error, balance: result.balance })
  res.json({ ok: true, balance: result.balance })
})

router.get('/binance/balance', async (_req: Request, res: Response) => {
  try {
    const exchange = getExchange()
    logger.info('🛸 Binance fetchBalance')
    const bal = await exchange.fetchBalance()
    const free = bal.free as unknown as Record<string, number>
    const nonZero = Object.fromEntries(Object.entries(free).filter(([, v]) => (v ?? 0) > 0))
    res.json(nonZero)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/portfolio/transfer', async (req: Request, res: Response) => {
  const { direction, coin, quantity, buy_price } = req.body

  if (!['from_binance', 'to_binance'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be from_binance or to_binance' })
  }
  if (!coin || typeof coin !== 'string') {
    return res.status(400).json({ error: 'coin required' })
  }
  if (typeof quantity !== 'number' || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' })
  }

  const symbol = normalizeSymbol(coin)
  if (symbol === 'USDC') {
    return res.status(400).json({ error: 'Use deposit/withdraw for USDC' })
  }

  try {
    if (direction === 'from_binance') {
      if (typeof buy_price !== 'number' || buy_price <= 0) {
        return res.status(400).json({ error: 'buy_price required for Binance → Local transfer' })
      }

      {
        const exchange = getExchange()
        logger.info('🛸 Binance fetchBalance')
        const bal = await exchange.fetchBalance()
        const asset = symbol.split('/')[0]
        const available = (bal.free as unknown as Record<string, number>)[asset] ?? 0
        if (available < quantity) {
          return res.status(400).json({
            error: `Insufficient Binance balance: ${available} ${asset} available`,
            binance_balance: available,
          })
        }
      }

      const date = new Date().toISOString().split('T')[0]
      const id = addEntry(symbol, quantity, buy_price, date, 'transfer')
      return res.json({ ok: true, id })
    }

    // to_binance: remove from local tracking FIFO
    const entries = (getOpenEntries() as unknown as PortfolioEntry[]).filter(e => e.coin === symbol)
    if (entries.length === 0) {
      return res.status(400).json({ error: `No open local position for ${symbol}` })
    }

    const totalLocal = entries.reduce((s, e) => s + e.quantity, 0)
    if (quantity > totalLocal + 1e-10) {
      const asset = symbol.split('/')[0]
      return res.status(400).json({
        error: `Insufficient local balance: ${totalLocal} ${asset} available`,
        local_balance: totalLocal,
      })
    }

    let remaining = quantity
    for (const entry of entries) {
      if (remaining <= 1e-10) break
      if (entry.quantity <= remaining + 1e-10) {
        remaining -= entry.quantity
        closeEntry(entry.id)
      } else {
        reduceEntryQuantity(entry.id, remaining)
        remaining = 0
      }
    }

    return res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/portfolio/entry/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  removeEntry(id)
  res.json({ ok: true })
})

router.get('/portfolio/gains', (_req: Request, res: Response) => {
  try {
    const rows = queryAll(`
      SELECT
        p.id,
        p.coin,
        p.quantity,
        p.entry_price,
        p.status,
        p.pnl,
        p.created_at                                                   AS opened_at,
        h.created_at                                                   AS closed_at,
        CAST((julianday(COALESCE(h.created_at, 'now')) - julianday(p.created_at)) * 86400 AS INTEGER)
                                                                       AS duration_seconds
      FROM positions p
      LEFT JOIN sl_tp_history h ON h.position_id = p.id AND h.event = 'close'
      WHERE p.status IN ('CLOSED', 'SL_HIT', 'TP_HIT')
        AND p.pnl IS NOT NULL
        AND p.coin != 'USDC'
      ORDER BY COALESCE(h.created_at, p.created_at) DESC
    `) as {
      id: number; coin: string; quantity: number; entry_price: number
      status: string; pnl: number; opened_at: string; closed_at: string | null
      duration_seconds: number
    }[]

    const feeRow = queryOne(`
      SELECT SUM(fee_cost) AS total_bnb_fees
      FROM trades
      WHERE fee_currency = 'BNB' AND status = 'EXECUTED' AND fee_cost > 0
    `) as { total_bnb_fees: number | null } | null

    const total_pnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0)
    const total_bnb_fees = Math.round((feeRow?.total_bnb_fees ?? 0) * 1e8) / 1e8

    res.json({
      total_pnl: Math.round(total_pnl * 100) / 100,
      total_bnb_fees,
      positions: rows.map(r => {
        const invested = r.quantity * r.entry_price
        return {
          id: r.id,
          coin: r.coin,
          quantity: r.quantity,
          entry_price: r.entry_price,
          status: r.status,
          pnl: Math.round((r.pnl ?? 0) * 100) / 100,
          pnl_pct: invested > 0 ? Math.round(((r.pnl ?? 0) / invested) * 10000) / 100 : 0,
          opened_at: r.opened_at,
          closed_at: r.closed_at,
          duration_seconds: r.duration_seconds ?? 0,
        }
      }),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/portfolio/history', (_req: Request, res: Response) => {
  try {
    const entries = getAllEntries()
    const symbols = [...new Set(entries.filter(e => e.status === 'OPEN').map(e => e.coin))]
    priceCache.subscribe(symbols)
    const allPrices = priceCache.getAll()
    const marketData = symbols.map(s => {
      const snap = allPrices.get(s)
      return { symbol: s, price: snap?.price ?? 0, change24h: 0, volume: 0 }
    })
    const enriched = enrichPortfolioEntriesWithPrices(entries, marketData)
    res.json(enriched)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/portfolio/snapshots', (req: Request, res: Response) => {
  try {
    const RANGES: Record<string, string> = {
      '24h': '-24 hours',
      '7d': '-7 days',
      '30d': '-30 days',
    }
    const range = String(req.query.range ?? 'all')
    const modifier = RANGES[range]
    const rows = (modifier
      ? queryAll(
          "SELECT total_value_usd, created_at FROM portfolio_snapshots WHERE created_at >= datetime('now', ?) ORDER BY created_at ASC",
          [modifier]
        )
      : queryAll('SELECT total_value_usd, created_at FROM portfolio_snapshots ORDER BY created_at ASC')
    ) as { total_value_usd: number; created_at: string }[]
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/positions', (_req: Request, res: Response) => {
  try {
    const positions = queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as Record<string, unknown>[]
    if (positions.length === 0) return res.json([])
    const coins = [...new Set(positions.map(p => p.coin as string))]
    priceCache.subscribe(coins)
    const allPrices = priceCache.getAll()
    const enriched = positions.map((pos) => {
      const snap = allPrices.get(pos.coin as string)
      const currentPrice = snap?.price || (pos.entry_price as number)
      const pnl = (pos.quantity as number) * (currentPrice - (pos.entry_price as number))
      const pnlPct = ((currentPrice - (pos.entry_price as number)) / (pos.entry_price as number)) * 100
      const distanceToSlPct = pos.stop_loss ? ((currentPrice - (pos.stop_loss as number)) / currentPrice) * 100 : null
      const distanceToTpPct = pos.take_profit ? (((pos.take_profit as number) - currentPrice) / currentPrice) * 100 : null
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

router.patch('/positions/:id/horizon', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const { horizon } = req.body as { horizon?: string }
    if (!['short', 'medium', 'long', 'disabled', 'llm'].includes(horizon ?? '')) {
      return res.status(400).json({ error: 'horizon must be short, medium, long, disabled, or llm' })
    }
    const pos = queryOne("SELECT id FROM positions WHERE id = ? AND status = 'OPEN'", [id])
    if (!pos) return res.status(404).json({ error: 'Position not found' })
    runSQL('UPDATE positions SET horizon = ? WHERE id = ?', [horizon!, id])
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

    const pos = queryOne("SELECT * FROM positions WHERE id = ? AND status = 'OPEN'", [id]) as Record<string, unknown> | null
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

    const closed = closePositionFromExit({
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

router.get('/sl-tp/:coin', (req: Request, res: Response) => {
  try {
    const raw = decodeURIComponent(req.params.coin).trim().toUpperCase()
    const coin = raw.includes('/') ? raw : `${raw}/USDC`
    res.json(getSlTpHistory(coin))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

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
  const preCheck = fromSymbol === 'USDC' ? getUsdtEntry() : (getOpenEntries() as unknown as PortfolioEntry[]).find(e => e.coin === fromSymbol) ?? null
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

router.get('/price/:symbol', async (req: Request, res: Response) => {
  try {
    const raw = req.params.symbol.trim().toUpperCase()
    const symbol = raw === 'USDC' ? 'USDC' : (raw.includes('/') ? raw : `${raw}/USDC`)
    if (symbol === 'USDC') return res.json({ symbol: 'USDC', price: 1, change24h: 0, volume: 0 })

    // Ensure this symbol is tracked by the WS stream going forward
    priceCache.subscribe([symbol])

    const snap = priceCache.getPrice(symbol)
    if (snap && Date.now() - snap.updatedAt < 10_000) {
      return res.json({ symbol, price: snap.price, change24h: snap.change24h, volume: snap.volume })
    }

    // Cache cold (first request for this symbol) — fall back to REST once, then WS takes over
    logger.info('🛸 Binance fetchTicker (cache cold)', { symbol })
    const exchange = getExchange()
    const ticker = await exchange.fetchTicker(symbol)
    return res.json({ symbol, price: ticker.last ?? 0, change24h: ticker.percentage ?? 0, volume: ticker.quoteVolume ?? 0 })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/ohlcv/:symbol', async (req: Request, res: Response) => {
  try {
    const raw = req.params.symbol.trim().toUpperCase()
    const symbol = raw.includes('/') ? raw : `${raw}/USDC`
    if (symbol === 'USDC' || !isTradeable(symbol)) {
      return res.status(400).json({ error: `No candlestick data for ${symbol}` })
    }

    const tf = (req.query.tf as string) || '1h'
    if (!priceCache.isTimeframe(tf)) {
      return res.status(400).json({ error: `Unsupported timeframe "${tf}". Use one of ${priceCache.SUPPORTED_TIMEFRAMES.join(', ')}` })
    }

    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '150', 10) || 150, 10), 1000)
    const candles = await priceCache.getOHLCV(symbol, tf, limit)
    res.json({ symbol, timeframe: tf, candles })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── Extraction cache ────────────────────────────────────────────────────────

router.get('/cache', (_req: Request, res: Response) => {
  try {
    const rows = queryAll(
      "SELECT coin, COUNT(*) as count FROM extraction_cache GROUP BY coin ORDER BY coin ASC"
    ) as { coin: string; count: number }[]
    const total = rows.reduce((s, r) => s + r.count, 0)
    res.json({ coins: rows, total })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/cache/:coin', (req: Request, res: Response) => {
  try {
    const coin = decodeURIComponent(req.params.coin)
    const rows = queryAll(
      'SELECT url, coin, data, cached_at FROM extraction_cache WHERE coin = ? ORDER BY cached_at DESC',
      [coin]
    ) as { url: string; coin: string; data: string; cached_at: string }[]
    const articles = rows.map(r => {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(r.data) } catch {}
      return { url: r.url, coin: r.coin, cached_at: r.cached_at, ...parsed }
    })
    res.json(articles)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache', (_req: Request, res: Response) => {
  try {
    const info = runSQL('DELETE FROM extraction_cache')
    res.json({ ok: true, deleted: info.changes })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache/coin/:coin', (req: Request, res: Response) => {
  try {
    const coin = decodeURIComponent(req.params.coin)
    const info = runSQL('DELETE FROM extraction_cache WHERE coin = ?', [coin])
    res.json({ ok: true, deleted: info.changes })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache/article', (req: Request, res: Response) => {
  try {
    const { url } = req.body
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' })
    runSQL('DELETE FROM extraction_cache WHERE url = ?', [url])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── Discover pipeline ──────────────────────────────────────────────────────

router.get('/discover', (_req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((_req.query.limit as string) || '50', 10), 1), 200)
    const discoveries = getDiscoveries(limit)
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
  const discovery = queryOne('SELECT coin FROM coin_discoveries WHERE id = ?', [id]) as { coin: string } | null
  if (!discovery) return res.status(404).json({ error: 'Discovery not found' })

  try {
    const ticker = await getExchange().fetchTicker(discovery.coin)
    if (!ticker?.last || ticker.last === 0) {
      return res.status(400).json({ error: `${discovery.coin} has no price on Binance — may not be a valid USDC pair` })
    }
  } catch {
    return res.status(400).json({ error: `${discovery.coin} is not tradeable on Binance as a USDC pair` })
  }

  const result = approveDiscovery(id)
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json({ ok: true })
})

router.post('/discover/reject/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const result = rejectDiscovery(id)
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json({ ok: true })
})

router.delete('/discover/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  deleteDiscovery(id)
  res.json({ ok: true })
})

// ── Position Monitor ───────────────────────────────────────────────────────

router.get('/monitor', (_req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((_req.query.limit as string) || '100', 10), 1), 500)
    const reviews = getReviews(limit)
    res.json({ running: isMonitorRunning(), reviews, notes: getMonitorNotes() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
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

// ── LLM call log ──────────────────────────────────────────────────────────────

router.get('/llm-calls/running', (_req: Request, res: Response) => {
  res.json(getRunningLLMCalls())
})

router.get('/llm-calls', (req: Request, res: Response) => {
  try {
    const defaultLimit = getSettings().llm_debug_fetch_limit || 200
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || String(defaultLimit), 10), 1), 2000)
    const module = req.query.module as string | undefined
    const coin = req.query.coin as string | undefined

    let sql = 'SELECT id, module, model, base_url, response, reasoning_content, error, prompt_tokens, completion_tokens, thinking_tokens, duration_ms, coin, cycle_id, created_at FROM llm_calls'
    const params: (string | number)[] = []
    const conditions: string[] = []

    if (module) { conditions.push('module = ?'); params.push(module) }
    if (coin) { conditions.push('coin = ?'); params.push(coin) }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    res.json(queryAll(sql, params))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/llm-calls/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
    const call = queryOne('SELECT * FROM llm_calls WHERE id = ?', [id])
    if (!call) return res.status(404).json({ error: 'Not found' })
    res.json(call)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/llm-calls', (_req: Request, res: Response) => {
  try {
    runSQL('DELETE FROM llm_calls')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/llm-stats-snapshots', (_req: Request, res: Response) => {
  try {
    const rows = queryAll('SELECT module, model, base_url, call_count, error_count, total_duration_ms, total_prompt_tokens, total_completion_tokens, total_thinking_tokens FROM llm_stats_snapshots')
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/settings', (_req: Request, res: Response) => {
  res.json(getSettings())
})

router.put('/settings', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>
  for (const [key, value] of Object.entries(body)) {
    updateSetting(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const updated = getSettings()
  bus.emit('settings_updated', updated as import('../types.js').BotSettings)
  res.json(updated)
})
