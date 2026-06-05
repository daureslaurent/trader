import { Router, Request, Response } from 'express'
import { queryAll, queryOne, runSQL, getSettings, updateSetting } from '../db/index.js'
import { executeTrade } from '../trader/index.js'
import { bus } from '../core/events.js'
import { Signal } from '../types.js'

import { getOpenEntries, getAllEntries, getEntryById, addEntry, updateEntry, removeEntry, enrichPortfolioEntriesWithPrices } from '../portfolio/index.js'

export const router = Router()

router.get('/portfolio', async (_req: Request, res: Response) => {
  try {
    const { getExchange } = await import('../trader/service.js')
    const exchange = getExchange()
    const entries = getOpenEntries()
    const symbols = entries.map(e => e.coin)
    const tickers = symbols.length > 0 ? await exchange.fetchTickers(symbols) : {}

    const bal = await exchange.fetchBalance()
    const usdtBalance = (bal.total as unknown as Record<string, number>)['USDT'] || 0

    const marketData = symbols.map(s => ({
      symbol: s,
      price: ((tickers as any)[s]?.last) || 0,
      change24h: ((tickers as any)[s]?.percentage) || 0,
      volume: ((tickers as any)[s]?.quoteVolume) || 0,
    }))

    const enriched = enrichPortfolioEntriesWithPrices(entries, marketData)

    const totalValue = enriched.reduce((sum, e) => sum + ((e.current_price ?? 0) * e.quantity), 0) + usdtBalance

    res.json({
      total_value_usd: Math.round(totalValue * 100) / 100,
      entries: enriched,
      usdt_balance: usdtBalance,
      open_position_count: enriched.length,
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

router.delete('/portfolio/entry/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  removeEntry(id)
  res.json({ ok: true })
})

router.get('/portfolio/history', async (_req: Request, res: Response) => {
  try {
    const { getExchange } = await import('../trader/service.js')
    const exchange = getExchange()
    const entries = getAllEntries()
    const symbols = [...new Set(entries.filter(e => e.status === 'OPEN').map(e => e.coin))]
    const tickers = symbols.length > 0 ? await exchange.fetchTickers(symbols) : {}
    const marketData = symbols.map(s => ({
      symbol: s,
      price: ((tickers as any)[s]?.last) || 0,
      change24h: 0,
      volume: 0,
    }))
    const enriched = enrichPortfolioEntriesWithPrices(entries, marketData)
    res.json(enriched)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/positions', async (_req: Request, res: Response) => {
  try {
    const positions = queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as Record<string, unknown>[]
    if (positions.length === 0) return res.json([])
    const { getExchange } = await import('../trader/service.js')
    const exchange = getExchange()
    const enriched = await Promise.all(positions.map(async (pos) => {
      try {
        const ticker = await exchange.fetchTicker(pos.coin as string)
        const currentPrice = ticker.last || (pos.entry_price as number)
        const pnl = (pos.quantity as number) * (currentPrice - (pos.entry_price as number))
        const pnlPct = ((currentPrice - (pos.entry_price as number)) / (pos.entry_price as number)) * 100
        const distanceToSlPct = pos.stop_loss ? ((currentPrice - (pos.stop_loss as number)) / currentPrice) * 100 : null
        const distanceToTpPct = pos.take_profit ? (((pos.take_profit as number) - currentPrice) / currentPrice) * 100 : null
        return {
          id: pos.id,
          coin: pos.coin,
          quantity: pos.quantity,
          entry_price: pos.entry_price,
          current_price: currentPrice,
          pnl,
          pnl_pct: Math.round(pnlPct * 100) / 100,
          stop_loss: pos.stop_loss,
          take_profit: pos.take_profit,
          distance_to_sl_pct: distanceToSlPct ? Math.round(distanceToSlPct * 100) / 100 : null,
          distance_to_tp_pct: distanceToTpPct ? Math.round(distanceToTpPct * 100) / 100 : null,
          status: pos.status,
        }
      } catch {
        return {
          id: pos.id,
          coin: pos.coin,
          quantity: pos.quantity,
          entry_price: pos.entry_price,
          current_price: null, pnl: null, pnl_pct: null,
          stop_loss: pos.stop_loss, take_profit: pos.take_profit,
          distance_to_sl_pct: null, distance_to_tp_pct: null,
          status: pos.status,
        }
      }
    }))
    res.json(enriched)
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

router.post('/trade/approve/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid trade ID' })
  const trade = queryOne("SELECT id FROM trades WHERE id = ? AND status = 'PENDING'", [id])
  if (!trade) return res.status(404).json({ error: 'Trade not found or not pending' })
  bus.emit('trade_approved', id)
  res.json({ ok: true })
})

router.post('/trade/reject/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid trade ID' })
  const trade = queryOne("SELECT id FROM trades WHERE id = ? AND status = 'PENDING'", [id])
  if (!trade) return res.status(404).json({ error: 'Trade not found or not pending' })
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
      'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [coin, side, quantity, result.price, result.cost, 'EXECUTED', 1]
    )
    res.json({ ok: true, id: info.lastInsertRowid })
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
  res.json(getSettings())
})
