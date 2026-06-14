import { queryOne, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { fetchMarketData } from '../trader/index.js'
import {
  getPortfolioState, getUsdcEntry, getMarketContext,
  calculatePositionSize, calculateStopLoss, calculateTakeProfit,
} from '../portfolio/index.js'
import { handleTradeSignal } from '../execution/index.js'
import { Signal } from '../types.js'
import { logPipelineEvent } from './events.js'

interface SimulatedSignalInput {
  symbol: string
  action: Signal['action']
  confidence: number
  reason: string
  cycle_id: string
}

/**
 * Execute a hand-crafted ("simulated") signal from the debug UI. Mirrors the
 * live pipeline's gates but uses rule-based SL/TP and skips the fee-edge gate —
 * it's a testing path, intentionally looser than the analyst-driven one.
 */
export async function runSimulatedSignal({ symbol, action, confidence, reason, cycle_id }: SimulatedSignalInput): Promise<void> {
  logger.info('Simulated signal received', { symbol, action, confidence, cycle_id })
  try {
    const settings = getSettings()
    const marketData = await fetchMarketData([symbol])
    const data = marketData[0]
    if (!data) {
      logPipelineEvent('pipeline_failed', symbol, cycle_id, { error: 'Failed to fetch market data' })
      return
    }

    logPipelineEvent('signal_generated', symbol, cycle_id, {
      symbol, action, confidence, reason,
    })

    const signal: Signal = { coin: symbol, action, confidence, reason, quantity: 0 }

    if (action === 'BUY') {
      const portfolioState = getPortfolioState(marketData, settings)
      if (portfolioState.openPositionCount >= portfolioState.maxOpenPositions) {
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: 'Max open positions reached' })
        return
      }

      const existingHolding = queryOne("SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [symbol])
      if (existingHolding) {
        logger.warn('Skipping BUY — coin already held in portfolio', { coin: symbol })
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: 'Coin already held in portfolio' })
        return
      }

      const availableUsdc = getUsdcEntry()?.quantity ?? 0
      if (availableUsdc < settings.min_trade_usdc) {
        logger.warn('Skipping BUY — USDC below minimum threshold', { coin: symbol, availableUsdc, min: settings.min_trade_usdc })
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: `Insufficient USDC ($${availableUsdc.toFixed(2)} < minimum $${settings.min_trade_usdc})` })
        return
      }

      const marketCtx = await getMarketContext(symbol, data.price)
      const qty = calculatePositionSize(data.price, marketCtx.atr14, confidence, portfolioState.totalValueUsd, settings, availableUsdc)
      if (qty <= 0) {
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: `Insufficient USDC (available: $${availableUsdc.toFixed(2)})` })
        return
      }
      const sl = calculateStopLoss(data.price, marketCtx.atr14, settings)
      const tp = calculateTakeProfit(data.price, marketCtx.atr14, settings)
      const { outcome, error: tradeErr } = await handleTradeSignal({ ...signal, quantity: qty }, data.price, marketCtx.atr14, settings)
      logPipelineEvent('trade_executed', symbol, cycle_id, {
        action: 'BUY', price: data.price, quantity: qty, stop_loss: sl, take_profit: tp,
        pending_approval: outcome === 'pending',
        error: outcome === 'failed' ? tradeErr : undefined,
      })
    } else {
      const existing = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [symbol])
      if (!existing) {
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: 'No open position to sell' })
        return
      }
      const qty = existing.quantity as number
      const { outcome, error: tradeErr } = await handleTradeSignal({ ...signal, quantity: qty }, data.price)
      logPipelineEvent('trade_executed', symbol, cycle_id, {
        action: 'SELL', price: data.price, quantity: qty,
        pending_approval: outcome === 'pending',
        error: outcome === 'failed' ? tradeErr : undefined,
      })
      // Portfolio writes are handled inside submitTrade atomically.
    }
  } catch (err) {
    logger.error('Simulated signal failed', { symbol, error: err instanceof Error ? err.message : String(err) })
    logPipelineEvent('pipeline_failed', symbol, cycle_id, { error: err instanceof Error ? err.message : String(err) })
  }
}
