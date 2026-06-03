import ccxt, { Exchange } from 'ccxt'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult } from './types.js'
import { TradeError } from '../core/errors.js'

let exchange: Exchange

function getExchange(): Exchange {
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
  const bal = await ex.fetchBalance()
  const result: AccountBalance = {}
  for (const [coin, info] of Object.entries(bal.total)) {
    if (info && ((bal.total as any)[coin] || (bal.free as any)[coin] || (bal.used as any)[coin])) {
      result[coin] = {
        total: (bal.total as any)[coin] || 0,
        free: (bal.free as any)[coin] || 0,
        used: (bal.used as any)[coin] || 0,
      }
    }
  }
  return result
}

export async function executeTrade(signal: Signal): Promise<TradeResult> {
  const ex = getExchange()
  const symbol = signal.coin

  logger.info('Executing trade', { symbol, side: signal.action, quantity: signal.quantity })

  try {
    if (signal.action === 'BUY') {
      const order = await ex.createMarketBuyOrder(symbol, signal.quantity)
      return { id: order.id, price: order.price, quantity: order.amount, cost: order.cost }
    } else {
      const order = await ex.createMarketSellOrder(symbol, signal.quantity)
      return { id: order.id, price: order.price, quantity: order.amount, cost: order.cost }
    }
  } catch (err) {
    throw new TradeError(`Trade failed for ${symbol}: ${(err as Error).message}`)
  }
}

export async function getTopPairs(limit = 20): Promise<string[]> {
  const ex = getExchange()
  const tickers = await ex.fetchTickers()
  const usdtPairs = Object.entries(tickers)
    .filter(([s]) => s.endsWith('/USDT'))
    .sort((a, b) => (b[1]?.quoteVolume ?? 0) - (a[1]?.quoteVolume ?? 0))
    .slice(0, limit)
    .map(([s]) => s)
  return usdtPairs
}
