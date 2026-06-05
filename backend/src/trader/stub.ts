import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, BalanceInfo } from './types.js'
import { logger } from '../core/logger.js'

const FAKE_PRICES: Record<string, number> = {
  'BTC/USDT': 67500,
  'ETH/USDT': 3450,
  'SOL/USDT': 145,
  'BNB/USDT': 580,
  'XRP/USDT': 0.52,
  'DOGE/USDT': 0.12,
  'ADA/USDT': 0.38,
  'AVAX/USDT': 28,
  'DOT/USDT': 6.50,
  'LINK/USDT': 14,
  'MATIC/USDT': 0.55,
  'UNI/USDT': 7.20,
  'SHIB/USDT': 0.000023,
  'LTC/USDT': 72,
  'ATOM/USDT': 8.10,
  'ETC/USDT': 22,
  'XLM/USDT': 0.095,
  'FIL/USDT': 4.20,
  'TRX/USDT': 0.13,
  'APT/USDT': 8.50,
}

const DEFAULT_PRICE = 10
export async function fetchMarketData(symbols: string[]): Promise<MarketData[]> {
  logger.info('Stub: fetching market data', { count: symbols.length })
  return symbols.map((s) => ({
    symbol: s,
    price: FAKE_PRICES[s] || DEFAULT_PRICE,
    change24h: Math.random() * 10 - 5,
    volume: FAKE_PRICES[s] ? Math.random() * 1e9 : Math.random() * 1e6,
  }))
}

export async function fetchBalance(): Promise<AccountBalance> {
  logger.info('Stub: fetching balance')
  return {
    USDT: { total: 10000, free: 10000, used: 0 },
    BTC: { total: 0.05, free: 0.05, used: 0 },
    ETH: { total: 0.5, free: 0.5, used: 0 },
    SOL: { total: 5, free: 5, used: 0 },
  }
}

export async function executeTrade(signal: Signal): Promise<TradeResult> {
  const price = FAKE_PRICES[signal.coin] || DEFAULT_PRICE
  const cost = signal.quantity * price

  logger.info('Stub: executing trade', { symbol: signal.coin, side: signal.action, quantity: signal.quantity, price })

  return {
    id: `stub-${Date.now()}`,
    price,
    quantity: signal.quantity,
    cost,
    fee: { cost: cost * 0.001, currency: 'USDT' },
  }
}

export async function getTopPairs(limit = 20): Promise<string[]> {
  logger.info('Stub: fetching top pairs')
  return Object.keys(FAKE_PRICES).slice(0, limit)
}
