import { Router, Request, Response } from 'express'
import { queryAll, queryOne, runSQL, getSettings, updateSetting } from '../db/index.js'
import { executeTrade, executeCoinTrade } from '../trader/index.js'
import { getExchange } from '../trader/service.js'
import { config } from '../config/index.js'
import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { Signal, PortfolioEntry } from '../types.js'
import * as priceCache from '../market/index.js'

import { getOpenEntries, getAllEntries, getEntryById, addEntry, updateEntry, removeEntry, enrichPortfolioEntriesWithPrices, depositUsdt, withdrawUsdt, getUsdtEntry, updatePortfolioForTrade } from '../portfolio/index.js'

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
    if (!config.stub) {
      try {
        const exchange = getExchange()
        const bal = await exchange.fetchBalance()
        binanceUsdc = (bal.free as unknown as Record<string, number>)['USDC'] ?? 0
      } catch {
        // Binance unavailable — leave null
      }
    }

    const localUsdc = entries.find(e => e.coin === 'USDC')?.quantity ?? 0

    res.json({
      total_value: Math.round(totalValue * 100) / 100,
      entries: enriched,
      open_position_count: enriched.filter(e => e.coin !== 'USDC').length,
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

  if (!config.stub) {
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
  }

  const balance = depositUsdt(amount)
  res.json({ ok: true, balance })
})

router.post('/portfolio/usdc/withdraw', async (req: Request, res: Response) => {
  const { amount } = req.body
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' })
  }

  if (!config.stub) {
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
  }

  const result = withdrawUsdt(amount)
  if (!result.ok) return res.status(400).json({ error: result.error, balance: result.balance })
  res.json({ ok: true, balance: result.balance })
})

router.delete('/portfolio/entry/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  removeEntry(id)
  res.json({ ok: true })
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
      }
    })
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

router.post('/pipeline/run', (req: Request, res: Response) => {
  const { coin } = req.body
  if (!coin || typeof coin !== 'string') return res.status(400).json({ error: 'coin required' })
  const raw = coin.trim().toUpperCase()
  const symbol = raw.includes('/') ? raw : `${raw}/USDC`
  const cycleId = `${Date.now().toString(36)}-manual`
  bus.emit('pipeline_run_requested', { symbol, cycle_id: cycleId })
  res.json({ ok: true, cycle_id: cycleId })
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
    const result = await executeCoinTrade(fromSymbol, toSymbol, amount)

    let tradeInfo: ReturnType<typeof runSQL>
    if (toSymbol === 'USDC') {
      tradeInfo = runSQL(
        'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [fromSymbol, 'SELL', amount, result.fromPrice, amount * result.fromPrice, 'EXECUTED', 1]
      )
    } else {
      tradeInfo = runSQL(
        'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [toSymbol, 'BUY', result.toAmount, result.toPrice, result.toAmount * result.toPrice, 'EXECUTED', 1]
      )
    }

    updatePortfolioForTrade(fromSymbol, amount, toSymbol, result.toAmount, result.toPrice, tradeInfo.lastInsertRowid)

    res.json({
      ok: true,
      tradeId: tradeInfo.lastInsertRowid,
      fromSymbol,
      toSymbol,
      fromAmount: amount,
      toAmount: result.toAmount,
      fromPrice: result.fromPrice,
      toPrice: result.toPrice,
      fee: result.fee,
    })
  } catch (err) {
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
    if (!config.stub) {
      logger.info('🛸 Binance fetchTicker (cache cold)', { symbol })
      const exchange = getExchange()
      const ticker = await exchange.fetchTicker(symbol)
      return res.json({ symbol, price: ticker.last ?? 0, change24h: ticker.percentage ?? 0, volume: ticker.quoteVolume ?? 0 })
    }

    return res.json({ symbol, price: snap?.price ?? 10, change24h: snap?.change24h ?? 0, volume: 0 })
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
