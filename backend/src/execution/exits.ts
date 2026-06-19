import { trades, positions as positionsRepo, portfolioEntries, withTransaction, nowSql, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { executeTrade } from '../trader/index.js'
import {
  cancelProtection, replaceProtection, closePositionFromExit,
  reduceEntryQuantity, increaseEntryQuantity, getUsdcEntry, seedUsdcIfAbsent,
} from '../portfolio/index.js'
import { claimExit, releaseExit } from './exitsInFlight.js'

// Record a FAILED SELL trade and broadcast it. Shared by the exit handlers' catch blocks.
async function recordFailedSell(coin: string, errMsg: string): Promise<void> {
  const id = await trades.insert({
    coin, side: 'SELL', quantity: 0, price: 0, total: 0, fee_cost: 0, fee_currency: 'USDC',
    signal_id: null, status: 'FAILED', approved: 1, error: errMsg, created_at: nowSql(),
  })
  broadcast('trade_failed', await trades.findById(id as number))
  bus.emit('trade_failed', { coin, side: 'SELL', error: errMsg })
}

// Monitor-initiated CLOSE: move SL to current price so the OCO stop leg
// triggers immediately on Binance (avoids the cancel-then-market-sell path
// that fails when coins are locked in a partially-cancelled OCO).
export async function executeMonitorClose(
  positionId: number,
  coin: string,
  triggerPrice: number,
  reasoning: string,
): Promise<void> {
  if (!claimExit(positionId)) {
    logger.warn('Monitor CLOSE skipped — another exit is already in flight', { coin, positionId })
    return
  }
  try {
    const pos = (await positionsRepo.findOne(
      { _id: positionId, status: 'OPEN' },
      { projection: { quantity: 1, oco_status: 1, take_profit: 1 } },
    )) as { quantity: number; oco_status: string; take_profit: number | null } | null
    if (!pos) return

    const qty = pos.quantity

    // If an active OCO is in place, move its SL to the current price rather than
    // cancelling it and issuing a market sell. The stop-limit triggers immediately,
    // and the reconciler closes the ledger entry once the fill is detected.
    if (pos.oco_status === 'ACTIVE' && pos.take_profit != null && pos.take_profit > triggerPrice) {
      await positionsRepo.update({ _id: positionId }, { stop_loss: triggerPrice, current_sl: triggerPrice })
      await replaceProtection(positionId)

      const refreshed = (await positionsRepo.findOne(
        { _id: positionId, status: 'OPEN' },
        { projection: { oco_status: 1 } },
      )) as { oco_status: string } | null

      if (refreshed?.oco_status === 'ACTIVE') {
        logger.warn('Monitor CLOSE: SL moved to current price, awaiting OCO fill', { coin, positionId, price: triggerPrice })
        broadcast('monitor_position_closing', { coin, positionId, price: triggerPrice, reasoning })
        return
      }
      // OCO replacement failed (e.g. Binance rejected stop at current price after
      // the cancel succeeded) — fall through to market sell. The coins are now
      // unlocked because the cancel step did complete.
    }

    // No active OCO or OCO replacement failed: cancel any remnants and market-sell.
    await cancelProtection(positionId)
    const result = await executeTrade({ coin, action: 'SELL', quantity: qty, reason: `Monitor close: ${reasoning}`, confidence: 1 })
    await closePositionFromExit({
      positionId,
      coin,
      status: 'CLOSED',
      fillPrice: result.price || triggerPrice,
      fillQty: result.quantity || qty,
      reason: `Monitor close: ${reasoning}`,
    })
    broadcast('monitor_position_closed', { coin, positionId, price: result.price || triggerPrice, reasoning })
    logger.warn('Monitor CLOSE executed', { coin, positionId, price: result.price || triggerPrice })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('Monitor close failed', { coin, error: errMsg })
    await recordFailedSell(coin, errMsg)
  } finally {
    releaseExit(positionId)
  }
}

// Software-fallback exits. These fire only from the reconciler when a position
// has NO live exchange-side OCO (placement failed / unsupported). The bot issues
// the market sell itself, then closePositionFromExit handles the bookkeeping.
// When an OCO is active, Binance executes the exit and the reconciler detects the
// fill directly — these handlers do not run.
export async function executeFallbackExit(
  positionId: number,
  coin: string,
  triggerPrice: number,
  status: 'SL_HIT' | 'TP_HIT',
  label: string,
): Promise<void> {
  if (!claimExit(positionId)) {
    logger.warn('Fallback exit skipped — another exit is already in flight', { coin, positionId, label })
    return
  }
  try {
    const pos = await positionsRepo.findOne({ _id: positionId, status: 'OPEN' }, { projection: { quantity: 1 } })
    if (!pos) return
    const qty = pos.quantity as number
    const result = await executeTrade({ coin, action: 'SELL', quantity: qty, reason: label, confidence: 1 })
    await closePositionFromExit({
      positionId,
      coin,
      status,
      fillPrice: result.price || triggerPrice,
      fillQty: result.quantity || qty,
      reason: `${label} (software fallback)`,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error(`Failed to execute ${label.toLowerCase()}`, { coin, error: errMsg })
    await recordFailedSell(coin, errMsg)
  } finally {
    releaseExit(positionId)
  }
}
