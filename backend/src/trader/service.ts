import ccxt, { Exchange } from 'ccxt'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, CoinTradeResult } from './types.js'
import { TradeError } from '../core/errors.js'

let exchange: Exchange

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

export async function fetchMarketData(symbols: string[]): Promise<MarketData[]> {
  const ex = getExchange()
  logger.info('🛸 Binance fetchTickers', { symbols })
  const tickers = await ex.fetchTickers(symbols)
  return symbols.map((s) => {
    const t = tickers[s]
    return {
      symbol: s,
      price: t?.last ?? 0,
      change24h: t?.percentage ?? 0,
      volume: t?.quoteVolume ?? 0,
    }
  })
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

// Normalise all fees to a USDC-equivalent amount.
// CCXT may report fee in base currency (e.g. BTC on a BUY) or quote (USDC on a SELL).
function extractFeeUsdc(order: any, fillPriceValue: number): { cost: number; currency: string } {
  const rawFees: { cost?: number; currency?: string }[] = []
  if (Array.isArray(order.fees) && order.fees.length > 0) {
    rawFees.push(...order.fees)
  } else if (order.fee && order.fee.cost != null) {
    rawFees.push(order.fee)
  }

  let totalUsdc = 0
  for (const f of rawFees) {
    if (!f.cost) continue
    const cur = (f.currency ?? '').toUpperCase()
    if (cur === 'USDC' || cur === 'USDT' || cur === '') {
      totalUsdc += f.cost
    } else {
      // Base-currency fee (e.g. BTC) — convert to USDC using fill price
      totalUsdc += f.cost * fillPriceValue
    }
  }
  return { cost: totalUsdc, currency: 'USDC' }
}

export async function executeTrade(signal: Signal): Promise<TradeResult> {
  const ex = getExchange()
  const symbol = signal.coin

  try {
    if (signal.action === 'BUY') {
      logger.info('🛸 Binance fetchTicker', { symbol })
      const ticker = await ex.fetchTicker(symbol)
      const cost = signal.quantity * (ticker.last || 1)
      logger.info('🛸 Binance createMarketOrder', { symbol, side: 'buy', cost })
      const order = await ex.createMarketOrderWithCost(symbol, 'buy', cost)
      const price = fillPrice(order)
      const fee = extractFeeUsdc(order, price)
      return { id: order.id, price, quantity: order.amount || 0, cost: order.cost || cost, fee }
    } else {
      logger.info('🛸 Binance createMarketOrder', { symbol, side: 'sell', quantity: signal.quantity })
      const order = await ex.createMarketSellOrder(symbol, signal.quantity)
      const price = fillPrice(order)
      const fee = extractFeeUsdc(order, price)
      return { id: order.id, price, quantity: order.amount || signal.quantity, cost: order.cost || (price * signal.quantity), fee }
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
      const fee = extractFeeUsdc(order, toPrice)
      return { fromSymbol, toSymbol, fromAmount, toAmount, fromPrice: 1, toPrice, fee }
    }

    if (toBase === 'USDC') {
      logger.info('🛸 Binance createMarketOrder', { symbol: fromSymbol, side: 'sell', quantity: fromAmount })
      const order = await ex.createMarketSellOrder(fromSymbol, fromAmount)
      const fromPrice = fillPrice(order)
      const toAmount = order.cost || (fromPrice * fromAmount)
      const fee = extractFeeUsdc(order, fromPrice)
      return { fromSymbol, toSymbol, fromAmount, toAmount, fromPrice, toPrice: 1, fee }
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
  const usdtPairs = Object.entries(tickers)
    .filter(([s]) => s.endsWith('/USDC'))
    .sort((a, b) => (b[1]?.quoteVolume ?? 0) - (a[1]?.quoteVolume ?? 0))
    .slice(0, limit)
    .map(([s]) => s)
  return usdtPairs
}
