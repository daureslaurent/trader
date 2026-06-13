import { queryAll, queryOne, runSQL, withTransaction, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { getPrice } from '../market/index.js'
import { checkPosition } from './risk.js'
import { recordPositionClose } from './slTpHistory.js'
import { clearReviewsForCoin } from '../monitor/index.js'
import { MarketData, PortfolioEntry, PortfolioState, BotSettings, PositionRecord } from '../types.js'

const USDC_COIN = 'USDC'

export function getOpenEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown as PortfolioEntry[]
}

export function getCoinEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries WHERE status = 'OPEN' AND coin != ? ORDER BY created_at ASC", [USDC_COIN]) as unknown as PortfolioEntry[]
}

export function getUsdcEntry(): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [USDC_COIN]) as PortfolioEntry | null
}

export function seedUsdcIfAbsent(amount: number): void {
  if (getUsdcEntry()) return
  const today = new Date().toISOString().split('T')[0]
  addEntry(USDC_COIN, amount, 1.0, today, 'manual')
  logger.info('USDC entry seeded', { amount })
}

// Compares the real Binance USDC balance against the local ledger.
// Only acts when a local entry already exists — never auto-seeds.
// If Binance < local, an external withdrawal happened — reduce local accordingly.
// Deposits must be done explicitly via the deposit endpoint.
export function detectExternalWithdrawal(binanceUsdc: number): void {
  const existing = getUsdcEntry()
  if (!existing) return
  if (binanceUsdc < existing.quantity) {
    const withdrawn = existing.quantity - binanceUsdc
    logger.info('External USDC withdrawal detected', { withdrawn, localBefore: existing.quantity, binanceNow: binanceUsdc })
    reduceEntryQuantity(existing.id, withdrawn)
  }
}

export function depositUsdc(amount: number): number {
  const entry = getUsdcEntry()
  if (entry) {
    increaseEntryQuantity(entry.id, amount)
    return entry.quantity + amount
  } else {
    const today = new Date().toISOString().split('T')[0]
    addEntry(USDC_COIN, amount, 1.0, today, 'manual')
    return amount
  }
}

export function withdrawUsdc(amount: number): { ok: boolean; balance: number; error?: string } {
  const entry = getUsdcEntry()
  if (!entry) return { ok: false, balance: 0, error: 'No USDC balance' }
  if (entry.quantity < amount) return { ok: false, balance: entry.quantity, error: 'Insufficient balance' }
  reduceEntryQuantity(entry.id, amount)
  return { ok: true, balance: entry.quantity - amount }
}

export function getEntryByCoin(coin: string): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC LIMIT 1", [coin]) as PortfolioEntry | null
}

export function updatePortfolioForTrade(
  fromCoin: string,
  fromAmount: number,
  toCoin: string,
  toAmount: number,
  toPrice: number,
  buyTradeId: number,
): void {
  const fromEntry = fromCoin === USDC_COIN ? getUsdcEntry() : getEntryByCoin(fromCoin)
  if (!fromEntry) throw new Error(`updatePortfolioForTrade: no open entry for ${fromCoin}`)
  if (fromEntry.quantity < fromAmount) throw new Error(`updatePortfolioForTrade: insufficient balance for ${fromCoin}`)

  reduceEntryQuantity(fromEntry.id, fromAmount)

  const toEntry = toCoin === USDC_COIN ? getUsdcEntry() : getEntryByCoin(toCoin)
  if (toEntry) {
    increaseEntryQuantity(toEntry.id, toAmount)
  } else {
    const today = new Date().toISOString().split('T')[0]
    addEntry(toCoin, toAmount, toPrice, today, 'trade', buyTradeId)
  }
}

export function getAllEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries ORDER BY created_at DESC") as unknown as PortfolioEntry[]
}

export function getEntryById(id: number): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE id = ?", [id]) as PortfolioEntry | null
}

