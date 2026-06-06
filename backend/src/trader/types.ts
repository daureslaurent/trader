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
  fee?: { cost: number; currency: string }
}

export interface CoinTradeResult {
  fromSymbol: string
  toSymbol: string
  fromAmount: number
  toAmount: number
  fromPrice: number
  toPrice: number
  fee?: { cost: number; currency: string }
}
