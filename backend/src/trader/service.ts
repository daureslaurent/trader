import ccxt, { Exchange } from 'ccxt'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, CoinTradeResult, OrderBook, OrderBookAnalysis } from './types.js'
import { TradeError } from '../core/errors.js'

let exchange: Exchange
let marketsLoaded = false

export function getExchange(): Exchange {
  if (!exchange) {
    exchange = new ccxt.binance({
      apiKey: config.binance.apiKey,
      secret: config.binance.secret,
      enableRateLimit: true,
    })
  }
  return exchange
}

async function ensureMarkets(): Promise<void> {
  const ex = getExchange()
  if (!marketsLoaded) {
    await ex.loadMarkets()
    marketsLoaded = true
  }
}

// ── Order book ────────────────────────────────────────────────────────────────

export async function fetchOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
  const ex = getExchange()
  logger.info('🛸 Binance fetchOrderBook', { symbol, depth })
  const book = await ex.fetchOrderBook(symbol, depth)
  return {
    symbol,
    bids: (book.bids as [number, number][]).slice(0, depth),
    asks: (book.asks as [number, number][]).slice(0, depth),
    timestamp: book.timestamp ?? Date.now(),
  }
}

/**
 * Walk the ask side of the order book to find the VWAP for buying `targetQty`
 * coins, and derive execution metadata for the LLM prompt and order placement.
 */
export function analyzeOrderBook(book: OrderBook, targetQty: number): OrderBookAnalysis {
  const bestAsk = book.asks[0]?.[0] ?? 0
  const bestBid = book.bids[0]?.[0] ?? 0
  const midPrice = bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : bestAsk || bestBid

  const spreadPct = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0

  let remaining = targetQty
  let totalQty = 0
  let weightedSum = 0

  for (const [price, qty] of book.asks) {
    if (remaining <= 0) break
    const take = Math.min(qty, remaining)
    totalQty += take
    weightedSum += price * take
    remaining -= take
  }

  // If order book doesn't have enough depth, extrapolate using the last ask level
  if (remaining > 0 && book.asks.length > 0) {
    const lastPrice = book.asks[book.asks.length - 1][0]
    totalQty += remaining
    weightedSum += lastPrice * remaining
  }

  const vwap = totalQty > 0 ? weightedSum / totalQty : bestAsk
  const fillQty = Math.min(totalQty, targetQty)
  const priceImpactPct = bestAsk > 0 ? ((vwap - bestAsk) / bestAsk) * 100 : 0
  const suggestedLimitPrice = vwap * 1.001

  const liquidityScore: 'high' | 'medium' | 'low' =
    priceImpactPct < 0.1 ? 'high' : priceImpactPct < 0.5 ? 'medium' : 'low'

  return { bestBid, bestAsk, midPrice, spreadPct, vwap, fillQty, priceImpactPct, suggestedLimitPrice, liquidityScore }
}

export async function fetchMarketData(symbols: string[]): Promise<MarketData[]> {
  const ex = getExchange()

  // Try batch first; fall back to per-symbol if Binance rejects the batch
  // (happens when any symbol in the list is invalid/delisted)
  try {
    logger.info('Binance fetchTickers batch', { symbols })
    const tickers = await ex.fetchTickers(symbols)
    return symbols.map((s) => {
      const t = tickers[s]
      return { symbol: s, price: t?.last ?? 0, change24h: t?.percentage ?? 0, volume: t?.quoteVolume ?? 0 }
    })
  } catch (batchErr) {
    logger.warn('Batch ticker fetch failed, falling back to per-symbol', {
      error: (batchErr as Error).message,
      symbols,
    })
    const results = await Promise.allSettled(symbols.map(s => ex.fetchTicker(s)))
    return symbols.map((s, i) => {
      const r = results[i]
      if (r.status === 'fulfilled') {
        const t = r.value
        return { symbol: s, price: t?.last ?? 0, change24h: t?.percentage ?? 0, volume: t?.quoteVolume ?? 0 }
      }
      logger.warn('Ticker fetch failed for symbol', { symbol: s, error: (r.reason as Error)?.message })
      return { symbol: s, price: 0, change24h: 0, volume: 0 }
    })
  }
}

export async function fetchBalance(): Promise<AccountBalance> {
  const ex = getExchange()
  logger.info('🛸 Binance fetchBalance')
  const bal = await ex.fetchBalance()
  const result: AccountBalance = {}
  for (const [coin, info] of Object.entries(bal.total)) {
    if (info !== undefined) {
      result[coin] = {
        total: Number((bal.total as any)[coin]) || 0,
        free: Number((bal.free as any)[coin]) || 0,
        used: Number((bal.used as any)[coin]) || 0,
      }
    }
  }
  return result
}

function fillPrice(order: { price?: number | null; average?: number | null; cost?: number | null; amount?: number | null }): number {
  if (order.average) return order.average
  if (order.price) return order.price
  if (order.cost && order.amount && order.amount > 0) return order.cost / order.amount
  return 0
}

function extractFee(order: any): { fee_cost: number; fee_currency: string } {
  const fee = (order as any).fee
  if (fee?.cost != null && fee?.currency) return { fee_cost: Number(fee.cost), fee_currency: String(fee.currency) }
  return { fee_cost: 0, fee_currency: 'BNB' }
}

