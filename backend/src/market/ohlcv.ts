import { logger } from '../core/logger.js'
import { queryOne, runSQL } from '../db/index.js'

export interface Candle {
  time: number   // epoch seconds (chart-friendly)
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export const SUPPORTED_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Timeframe = (typeof SUPPORTED_TIMEFRAMES)[number]

// How long a cached series stays fresh before we re-hit Binance.
// Short relative to the candle width — the most recent candle keeps moving.
const TTL_MS: Record<Timeframe, number> = {
  '1m': 15_000,
  '5m': 30_000,
  '15m': 60_000,
  '1h': 5 * 60_000,
  '4h': 10 * 60_000,
  '1d': 15 * 60_000,
}

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}

export function isTimeframe(tf: string): tf is Timeframe {
  return (SUPPORTED_TIMEFRAMES as readonly string[]).includes(tf)
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

async function fetchFromBinance(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const { getExchange } = await import('../trader/service.js')
  const exchange = getExchange()
  logger.info('🛸 Binance fetchOHLCV', { symbol, timeframe, limit })
  const raw: unknown[][] = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit)
  return (raw || []).map(c => ({
    time: Math.floor((c[0] as number) / 1000),
    open: c[1] as number,
    high: c[2] as number,
    low: c[3] as number,
    close: c[4] as number,
    volume: c[5] as number,
  }))
}

/**
 * Returns OHLCV candles for a symbol/timeframe, served from the cache table when
 * fresh and re-fetched from Binance otherwise.
 */
export async function getOHLCV(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const cacheKey = `${symbol}|${timeframe}`
  const cached = queryOne(
    'SELECT data, fetched_at FROM ohlcv_cache WHERE cache_key = ?',
    [cacheKey]
  ) as { data: string; fetched_at: number } | null

  if (cached) {
    const age = Date.now() - cached.fetched_at
    if (age < TTL_MS[timeframe]) {
      try {
        const candles = JSON.parse(cached.data) as Candle[]
        if (candles.length >= limit) return candles.slice(-limit)
      } catch { /* fall through to refetch */ }
    }
  }

  // Fetch a generous window so smaller requests can be served from one cache row.
  const fetchLimit = Math.min(Math.max(limit, 200), 1000)
  let candles: Candle[]
  try {
    candles = await fetchFromBinance(symbol, timeframe, fetchLimit)
  } catch (err) {
    // On failure, serve stale cache if we have any.
    if (cached) {
      try { return (JSON.parse(cached.data) as Candle[]).slice(-limit) } catch { /* ignore */ }
    }
    throw err
  }

  runSQL(
    'INSERT OR REPLACE INTO ohlcv_cache (cache_key, symbol, timeframe, data, fetched_at) VALUES (?, ?, ?, ?, ?)',
    [cacheKey, symbol, timeframe, JSON.stringify(candles), Date.now()]
  )

  return candles.slice(-limit)
}
