import { BotSettings, PositionRecord, RiskConfig } from '../types.js'

function parseSettings(s: BotSettings): RiskConfig {
  return {
    stopLossAtrMultiplier: parseFloat((s as any).stop_loss_atr || '2'),
    takeProfitAtrMultiplier: parseFloat((s as any).take_profit_atr || '4'),
    maxRiskPerTrade: parseFloat((s as any).max_risk_per_trade || '0.02'),
    maxOpenPositions: parseInt((s as any).max_open_positions || '5', 10),
  }
}

export function calculatePositionSize(
  price: number,
  atr: number,
  confidence: number,
  balanceUsd: number,
  settings: BotSettings,
  availableUsdc?: number,
): number {
  const risk = parseSettings(settings)

  const targetRisk = balanceUsd * risk.maxRiskPerTrade
  const riskAdjusted = targetRisk * Math.max(confidence, 0.1)

  let qty: number
  if (atr <= 0 || risk.stopLossAtrMultiplier <= 0) {
    qty = Math.min(riskAdjusted / price, settings.max_position_size_usd / price)
  } else {
    const volAdjusted = riskAdjusted / (atr * risk.stopLossAtrMultiplier)
    const maxQty = settings.max_position_size_usd / price
    qty = Math.min(volAdjusted, maxQty)
  }

  // Cap to what we can actually afford with the current USDC balance
  if (availableUsdc !== undefined && availableUsdc > 0) {
    qty = Math.min(qty, availableUsdc / price)
  }

  return qty
}

export function calculateStopLoss(
  entryPrice: number,
  atr: number,
  settings: BotSettings,
): number {
  const risk = parseSettings(settings)
  const raw = entryPrice - (atr * risk.stopLossAtrMultiplier)
  // Guard against zero/negative SL — would never trigger, leaving position unprotected
  return Math.max(raw, entryPrice * 0.01)
}

export function calculateTakeProfit(
  entryPrice: number,
  atr: number,
  settings: BotSettings,
): number {
  const risk = parseSettings(settings)
  return entryPrice + (atr * risk.takeProfitAtrMultiplier)
}

export interface RiskLevels {
  stopLossPct: number   // % below entry price
  takeProfitPct: number // % above entry price
  source: 'atr' | 'horizon'
  notes: string[]
}

/**
 * Deterministically derive stop-loss / take-profit percentages for a new BUY.
 *
 * Replaces the LLM-decided SL/TP (to_fix.md #1): risk sizing is a mechanical
 * function of ATR, the configured horizon targets, and the volatility regime —
 * not a judgement call. The decision LLM now only picks direction/confidence.
 *
 *  - horizon === 'auto'  → ATR-based, volatility is already baked into ATR.
 *  - horizon set         → owner's configured % targets, scaled for volatility.
 *
 * Always guarantees TP ≥ 1.5 × SL and clamps to the same safe ranges the old
 * LLM path used (SL 0.5–25%, TP 0.5–50%).
 */
export function computeRiskLevels(
  market: { price: number; atr14: number },
  regime: { volatility: 'high' | 'normal' | 'low' },
  horizon: 'auto' | 'short' | 'medium' | 'long',
  settings: BotSettings,
): RiskLevels {
  const risk = parseSettings(settings)
  const notes: string[] = []

  let stopLossPct: number
  let takeProfitPct: number
  let source: 'atr' | 'horizon'

  const atrSlPct = market.price > 0 && market.atr14 > 0
    ? (market.atr14 * risk.stopLossAtrMultiplier / market.price) * 100
    : 0

  if (horizon === 'auto') {
    source = 'atr'
    if (atrSlPct > 0) {
      stopLossPct = atrSlPct
      takeProfitPct = (market.atr14 * risk.takeProfitAtrMultiplier / market.price) * 100
    } else {
      // ATR unavailable (insufficient candles) — fall back to a safe default.
      stopLossPct = 3
      takeProfitPct = 6
      notes.push('ATR unavailable, used 3%/6% default')
    }
  } else {
    source = 'horizon'
    const slBase = horizon === 'short' ? settings.monitor_sl_pct_short
      : horizon === 'long' ? settings.monitor_sl_pct_long
      : settings.monitor_sl_pct_medium
    const tpBase = horizon === 'short' ? settings.monitor_tp_pct_short
      : horizon === 'long' ? settings.monitor_tp_pct_long
      : settings.monitor_tp_pct_medium

    // Scale the owner's targets to the current volatility regime.
    const volFactor = regime.volatility === 'high' ? 1.4 : regime.volatility === 'low' ? 0.8 : 1
    if (volFactor !== 1) notes.push(`${regime.volatility}-vol scaling ×${volFactor}`)
    stopLossPct = slBase * volFactor
    takeProfitPct = tpBase * volFactor
  }

  // Enforce minimum reward/risk of 1.5.
  if (takeProfitPct < stopLossPct * 1.5) {
    takeProfitPct = stopLossPct * 1.5
    notes.push('TP raised to 1.5× SL')
  }

  stopLossPct = Math.min(Math.max(stopLossPct, 0.5), 25)
  takeProfitPct = Math.min(Math.max(takeProfitPct, 0.5), 50)

  return {
    stopLossPct: Math.round(stopLossPct * 100) / 100,
    takeProfitPct: Math.round(takeProfitPct * 100) / 100,
    source,
    notes,
  }
}

