import { portfolioEntries, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import {
  getPortfolioState, getUsdcEntry,
  calculatePositionSize, calculateStopLoss, calculateTakeProfit, hasSufficientEdge,
} from '../portfolio/index.js'
import * as entry from '../entry/index.js'
import { Signal } from '../types.js'

export type PreparedBuyOrder = { qty: number; sl: number; tp: number; tpPct: number }
export type BuyEvaluation =
  | { ok: true; order: PreparedBuyOrder }
  | { ok: false; reason: string }

interface PrepareBuyArgs {
  symbol: string
  price: number
  atr14: number
  signal: Signal
  portfolioState: Awaited<ReturnType<typeof getPortfolioState>>
  settings: ReturnType<typeof getSettings>
  /** Whether to reject when an entry-timing intent is already pending (live pipeline only). */
  checkActiveIntent: boolean
}

/**
 * Run the full BUY gauntlet — max-positions, already-held, pending-intent,
 * min-USDC, position sizing, min-order floor, and the fee-edge gate — and either
 * reject with a human-readable reason (also emitted as a `trade_skipped` pipeline
 * event by the caller) or return a sized order with SL/TP and the TP percentage.
 *
 * The SL/TP here are decision-time levels used for display and the fee-edge
 * check; the executed levels are recomputed at the real fill price in submitTrade.
 */
export async function prepareBuyOrder(args: PrepareBuyArgs): Promise<BuyEvaluation> {
  const { symbol, price, atr14, signal, portfolioState, settings, checkActiveIntent } = args

  if (portfolioState.openPositionCount >= portfolioState.maxOpenPositions) {
    logger.warn('Max open positions reached, skipping BUY', { coin: symbol, openPositions: portfolioState.openPositionCount })
    return { ok: false, reason: 'Max open positions reached' }
  }

  const existingHolding = await portfolioEntries.findOne({ coin: symbol, status: 'OPEN' }, { projection: { id: 1 } })
  if (existingHolding) {
    logger.warn('Skipping BUY — coin already held in portfolio', { coin: symbol })
    return { ok: false, reason: 'Coin already held in portfolio' }
  }

  if (checkActiveIntent && entry.hasActiveIntent(symbol)) {
    logger.debug('Skipping BUY — entry intent already pending', { coin: symbol })
    return { ok: false, reason: 'Entry intent already pending for this coin' }
  }

  const availableUsdc = (await getUsdcEntry())?.quantity ?? 0
  if (availableUsdc < settings.min_trade_usdc) {
    logger.warn('Skipping BUY — USDC below minimum threshold', { coin: symbol, availableUsdc, min: settings.min_trade_usdc })
    return { ok: false, reason: `Insufficient USDC ($${availableUsdc.toFixed(2)} < minimum $${settings.min_trade_usdc})` }
  }

  let qty = calculatePositionSize(price, atr14, signal.confidence, portfolioState.totalValueUsd, settings, availableUsdc)
  if (qty <= 0) {
    logger.warn('Skipping BUY — insufficient USDC or zero position size', { coin: symbol, availableUsdc })
    return { ok: false, reason: `Insufficient USDC (available: $${availableUsdc.toFixed(2)})` }
  }

  const minQty = settings.min_trade_usdc / price
  if (qty < minQty) {
    logger.info('BUY qty floored to minimum order size', { coin: symbol, originalUsd: qty * price, minUsd: settings.min_trade_usdc })
    qty = minQty
  }

  const sl = signal.stop_loss_pct != null
    ? price * (1 - signal.stop_loss_pct / 100)
    : calculateStopLoss(price, atr14, settings)
  const tp = signal.take_profit_pct != null
    ? price * (1 + signal.take_profit_pct / 100)
    : calculateTakeProfit(price, atr14, settings)

  // Fee-edge gate: the profit target must clear a multiple of the round-trip
  // cost, otherwise fees + spread consume most realistic outcomes.
  const tpPct = price > 0 ? ((tp - price) / price) * 100 : 0
  const edge = hasSufficientEdge(tpPct, settings.fee_rate)
  if (!edge.ok) {
    logger.info('Skipping BUY — profit target below fee-edge minimum', { coin: symbol, tpPct, requiredPct: edge.requiredPct })
    return { ok: false, reason: `TP +${tpPct.toFixed(2)}% below fee-edge minimum +${edge.requiredPct.toFixed(2)}%` }
  }

  return { ok: true, order: { qty, sl, tp, tpPct } }
}
