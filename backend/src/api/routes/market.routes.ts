import { Router, Request, Response } from 'express'
import { logger } from '../../core/logger.js'
import { getExchange } from '../../trader/service.js'
import * as priceCache from '../../market/index.js'
import { isTradeable } from '../../core/tradeable.js'

export const router = Router()

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
