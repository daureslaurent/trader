import { trades, positions as positionsRepo, portfolioEntries, withTransaction, nowSql, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { systemBus, SystemEvent } from '../core/bus.js'
import { broadcast } from '../api/ws.js'
import { executeTrade } from '../trader/index.js'
import {
  cancelProtection, placeProtection,
  calculateStopLoss, calculateTakeProfit,
  recordPositionOpen, recordPositionClose,
  addEntry, reduceEntryQuantity, increaseEntryQuantity, getUsdcEntry, netRealizedPnl,
} from '../portfolio/index.js'
import { clearReviewsForCoin } from '../monitor/index.js'
import { Signal } from '../types.js'
import { claimExit, releaseExit } from './exitsInFlight.js'

/**
 * The single choke point for all real exchange orders. Guards concurrent exits
 * via the exits-in-flight claim, cancels the exchange OCO before selling, and
 * performs all DB writes (trade record + position + portfolio entries) inside
 * one transaction. SL/TP percentages from the analyst are applied at the real
 * fill price, falling back to ATR sizing only when absent.
 */
export async function submitTrade(signal: Signal, estimatedPrice: number, tradeId?: number, atr?: number, settings?: any): Promise<{ ok: boolean; error?: string }> {
  let claimedPositionId: number | undefined
  try {
    // Cancel exchange-side OCO before our own market sell — the coins are locked
    // in the open OCO and Binance would otherwise reject the sell.
    if (signal.action === 'SELL') {
      const openPos = await positionsRepo.findOne({ coin: signal.coin, status: 'OPEN' }, { projection: { id: 1 } })
      if (openPos) {
        const posId = openPos.id as number
        if (!claimExit(posId)) {
          logger.warn('SELL skipped — another exit is already in flight for this position', { coin: signal.coin, positionId: posId })
          return { ok: false, error: 'Exit already in progress for this position' }
        }
        claimedPositionId = posId
        await cancelProtection(posId)
      }
    }

    // Exchange API call — must happen OUTSIDE the transaction (async)
    const result = await executeTrade(signal)

    // Capture data needed post-transaction (OCO placement needs the new position ID)
    let newPositionId: number | undefined

    // Atomic DB writes: trade record + position + portfolio entries
    await withTransaction(async (session) => {
      if (tradeId) {
        await trades.update(
          { _id: tradeId },
          { price: result.price, total: result.cost, fee_cost: result.fee_cost, fee_currency: result.fee_currency, status: 'EXECUTED', approved: 1 },
          { session },
        )
      } else {
        await trades.insert({
          coin: signal.coin, side: signal.action, quantity: result.quantity, price: result.price,
          total: result.cost, fee_cost: result.fee_cost, fee_currency: result.fee_currency,
          signal_id: null, status: 'EXECUTED', approved: 1, error: null, created_at: nowSql(),
        }, { session })
      }

      if (signal.action === 'BUY') {
        // The exchange order already filled — the position MUST be recorded
        // regardless of ATR (a falsy atr only changes the SL/TP *fallback*, never
        // whether we book the position). atr was previously part of this gate,
        // which meant a 0/undefined ATR silently dropped the position + ledger
        // entry, leaving real coins untracked and unprotected.
        const s = settings ?? getSettings()
        // Prefer the horizon-derived SL/TP percentages the analyst computed
        // (computeRiskLevels), applied at the REAL fill price; fall back to ATR
        // sizing only when the signal carries no percentages ('auto' horizon).
        const sl = signal.stop_loss_pct != null
          ? result.price * (1 - signal.stop_loss_pct / 100)
          : calculateStopLoss(result.price, atr ?? 0, s)
        const tp = signal.take_profit_pct != null
          ? result.price * (1 + signal.take_profit_pct / 100)
          : calculateTakeProfit(result.price, atr ?? 0, s)
        const existing = await positionsRepo.findOne({ coin: signal.coin, status: 'OPEN' }, { projection: { id: 1 }, session })
        if (!existing) {
          newPositionId = Number(await positionsRepo.insert({
            coin: signal.coin, side: 'BUY', quantity: result.quantity, entry_price: result.price,
            stop_loss: sl, take_profit: tp, current_sl: sl, horizon: signal.horizon ?? 'medium',
            status: 'OPEN', entry_id: tradeId ?? null, exit_id: null, pnl: null,
            oco_order_list_id: null, oco_sl_order_id: null, oco_tp_order_id: null,
            oco_status: 'NONE', oco_synced_at: null, created_at: nowSql(),
          }, { session }))
          await recordPositionOpen(newPositionId, signal.coin, sl, tp ?? null, result.price, { session })
        }
        const costBasis = result.quantity > 0 ? result.cost / result.quantity : result.price
        await addEntry(signal.coin, result.quantity, costBasis, new Date().toISOString().split('T')[0], 'trade', tradeId, { session })
        const usdcEntry = await getUsdcEntry({ session })
        if (usdcEntry) await reduceEntryQuantity(usdcEntry.id, result.cost, { session })

      } else if (signal.action === 'SELL') {
        // Consolidate all SELL portfolio writes here so callers don't need to
        // duplicate them — and so they're in the same atomic transaction.
        const existingPos = await positionsRepo.findOne({ coin: signal.coin, status: 'OPEN' }, { session })
        if (existingPos) {
          const posId = existingPos.id as number
          const qty = result.quantity || (existingPos.quantity as number)
          await recordPositionClose(posId, result.price, { session })
          const pnl = netRealizedPnl(qty, existingPos.entry_price as number, result.price, getSettings().fee_rate)
          await positionsRepo.update({ _id: posId }, { status: 'CLOSED', pnl }, { session })
          const sellEntries = (await portfolioEntries.find(
            { coin: signal.coin, status: 'OPEN' },
            { sort: { created_at: 1 }, projection: { id: 1, quantity: 1 }, session },
          )) as unknown as { id: number; quantity: number }[]
          for (const entry of sellEntries) await reduceEntryQuantity(entry.id, qty, { session })
          const usdcEntry = await getUsdcEntry({ session })
          if (usdcEntry) await increaseEntryQuantity(usdcEntry.id, qty * result.price, { session })
        }
      }
    })

    // Post-transaction: broadcasts and async exchange operations
    void clearReviewsForCoin(signal.coin).catch(() => { /* best-effort cleanup */ })
    const trade = await trades.findOne({}, { sort: { id: -1 } })
    bus.emit('trade_executed', trade as any)
    broadcast('trade_executed', trade)
    systemBus.emitEvent(SystemEvent.EXECUTION_ORDER_FILLED, {
      symbol: signal.coin,
      side: signal.action as 'BUY' | 'SELL',
      qty: result.quantity,
      price: result.price,
      notionalUsd: result.quantity * result.price,
    })

    if (newPositionId !== undefined) {
      logger.info('Position opened', { coin: signal.coin, price: result.price })
      await placeProtection(newPositionId)
      const openedPos = await positionsRepo.findById(newPositionId) as unknown as import('../types.js').PositionRecord | null
      if (openedPos) bus.emit('position_opened', openedPos)
    }

    logger.info('Trade executed', { coin: signal.coin, action: signal.action, price: result.price })
    return { ok: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('Trade failed', { coin: signal.coin, error: errMsg })
    let failedId: number | undefined = tradeId
    if (tradeId) {
      await trades.update({ _id: tradeId, status: 'PENDING' }, { status: 'FAILED', error: errMsg })
    } else {
      failedId = Number(await trades.insert({
        coin: signal.coin, side: signal.action, quantity: signal.quantity, price: estimatedPrice,
        total: estimatedPrice * signal.quantity, fee_cost: 0, fee_currency: 'USDC',
        signal_id: null, status: 'FAILED', approved: 1, error: errMsg, created_at: nowSql(),
      }))
    }
    const failedTrade = failedId
      ? await trades.findById(failedId)
      : null
    broadcast('trade_failed', failedTrade)
    bus.emit('trade_failed', { coin: signal.coin, side: signal.action, error: errMsg })
    systemBus.emitEvent(SystemEvent.EXECUTION_ORDER_FAILED, {
      symbol: signal.coin,
      side: signal.action as 'BUY' | 'SELL',
      error: errMsg,
    })
    return { ok: false, error: errMsg }
  } finally {
    if (claimedPositionId !== undefined) releaseExit(claimedPositionId)
  }
}