export async function executeTrade(signal: Signal): Promise<TradeResult> {
  const ex = getExchange()
  const symbol = signal.coin

  try {
    if (signal.action === 'BUY') {
      await ensureMarkets()

      const book = await fetchOrderBook(symbol, 20)
      const analysis = analyzeOrderBook(book, signal.quantity)

      logger.info('Order book analysis', {
        symbol,
        bestAsk: analysis.bestAsk,
        vwap: analysis.vwap,
        priceImpact: `${analysis.priceImpactPct.toFixed(4)}%`,
        liquidity: analysis.liquidityScore,
        suggestedLimitPrice: analysis.suggestedLimitPrice,
      })

      const qty   = parseFloat(ex.amountToPrecision(symbol, signal.quantity))
      const price = parseFloat(ex.priceToPrecision(symbol, analysis.suggestedLimitPrice))

      if (qty <= 0) {
        throw new TradeError(`Order quantity rounds to zero after precision adjustment for ${symbol}`)
      }

      logger.info('🛸 Binance createLimitOrder IOC', { symbol, side: 'buy', qty, price })

      let iocFilled = 0
      let iocResult: { id: string; price: number; quantity: number; cost: number; fee_cost: number; fee_currency: string } | null = null

      try {
        const order = await ex.createLimitBuyOrder(symbol, qty, price, { timeInForce: 'IOC' })
        iocFilled = order.filled ?? 0
        const actualPrice = fillPrice(order)

        if (iocFilled >= qty * 0.95) {
          logger.info('IOC limit order fully filled', { symbol, qty: iocFilled, price: actualPrice })
          const fee = extractFee(order)
          return { id: order.id, price: actualPrice, quantity: iocFilled, cost: order.cost || actualPrice * iocFilled, ...fee }
        }

        if (iocFilled > 0) {
          logger.warn('IOC limit order partially filled — market order for remainder', {
            symbol, requested: qty, filled: iocFilled, pct: `${((iocFilled / qty) * 100).toFixed(1)}%`,
          })
          iocResult = { id: order.id, price: actualPrice, quantity: iocFilled, cost: order.cost || actualPrice * iocFilled, ...extractFee(order) }
        } else {
          logger.warn('IOC limit order not filled, falling back to market order', {
            symbol, limitPrice: price, bestAsk: analysis.bestAsk,
          })
        }
      } catch (ioErr) {
        logger.warn('IOC limit order rejected, falling back to market order', {
          symbol, error: (ioErr as Error).message,
        })
      }

      const remainingQty = signal.quantity - iocFilled
      const cost = remainingQty * analysis.bestAsk
      logger.info('🛸 Binance createMarketOrderWithCost (fallback)', { symbol, cost, remainingQty })
      const mkt = await ex.createMarketOrderWithCost(symbol, 'buy', cost)
      const mktPrice = fillPrice(mkt)
      const mktQty = mkt.amount || 0
      const mktCost = mkt.cost || cost

      const mktFee = extractFee(mkt)
      if (iocResult) {
        const totalQty = iocResult.quantity + mktQty
        const totalCost = iocResult.cost + mktCost
        const blendedPrice = totalQty > 0 ? totalCost / totalQty : mktPrice
        const blendedFeeCost = iocResult.fee_cost + mktFee.fee_cost
        const feeCurrency = iocResult.fee_currency || mktFee.fee_currency
        return { id: mkt.id, price: blendedPrice, quantity: totalQty, cost: totalCost, fee_cost: blendedFeeCost, fee_currency: feeCurrency }
      }
      return { id: mkt.id, price: mktPrice, quantity: mktQty, cost: mktCost, ...mktFee }

    } else {
      logger.info('🛸 Binance createMarketOrder', { symbol, side: 'sell', quantity: signal.quantity })
      const order = await ex.createMarketSellOrder(symbol, signal.quantity)
      const price = fillPrice(order)
      return { id: order.id, price, quantity: order.amount || signal.quantity, cost: order.cost || (price * signal.quantity), ...extractFee(order) }
    }
  } catch (err) {
    throw new TradeError(`Trade failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function parseBase(symbol: string): string {
  return symbol.includes('/') ? symbol.split('/')[0] : symbol
}

export async function executeCoinTrade(fromSymbol: string, toSymbol: string, fromAmount: number): Promise<CoinTradeResult> {
  const ex = getExchange()
  const fromBase = parseBase(fromSymbol)
  const toBase = parseBase(toSymbol)

  try {
    if (fromBase === 'USDC') {
      logger.info('🛸 Binance createMarketOrder', { symbol: toSymbol, side: 'buy', cost: fromAmount })
      const order = await ex.createMarketOrderWithCost(toSymbol, 'buy', fromAmount)
      const toPrice = fillPrice(order)
      const toAmount = order.amount || (toPrice > 0 ? fromAmount / toPrice : 0)
      return { fromSymbol, toSymbol, fromAmount, toAmount, fromPrice: 1, toPrice }
    }

    if (toBase === 'USDC') {
      logger.info('🛸 Binance createMarketOrder', { symbol: fromSymbol, side: 'sell', quantity: fromAmount })
      const order = await ex.createMarketSellOrder(fromSymbol, fromAmount)
      const fromPrice = fillPrice(order)
      const toAmount = order.cost || (fromPrice * fromAmount)
      return { fromSymbol, toSymbol, fromAmount, toAmount, fromPrice, toPrice: 1 }
    }

    throw new TradeError(`Trade requires one side to be USDC (got ${fromSymbol}→${toSymbol})`)
  } catch (err) {
    if (err instanceof TradeError) throw err
    throw new TradeError(`Trade failed (${fromSymbol}→${toSymbol}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function getTopPairs(limit = 20): Promise<string[]> {
  const ex = getExchange()
  logger.info('🛸 Binance fetchTickers (all)')
  const tickers = await ex.fetchTickers()
  const usdcPairs = Object.entries(tickers)
    .filter(([s]) => s.endsWith('/USDC'))
    .sort((a, b) => (b[1]?.quoteVolume ?? 0) - (a[1]?.quoteVolume ?? 0))
    .slice(0, limit)
    .map(([s]) => s)
  return usdcPairs
}
