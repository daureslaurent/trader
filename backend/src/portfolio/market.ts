import { logger } from '../core/logger.js'
import { MarketContext } from '../types.js'

interface OHLCV {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function computeSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function computeRSI(values: number[], period: number): number {
  if (values.length < period + 1) return 50
  const changes = []
  for (let i = 1; i < values.length; i++) changes.push(values[i] - values[i - 1])
  const recent = changes.slice(-period)
  const gains = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period
  const losses = recent.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - (100 / (1 + rs))
}

function computeATR(candles: OHLCV[], period: number): number {
  if (candles.length < period + 1) return 0
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }
  const recentTRs = trs.slice(-period)
  return recentTRs.reduce((a, b) => a + b, 0) / period
}

// ── Deterministic market-regime classification ──────────────────────────────
// The regime is derived purely from the SMA/RSI/ATR figures already computed in
// getMarketContext. Keeping it deterministic means a "regime" mistake can never
// cascade into a wrong trade direction or wrong SL/TP (to_fix.md #1b), and it
// removes that subtask from the LLM prompt entirely (#1a, #1c).

export type RegimeMomentum = 'overbought' | 'bullish' | 'neutral' | 'bearish' | 'oversold'

export interface MarketRegime {
  trend: 'uptrend' | 'downtrend' | 'ranging'
  volatility: 'high' | 'normal' | 'low'
  momentum: RegimeMomentum
  smaAlignment: 'bullish' | 'bearish' | 'mixed'
  /** One-line human-readable summary handed to the decision LLM. */
  summary: string
}

export function classifyRegime(m: MarketContext): MarketRegime {
  const smaAlignment: MarketRegime['smaAlignment'] =
    m.sma7 > m.sma25 && m.sma25 > (m.sma99 ?? 0) ? 'bullish'
    : m.sma7 < m.sma25 && m.sma25 < (m.sma99 ?? Infinity) ? 'bearish'
    : 'mixed'

  const momentum: RegimeMomentum =
    m.rsi14 >= 70 ? 'overbought'
    : m.rsi14 >= 55 ? 'bullish'
    : m.rsi14 > 45 ? 'neutral'
    : m.rsi14 > 30 ? 'bearish'
    : 'oversold'

  const summary =
    `${m.trend.toUpperCase()} · ${m.volatility}-volatility · ` +
    `RSI ${m.rsi14.toFixed(0)} (${momentum}) · SMA alignment ${smaAlignment}`

  return { trend: m.trend, volatility: m.volatility, momentum, smaAlignment, summary }
}

export async function getMarketContext(symbol: string, price: number): Promise<MarketContext> {
  try {
    const { getExchange } = await import('../trader/service.js')
    const exchange = getExchange()
    const ohlcvRaw: unknown[][] = await exchange.fetchOHLCV(symbol, '1h', undefined, 168)
    const candles: OHLCV[] = (ohlcvRaw || []).map(c => ({
      timestamp: c[0] as number,
      open: c[1] as number,
      high: c[2] as number,
      low: c[3] as number,
      close: c[4] as number,
      volume: c[5] as number,
    }))

    if (candles.length < 14) {
      logger.warn('Not enough OHLCV data for indicators', { symbol, count: candles.length })
      return {
        price, change24h: 0, volume: 0,
        rsi14: 50, sma7: price, sma25: price, sma99: price,
        atr14: 0, trend: 'ranging', perf7d: 0, volatility: 'normal',
      }
    }

    const closes = candles.map(c => c.close)
    const rsi14 = computeRSI(closes, 14)
    const sma7 = computeSMA(closes, 7)
    const sma25 = computeSMA(closes, 25)
    const sma99 = computeSMA(closes, Math.min(99, closes.length))
    const atr14 = computeATR(candles, 14)
    const perf7d = closes.length >= 168
      ? ((closes[closes.length - 1] - closes[closes.length - 168]) / closes[closes.length - 168]) * 100
      : 0

    let trend: 'uptrend' | 'downtrend' | 'ranging' = 'ranging'
    if (sma7 > sma25 && sma25 > sma99) trend = 'uptrend'
    else if (sma7 < sma25 && sma25 < sma99) trend = 'downtrend'

    const avgATR = computeATR(candles.slice(0, 168), 14) || atr14
    const volatility: 'high' | 'normal' | 'low' =
      atr14 > avgATR * 1.5 ? 'high' : atr14 < avgATR * 0.5 ? 'low' : 'normal'

    const lastCandle = candles[candles.length - 1]

    return {
      price,
      change24h: closes.length >= 24
        ? ((closes[closes.length - 1] - closes[closes.length - 25]) / closes[closes.length - 25]) * 100
        : 0,
      volume: lastCandle.volume,
      rsi14: Math.round(rsi14 * 10) / 10,
      sma7: Math.round(sma7 * 100) / 100,
      sma25: Math.round(sma25 * 100) / 100,
      sma99: Math.round(sma99 * 100) / 100,
      atr14: Math.round(atr14 * 100) / 100,
      trend,
      perf7d: Math.round(perf7d * 10) / 10,
      volatility,
    }
  } catch (err) {
    logger.warn('Failed to fetch market context', { symbol, error: err instanceof Error ? err.message : String(err) })
    return {
      price, change24h: 0, volume: 0,
      rsi14: 50, sma7: price, sma25: price, sma99: price,
      atr14: 0, trend: 'ranging', perf7d: 0, volatility: 'normal',
    }
  }
}
