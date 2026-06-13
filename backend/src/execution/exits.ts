import { queryAll, queryOne, runSQL, withTransaction, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { executeTrade } from '../trader/index.js'
import {
  cancelProtection, replaceProtection, closePositionFromExit,
  reduceEntryQuantity, increaseEntryQuantity, getUsdcEntry, seedUsdcIfAbsent,
} from '../portfolio/index.js'
import { claimExit, releaseExit } from './exitsInFlight.js'

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
    const pos = queryOne(
      "SELECT quantity, oco_status, take_profit FROM positions WHERE id = ? AND status = 'OPEN'",
      [positionId],
    ) as { quantity: number; oco_status: string; take_profit: number | null } | null
    if (!pos) return

    const qty = pos.quantity

    // If an active OCO is in place, move its SL to the current price rather than
    // cancelling it and issuing a market sell. The stop-limit triggers immediately,
    // and the reconciler closes the ledger entry once the fill is detected.
    if (pos.oco_status === 'ACTIVE' && pos.take_profit != null && pos.take_profit > triggerPrice) {
      runSQL(
        'UPDATE positions SET stop_loss = ?, current_sl = ? WHERE id = ?',
        [triggerPrice, triggerPrice, positionId],
      )
      await replaceProtection(positionId)

      const refreshed = queryOne(
        "SELECT oco_status FROM positions WHERE id = ? AND status = 'OPEN'",
        [positionId],
      ) as { oco_status: string } | null

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
    closePositionFromExit({
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
    runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved, error) VALUES (?, 'SELL', 0, 0, 0, 0, 'USDC', 'FAILED', 1, ?)",
      [coin, errMsg]
    )
    const failedTrade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    broadcast('trade_failed', failedTrade)
    bus.emit('trade_failed', { coin, side: 'SELL', error: errMsg })
  } finally {
    releaseExit(positionId)
  }
}

// Monitor-initiated REDUCE: partial market sell, then re-protect the remainder.
const MIN_REDUCE_NOTIONAL_USD = 5 // Binance spot minimum order notional

export async function executeMonitorReduce(
  positionId: number,
  coin: string,
  reduceToPct: number,
  triggerPrice: number,
  reasoning: string,
): Promise<void> {
  if (!claimExit(positionId)) {
    logger.warn('Monitor REDUCE skipped — another exit is already in flight', { coin, positionId })
    return
  }

  const pos = queryOne(
    "SELECT quantity FROM positions WHERE id = ? AND status = 'OPEN'",
    [positionId],
  ) as { quantity: number } | null
  if (!pos) {
    releaseExit(positionId)
    return
  }

  const sellQty = pos.quantity * (1 - reduceToPct / 100)
  const keepQty = pos.quantity - sellQty

  if (sellQty * triggerPrice < MIN_REDUCE_NOTIONAL_USD) {
    logger.warn('Monitor REDUCE skipped — sell amount below exchange minimum', { coin, positionId, sellQty, reduceToPct })
    releaseExit(positionId)
    return
  }
  if (keepQty * triggerPrice < MIN_REDUCE_NOTIONAL_USD) {
    // Remainder would be untradeable dust — exit fully instead. Release the claim
    // first so the delegated close can take it.
    logger.warn('Monitor REDUCE remainder below exchange minimum — closing position instead', { coin, positionId, keepQty })
    releaseExit(positionId)
    await executeMonitorClose(positionId, coin, triggerPrice, `${reasoning} (REDUCE remainder below minimum)`)
    return
  }

  try {
    // The coins are locked in the OCO; cancel before selling, re-place after.
    await cancelProtection(positionId)
    const result = await executeTrade({ coin, action: 'SELL', quantity: sellQty, reason: `Monitor reduce: ${reasoning}`, confidence: 1 })
    const fillQty = result.quantity || sellQty
    const fillPrice = result.price || triggerPrice
    const proceeds = fillQty * fillPrice

    withTransaction(() => {
      runSQL('UPDATE positions SET quantity = quantity - ? WHERE id = ?', [fillQty, positionId])

      // FIFO-reduce the local ledger entries for the coin.
      let remaining = fillQty
      const entries = queryAll(
        "SELECT id, quantity FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC",
        [coin],
      ) as { id: number; quantity: number }[]
      for (const e of entries) {
        if (remaining <= 0) break
        const take = Math.min(e.quantity, remaining)
        reduceEntryQuantity(e.id, take)
        remaining -= take
      }

      let usdcEntry = getUsdcEntry()
      if (!usdcEntry) {
        seedUsdcIfAbsent(0)
        usdcEntry = getUsdcEntry()
      }
      if (usdcEntry) increaseEntryQuantity(usdcEntry.id, proceeds)
      else logger.error('Monitor REDUCE: USDC entry missing after seed attempt — proceeds lost', { coin, proceeds })

      runSQL(
        "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, 'SELL', ?, ?, ?, ?, 'USDC', 'EXECUTED', 1)",
        [coin, fillQty, fillPrice, proceeds, getSettings().fee_rate * proceeds],
      )
    })

    // Re-place the OCO for the remaining quantity at the existing SL/TP levels.
    await replaceProtection(positionId)

    const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    if (trade) broadcast('trade_executed', trade)
    broadcast('monitor_position_reduced', { coin, positionId, soldQty: fillQty, keptQty: keepQty, price: fillPrice, reduceToPct, reasoning })
    bus.emit('portfolio_updated')
    logger.warn('Monitor REDUCE executed', { coin, positionId, soldQty: fillQty, keptPct: reduceToPct, price: fillPrice })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('Monitor reduce failed', { coin, error: errMsg })
    runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved, error) VALUES (?, 'SELL', 0, 0, 0, 0, 'USDC', 'FAILED', 1, ?)",
      [coin, errMsg],
    )
    broadcast('trade_failed', queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1'))
    bus.emit('trade_failed', { coin, side: 'SELL', error: errMsg })
    // The sell may have failed after the OCO cancel — re-protect whatever remains.
    await replaceProtection(positionId).catch(() => {})
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
    const pos = queryOne("SELECT quantity FROM positions WHERE id = ? AND status = 'OPEN'", [positionId])
    if (!pos) return
    const qty = pos.quantity as number
    const result = await executeTrade({ coin, action: 'SELL', quantity: qty, reason: label, confidence: 1 })
    closePositionFromExit({
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
    runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved, error) VALUES (?, 'SELL', 0, 0, 0, 0, 'USDC', 'FAILED', 1, ?)",
      [coin, errMsg]
    )
    const failedId = (queryOne('SELECT last_insert_rowid() AS id') as any)?.id
    broadcast('trade_failed', failedId ? queryOne('SELECT * FROM trades WHERE id = ?', [failedId]) : null)
    bus.emit('trade_failed', { coin, side: 'SELL', error: errMsg })
  } finally {
    releaseExit(positionId)
  }
}
