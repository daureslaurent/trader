import { portfolioEntries, positions as positionsRepo, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { getUsdcEntry } from '../portfolio/index.js'
import { handleTradeSignal } from '../execution/index.js'
import { Signal } from '../types.js'
import { logPipelineEvent } from './events.js'

interface EntryFireInput {
  signal: Signal
  price: number
  atr?: number
}

/**
 * The entry engine fired a deferred BUY at a good price. Re-check live gates
 * (state may have shifted during the wait), then run it through the normal
 * execution path so approval + OCO placement behave exactly as an immediate BUY.
 */
export async function executeEntryFire({ signal, price, atr }: EntryFireInput): Promise<void> {
  const coin = signal.coin
  const settings = getSettings()

  if (signal.quantity <= 0) {
    logger.warn('Entry fire aborted — non-positive quantity', { coin })
    return
  }
  if (await portfolioEntries.findOne({ coin, status: 'OPEN' }, { projection: { id: 1 } })) {
    logger.warn('Entry fire aborted — coin already held', { coin })
    return
  }
  const openPositions = await positionsRepo.count({ status: 'OPEN' })
  if (openPositions >= settings.max_open_positions) {
    logger.warn('Entry fire aborted — max open positions reached', { coin, openPositions })
    return
  }
  const availableUsdc = (await getUsdcEntry())?.quantity ?? 0
  if (availableUsdc < settings.min_trade_usdc || availableUsdc < price * signal.quantity) {
    logger.warn('Entry fire aborted — insufficient USDC', { coin, availableUsdc, needed: price * signal.quantity })
    return
  }

  const { outcome, error } = await handleTradeSignal(signal, price, atr, settings)
  logPipelineEvent('trade_executed', coin, `${Date.now().toString(36)}-entry`, {
    action: 'BUY', price, quantity: signal.quantity,
    pending_approval: outcome === 'pending',
    sl_source: signal.stop_loss_pct != null ? 'rule' : 'atr',
    triggered_by: 'entry_timing',
    error: outcome === 'failed' ? error : undefined,
  })
  if (outcome !== 'failed') bus.emit('portfolio_updated')
}