/** Realized PnL net of entry+exit exchange fees (per-side rate charged on each notional). */
export function netRealizedPnl(qty: number, entryPrice: number, exitPrice: number, feeRate: number): number {
  const gross = qty * (exitPrice - entryPrice)
  const fees = feeRate * qty * (entryPrice + exitPrice)
  return gross - fees
}

// A trade's profit target must clear the round-trip cost by this multiple,
// otherwise fees and spread eat the bulk of any realistic outcome.
const MIN_EDGE_MULTIPLE = 5

/** Whether a BUY's take-profit distance clears MIN_EDGE_MULTIPLE × round-trip fees. */
export function hasSufficientEdge(takeProfitPct: number, feeRate: number): { ok: boolean; requiredPct: number } {
  const requiredPct = feeRate * 2 * 100 * MIN_EDGE_MULTIPLE
  return { ok: takeProfitPct >= requiredPct, requiredPct }
}

export function checkPosition(currentPrice: number, position: PositionRecord): 'HOLD' | 'SL_HIT' | 'TP_HIT' {
  if (position.status !== 'OPEN') return 'HOLD'
  if (position.take_profit && currentPrice >= position.take_profit) return 'TP_HIT'
  if (currentPrice <= position.stop_loss) return 'SL_HIT'
  return 'HOLD'
}

export interface SlTpProposal {
  currentPrice: number
  oldStopLoss: number | null
  oldTakeProfit: number | null
  proposedStopLoss: number | null
  proposedTakeProfit: number | null
  // When set, loosening is allowed up to this % below current price (the horizon floor).
  // When absent, the old tighten-only rule applies.
  maxSlPct?: number
  // Entry price of the position. When set and the position is in profit, the profit
  // ratchet applies: SL may only move up and TP may not be lowered.
  entryPrice?: number
  // True when a recent review already tightened the SL — loosening is then refused,
  // so the LLM can't alternate tighten/loosen every cycle (each flip costs an
  // exchange-side OCO cancel+replace).
  slRecentlyTightened?: boolean
  // Proposals closer than this % of current price to the existing level are treated as
  // unchanged. Defaults to 0.25 — absorbs LLM rounding and price drift between prompt
  // and reply, so "echoed" levels don't trigger an OCO cancel+replace every cycle.
  minChangePct?: number
  // Round-trip exchange fee as a % of notional (2 × per-side rate × 100). Break-even
  // for a long is entry × (1 + this/100); a stop between entry and that price still
  // realizes a fee-sized loss when hit.
  feeRoundTripPct?: number
  // P&L % (vs entry) the position must reach before the stop may ratchet to
  // break-even or above. Blocks the "protect a +0.1% gain" pattern that scratches
  // every position on ordinary noise.
  breakevenTriggerPct?: number
  // Minimum distance (% of current price) the stop must keep below the current
  // price. A stop inside this band is hit by routine noise almost immediately.
  minSlGapPct?: number
}

/**
 * Minimum % gap a trailed stop must keep below the current price for a given
 * horizon stop-loss target. Half the horizon distance, floored at 0.5%
 * (≈ 2.5× a 0.2% round-trip cost). Pass null when no horizon applies.
 */
export function minStopGapPct(horizonSlPct: number | null): number {
  return horizonSlPct == null ? 0.5 : Math.max(0.5, horizonSlPct / 2)
}

