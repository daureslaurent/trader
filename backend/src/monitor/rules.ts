import { PositionContext } from './types.js'
import type { RawReview, CycleParams } from './context.js'

/**
 * Deterministic, LLM-free position review used in offline mode (see core/offlineMode.ts). It
 * produces the SAME RawReview shape the agentic monitor emits, so the verdict flows through the
 * unchanged finalizeReview() safety net (confidence gate, profit-protection, adjust cooldown,
 * validateSlTpAdjustment ratchet/floor rules) and the same close/adjust bus events.
 *
 * Two deterministic levers, mirroring sane manual risk management:
 *  - CLOSE when the long thesis has clearly broken (trend turned down + momentum gone).
 *  - ADJUST (trailing stop) to lock in gains once a position is comfortably in profit, ratcheting
 *    the stop up toward a fraction of the open profit. The TP is left untouched. validateSlTpAdjustment
 *    rejects any non-ratcheting / too-tight proposal, downgrading it to HOLD.
 * Everything else is HOLD.
 */

// Fraction of the open profit to lock in when trailing (stop sits this far up from entry toward price).
const TRAIL_LOCK_FRACTION = 0.5

export function reviewPositionRules(ctx: PositionContext, p: CycleParams): RawReview {
  const { trend, rsi14, pnlPct, entryPrice, currentPrice, stopLoss } = ctx

  // ── CLOSE: thesis broken ────────────────────────────────────────────────────
  // A held position is a long. If the trend has rolled over to a downtrend and momentum has
  // left (RSI below 45), exit. Confidence is set above the configured minimum so finalizeReview
  // executes it; the profit-protection guard stays inert because the trend is no longer up.
  if (trend === 'downtrend' && rsi14 < 45) {
    return {
      action: 'CLOSE',
      confidence: Math.max(0.7, p.minConfidence),
      reasoning: `[rules] CLOSE — downtrend with weak momentum (RSI ${rsi14.toFixed(0)}); long thesis invalidated.`,
      thesis_status: 'invalidated',
      regime: 'risk_off',
    }
  }

  // ── ADJUST: trailing stop on a comfortable winner ───────────────────────────
  // Only trail once profit clears the breakeven trigger, and only when the proposed stop sits
  // ABOVE the current one (a genuine ratchet). Propose as a % below current price; the safety net
  // converts, validates the gap/ratchet, and applies (or downgrades to HOLD).
  if (pnlPct >= p.breakevenPct && entryPrice > 0 && currentPrice > 0) {
    const targetStop = entryPrice + (currentPrice - entryPrice) * TRAIL_LOCK_FRACTION
    const ratchetsUp = stopLoss == null || targetStop > stopLoss
    if (targetStop < currentPrice && ratchetsUp) {
      const newStopPct = (targetStop / currentPrice - 1) * 100 // negative: % below current price
      return {
        action: 'ADJUST',
        confidence: 0.6,
        reasoning: `[rules] ADJUST — trailing stop up to lock ~${Math.round(TRAIL_LOCK_FRACTION * 100)}% of a +${pnlPct.toFixed(1)}% gain (RSI ${rsi14.toFixed(0)}, ${trend}).`,
        new_stop_loss_pct: Math.round(newStopPct * 100) / 100,
        new_take_profit_pct: null,
        thesis_status: 'intact',
      }
    }
  }

  // ── HOLD ────────────────────────────────────────────────────────────────────
  return {
    action: 'HOLD',
    confidence: 0.5,
    reasoning: `[rules] HOLD — ${trend}, RSI ${rsi14.toFixed(0)}, P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%; no rule trigger.`,
    thesis_status: trend === 'uptrend' ? 'intact' : 'weakening',
  }
}
