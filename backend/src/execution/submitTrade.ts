import { queryAll, queryOne, runSQL, withTransaction, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
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
      const openPos = queryOne("SELECT id FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
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
    withTransaction(() => {
      if (tradeId) {
        runSQL(
          "UPDATE trades SET price = ?, total = ?, fee_cost = ?, fee_currency = ?, status = 'EXECUTED', approved = 1 WHERE id = ?",
          [result.price, result.cost, result.fee_cost, result.fee_currency, tradeId]
        )
      } else {
        runSQL(
          "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?, 'EXECUTED', 1)",
          [signal.coin, signal.action, result.quantity, result.price, result.cost, result.fee_cost, result.fee_currency]
        )
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
        const existing = queryOne("SELECT id FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
        if (!existing) {
          const { lastInsertRowid } = runSQL(
            'INSERT INTO positions (coin, side, quantity, entry_price, stop_loss, take_profit, current_sl, horizon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [signal.coin, 'BUY', result.quantity, result.price, sl, tp, sl, signal.horizon ?? 'medium']
          )
          newPositionId = Number(lastInsertRowid)
          recordPositionOpen(newPositionId, signal.coin, sl, tp ?? null, result.price)
        }
        const costBasis = result.quantity > 0 ? result.cost / result.quantity : result.price
        addEntry(signal.coin, result.quantity, costBasis, new Date().toISOString().split('T')[0], 'trade', tradeId)
        const usdcEntry = getUsdcEntry()
        if (usdcEntry) reduceEntryQuantity(usdcEntry.id, result.cost)

      } else if (signal.action === 'SELL') {
        // Consolidate all SELL portfolio writes here so callers don't need to
        // duplicate them — and so they're in the same atomic transaction.
        const existingPos = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
        if (existingPos) {
          const posId = existingPos.id as number
          const qty = result.quantity || (existingPos.quantity as number)
          recordPositionClose(posId, result.price)
          const pnl = netRealizedPnl(qty, existingPos.entry_price as number, result.price, getSettings().fee_rate)
          runSQL(
            "UPDATE positions SET status = 'CLOSED', pnl = ? WHERE id = ?",
            [pnl, posId]
          )
          const sellEntries = queryAll(
            "SELECT id, quantity FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC",
            [signal.coin]
          ) as { id: number; quantity: number }[]
          for (const entry of sellEntries) reduceEntryQuantity(entry.id, qty)
          const usdcEntry = getUsdcEntry()
          if (usdcEntry) increaseEntryQuantity(usdcEntry.id, qty * result.price)
        }
      }
    })

    // Post-transaction: broadcasts and async exchange operations
    clearReviewsForCoin(signal.coin)
    const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    bus.emit('trade_executed', trade as any)
    broadcast('trade_executed', trade)

    if (newPositionId !== undefined) {
      logger.info('Position opened', { coin: signal.coin, price: result.price })
      await placeProtection(newPositionId)
      const openedPos = queryOne("SELECT * FROM positions WHERE id = ?", [newPositionId]) as import('../types.js').PositionRecord | null
      if (openedPos) bus.emit('position_opened', openedPos)
    }

    logger.info('Trade executed', { coin: signal.coin, action: signal.action, price: result.price })
    return { ok: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('Trade failed', { coin: signal.coin, error: errMsg })
    let failedId = tradeId
    if (tradeId) {
      runSQL("UPDATE trades SET status = 'FAILED', error = ? WHERE id = ? AND status = 'PENDING'", [errMsg, tradeId])
    } else {
      runSQL(
        "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved, error) VALUES (?, ?, ?, ?, ?, 0, 'USDC', 'FAILED', 1, ?)",
        [signal.coin, signal.action, signal.quantity, estimatedPrice, estimatedPrice * signal.quantity, errMsg]
      )
      failedId = (queryOne('SELECT last_insert_rowid() AS id') as any)?.id
    }
    const failedTrade = failedId
      ? queryOne('SELECT * FROM trades WHERE id = ?', [failedId])
      : null
    broadcast('trade_failed', failedTrade)
    bus.emit('trade_failed', { coin: signal.coin, side: signal.action, error: errMsg })
    return { ok: false, error: errMsg }
  } finally {
    if (claimedPositionId !== undefined) releaseExit(claimedPositionId)
  }
}