export function addEntry(
  coin: string,
  quantity: number,
  buyPrice: number,
  buyDate: string,
  source: 'trade' | 'manual' | 'transfer' = 'trade',
  tradeId?: number,
): number {
  const { lastInsertRowid } = runSQL(
    `INSERT INTO portfolio_entries (coin, quantity, buy_price, buy_date, source, trade_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [coin, quantity, buyPrice, buyDate, source, tradeId ?? null]
  )
  logger.info('Portfolio entry added', { coin, quantity, buyPrice, id: lastInsertRowid })
  return lastInsertRowid
}

export function closeEntry(id: number): void {
  runSQL("UPDATE portfolio_entries SET status = 'CLOSED' WHERE id = ? AND status = 'OPEN'", [id])
  const entry = getEntryById(id)
  if (entry) {
    logger.info('Portfolio entry closed', { coin: entry.coin, id })
  }
}

export function reduceEntryQuantity(id: number, sellQty: number): void {
  const entry = getEntryById(id)
  if (!entry) return
  const newQty = entry.quantity - sellQty
  if (newQty <= 0) {
    closeEntry(id)
  } else {
    runSQL("UPDATE portfolio_entries SET quantity = ? WHERE id = ?", [newQty, id])
  }
}

export function removeEntry(id: number): void {
  runSQL("DELETE FROM portfolio_entries WHERE id = ?", [id])
}

export function updateEntryQuantity(id: number, quantity: number): void {
  runSQL("UPDATE portfolio_entries SET quantity = ? WHERE id = ?", [quantity, id])
}

export function increaseEntryQuantity(id: number, additionalQty: number): void {
  runSQL("UPDATE portfolio_entries SET quantity = quantity + ? WHERE id = ?", [additionalQty, id])
}

export function updateEntry(id: number, updates: Partial<Pick<PortfolioEntry, 'quantity' | 'buy_price' | 'buy_date'>>): void {
  const setClauses: string[] = []
  const params: (string | number)[] = []
  if (updates.quantity !== undefined) {
    setClauses.push('quantity = ?')
    params.push(updates.quantity)
  }
  if (updates.buy_price !== undefined) {
    setClauses.push('buy_price = ?')
    params.push(updates.buy_price)
  }
  if (updates.buy_date !== undefined) {
    setClauses.push('buy_date = ?')
    params.push(updates.buy_date)
  }
  if (setClauses.length === 0) return
  params.push(id)
  runSQL(`UPDATE portfolio_entries SET ${setClauses.join(', ')} WHERE id = ?`, params)
}

export function getPortfolioState(
  marketData: MarketData[],
  settings: BotSettings,
): PortfolioState {
  const usdcEntry = getUsdcEntry()
  const coinEntries = getCoinEntries()
  const usdcTotal = usdcEntry ? usdcEntry.quantity : 0
  let totalValue = usdcTotal

  for (const entry of coinEntries) {
    const md = marketData.find(d => d.symbol === entry.coin)
    if (md) {
      totalValue += entry.quantity * md.price
    }
  }

  const positions = coinEntries.map(e => {
    const md = marketData.find(d => d.symbol === e.coin)
    const currentPrice = md?.price || e.buy_price
    const currentValue = e.quantity * currentPrice
    const allocationPct = totalValue > 0 ? currentValue / totalValue : 0
    const deltaPct = e.buy_price > 0 ? ((currentPrice - e.buy_price) / e.buy_price) * 100 : 0
    return {
      coin: e.coin,
      allocationPct,
      deltaPct,
      entryPrice: e.buy_price,
      currentPrice,
      quantity: e.quantity,
    }
  })

  const coinCount = positions.length + 1
  const targetAllocationPct = coinCount > 0 ? 1 / coinCount : 1

  const allocs = positions.map(p => p.allocationPct)
  const idealAlloc = 1 / coinCount
  const deviations = allocs.map(a => Math.abs(a - idealAlloc))
  const avgDeviation = deviations.length > 0 ? deviations.reduce((s, d) => s + d, 0) / deviations.length : 0
  const diversificationScore = Math.max(0, 1 - avgDeviation)

  // openPositionCount tracks only bot-managed positions (positions table, status=OPEN).
  // portfolio_entries includes manual/transfer holdings which don't consume a bot slot.
  const botPositionCount = (queryAll("SELECT COUNT(*) AS cnt FROM positions WHERE status = 'OPEN'")[0]?.cnt as number) ?? 0

  return {
    totalValueUsd: totalValue,
    positions,
    diversificationScore,
    openPositionCount: botPositionCount,
    maxOpenPositions: settings.max_open_positions,
    targetAllocationPct,
  }
}

export interface CoinPortfolioContext {
  currentQuantity: number
  avgBuyPrice: number | null
  recentTrades: { side: 'BUY' | 'SELL'; quantity: number; price: number; date: string }[]
}

export function getCoinPortfolioContext(coin: string): CoinPortfolioContext {
  const entries = queryAll(
    "SELECT quantity, buy_price FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'",
    [coin]
  ) as { quantity: number; buy_price: number }[]

  const currentQuantity = entries.reduce((sum, e) => sum + e.quantity, 0)
  const avgBuyPrice = currentQuantity > 0
    ? entries.reduce((sum, e) => sum + e.buy_price * e.quantity, 0) / currentQuantity
    : null

  const trades = queryAll(
    "SELECT side, quantity, price, created_at FROM trades WHERE coin = ? AND status = 'EXECUTED' ORDER BY created_at DESC LIMIT 5",
    [coin]
  ) as { side: string; quantity: number; price: number; created_at: string }[]

  return {
    currentQuantity,
    avgBuyPrice,
    recentTrades: trades.map(t => ({
      side: t.side as 'BUY' | 'SELL',
      quantity: t.quantity,
      price: t.price,
      date: t.created_at.split('T')[0] ?? t.created_at.split(' ')[0] ?? t.created_at,
    })),
  }
}

// ── Exchange-side OCO lifecycle ──────────────────────────────────────────────
// The bot places a real OCO sell on Binance for every open position so the
// exchange enforces SL/TP even when the bot is offline. These helpers place,
// reconcile, and (when the exchange can't protect a position) fall back to a
// software stop. See trader/oco.ts for the exchange API.

function getBotPositionById(id: number): PositionRecord | null {
  return queryOne("SELECT * FROM positions WHERE id = ?", [id]) as unknown as PositionRecord | null
}

function getOpenBotPositions(): PositionRecord[] {
  return queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown as PositionRecord[]
}

function persistOco(positionId: number, oco: { orderListId: string; slOrderId: string | null; tpOrderId: string | null; status: 'NONE' | 'ACTIVE' | 'FAILED' }): void {
  runSQL(
    "UPDATE positions SET oco_order_list_id = ?, oco_sl_order_id = ?, oco_tp_order_id = ?, oco_status = ?, oco_synced_at = datetime('now') WHERE id = ?",
    [oco.orderListId || null, oco.slOrderId, oco.tpOrderId, oco.status, positionId]
  )
}

function setOcoStatus(positionId: number, status: 'NONE' | 'ACTIVE' | 'FAILED'): void {
  runSQL("UPDATE positions SET oco_status = ?, oco_synced_at = datetime('now') WHERE id = ?", [status, positionId])
}

export interface PositionExit {
  positionId: number
  coin: string
  status: 'CLOSED' | 'SL_HIT' | 'TP_HIT'
  fillPrice: number
  fillQty: number
  reason: string
}

/**
 * Pure bookkeeping for a position that has already exited (sold). Records the
 * SELL trade, closes the position + ledger entries, credits net USDC proceeds,
 * and broadcasts. Idempotent — bails if the position is no longer OPEN, so
 * overlapping reconcile passes can't double-close.
 *
 * All DB writes are wrapped in a single transaction so a mid-crash can't leave
 * the coin closed but USDC unreplenished (issue #3/#6d).
 *
 * The actual exchange sell must already have happened (OCO fill on the exchange,
 * or a market sell issued by the caller). This function never trades.
 */
export function closePositionFromExit(exit: PositionExit): boolean {
  let positionClosed = false
  let pnl: number | null = null

  const preClose = queryOne("SELECT entry_price, quantity, created_at FROM positions WHERE id = ? AND status = 'OPEN'", [exit.positionId]) as
    | { entry_price: number; quantity: number; created_at: string }
    | null

  // Exchange fees are not reported for OCO fills, so estimate from the configured
  // rate: one side on the entry notional, one on the exit notional. Without this
  // every scratch exit shows pnl = 0 when it actually lost the round-trip cost.
  const feeRate = getSettings().fee_rate
  const feeEst = preClose != null
    ? feeRate * exit.fillQty * (preClose.entry_price + exit.fillPrice)
    : 0

  // Atomic: position close + ledger update + USDC credit
  const committed = withTransaction(() => {
    const r = runSQL(
      "UPDATE positions SET status = ?, pnl = (quantity * (? - entry_price)) - ? WHERE id = ? AND status = 'OPEN'",
      [exit.status, exit.fillPrice, feeEst, exit.positionId]
    )
    if (r.changes === 0) return false  // already closed by a concurrent pass

    positionClosed = true
    pnl = (getBotPositionById(exit.positionId)?.pnl) ?? null

    recordPositionClose(exit.positionId, exit.fillPrice)

    // Close the local ledger entries for the coin (full exit).
    const entries = queryAll(
      "SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC",
      [exit.coin]
    ) as { id: number }[]
    for (const e of entries) closeEntry(e.id)

    const proceeds = exit.fillPrice * exit.fillQty
    let usdcEntry = getUsdcEntry()
    if (!usdcEntry) {
      // #6a: USDC entry was deleted or never seeded — auto-seed at zero so the credit lands safely
      seedUsdcIfAbsent(0)
      usdcEntry = getUsdcEntry()
    }
    if (usdcEntry) {
      increaseEntryQuantity(usdcEntry.id, proceeds)
    } else {
      logger.error('closePositionFromExit: USDC entry missing after seed attempt — proceeds lost', {
        coin: exit.coin, proceeds,
      })
    }

    // Estimated sell-side fee; the USDC credit above stays gross because the
    // periodic Binance balance sync only ever corrects downward — under-crediting
    // would register as a phantom external withdrawal.
    runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, 'SELL', ?, ?, ?, ?, 'USDC', 'EXECUTED', 1)",
      [exit.coin, exit.fillQty, exit.fillPrice, exit.fillPrice * exit.fillQty, feeRate * exit.fillPrice * exit.fillQty]
    )
    return true
  })

  if (!committed || !positionClosed) return false

  // Post-commit: non-critical cleanup + broadcasts
  clearReviewsForCoin(exit.coin)

  if (exit.status === 'SL_HIT') broadcast('stop_loss_hit', { coin: exit.coin, price: exit.fillPrice, pnl })
  else if (exit.status === 'TP_HIT') broadcast('take_profit_hit', { coin: exit.coin, price: exit.fillPrice, pnl })
  const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
  if (trade) broadcast('trade_executed', trade)

  bus.emit('portfolio_updated')
  bus.emit('position_closed', {
    positionId: exit.positionId,
    coin: exit.coin,
    status: exit.status,
    fillPrice: exit.fillPrice,
    fillQty: exit.fillQty,
    pnl,
    reason: exit.reason,
    entryPrice: preClose?.entry_price ?? null,
    openedAt: preClose?.created_at ?? null,
  })
  logger.info('Position closed from exit', { coin: exit.coin, status: exit.status, fillPrice: exit.fillPrice, reason: exit.reason })
  return true
}

/**
 * Place (or replace) exchange-side OCO protection for an open position. On
 * failure the position is marked FAILED and the software fallback in
 * reconcileOpenPositions() keeps it protected. Safe to call repeatedly.
 */
export async function placeProtection(positionId: number): Promise<void> {
  const pos = getBotPositionById(positionId)
  if (!pos || pos.status !== 'OPEN') return
  if (pos.take_profit == null) {
    // OCO needs both legs; without a TP we rely on the software stop.
    setOcoStatus(positionId, 'FAILED')
    logger.warn('No take-profit set — OCO skipped, software stop active', { coin: pos.coin, positionId })
    return
  }

  const trader = await import('../trader/index.js')
  const bufferPct = getSettings().oco_sl_buffer_pct
  try {
    const res = await trader.placeOco(pos.coin, pos.quantity, {
      stopLoss: pos.current_sl,
      takeProfit: pos.take_profit,
      bufferPct,
    })
    persistOco(positionId, res)
    logger.info('OCO protection placed', { coin: pos.coin, positionId, orderListId: res.orderListId, stopLoss: pos.current_sl, takeProfit: pos.take_profit })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)

    // "Insufficient balance" has two sub-cases:
    //  1. Coins are locked in a surviving OCO (bot restart lost the IDs) → reattach.
    //  2. Buy fee was taken in the base currency so actual balance < recorded
    //     position quantity → retry with the real free balance.
    if (/insufficient balance/i.test(msg)) {
      try {
        const existing = await trader.findExistingOco(pos.coin)
        if (existing) {
          persistOco(positionId, existing)
          logger.info('OCO protection reattached after restart (recovered lost OCO state)', {
            coin: pos.coin, positionId, orderListId: existing.orderListId,
          })
          return
        }
      } catch (recErr) {
        logger.warn('OCO recovery lookup threw unexpectedly', { coin: pos.coin, error: recErr instanceof Error ? recErr.message : String(recErr) })
      }

      // No locked OCO found — try with the actual free balance (fees may have
      // reduced it by ~0.1 %). Accept up to 2 % below the recorded quantity.
      try {
        const base = pos.coin.split('/')[0]
        const bal = await trader.fetchBalance()
        const actualQty = bal[base]?.free ?? 0
        if (actualQty > 0 && actualQty >= pos.quantity * 0.98 && actualQty < pos.quantity) {
          logger.info('Retrying OCO with fee-adjusted balance', {
            coin: pos.coin, positionId, recorded: pos.quantity, actual: actualQty,
          })
          const res = await trader.placeOco(pos.coin, actualQty, {
            stopLoss: pos.current_sl,
            takeProfit: pos.take_profit!,
            bufferPct,
          })
          persistOco(positionId, res)
          // Align the recorded quantity with what Binance actually holds so
          // future OCO replacements and close calculations use the correct value.
          runSQL('UPDATE positions SET quantity = ? WHERE id = ?', [actualQty, positionId])
          logger.info('OCO protection placed with fee-adjusted quantity', {
            coin: pos.coin, positionId, orderListId: res.orderListId, qty: actualQty,
          })
          return
        }
      } catch (feeRetryErr) {
        logger.warn('OCO fee-adjusted retry failed', {
          coin: pos.coin, positionId, error: feeRetryErr instanceof Error ? feeRetryErr.message : String(feeRetryErr),
        })
      }
    }

    setOcoStatus(positionId, 'FAILED')
    logger.error('OCO placement failed — software fallback active', { coin: pos.coin, positionId, error: msg })
  }
}

/**
 * Replace a position's OCO after its SL/TP levels change (cancel + place; Binance
 * Spot has no native modify). Falls back to a fresh placement if nothing is live.
 * Reads the current levels from the DB, so callers should persist new levels first.
 */
export async function replaceProtection(positionId: number): Promise<void> {
  const pos = getBotPositionById(positionId)
  if (!pos || pos.status !== 'OPEN') return
  if (pos.oco_status !== 'ACTIVE' || !pos.oco_order_list_id) {
    await placeProtection(positionId)
    return
  }
  if (pos.take_profit == null) {
    await cancelProtection(positionId)
    setOcoStatus(positionId, 'FAILED')
    return
  }
  const trader = await import('../trader/index.js')
  const bufferPct = getSettings().oco_sl_buffer_pct
  try {
    const res = await trader.updateOco(pos.coin, pos.oco_order_list_id, pos.quantity, {
      stopLoss: pos.current_sl,
      takeProfit: pos.take_profit,
      bufferPct,
    })
    persistOco(positionId, res)
    if (res.status === 'FAILED') logger.error('OCO replace failed — software fallback active', { coin: pos.coin, positionId })
    else logger.info('OCO protection replaced', { coin: pos.coin, positionId, orderListId: res.orderListId, stopLoss: pos.current_sl, takeProfit: pos.take_profit })
  } catch (err) {
    setOcoStatus(positionId, 'FAILED')
    logger.error('OCO replace failed — software fallback active', { coin: pos.coin, positionId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Cancel a position's OCO before the bot issues its own market sell (analyst
 * exit, manual close). Otherwise Binance rejects the sell — the coins are locked
 * in the open OCO. Idempotent and best-effort.
 */
export async function cancelProtection(positionId: number): Promise<void> {
  const pos = getBotPositionById(positionId)
  if (!pos || pos.oco_status !== 'ACTIVE' || !pos.oco_order_list_id) return
  const trader = await import('../trader/index.js')
  try {
    await trader.cancelOco(pos.coin, pos.oco_order_list_id)
  } catch (err) {
    logger.warn('Failed to cancel OCO before sell', { coin: pos.coin, positionId, error: err instanceof Error ? err.message : String(err) })
  }
  setOcoStatus(positionId, 'NONE')
}

let reconciling = false

/**
 * Reconcile every open position with the exchange:
 *  1. ACTIVE OCO → check whether a leg filled (exchange closed the position) and
 *     record the close, or detect a manual Binance cancel and re-protect.
 *  2. Unprotected (NONE/FAILED) → place a fresh OCO; if that fails, run a
 *     software stop so the position is never silently unprotected.
 * Replaces the old market-sell polling loop. Re-entrancy guarded.
 */
export async function reconcileOpenPositions(): Promise<void> {
  if (reconciling) return
  reconciling = true
  try {
    const positions = getOpenBotPositions()
    if (positions.length === 0) return
    const trader = await import('../trader/index.js')

    for (const pos of positions) {
      try {
        if (pos.oco_status === 'ACTIVE' && pos.oco_order_list_id) {
          const oco = await trader.fetchOco(pos.coin, {
            orderListId: pos.oco_order_list_id,
            slOrderId: pos.oco_sl_order_id,
            tpOrderId: pos.oco_tp_order_id,
          })
          if (oco.status === 'OPEN') continue
          if (oco.status === 'FILLED' && oco.filledLeg) {
            const fillQty = oco.fillQty ?? pos.quantity
            // #6b: Skip close if only partially filled — wait for the full fill next cycle.
            // A partial fill shouldn't close the ledger entry; it isn't fully executed yet.
            if (fillQty < pos.quantity * 0.99) {
              logger.warn('OCO partially filled — waiting for full fill before closing', {
                coin: pos.coin, positionQty: pos.quantity, fillQty,
              })
              continue
            }
            closePositionFromExit({
              positionId: pos.id,
              coin: pos.coin,
              status: oco.filledLeg === 'SL' ? 'SL_HIT' : 'TP_HIT',
              fillPrice: oco.fillPrice ?? (oco.filledLeg === 'SL' ? pos.current_sl : (pos.take_profit ?? pos.entry_price)),
              fillQty,
              reason: oco.filledLeg === 'SL' ? 'Stop loss (OCO)' : 'Take profit (OCO)',
            })
            continue
          }
          // CANCELED on the exchange while still open (manual cancel) → re-protect.
          logger.warn('OCO cancelled on exchange, re-placing protection', { coin: pos.coin, positionId: pos.id })
          setOcoStatus(pos.id, 'NONE')
          pos.oco_status = 'NONE'
        }

        // Needs protection (NONE / FAILED / just-cancelled).
        await placeProtection(pos.id)

        // If protection still couldn't be placed, check whether the coin was
        // sold on Binance externally (manually or via a fill the bot didn't see).
        // If the balance is effectively zero the position is gone — close it.
        const refreshed = getBotPositionById(pos.id)
        if (refreshed && refreshed.status === 'OPEN' && refreshed.oco_status !== 'ACTIVE') {
          try {
            const base = pos.coin.split('/')[0]
            const bal = await trader.fetchBalance()
            const held = bal[base]?.total ?? 0
            if (held < pos.quantity * 0.01) {
              const price = getPrice(pos.coin)?.price ?? pos.entry_price
              logger.warn('External position close detected — coin no longer held on Binance', {
                coin: pos.coin, positionId: pos.id, held, expected: pos.quantity,
              })
              closePositionFromExit({
                positionId: pos.id,
                coin: pos.coin,
                status: 'CLOSED',
                fillPrice: price,
                fillQty: pos.quantity,
                reason: 'External close (coin no longer held on Binance)',
              })
              continue
            }
          } catch (balErr) {
            logger.warn('Balance check for external-close detection failed', {
              coin: pos.coin, error: balErr instanceof Error ? balErr.message : String(balErr),
            })
          }

          // Coin is still held — enforce the stop in software.
          const price = getPrice(pos.coin)?.price
          if (price) {
            const hit = checkPosition(price, refreshed)
            if (hit === 'SL_HIT') bus.emit('stop_loss_hit', { positionId: pos.id, coin: pos.coin, price })
            else if (hit === 'TP_HIT') bus.emit('take_profit_hit', { positionId: pos.id, coin: pos.coin, price })
          }
        }
      } catch (err) {
        logger.warn('Failed to reconcile position', { coin: pos.coin, error: err instanceof Error ? err.message : String(err) })
      }
    }
  } finally {
    reconciling = false
  }
}

export function enrichPortfolioEntriesWithPrices(
  entries: PortfolioEntry[],
  marketData: MarketData[],
): PortfolioEntry[] {
  return entries.map(e => {
    const isUsdc = e.coin === USDC_COIN
    const currentPrice = isUsdc ? 1.0 : (marketData.find(d => d.symbol === e.coin)?.price ?? null)
    const deltaUsd = currentPrice !== null && e.buy_price > 0
      ? (currentPrice - e.buy_price) * e.quantity
      : null
    const deltaPct = currentPrice !== null && e.buy_price > 0
      ? ((currentPrice - e.buy_price) / e.buy_price) * 100
      : null
    return {
      ...e,
      current_price: currentPrice,
      delta_usd: deltaUsd !== null ? Math.round(deltaUsd * 100) / 100 : null,
      delta_pct: deltaPct !== null ? Math.round(deltaPct * 100) / 100 : null,
    }
  })
}
