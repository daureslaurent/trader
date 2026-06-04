export type TradeAction = 'BUY' | 'SELL' | 'HOLD'

export interface Signal {
  coin: string
  action: TradeAction
  quantity: number
  reason: string
  confidence: number
}

export interface TradeRecord {
  id: number
  coin: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  total: number
  signal_id: number | null
  status: 'PENDING' | 'EXECUTED' | 'FAILED'
  approved: boolean | null
  created_at: string
}

export interface DecisionRecord {
  id: number
  coin: string
  action: TradeAction
  reason: string
  confidence: number
  context: string
  triggered_trade_id: number | null
  created_at: string
}

export interface PortfolioSnapshot {
  id: number
  total_value_usd: number
  holdings: string
  created_at: string
}

export interface BotSettings {
  watchlist: string[]
  interval_minutes: number
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
}

export interface ApprovalRequest {
  tradeId: number
  coin: string
  side: 'BUY' | 'SELL'
  quantity: number
  estimatedPrice: number
  reason: string
  confidence: number
  expiresAt: string
}