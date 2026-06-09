import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, CoinTradeResult, OcoLevels, OcoResult, OcoCancelResult, OcoFetchResult, OrderBook, OrderBookAnalysis } from './types.js'
import * as real from './service.js'
import * as realOco from './oco.js'

export function fetchMarketData(symbols: string[]): Promise<MarketData[]> {
  return real.fetchMarketData(symbols)
}

export function fetchBalance(): Promise<AccountBalance> {
  return real.fetchBalance()
}

export function executeTrade(signal: Signal): Promise<TradeResult> {
  return real.executeTrade(signal)
}

export function executeCoinTrade(fromSymbol: string, toSymbol: string, fromAmount: number): Promise<CoinTradeResult> {
  return real.executeCoinTrade(fromSymbol, toSymbol, fromAmount)
}

export function getTopPairs(limit?: number): Promise<string[]> {
  return real.getTopPairs(limit)
}

export function fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook> {
  return real.fetchOrderBook(symbol, depth)
}

// analyzeOrderBook is pure — always use the real implementation
export { analyzeOrderBook } from './service.js'

export function placeOco(symbol: string, quantity: number, levels: OcoLevels): Promise<OcoResult> {
  return realOco.placeOco(symbol, quantity, levels)
}

export function cancelOco(symbol: string, orderListId: string): Promise<OcoCancelResult> {
  return realOco.cancelOco(symbol, orderListId)
}

export function updateOco(symbol: string, orderListId: string, quantity: number, levels: OcoLevels): Promise<OcoResult> {
  return realOco.updateOco(symbol, orderListId, quantity, levels)
}

export function fetchOco(
  symbol: string,
  oco: { orderListId: string; slOrderId: string | null; tpOrderId: string | null },
): Promise<OcoFetchResult> {
  return realOco.fetchOco(symbol, oco)
}

export function findExistingOco(symbol: string): Promise<OcoResult | null> {
  return realOco.findExistingOco(symbol)
}

export { OcoUnplaceableError } from './oco.js'
export type { MarketData, AccountBalance, TradeResult, CoinTradeResult, OcoLevels, OcoResult, OcoCancelResult, OcoFetchResult, OcoStatus, OrderBook, OrderBookAnalysis } from './types.js'
