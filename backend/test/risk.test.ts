import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculatePositionSize,
  calculateStopLoss,
  calculateTakeProfit,
  computeRiskLevels,
  netRealizedPnl,
  hasSufficientEdge,
  checkPosition,
  minStopGapPct,
  validateSlTpAdjustment,
} from '../src/portfolio/risk.js'
import { makeSettings, makePosition } from './fixtures.js'

const approx = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`)

describe('calculatePositionSize', () => {
  it('sizes off ATR risk budget: balance × maxRisk × confidence / (atr × slMult)', () => {
    // targetRisk = 10000 × 0.02 = 200; ×conf 0.5 = 100; / (atr 2 × slMult 2 = 4) = 25
    const settings = makeSettings({ max_position_size_usd: 1_000_000, max_risk_per_trade: 0.02, stop_loss_atr: 2 })
    const qty = calculatePositionSize(100, 2, 0.5, 10_000, settings)
    approx(qty, 25)
  })

  it('caps quantity at max_position_size_usd / price', () => {
    // Risk budget would buy far more, but the notional cap is $1000 at price 100 → 10 units.
    const settings = makeSettings({ max_position_size_usd: 1000, max_risk_per_trade: 0.02, stop_loss_atr: 2 })
    const qty = calculatePositionSize(100, 0.01, 1, 1_000_000, settings)
    approx(qty, 10)
  })

  it('floors confidence at 0.1 so a near-zero confidence still sizes like 0.1', () => {
    const settings = makeSettings({ max_position_size_usd: 1_000_000 })
    const atZero = calculatePositionSize(100, 2, 0, 10_000, settings)
    const atFloor = calculatePositionSize(100, 2, 0.1, 10_000, settings)
    approx(atZero, atFloor)
  })

  it('falls back to risk-budget / price when ATR is unavailable', () => {
    // atr 0 → qty = min(riskAdjusted/price, cap/price). riskAdjusted = 10000×0.02×1 = 200; /100 = 2.
    const settings = makeSettings({ max_position_size_usd: 1_000_000, max_risk_per_trade: 0.02 })
    const qty = calculatePositionSize(100, 0, 1, 10_000, settings)
    approx(qty, 2)
  })

  it('never sizes beyond the available USDC balance', () => {
    const settings = makeSettings({ max_position_size_usd: 1_000_000 })
    // Plenty of risk budget, but only $50 cash at price 100 → 0.5 units.
    const qty = calculatePositionSize(100, 2, 1, 10_000, settings, 50)
    approx(qty, 0.5)
  })
})

describe('calculateStopLoss', () => {
  it('places the stop atr × multiplier below entry', () => {
    approx(calculateStopLoss(100, 2, makeSettings({ stop_loss_atr: 2 })), 96)
  })

  it('floors the stop at 1% of entry so it is never zero/negative', () => {
    // A huge ATR would drive the raw stop below zero; guard clamps to entry × 0.01.
    approx(calculateStopLoss(100, 100, makeSettings({ stop_loss_atr: 2 })), 1)
  })
})

describe('calculateTakeProfit', () => {
  it('places the target atr × multiplier above entry', () => {
    approx(calculateTakeProfit(100, 2, makeSettings({ take_profit_atr: 4 })), 108)
  })
})

describe('computeRiskLevels', () => {
  const settings = makeSettings({ stop_loss_atr: 2, take_profit_atr: 4 })

  it('auto horizon derives SL/TP straight from ATR', () => {
    const r = computeRiskLevels({ price: 100, atr14: 2 }, { volatility: 'normal' }, 'auto', settings)
    assert.equal(r.source, 'atr')
    assert.equal(r.stopLossPct, 4)   // 2×2/100 = 4%
    assert.equal(r.takeProfitPct, 8) // 2×4/100 = 8%
  })

  it('auto horizon falls back to 3%/6% when ATR is unavailable', () => {
    const r = computeRiskLevels({ price: 100, atr14: 0 }, { volatility: 'normal' }, 'auto', settings)
    assert.equal(r.stopLossPct, 3)
    assert.equal(r.takeProfitPct, 6)
    assert.ok(r.notes.some(n => n.includes('ATR unavailable')))
  })

  it('horizon mode uses the owner-configured per-horizon targets', () => {
    const r = computeRiskLevels({ price: 100, atr14: 2 }, { volatility: 'normal' }, 'medium', settings)
    assert.equal(r.source, 'horizon')
    assert.equal(r.stopLossPct, 6)   // monitor_sl_pct_medium
    assert.equal(r.takeProfitPct, 12) // monitor_tp_pct_medium
  })

  it('scales horizon targets up in a high-volatility regime (×1.4)', () => {
    const r = computeRiskLevels({ price: 100, atr14: 2 }, { volatility: 'high' }, 'medium', settings)
    approx(r.stopLossPct, 8.4)
    approx(r.takeProfitPct, 16.8)
    assert.ok(r.notes.some(n => n.includes('high-vol')))
  })

  it('scales horizon targets down in a low-volatility regime (×0.8)', () => {
    const r = computeRiskLevels({ price: 100, atr14: 2 }, { volatility: 'low' }, 'medium', settings)
    approx(r.stopLossPct, 4.8)
    approx(r.takeProfitPct, 9.6)
  })

  it('enforces a minimum reward/risk of 1.5', () => {
    const s = makeSettings({ monitor_sl_pct_short: 4, monitor_tp_pct_short: 4 })
    const r = computeRiskLevels({ price: 100, atr14: 2 }, { volatility: 'normal' }, 'short', s)
    assert.equal(r.takeProfitPct, 6) // raised from 4 to 4 × 1.5
    assert.ok(r.notes.some(n => n.includes('1.5')))
  })

  it('clamps SL to 25% and TP to 50%', () => {
    const s = makeSettings({ monitor_sl_pct_long: 100, monitor_tp_pct_long: 200 })
    const r = computeRiskLevels({ price: 100, atr14: 2 }, { volatility: 'normal' }, 'long', s)
    assert.equal(r.stopLossPct, 25)
    assert.equal(r.takeProfitPct, 50)
  })

  it('clamps SL and TP up to the 0.5% minimum', () => {
    const s = makeSettings({ monitor_sl_pct_short: 0.1, monitor_tp_pct_short: 0.2 })
    const r = computeRiskLevels({ price: 100, atr14: 2 }, { volatility: 'normal' }, 'short', s)
    assert.equal(r.stopLossPct, 0.5)
    assert.equal(r.takeProfitPct, 0.5)
  })
})

describe('netRealizedPnl', () => {
  it('subtracts the per-side fee on both the entry and exit notional', () => {
    // gross = 10×(110−100) = 100; fees = 0.001×10×(100+110) = 2.1 → 97.9
    approx(netRealizedPnl(10, 100, 110, 0.001), 97.9)
  })

  it('makes a small nominal gain a net loss once fees exceed it', () => {
    // gross = 10×(100.1−100) = 1; fees = 0.001×10×200.1 = 2.001 → negative
    assert.ok(netRealizedPnl(10, 100, 100.1, 0.001) < 0)
  })

  it('equals gross PnL when the fee rate is zero', () => {
    approx(netRealizedPnl(10, 100, 90, 0), -100)
  })
})

describe('hasSufficientEdge', () => {
  it('requires TP ≥ 5 × round-trip fees', () => {
    // required = feeRate 0.001 × 2 × 100 × 5 = 1.0%
    const r = hasSufficientEdge(2, 0.001)
    assert.equal(r.requiredPct, 1)
    assert.equal(r.ok, true)
  })

  it('rejects a take-profit below the fee-edge minimum', () => {
    assert.equal(hasSufficientEdge(0.5, 0.001).ok, false)
  })

  it('accepts a take-profit exactly at the minimum', () => {
    assert.equal(hasSufficientEdge(1, 0.001).ok, true)
  })
})

describe('checkPosition', () => {
  it('signals TP_HIT once price reaches the take-profit', () => {
    assert.equal(checkPosition(111, makePosition({ stop_loss: 95, take_profit: 110 })), 'TP_HIT')
  })

  it('signals SL_HIT once price falls to the stop-loss', () => {
    assert.equal(checkPosition(94, makePosition({ stop_loss: 95, take_profit: 110 })), 'SL_HIT')
  })

  it('holds while price sits between the stop and target', () => {
    assert.equal(checkPosition(100, makePosition({ stop_loss: 95, take_profit: 110 })), 'HOLD')
  })

  it('never triggers on a position that is not OPEN', () => {
    assert.equal(checkPosition(1, makePosition({ status: 'CLOSED', stop_loss: 95 })), 'HOLD')
  })

  it('still honors the stop when no take-profit is set', () => {
    assert.equal(checkPosition(200, makePosition({ take_profit: null, stop_loss: 95 })), 'HOLD')
    assert.equal(checkPosition(94, makePosition({ take_profit: null, stop_loss: 95 })), 'SL_HIT')
  })
})

describe('minStopGapPct', () => {
  it('defaults to 0.5% when no horizon applies', () => {
    assert.equal(minStopGapPct(null), 0.5)
  })

  it('is half the horizon stop distance', () => {
    assert.equal(minStopGapPct(6), 3)
  })

  it('floors at 0.5% for tight horizons', () => {
    assert.equal(minStopGapPct(0.4), 0.5)
  })
})

describe('validateSlTpAdjustment', () => {
  it('accepts a straightforward stop tightening', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 90, oldTakeProfit: 110,
      proposedStopLoss: 95, proposedTakeProfit: null,
    })
    assert.equal(r.stopLoss, 95)
    assert.equal(r.changed, true)
  })

  it('rejects a stop at or above the current price', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 90, oldTakeProfit: null,
      proposedStopLoss: 105, proposedTakeProfit: null,
    })
    assert.equal(r.stopLoss, 90)
    assert.equal(r.changed, false)
    assert.ok(r.notes.some(n => n.includes('would trigger immediately')))
  })

  it('refuses to loosen the stop on a winning position (profit ratchet)', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 95, oldTakeProfit: 120,
      proposedStopLoss: 92, proposedTakeProfit: null,
      entryPrice: 90, // current > entry → in profit
    })
    assert.equal(r.stopLoss, 95)
    assert.equal(r.changed, false)
    assert.ok(r.notes.some(n => n.includes('profit ratchet')))
  })

  it('refuses to loosen the stop right after a tightening (anti flip-flop)', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 95, oldTakeProfit: null,
      proposedStopLoss: 92, proposedTakeProfit: null,
      slRecentlyTightened: true,
    })
    assert.equal(r.stopLoss, 95)
    assert.equal(r.changed, false)
    assert.ok(r.notes.some(n => n.includes('anti flip-flop')))
  })

  it('allows loosening within the horizon floor', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 95, oldTakeProfit: null,
      proposedStopLoss: 92, proposedTakeProfit: null,
      maxSlPct: 10, // floor at 90
    })
    assert.equal(r.stopLoss, 92)
    assert.equal(r.changed, true)
  })

  it('rejects loosening beyond the horizon floor', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 95, oldTakeProfit: null,
      proposedStopLoss: 85, proposedTakeProfit: null,
      maxSlPct: 10, // floor at 90, 85 is below it
    })
    assert.equal(r.stopLoss, 95)
    assert.equal(r.changed, false)
    assert.ok(r.notes.some(n => n.includes('beyond horizon floor')))
  })

  it('treats a proposal within the deadband as unchanged (no OCO churn)', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 95, oldTakeProfit: null,
      proposedStopLoss: 95.1, proposedTakeProfit: null, // < 0.25% of price away
    })
    assert.equal(r.stopLoss, 95)
    assert.equal(r.changed, false)
  })

  it('rejects a stop parked inside the noise band', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: 80, oldTakeProfit: null,
      proposedStopLoss: 99.9, proposedTakeProfit: null,
      minSlGapPct: 1, // 0.1% gap is well under 1%
    })
    assert.equal(r.stopLoss, 80)
    assert.equal(r.changed, false)
    assert.ok(r.notes.some(n => n.includes('minimum gap')))
  })

  it('rejects a premature break-even stop below the trigger P&L', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100.5, oldStopLoss: 90, oldTakeProfit: null,
      proposedStopLoss: 100.2, proposedTakeProfit: null,
      entryPrice: 100, feeRoundTripPct: 0.2, // break-even = 100.2
      breakevenTriggerPct: 1, // only +0.5% P&L so far
    })
    assert.equal(r.stopLoss, 90)
    assert.equal(r.changed, false)
    assert.ok(r.notes.some(n => n.includes('break-even')))
  })

  it('accepts a take-profit raise above the current price', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: null, oldTakeProfit: 110,
      proposedStopLoss: null, proposedTakeProfit: 120,
    })
    assert.equal(r.takeProfit, 120)
    assert.equal(r.changed, true)
  })

  it('rejects a take-profit at or below the current price', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: null, oldTakeProfit: 110,
      proposedStopLoss: null, proposedTakeProfit: 99,
    })
    assert.equal(r.takeProfit, 110)
    assert.equal(r.changed, false)
  })

  it('refuses to lower the take-profit on a winning position', () => {
    const r = validateSlTpAdjustment({
      currentPrice: 100, oldStopLoss: null, oldTakeProfit: 120,
      proposedStopLoss: null, proposedTakeProfit: 110,
      entryPrice: 90, // in profit
    })
    assert.equal(r.takeProfit, 120)
    assert.equal(r.changed, false)
    assert.ok(r.notes.some(n => n.includes('profit ratchet')))
  })
})
