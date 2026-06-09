import { config } from '../config/index.js'
import { Signal } from '../types.js'
import { MarketData, AccountBalance, TradeResult, CoinTradeResult, OcoLevels, OcoResult, OcoCancelResult, OcoFetchResult, OrderBook, OrderBookAnalysis } from './types.js'
import * as real from './service.js'
import * as realOco from './oco.js'
import * as stub from './stub.js'

function impl() {
  return config.stub ? stub : real
}

// OCO lives in a dedicated real module (oco.js); dispatch to the stub in dev mode.
function ocoImpl() {
  return config.stub ? stub : realOco
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

export function fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook> {
  return impl().fetchOrderBook(symbol, depth)
}

// analyzeOrderBook is pure — always use the real implementation
export { analyzeOrderBook } from './service.js'

export function placeOco(symbol: string, quantity: number, levels: OcoLevels): Promise<OcoResult> {
  return ocoImpl().placeOco(symbol, quantity, levels)
}

export function cancelOco(symbol: string, orderListId: string): Promise<OcoCancelResult> {
  return ocoImpl().cancelOco(symbol, orderListId)
}

export function updateOco(symbol: string, orderListId: string, quantity: number, levels: OcoLevels): Promise<OcoResult> {
  return ocoImpl().updateOco(symbol, orderListId, quantity, levels)
}

export function fetchOco(
  symbol: string,
  oco: { orderListId: string; slOrderId: string | null; tpOrderId: string | null },
): Promise<OcoFetchResult> {
  return ocoImpl().fetchOco(symbol, oco)
}

export function findExistingOco(symbol: string): Promise<OcoResult | null> {
  return ocoImpl().findExistingOco(symbol)
}

export { OcoUnplaceableError } from './oco.js'
export type { MarketData, AccountBalance, TradeResult, CoinTradeResult, BalanceInfo, OcoLevels, OcoResult, OcoCancelResult, OcoFetchResult, OcoStatus, OrderBook, OrderBookAnalysis } from './types.js'
