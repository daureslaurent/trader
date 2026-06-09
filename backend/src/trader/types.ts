export interface BalanceInfo {
  total: number
  free: number
  used: number
}

export interface MarketData {
  symbol: string
  price: number
  change24h: number
  volume: number
}

export interface AccountBalance {
  [coin: string]: BalanceInfo
}

export interface TradeResult {
  id: string
  price: number
  quantity: number
  cost: number
  fee_cost: number
  fee_currency: string
}

export interface CoinTradeResult {
  fromSymbol: string
  toSymbol: string
  fromAmount: number
  toAmount: number
  fromPrice: number
  toPrice: number
}

// ── Order book ───────────────────────────────────────────────────────────────

export interface OrderBook {
  symbol: string
  /** Each entry: [price, quantity] */
  bids: [number, number][]
  asks: [number, number][]
  timestamp: number
}

export interface OrderBookAnalysis {
  bestBid: number
  bestAsk: number
  midPrice: number
  /** (ask − bid) / mid × 100 */
  spreadPct: number
  /** Volume-weighted avg price to fill targetQty coins walking the ask side */
  vwap: number
  /** How many coins are available up to suggestedLimitPrice */
  fillQty: number
  /** (vwap − bestAsk) / bestAsk × 100 */
  priceImpactPct: number
  /** vwap × 1.001 — limit price that absorbs normal micro-movements */
  suggestedLimitPrice: number
  liquidityScore: 'high' | 'medium' | 'low'
}

// ── Exchange-side OCO (One-Cancels-the-Other) ────────────────────────────────
// An OCO sell pairs a take-profit (LIMIT_MAKER) leg with a stop-loss
// (STOP_LOSS_LIMIT) leg; whichever fills first cancels the other on the exchange.

/** Local view of whether exchange-side protection is live for a position. */
export type OcoStatus = 'NONE' | 'ACTIVE' | 'FAILED'

/** Desired SL/TP levels for an OCO sell, plus the stop-limit buffer. */
export interface OcoLevels {
  stopLoss: number
  takeProfit: number | null
  /** Limit price for the SL leg sits this % below the stop trigger (e.g. 0.5). */
  bufferPct: number
}

/** Result of placing/replacing an OCO on the exchange. */
export interface OcoResult {
  orderListId: string
  slOrderId: string | null
  tpOrderId: string | null
  status: OcoStatus
}

/** Outcome of cancelling an OCO. `already-gone` means a leg had already filled/cancelled. */
export type OcoCancelResult = 'cancelled' | 'already-gone'

/** Live status of an OCO as reported by the exchange. */
export interface OcoFetchResult {
  status: 'OPEN' | 'FILLED' | 'CANCELED'
  filledLeg: 'SL' | 'TP' | null
  fillPrice: number | null
  fillQty: number | null
  fee: { cost: number; currency: string } | null
}
