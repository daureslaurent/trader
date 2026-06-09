import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, CoinTradeResult, BalanceInfo, OcoLevels, OcoResult, OcoCancelResult, OcoFetchResult, OrderBook } from './types.js'
import { logger } from '../core/logger.js'
import { getPrice } from '../market/priceCache.js'

const FAKE_PRICES: Record<string, number> = {
  'BTC/USDC': 67500,
  'ETH/USDC': 3450,
  'SOL/USDC': 145,
  'BNB/USDC': 580,
  'XRP/USDC': 0.52,
  'DOGE/USDC': 0.12,
  'ADA/USDC': 0.38,
  'AVAX/USDC': 28,
  'DOT/USDC': 6.50,
  'LINK/USDC': 14,
  'MATIC/USDC': 0.55,
  'UNI/USDC': 7.20,
  'SHIB/USDC': 0.000023,
  'LTC/USDC': 72,
  'ATOM/USDC': 8.10,
  'ETC/USDC': 22,
  'XLM/USDC': 0.095,
  'FIL/USDC': 4.20,
  'TRX/USDC': 0.13,
  'APT/USDC': 8.50,
}

const DEFAULT_PRICE = 10

export async function fetchMarketData(symbols: string[]): Promise<MarketData[]> {
  logger.info('🛸 Binance fetchTickers', { symbols })
  return symbols.map((s) => ({
    symbol: s,
    price: FAKE_PRICES[s] || DEFAULT_PRICE,
    change24h: Math.random() * 10 - 5,
    volume: FAKE_PRICES[s] ? Math.random() * 1e9 : Math.random() * 1e6,
  }))
}

export async function fetchBalance(): Promise<AccountBalance> {
  logger.info('🛸 Binance fetchBalance')
  return {
    USDC: { total: 10000, free: 10000, used: 0 },
    BTC: { total: 0.05, free: 0.05, used: 0 },
    ETH: { total: 0.5, free: 0.5, used: 0 },
    SOL: { total: 5, free: 5, used: 0 },
  }
}

export async function executeTrade(signal: Signal): Promise<TradeResult> {
  const price = FAKE_PRICES[signal.coin] || DEFAULT_PRICE
  const cost = signal.quantity * price

  if (signal.action === 'BUY') {
    logger.info('🛸 Binance fetchTicker', { symbol: signal.coin })
    logger.info('🛸 Binance createMarketOrder', { symbol: signal.coin, side: 'buy', cost })
    return { id: `stub-${Date.now()}`, price, quantity: signal.quantity, cost, fee_cost: cost * 0.001, fee_currency: 'BNB' }
  } else {
    logger.info('🛸 Binance createMarketOrder', { symbol: signal.coin, side: 'sell', quantity: signal.quantity })
    return { id: `stub-${Date.now()}`, price, quantity: signal.quantity, cost, fee_cost: cost * 0.001, fee_currency: 'BNB' }
  }
}

export async function executeCoinTrade(fromSymbol: string, toSymbol: string, fromAmount: number): Promise<CoinTradeResult> {
  const fromPrice = fromSymbol === 'USDC' ? 1 : (FAKE_PRICES[fromSymbol] || DEFAULT_PRICE)
  const toPrice = toSymbol === 'USDC' ? 1 : (FAKE_PRICES[toSymbol] || DEFAULT_PRICE)
  const toAmount = (fromAmount * fromPrice) / toPrice

  if (fromSymbol === 'USDC') {
    logger.info('🛸 Binance createMarketOrder', { symbol: toSymbol, side: 'buy', cost: fromAmount })
  } else {
    logger.info('🛸 Binance createMarketOrder', { symbol: fromSymbol, side: 'sell', quantity: fromAmount })
  }

  return { fromSymbol, toSymbol, fromAmount, toAmount, fromPrice, toPrice }
}

export async function getTopPairs(limit = 20): Promise<string[]> {
  logger.info('🛸 Binance fetchTickers (all)')
  return Object.keys(FAKE_PRICES).slice(0, limit)
}

// ── Order book stub ──────────────────────────────────────────────────────────

export async function fetchOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
  logger.info('🛸 Binance fetchOrderBook (stub)', { symbol, depth })
  const mid = FAKE_PRICES[symbol] || DEFAULT_PRICE
  const spread = mid * 0.001 // 0.1% spread
  const levels = Array.from({ length: depth }, (_, i) => i)
  return {
    symbol,
    bids: levels.map(i => [mid - spread * (i + 1), 1 + Math.random()] as [number, number]),
    asks: levels.map(i => [mid + spread * (i + 1), 1 + Math.random()] as [number, number]),
    timestamp: Date.now(),
  }
}

// ── Simulated exchange-side OCO ──────────────────────────────────────────────
// Mirrors the real module's contract using an in-memory store. `fetchOco`
// compares the (drifting) cached price against the stored levels so dev mode
// exercises the same place → reconcile → fill code path without Binance.

interface StubOco { symbol: string; quantity: number; stopLoss: number; takeProfit: number; bufferPct: number }
const stubOcoStore = new Map<string, StubOco>()
let stubOcoSeq = 0

export async function placeOco(symbol: string, quantity: number, levels: OcoLevels): Promise<OcoResult> {
  if (levels.takeProfit == null) throw new Error(`Stub OCO requires take-profit for ${symbol}`)
  const orderListId = `stub-oco-${++stubOcoSeq}`
  stubOcoStore.set(orderListId, { symbol, quantity, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit, bufferPct: levels.bufferPct })
  logger.info('🛸 Binance OCO place (stub)', { symbol, quantity, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit, orderListId })
  return { orderListId, slOrderId: `${orderListId}-sl`, tpOrderId: `${orderListId}-tp`, status: 'ACTIVE' }
}

export async function cancelOco(symbol: string, orderListId: string): Promise<OcoCancelResult> {
  const existed = stubOcoStore.delete(orderListId)
  logger.info('🛸 Binance OCO cancel (stub)', { symbol, orderListId, existed })
  return existed ? 'cancelled' : 'already-gone'
}

export async function updateOco(symbol: string, orderListId: string, quantity: number, levels: OcoLevels): Promise<OcoResult> {
  await cancelOco(symbol, orderListId)
  return placeOco(symbol, quantity, levels)
}

export async function findExistingOco(_symbol: string): Promise<OcoResult | null> {
  return null
}

export async function fetchOco(
  symbol: string,
  oco: { orderListId: string; slOrderId: string | null; tpOrderId: string | null },
): Promise<OcoFetchResult> {
  const stored = stubOcoStore.get(oco.orderListId)
  if (!stored) return { status: 'CANCELED', filledLeg: null, fillPrice: null, fillQty: null, fee: null }

  const price = getPrice(symbol)?.price
  if (price == null) return { status: 'OPEN', filledLeg: null, fillPrice: null, fillQty: null, fee: null }

  const fill = (fillPrice: number, leg: 'SL' | 'TP'): OcoFetchResult => {
    stubOcoStore.delete(oco.orderListId)
    return { status: 'FILLED', filledLeg: leg, fillPrice, fillQty: stored.quantity, fee: null }
  }

  if (price <= stored.stopLoss) return fill(stored.stopLoss * (1 - stored.bufferPct / 100), 'SL')
  if (price >= stored.takeProfit) return fill(stored.takeProfit, 'TP')
  return { status: 'OPEN', filledLeg: null, fillPrice: null, fillQty: null, fee: null }
}
