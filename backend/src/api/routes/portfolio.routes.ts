import { Router, Request, Response } from 'express'
import { positions as positionsRepo, portfolioSnapshots, trades, getSettings, nowSql } from '../../db/index.js'
import { getExchange } from '../../trader/service.js'
import { logger } from '../../core/logger.js'
import { PortfolioEntry } from '../../types.js'
import * as priceCache from '../../market/index.js'
import { getOHLCV } from '../../market/index.js'
import {
  getOpenEntries, getAllEntries, getEntryById, addEntry, updateEntry, removeEntry,
  closeEntry, reduceEntryQuantity, enrichPortfolioEntriesWithPrices,
  depositUsdc, withdrawUsdc, getSlTpHistory,
} from '../../portfolio/index.js'
import { normalizeSymbol } from './helpers.js'

export const router = Router()

// Parse a 'YYYY-MM-DD HH:MM:SS' UTC string (as the DB stores) to epoch ms.
function sqlToMs(s: string): number {
  return new Date(s.replace(' ', 'T') + 'Z').getTime()
}

// Pick the close of the last candle at/before a target time (candles are ascending
// by `time`, in epoch seconds). Falls back to the earliest candle when the target
// predates our window. Returns null only when there are no candles at all.
function priceAtMs(candles: { time: number; close: number }[], targetMs: number): number | null {
  if (candles.length === 0) return null
  const targetSec = targetMs / 1000
  let chosen = candles[0]
  for (const c of candles) {
    if (c.time <= targetSec) chosen = c
    else break
  }
  return chosen.close
}

