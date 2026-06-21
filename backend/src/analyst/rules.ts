import { logger } from '../core/logger.js'
import { getSettings, decisions } from '../db/index.js'
import { classifyRegime } from '../portfolio/market.js'
import { computeRiskLevels } from '../portfolio/risk.js'
import { Signal, MarketContext, PortfolioState } from '../types.js'

/**
 * Deterministic, LLM-free analyst used in offline mode (see core/offlineMode.ts). It mirrors
 * the contract of analyzeSignal(): produce a BUY/HOLD Signal with a [0,1] confidence and, for a
 * BUY, the same ATR/horizon-derived SL/TP percentages via computeRiskLevels(). Only the
 * *direction/confidence* judgement is replaced — every downstream gate and the execution layer
 * are reused unchanged.
 *
 * Strategy: trend + momentum. A BUY needs an established uptrend with non-bearish SMA alignment,
 * healthy (not overbought) RSI momentum, and price holding above the fast MA. Confidence scales
 * with how many of those line up. The pipeline only acts on BUYs for un-held watchlist coins, so
 * a non-BUY simply resolves to HOLD (no SELL is emitted here).
 */

// Resolve the risk horizon the same way the LLM analyst does, minus the LLM's per-trade pick:
// 'auto' sizes off ATR; an explicit horizon is honored; 'llm' (no model to ask) falls to medium.
function resolveRiskHorizon(mode: string): {
  positionHorizon: 'short' | 'medium' | 'long' | undefined
  riskHorizon: 'auto' | 'short' | 'medium' | 'long'
} {
  if (mode === 'auto') return { positionHorizon: undefined, riskHorizon: 'auto' }
  const h = (mode === 'llm' ? 'medium' : mode) as 'short' | 'medium' | 'long'
  return { positionHorizon: h, riskHorizon: h }
}

// Recent-sentiment tilt: in offline mode we may still lean on the most recent LLM analyst decision
// for this coin when it is fresh enough (offline_reuse_max_age_min). We read the aggregated article
// sentiment that was stored on that decision's context and nudge confidence accordingly. Returns a
// signed tilt in [-0.15, +0.1] and whether fresh cached data was actually used.
async function freshSentimentTilt(coin: string, maxAgeMin: number): Promise<{ tilt: number; used: boolean }> {
  if (maxAgeMin <= 0) return { tilt: 0, used: false }
  try {
    const row = (await decisions.findOne(
      { coin },
      { sort: { id: -1 }, projection: { created_at: 1, context: 1 } },
    )) as { created_at?: string; context?: string } | null
    if (!row?.created_at) return { tilt: 0, used: false }
    const ageMin = (Date.now() - new Date(row.created_at.replace(' ', 'T') + 'Z').getTime()) / 60000
    if (!(ageMin >= 0) || ageMin > maxAgeMin) return { tilt: 0, used: false }
    let sentiment: string | undefined
    try {
      sentiment = JSON.parse(row.context ?? '{}')?.selectedResearch?.aggregated_sentiment
    } catch { /* malformed context — ignore */ }
    if (sentiment === 'positive') return { tilt: 0.1, used: true }
    if (sentiment === 'negative') return { tilt: -0.15, used: true }
    if (sentiment === 'neutral') return { tilt: 0, used: true }
    return { tilt: 0, used: false }
  } catch (err) {
    logger.warn('Offline analyst: fresh-sentiment lookup failed', { coin, error: err instanceof Error ? err.message : String(err) })
    return { tilt: 0, used: false }
  }
}

export async function analyzeSignalRules(
  coin: string,
  market: MarketContext,
  _portfolio: PortfolioState,
): Promise<Signal> {
  const settings = getSettings()
  const regime = classifyRegime(market)

  // ── Hard direction gates ───────────────────────────────────────────────────
  const overbought = market.rsi14 >= 70
  const downtrend = market.trend === 'downtrend'
  const uptrend = market.trend === 'uptrend'
  const aboveFastMa = market.sma7 > 0 ? market.price >= market.sma7 : true
  const momentumOk = market.rsi14 >= 50 && market.rsi14 < 70

  const buy = uptrend && regime.smaAlignment !== 'bearish' && momentumOk && aboveFastMa

  // ── Confidence score (only meaningful for a BUY) ────────────────────────────
  let score = 0
  if (uptrend) score += 0.3
  if (regime.smaAlignment === 'bullish') score += 0.2
  else if (regime.smaAlignment === 'mixed') score += 0.05
  if (market.rsi14 >= 55 && market.rsi14 < 68) score += 0.25
  else if (market.rsi14 >= 50 && market.rsi14 < 55) score += 0.1
  if (market.sma7 > market.sma25 && market.sma25 > 0) score += 0.15
  if (market.perf7d > 0) score += 0.1

  const { tilt, used: usedCache } = await freshSentimentTilt(coin, settings.offline_reuse_max_age_min)
  const confidence = Math.min(1, Math.max(0, score + (buy ? tilt : 0)))

  const source = usedCache ? 'rules+cache' : 'rules'
  if (!buy) {
    const why = overbought ? `RSI ${market.rsi14.toFixed(0)} overbought`
      : downtrend ? 'downtrend'
      : !uptrend ? `no uptrend (${market.trend})`
      : regime.smaAlignment === 'bearish' ? 'bearish SMA alignment'
      : !momentumOk ? `RSI ${market.rsi14.toFixed(0)} lacks momentum`
      : 'price below fast MA'
    logger.info('Offline analyst HOLD', { coin, why, regime: regime.summary, source })
    return { coin, action: 'HOLD', quantity: 0, reason: `[${source}] HOLD — ${why}. ${regime.summary}`, confidence, horizon: undefined }
  }

  const { positionHorizon, riskHorizon } = resolveRiskHorizon(settings.default_horizon)
  const risk = computeRiskLevels(market, regime, riskHorizon, settings)
  const signal: Signal = {
    coin,
    action: 'BUY',
    quantity: 0,
    reason: `[${source}] BUY — uptrend, RSI ${market.rsi14.toFixed(0)}, ${regime.summary}` + (usedCache ? ' (recent sentiment applied)' : ''),
    confidence,
    horizon: positionHorizon,
    stop_loss_pct: risk.stopLossPct,
    take_profit_pct: risk.takeProfitPct,
  }
  logger.info('Offline analyst BUY', {
    coin, confidence: Number(confidence.toFixed(2)), sl_pct: risk.stopLossPct, tp_pct: risk.takeProfitPct,
    horizon: positionHorizon ?? 'auto', source,
  })
  return signal
}
