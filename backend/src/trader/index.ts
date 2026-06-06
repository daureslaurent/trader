import { config } from '../config/index.js'
import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, CoinTradeResult } from './types.js'
import * as real from './service.js'
import * as stub from './stub.js'

function impl() {
  return config.stub ? stub : real
}

export function fetchMarketData(symbols: string[]): Promise<MarketData[]> {
  return impl().fetchMarketData(symbols)
}

export function fetchBalance(): Promise<AccountBalance> {
  return impl().fetchBalance()
}

export function executeTrade(signal: Signal): Promise<TradeResult> {
  return impl().executeTrade(signal)
}

export function executeCoinTrade(fromSymbol: string, toSymbol: string, fromAmount: number): Promise<CoinTradeResult> {
  return impl().executeCoinTrade(fromSymbol, toSymbol, fromAmount)
}

export function getTopPairs(limit?: number): Promise<string[]> {
  return impl().getTopPairs(limit)
}

export type { MarketData, AccountBalance, TradeResult, CoinTradeResult, BalanceInfo } from './types.js'