router.get('/portfolio', async (_req: Request, res: Response) => {
  try {
    const entries = (await getOpenEntries()) as unknown as PortfolioEntry[]
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

    const botPositionCount = await positionsRepo.count({ status: 'OPEN' })

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

// Manually capture a portfolio snapshot now (the same row the pipeline writes at
// the end of a full cycle). Useful to seed the "vs HODL" benchmark, which needs
// at least one snapshot before it can render. Values come from live cached prices.
router.post('/portfolio/snapshot', async (_req: Request, res: Response) => {
  try {
    const entries = await getOpenEntries()
    const symbols = entries.filter(e => e.coin !== 'USDC').map(e => e.coin)
    priceCache.subscribe(symbols)
    const allPrices = priceCache.getAll()

    let total = 0
    const holdings: Record<string, number> = {}
    for (const entry of entries) {
      if (entry.coin === 'USDC') {
        total += entry.quantity
        holdings[entry.coin] = entry.quantity
      } else {
        const price = allPrices.get(entry.coin)?.price
        if (price) {
          total += entry.quantity * price
          holdings[entry.coin] = entry.quantity
        }
      }
    }

    const created_at = nowSql()
    await portfolioSnapshots.insert({ total_value_usd: total, holdings: JSON.stringify(holdings), created_at })
    logger.info('Manual portfolio snapshot captured', { totalValue: total })
    res.json({ ok: true, total_value_usd: Math.round(total * 100) / 100, created_at })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.post('/portfolio/entry', async (req: Request, res: Response) => {
  const { coin, quantity, buy_price, buy_date, source } = req.body
  if (!coin || typeof coin !== 'string') return res.status(400).json({ error: 'coin required' })
  if (typeof quantity !== 'number' || quantity <= 0) return res.status(400).json({ error: 'quantity must be positive number' })
  if (typeof buy_price !== 'number' || buy_price <= 0) return res.status(400).json({ error: 'buy_price must be positive number' })
  const date = buy_date || new Date().toISOString().split('T')[0]
  const id = await addEntry(coin, quantity, buy_price, date, source || 'manual')
  res.json({ ok: true, id })
})

router.patch('/portfolio/entry/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const entry = await getEntryById(id)
  if (!entry) return res.status(404).json({ error: 'Entry not found' })
  const { quantity, buy_price, buy_date } = req.body
  await updateEntry(id, { quantity, buy_price, buy_date })
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

  const balance = await depositUsdc(amount)
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

  const result = await withdrawUsdc(amount)
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
      const id = await addEntry(symbol, quantity, buy_price, date, 'transfer')
      return res.json({ ok: true, id })
    }

    // to_binance: remove from local tracking FIFO
    const entries = ((await getOpenEntries()) as unknown as PortfolioEntry[]).filter(e => e.coin === symbol)
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
        await closeEntry(entry.id)
      } else {
        await reduceEntryQuantity(entry.id, remaining)
        remaining = 0
      }
    }

    return res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/portfolio/entry/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  await removeEntry(id)
  res.json({ ok: true })
})

router.get('/portfolio/gains', async (_req: Request, res: Response) => {
  try {
    const rows = (await positionsRepo.aggregate<{
      id: number; coin: string; quantity: number; entry_price: number
      status: string; pnl: number; opened_at: string; closed_at: string | null
    }>([
      { $match: { status: { $in: ['CLOSED', 'SL_HIT', 'TP_HIT'] }, pnl: { $ne: null }, coin: { $ne: 'USDC' } } },
      {
        $lookup: {
          from: 'sl_tp_history',
          let: { pid: '$id' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$position_id', '$$pid'] }, { $eq: ['$event', 'close'] }] } } }],
          as: 'closeEvt',
        },
      },
      { $addFields: { closeEvt: { $arrayElemAt: ['$closeEvt', 0] } } },
      { $addFields: { closed_at: '$closeEvt.created_at', sortKey: { $ifNull: ['$closeEvt.created_at', '$created_at'] } } },
      { $sort: { sortKey: -1 } },
      { $project: { _id: 0, id: 1, coin: 1, quantity: 1, entry_price: 1, status: 1, pnl: 1, opened_at: '$created_at', closed_at: 1 } },
    ]))

    const feeAgg = await trades.aggregate<{ total: number }>([
      { $match: { fee_currency: 'BNB', status: 'EXECUTED', fee_cost: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$fee_cost' } } },
    ])

    const total_pnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0)
    const total_bnb_fees = Math.round((feeAgg[0]?.total ?? 0) * 1e8) / 1e8

    res.json({
      total_pnl: Math.round(total_pnl * 100) / 100,
      total_bnb_fees,
      positions: rows.map(r => {
        const invested = r.quantity * r.entry_price
        const durationSeconds = Math.max(0, Math.floor(
          ((r.closed_at ? sqlToMs(r.closed_at) : Date.now()) - sqlToMs(r.opened_at)) / 1000,
        ))
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
          duration_seconds: durationSeconds,
        }
      }),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Benchmark the portfolio against simply holding a single reference coin (default
// BTC) since the first snapshot. Returns the anchor points (inception + 24h-ago
// portfolio value and the coin's price at those times + now); the client converts
// those into the "vs HODL" total/daily deltas against its live total value, so the
// strip stays in lock-step with the live "Total Value" KPI.
router.get('/portfolio/benchmark', async (req: Request, res: Response) => {
  try {
    const settings = getSettings()
    const requested = String(req.query.coin ?? '').trim().toUpperCase().replace('/USDC', '')
    const coin = requested || settings.benchmark_coin || 'BTC'
    if (coin === 'USDC') return res.json({ available: false, coin })
    const symbol = `${coin}/USDC`

    const snaps = (await portfolioSnapshots.find(
      {}, { sort: { created_at: 1 }, projection: { _id: 0, total_value_usd: 1, created_at: 1 } },
    )) as { total_value_usd: number; created_at: string }[]
    if (snaps.length === 0) return res.json({ available: false, coin })

    const first = snaps[0]
    const t0 = sqlToMs(first.created_at)
    const v0 = Number(first.total_value_usd)

    // Latest snapshot at/before 24h ago (falls back to inception when history < 24h).
    const dayAgoMs = Date.now() - 24 * 3600_000
    let dayRef = first
    for (const s of snaps) {
      if (sqlToMs(s.created_at) <= dayAgoMs) dayRef = s
      else break
    }
    const t24 = sqlToMs(dayRef.created_at)
    const v24 = Number(dayRef.total_value_usd)

    // Coin price at inception (daily candles back to t0) and 24h ago (hourly).
    const days = Math.min(1000, Math.max(2, Math.ceil((Date.now() - t0) / 86400_000) + 2))
    let p0: number | null = null
    let p24: number | null = null
    let pNow: number | null = null
    try {
      const daily = await getOHLCV(symbol, '1d', days)
      p0 = priceAtMs(daily, t0)
      pNow = daily.length ? daily[daily.length - 1].close : null
    } catch { /* leave null — handled below */ }
    try {
      const hourly = await getOHLCV(symbol, '1h', 48)
      p24 = priceAtMs(hourly, t24)
      if (pNow == null && hourly.length) pNow = hourly[hourly.length - 1].close
    } catch { /* leave null — handled below */ }
    // Prefer the live cached price for "now" so the delta tracks the live KPI.
    try {
      priceCache.subscribe([symbol])
      const live = priceCache.getPrice(symbol)
      if (live?.price) pNow = live.price
    } catch { /* ignore */ }

    if (v0 <= 0 || p0 == null || p0 <= 0 || p24 == null || p24 <= 0 || pNow == null || pNow <= 0) {
      return res.json({ available: false, coin })
    }

    res.json({
      available: true,
      coin,
      symbol,
      inception_value: Math.round(v0 * 100) / 100,
      inception_at: first.created_at,
      inception_coin_price: p0,
      day_ago_value: Math.round(v24 * 100) / 100,
      day_ago_at: dayRef.created_at,
      day_ago_coin_price: p24,
      coin_price_now: pNow,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/portfolio/history', async (_req: Request, res: Response) => {
  try {
    const entries = await getAllEntries()
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

router.get('/portfolio/snapshots', async (req: Request, res: Response) => {
  try {
    const RANGE_MS: Record<string, number> = {
      '24h': 24 * 3600_000,
      '7d': 7 * 86400_000,
      '30d': 30 * 86400_000,
    }
    const range = String(req.query.range ?? 'all')
    const ms = RANGE_MS[range]
    const filter = ms
      ? { created_at: { $gte: new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19) } }
      : {}
    const rows = await portfolioSnapshots.find(filter, {
      sort: { created_at: 1 }, projection: { _id: 0, total_value_usd: 1, created_at: 1 },
    })
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/sl-tp/:coin', async (req: Request, res: Response) => {
  try {
    const raw = decodeURIComponent(req.params.coin).trim().toUpperCase()
    const coin = raw.includes('/') ? raw : `${raw}/USDC`
    res.json(await getSlTpHistory(coin))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
