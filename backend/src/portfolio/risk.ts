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
  return entryPrice - (atr * risk.stopLossAtrMultiplier)
}

export function calculateTakeProfit(
  entryPrice: number,
  atr: number,
  settings: BotSettings,
): number {
  const risk = parseSettings(settings)
  return entryPrice + (atr * risk.takeProfitAtrMultiplier)
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
 *  - Stop-loss may only be TIGHTENED (raised), never loosened, and must stay below price.
 *  - Take-profit must stay above the current price.
 * Returns the risk-approved levels and whether anything materially changed.
 */
export function validateSlTpAdjustment(p: SlTpProposal): SlTpValidation {
  const notes: string[] = []
  let stopLoss = p.oldStopLoss
  let takeProfit = p.oldTakeProfit
  let changed = false

  // Treat values within ~0.0001% as unchanged to avoid no-op churn.
  const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * 1e-6

  if (p.proposedStopLoss != null && p.proposedStopLoss > 0 &&
      !(p.oldStopLoss != null && same(p.proposedStopLoss, p.oldStopLoss))) {
    const sl = p.proposedStopLoss
    if (sl >= p.currentPrice) {
      notes.push('Ignored stop-loss ≥ current price (would trigger immediately)')
    } else if (p.oldStopLoss != null && sl < p.oldStopLoss) {
      notes.push('Ignored stop-loss loosening — stops may only be tightened')
    } else {
      stopLoss = sl
      changed = true
      notes.push(`Stop-loss tightened to ${sl}`)
    }
  }

  if (p.proposedTakeProfit != null && p.proposedTakeProfit > 0 &&
      !(p.oldTakeProfit != null && same(p.proposedTakeProfit, p.oldTakeProfit))) {
    const tp = p.proposedTakeProfit
    if (tp <= p.currentPrice) {
      notes.push('Ignored take-profit ≤ current price')
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
