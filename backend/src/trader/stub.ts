import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, CoinTradeResult, BalanceInfo } from './types.js'
import { logger } from '../core/logger.js'
import { getSettings } from '../db/index.js'

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
  const feeRate = getSettings().fee_rate
  const price = FAKE_PRICES[signal.coin] || DEFAULT_PRICE
  const grossCost = signal.quantity * price

  if (signal.action === 'BUY') {
    logger.info('🛸 Binance fetchTicker', { symbol: signal.coin })
    logger.info('🛸 Binance createMarketOrder', { symbol: signal.coin, side: 'buy', cost: grossCost })
    // BUY: fee charged from received coins — you get fewer coins for the same USDC spend
    const feeCostUsdc = grossCost * feeRate
    const netQuantity = signal.quantity * (1 - feeRate)
    return {
      id: `stub-${Date.now()}`,
      price,
      quantity: netQuantity,
      cost: grossCost,
      fee: { cost: feeCostUsdc, currency: 'USDC' },
    }
  } else {
    logger.info('🛸 Binance createMarketOrder', { symbol: signal.coin, side: 'sell', quantity: signal.quantity })
    // SELL: fee charged from received USDC — you get less USDC for the same coins sold
    const grossUsdc = signal.quantity * price
    const feeCostUsdc = grossUsdc * feeRate
    const netUsdc = grossUsdc - feeCostUsdc
    return {
      id: `stub-${Date.now()}`,
      price,
      quantity: signal.quantity,
      cost: netUsdc,
      fee: { cost: feeCostUsdc, currency: 'USDC' },
    }
  }
}

export async function executeCoinTrade(fromSymbol: string, toSymbol: string, fromAmount: number): Promise<CoinTradeResult> {
  const feeRate = getSettings().fee_rate
  const fromPrice = fromSymbol === 'USDC' ? 1 : (FAKE_PRICES[fromSymbol] || DEFAULT_PRICE)
  const toPrice = toSymbol === 'USDC' ? 1 : (FAKE_PRICES[toSymbol] || DEFAULT_PRICE)

  const usdcValue = fromAmount * fromPrice
  const feeCostUsdc = usdcValue * feeRate
  const toAmount = (usdcValue - feeCostUsdc) / toPrice

  if (fromSymbol === 'USDC') {
    logger.info('🛸 Binance createMarketOrder', { symbol: toSymbol, side: 'buy', cost: fromAmount })
  } else {
    logger.info('🛸 Binance createMarketOrder', { symbol: fromSymbol, side: 'sell', quantity: fromAmount })
  }

  return {
    fromSymbol,
    toSymbol,
    fromAmount,
    toAmount,
    fromPrice,
    toPrice,
    fee: { cost: feeCostUsdc, currency: 'USDC' },
  }
}

export async function getTopPairs(limit = 20): Promise<string[]> {
  logger.info('🛸 Binance fetchTickers (all)')
  return Object.keys(FAKE_PRICES).slice(0, limit)
}