export interface SlTpValidation {
  stopLoss: number | null
  takeProfit: number | null
  changed: boolean
  notes: string[]
}

/**
 * Apply the bot's risk rules to a proposed SL/TP change for a LONG position.
 * Risk discipline takes precedence over the LLM:
 *  - Stop-loss must stay below price. Loosening is allowed only within the horizon
 *    floor (maxSlPct), never while the position is in profit (profit ratchet), and
 *    never right after a tightening (anti flip-flop).
 *  - Tightening must keep at least minSlGapPct below the current price, and may
 *    not park the stop at break-even or above until P&L ≥ breakevenTriggerPct —
 *    both reject the noise-distance stops that scratch positions within minutes.
 *  - Take-profit must stay above the current price and may not be lowered while
 *    the position is in profit.
 * Returns the risk-approved levels and whether anything materially changed.
 */
export function validateSlTpAdjustment(p: SlTpProposal): SlTpValidation {
  const notes: string[] = []
  let stopLoss = p.oldStopLoss
  let takeProfit = p.oldTakeProfit
  let changed = false

  // Treat proposals within minChangePct of current price as unchanged to avoid no-op
  // churn: each "change" costs an exchange-side OCO cancel+replace.
  const deadband = p.currentPrice * ((p.minChangePct ?? 0.25) / 100)
  const same = (a: number, b: number) => Math.abs(a - b) <= deadband

  const inProfit = p.entryPrice != null && p.currentPrice > p.entryPrice

  if (p.proposedStopLoss != null && p.proposedStopLoss > 0 &&
      !(p.oldStopLoss != null && same(p.proposedStopLoss, p.oldStopLoss))) {
    const sl = p.proposedStopLoss
    if (sl >= p.currentPrice) {
      notes.push('Ignored stop-loss ≥ current price (would trigger immediately)')
    } else if (p.oldStopLoss != null && sl < p.oldStopLoss) {
      if (inProfit) {
        notes.push('Ignored stop-loss loosening on a winning position (profit ratchet)')
      } else if (p.slRecentlyTightened) {
        notes.push('Ignored stop-loss loosening — SL was tightened recently (anti flip-flop)')
      } else {
        const floor = p.maxSlPct != null ? p.currentPrice * (1 - p.maxSlPct / 100) : null
        if (floor != null && sl >= floor) {
          stopLoss = sl
          changed = true
          notes.push(`Stop-loss widened to ${sl} (within horizon floor -${p.maxSlPct}%)`)
        } else {
          notes.push('Ignored stop-loss loosening beyond horizon floor')
        }
      }
    } else {
      // Tightening — but never into the noise band or to a premature break-even.
      const gapPct = ((p.currentPrice - sl) / p.currentPrice) * 100
      const pnlPct = p.entryPrice != null && p.entryPrice > 0
        ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
        : null
      const breakeven = p.entryPrice != null
        ? p.entryPrice * (1 + (p.feeRoundTripPct ?? 0) / 100)
        : null
      if (p.minSlGapPct != null && gapPct < p.minSlGapPct) {
        notes.push(`Ignored stop-loss only ${gapPct.toFixed(2)}% below price — minimum gap is ${p.minSlGapPct}% (noise would trigger it)`)
      } else if (breakeven != null && p.breakevenTriggerPct != null && pnlPct != null &&
                 sl >= breakeven && pnlPct < p.breakevenTriggerPct) {
        notes.push(`Ignored break-even stop at +${pnlPct.toFixed(2)}% P&L — allowed only from +${p.breakevenTriggerPct}%`)
      } else {
        stopLoss = sl
        changed = true
        notes.push(`Stop-loss tightened to ${sl}`)
      }
    }
  }

  if (p.proposedTakeProfit != null && p.proposedTakeProfit > 0 &&
      !(p.oldTakeProfit != null && same(p.proposedTakeProfit, p.oldTakeProfit))) {
    const tp = p.proposedTakeProfit
    if (tp <= p.currentPrice) {
      notes.push('Ignored take-profit ≤ current price')
    } else if (inProfit && p.oldTakeProfit != null && tp < p.oldTakeProfit) {
      notes.push('Ignored take-profit lowering on a winning position (profit ratchet)')
    } else {
      takeProfit = tp
      changed = true
      notes.push(`Take-profit set to ${tp}`)
    }
  }

  return { stopLoss, takeProfit, changed, notes }
}

export { parseSettings }
export type { RiskConfig }
