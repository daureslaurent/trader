export type Page = 'dashboard' | 'portfolio' | 'trade' | 'pipeline' | 'charts' | 'logs' | 'cache' | 'settings'

export interface Trade {
  id: number
  coin: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  total: number
  status: 'EXECUTED' | 'PENDING' | 'FAILED'
  approved: number
  created_at: string
}

export interface Decision {
  id: number
  coin: string
  action: 'BUY' | 'SELL' | 'HOLD'
  reason: string
  confidence: number
  created_at: string
}

export interface PortfolioEntry {
  id: number
  coin: string
  quantity: number
  buy_price: number
  buy_date: string
  current_price?: number
  current_value?: number
  delta_pct?: number
  delta_usd?: number
}

export interface PortfolioResponse {
  total_value: number
  entries: PortfolioEntry[]
  open_position_count: number
  max_open_positions: number
  binance_usdc: number | null
  available_usdc: number | null
}

export interface Position {
  id: number
  coin: string
  side: string
  quantity: number
  entry_price: number
  current_price: number
  stop_loss: number
  take_profit: number
  current_sl: number
  pnl: number
  status: string
  created_at: string
}

export interface PipelineEvent {
  id: number
  coin: string
  cycle_id: string
  stage: string
  data: string
  created_at: string
}

export interface ChartPoint {
  coin: string
  value: number
  created_at: string
}

export interface Settings {
  watchlist: string[]
  pipeline_cron: string
  max_open_positions: number
  risk_per_trade: number
  min_confidence: number
  stop_loss_atr_multiplier: number
  take_profit_atr_multiplier: number
  approval_required: boolean
}

export interface ApprovalRequest {
  tradeId: number
  coin: string
  side: string
  quantity: number
  estimatedPrice: number
  reason: string
  confidence: number
  expiresAt: string
}

export interface CachedArticle {
  url: string
  coin: string
  cached_at: string
  title?: string
  relevance_score?: number
  sentiment?: 'positive' | 'negative' | 'neutral'
  summary?: string
  key_points?: string[]
  preliminary_signal?: 'BUY' | 'SELL' | 'HOLD'
}

export interface CacheCoin {
  coin: string
  count: number
}

export interface Toast {
  id: number
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
}
