import { Router, Request, Response } from 'express'
import { queryAll, queryOne, getSettings } from '../../db/index.js'
import { getExchange } from '../../trader/service.js'
import { logger } from '../../core/logger.js'
import { PortfolioEntry } from '../../types.js'
import * as priceCache from '../../market/index.js'
import {
  getOpenEntries, getAllEntries, getEntryById, addEntry, updateEntry, removeEntry,
  closeEntry, reduceEntryQuantity, enrichPortfolioEntriesWithPrices,
  depositUsdc, withdrawUsdc, getSlTpHistory,
} from '../../portfolio/index.js'
import { normalizeSymbol } from './helpers.js'

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

  const balance = depositUsdc(amount)
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

  const result = withdrawUsdc(amount)
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

router.get('/sl-tp/:coin', (req: Request, res: Response) => {
  try {
    const raw = decodeURIComponent(req.params.coin).trim().toUpperCase()
    const coin = raw.includes('/') ? raw : `${raw}/USDC`
    res.json(getSlTpHistory(coin))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
