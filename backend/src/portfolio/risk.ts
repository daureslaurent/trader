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
): number {
  const risk = parseSettings(settings)
  const feeRate = settings.fee_rate ?? 0.001

  const targetRisk = balanceUsd * risk.maxRiskPerTrade
  const riskAdjusted = targetRisk * Math.max(confidence, 0.1)

  // Effective price paid per coin including the buy-side fee
  // (fee is charged from received coins, so effective cost = price / (1 - feeRate))
  const effectivePrice = price / (1 - feeRate)

  let qty: number
  if (atr <= 0 || risk.stopLossAtrMultiplier <= 0) {
    qty = Math.min(riskAdjusted / effectivePrice, settings.max_position_size_usd / effectivePrice)
  } else {
    const volAdjusted = riskAdjusted / (atr * risk.stopLossAtrMultiplier)
    const maxQty = settings.max_position_size_usd / effectivePrice
    qty = Math.min(volAdjusted, maxQty)
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

// Minimum sell price to cover both the buy-side and sell-side fees (round-trip break-even).
// buy_fee is charged on received coins: effective_entry = entry / (1 - feeRate)
// sell_fee is charged on proceeds: break_even_sell = effective_entry / (1 - feeRate)
export function calculateBreakEven(entryPrice: number, feeRate: number): number {
  return entryPrice / Math.pow(1 - feeRate, 2)
}

export function checkPosition(currentPrice: number, position: PositionRecord): 'HOLD' | 'SL_HIT' | 'TP_HIT' {
  if (position.status !== 'OPEN') return 'HOLD'
  if (position.take_profit && currentPrice >= position.take_profit) return 'TP_HIT'
  if (currentPrice <= position.stop_loss) return 'SL_HIT'
  return 'HOLD'
}

export { parseSettings }
export type { RiskConfig }
