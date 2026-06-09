import { Exchange } from 'ccxt'
import { getExchange } from './service.js'
import { logger } from '../core/logger.js'
import { TradeError } from '../core/errors.js'
import { OcoLevels, OcoResult, OcoCancelResult, OcoFetchResult } from './types.js'

// ── Exchange-side OCO (One-Cancels-the-Other) on Binance Spot ────────────────
//
// An OCO sell protects an open long with two legs that live on the exchange:
//   • take-profit  → LIMIT_MAKER  at `takeProfit`
//   • stop-loss    → STOP_LOSS_LIMIT, triggered at `stopLoss`, limit a small
//                    buffer below the trigger so it still fills on a fast move.
// Whichever leg fills first cancels the other — enforced by Binance, so the
// position stays protected even when the bot is offline.
//
// IMPORTANT: Binance Spot has **no endpoint to modify an OCO**. `updateOco`
// therefore does an atomic cancel + replace internally. The rest of the codebase
// stays modify-shaped; if Binance ever ships a real edit endpoint this is the
// single place to change.

/** Thrown when an OCO cannot be placed for a structural reason (too small, bad levels). */
export class OcoUnplaceableError extends TradeError {
  constructor(message: string) {
    super(message)
    this.name = 'OcoUnplaceableError'
  }
}

let marketsLoaded = false

async function ensureMarkets(ex: Exchange): Promise<void> {
  if (marketsLoaded) return
  await ex.loadMarkets()
  marketsLoaded = true
}


/**
 * Place an exchange-side OCO sell. Validates the levels and exchange limits
 * first — throws {@link OcoUnplaceableError} if the position can't be protected
 * (e.g. below min-notional) so the caller can fall back to software stops.
 */
export async function placeOco(symbol: string, quantity: number, levels: OcoLevels): Promise<OcoResult> {
  const ex = getExchange()
  await ensureMarkets(ex)

  if (levels.takeProfit == null) {
    throw new OcoUnplaceableError(`OCO requires a take-profit level for ${symbol}`)
  }

  const market = ex.market(symbol)
  // Precision strings preserve exact tick/step sizing for the exchange request.
  const qtyStr = ex.amountToPrecision(symbol, quantity)
  const tpStr = ex.priceToPrecision(symbol, levels.takeProfit)
  const stopStr = ex.priceToPrecision(symbol, levels.stopLoss)
  const stopLimitStr = ex.priceToPrecision(symbol, levels.stopLoss * (1 - levels.bufferPct / 100))
  const qty = Number(qtyStr)
  const tp = Number(tpStr)
  const stop = Number(stopStr)

  // Structural validation — fail loudly so the caller can fall back to software stops.
  const minQty = market.limits?.amount?.min
  const minCost = market.limits?.cost?.min
  if (minQty != null && qty < minQty) {
    throw new OcoUnplaceableError(`OCO qty ${qty} below min ${minQty} for ${symbol}`)
  }
  if (minCost != null && qty * stop < minCost) {
    throw new OcoUnplaceableError(`OCO notional ${(qty * stop).toFixed(2)} below min ${minCost} for ${symbol}`)
  }
  if (!(tp > stop)) {
    throw new OcoUnplaceableError(`OCO take-profit ${tp} must be above stop ${stop} for ${symbol}`)
  }

  const params = {
    symbol: market.id,
    side: 'SELL',
    quantity: qtyStr,
    price: tpStr,                    // TP leg → LIMIT_MAKER
    stopPrice: stopStr,              // SL trigger
    stopLimitPrice: stopLimitStr,    // SL leg limit price (trigger - buffer)
    stopLimitTimeInForce: 'GTC',
  }

  logger.info('🛸 Binance OCO place', { symbol, qty: qtyStr, tp: tpStr, stop: stopStr, stopLimit: stopLimitStr })
  const raw = await (ex as any).privatePostOrderOco(params) as Record<string, any>

  const orderListId = String(raw.orderListId ?? '')
  const reports: any[] = Array.isArray(raw.orderReports) ? raw.orderReports : []
  const slLeg = reports.find(r => String(r.type).startsWith('STOP_LOSS'))
  const tpLeg = reports.find(r => String(r.type) === 'LIMIT_MAKER')

  return {
    orderListId,
    slOrderId: slLeg ? String(slLeg.orderId) : null,
    tpOrderId: tpLeg ? String(tpLeg.orderId) : null,
    status: 'ACTIVE',
  }
}

/**
 * Cancel an OCO. Idempotent: if a leg already filled/cancelled (Binance -2011),
 * resolves to `already-gone` rather than throwing.
 */
export async function cancelOco(symbol: string, orderListId: string): Promise<OcoCancelResult> {
  const ex = getExchange()
  await ensureMarkets(ex)
  try {
    logger.info('🛸 Binance OCO cancel', { symbol, orderListId })
    await (ex as any).privateDeleteOrderList({ symbol: ex.market(symbol).id, orderListId })
    return 'cancelled'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // -2011 = unknown order list (already filled or cancelled) → idempotent success.
    if (/-2011|Unknown order|does not exist|OrderList/i.test(msg)) {
      logger.info('OCO already gone on cancel', { symbol, orderListId })
      return 'already-gone'
    }
    throw new TradeError(`Cancel OCO failed for ${symbol}: ${msg}`)
  }
}

/**
 * Scan open orders for the symbol and reattach to any existing OCO list.
 * Called when OCO placement fails with "insufficient balance" — that error
 * almost always means the coins are already locked in an OCO that survived a
 * backend restart but whose IDs were lost from the local DB.
 * Returns null if no OCO is found or the lookup fails (non-fatal).
 */
export async function findExistingOco(symbol: string): Promise<OcoResult | null> {
  const ex = getExchange()
  await ensureMarkets(ex)
  try {
    logger.info('🛸 Binance fetchOpenOrders (OCO recovery)', { symbol })
    const openOrders = await ex.fetchOpenOrders(symbol)

    // Group orders by OCO list ID; standalone orders have orderListId = -1
    const byList = new Map<string, typeof openOrders>()
    for (const order of openOrders) {
      const listId = String((order.info as any)?.orderListId ?? -1)
      if (listId === '-1') continue
      if (!byList.has(listId)) byList.set(listId, [])
      byList.get(listId)!.push(order)
    }

    if (byList.size === 0) return null

    // Use the first OCO list found for this symbol
    const [orderListId, orders] = [...byList.entries()][0]
    const slOrder = orders.find(o => {
      const t = String((o.info as any)?.type ?? '').toUpperCase()
      return t === 'STOP_LOSS_LIMIT' || t.startsWith('STOP_LOSS')
    })
    const tpOrder = orders.find(o => String((o.info as any)?.type ?? '').toUpperCase() === 'LIMIT_MAKER')

    logger.info('Found existing OCO on Binance (recovery)', { symbol, orderListId, slOrderId: slOrder?.id ?? null, tpOrderId: tpOrder?.id ?? null })
    return {
      orderListId,
      slOrderId: slOrder ? String(slOrder.id) : null,
      tpOrderId: tpOrder ? String(tpOrder.id) : null,
      status: 'ACTIVE',
    }
  } catch (err) {
    logger.warn('OCO recovery lookup failed', { symbol, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Atomic cancel + replace (Binance Spot has no native OCO modify). Cancels the
 * old list, then places fresh levels. If the replace fails after the cancel, the
 * position is briefly unprotected — we return status FAILED so the caller marks
 * it and the software fallback re-engages.
 */
export async function updateOco(
  symbol: string,
  orderListId: string,
  quantity: number,
  levels: OcoLevels,
): Promise<OcoResult> {
  await cancelOco(symbol, orderListId)
  try {
    return await placeOco(symbol, quantity, levels)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('OCO replace failed after cancel — position unprotected until fallback', { symbol, error: msg })
    return { orderListId: '', slOrderId: null, tpOrderId: null, status: 'FAILED' }
  }
}

/**
 * Read the live status of an OCO by inspecting both legs. Returns which leg (if
 * any) filled, plus the real fill price/qty/fee for ledger reconciliation.
 */
export async function fetchOco(
  symbol: string,
  oco: { orderListId: string; slOrderId: string | null; tpOrderId: string | null },
): Promise<OcoFetchResult> {
  const ex = getExchange()
  await ensureMarkets(ex)

  const fetchLeg = async (orderId: string | null) => {
    if (!orderId) return null
    try {
      return await ex.fetchOrder(orderId, symbol)
    } catch (err) {
      logger.warn('OCO leg fetch failed', { symbol, orderId, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  const [slOrder, tpOrder] = await Promise.all([fetchLeg(oco.slOrderId), fetchLeg(oco.tpOrderId)])

  const isFilled = (o: any) => o && (o.status === 'closed' || (o.filled ?? 0) > 0 && o.status !== 'open' && o.status !== 'canceled')

  const filledLeg = isFilled(slOrder) ? 'SL' : isFilled(tpOrder) ? 'TP' : null
  if (filledLeg) {
    const o: any = filledLeg === 'SL' ? slOrder : tpOrder
    const fillPrice = o.average ?? o.price ?? null
    return {
      status: 'FILLED',
      filledLeg,
      fillPrice,
      fillQty: o.filled ?? null,
      fee: null,
    }
  }

  // Neither leg filled. If both are gone (canceled/expired) the list is dead.
  const legs = [slOrder, tpOrder].filter(Boolean) as any[]
  const anyOpen = legs.some(o => o.status === 'open')
  if (legs.length > 0 && !anyOpen) {
    return { status: 'CANCELED', filledLeg: null, fillPrice: null, fillQty: null, fee: null }
  }

  return { status: 'OPEN', filledLeg: null, fillPrice: null, fillQty: null, fee: null }
}
