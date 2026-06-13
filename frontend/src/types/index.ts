export type Page = 'dashboard' | 'trading-state' | 'portfolio' | 'monitor' | 'trade' | 'pipeline' | 'charts' | 'logs' | 'cache' | 'settings' | 'discover' | 'llm-debug' | 'llm-stats'

export interface PortfolioSnapshot {
  total_value_usd: number
  created_at: string
}

export interface Trade {
  id: number
  coin: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  total: number
  status: 'EXECUTED' | 'PENDING' | 'FAILED'
  approved: number
  error?: string
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
  source?: 'trade' | 'manual' | 'transfer'
  current_price?: number | null
  current_value?: number | null
  delta_pct?: number | null
  delta_usd?: number | null
}

export interface PortfolioResponse {
  total_value: number
  entries: PortfolioEntry[]
  /** Bot-managed positions (positions table, status=OPEN). Does NOT include manual/transfer holdings. */
  open_position_count: number
  /** All non-USDC portfolio_entries with status=OPEN */
  holdings_count: number
  max_open_positions: number
  binance_usdc: number | null
  available_usdc: number | null
}

export interface ActivePosition {
  id: number
  coin: string
  quantity: number
  entry_price: number
  current_price: number | null
  pnl: number | null
  pnl_pct: number | null
  stop_loss: number
  take_profit: number | null
  distance_to_sl_pct: number | null
  distance_to_tp_pct: number | null
  status: 'OPEN' | 'CLOSED' | 'SL_HIT' | 'TP_HIT'
  horizon: 'short' | 'medium' | 'long' | 'disabled' | 'llm'
  /** Exchange-side OCO protection state: ACTIVE = enforced on Binance, FAILED = software fallback. */
  oco_status: 'NONE' | 'ACTIVE' | 'FAILED'
  created_at: string
}

export interface ClosedPosition {
  id: number
  coin: string
  quantity: number
  entry_price: number
  status: 'CLOSED' | 'SL_HIT' | 'TP_HIT'
  pnl: number
  pnl_pct: number
  opened_at: string
  closed_at: string | null
  duration_seconds: number
}

export interface GainsResponse {
  total_pnl: number
  total_bnb_fees: number
  positions: ClosedPosition[]
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

export interface DiscoveryResult {
  id: number
  coin: string
  score: number
  reasoning: string
  market_data: string
  status: 'pending' | 'approved' | 'rejected' | 'auto_added'
  cycle_id: string
  created_at: string
}

export interface DiscoveryMarketData {
  price: number
  change24h: number
  volume: number
  rsi14: number
  trend: 'uptrend' | 'downtrend' | 'ranging'
  volatility: 'high' | 'normal' | 'low'
  atr14: number
  sma7: number
  sma25: number
  perf7d: number
}

export interface DiscoverResponse {
  running: boolean
  discoveries: DiscoveryResult[]
}

export interface PositionReview {
  id: number
  coin: string
  action: 'HOLD' | 'CLOSE' | 'REDUCE' | 'ADJUST'
  confidence: number
  reasoning: string
  reduce_to_pct: number | null
  old_stop_loss: number | null
  old_take_profit: number | null
  new_stop_loss?: number | null
  new_take_profit?: number | null
  market_data: string
  cycle_id: string
  created_at: string
}

export interface AdjustmentRequest {
  adjustmentId: number
  coin: string
  oldStopLoss: number | null
  oldTakeProfit: number | null
  newStopLoss: number | null
  newTakeProfit: number | null
  reasoning: string
  confidence: number
  expiresAt: string
}

export interface PositionAdjustment {
  id: number
  position_id: number
  coin: string
  old_stop_loss: number | null
  old_take_profit: number | null
  new_stop_loss: number | null
  new_take_profit: number | null
  reasoning: string | null
  confidence: number | null
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'EXPIRED'
  cycle_id: string | null
  created_at: string
}

export interface MonitorNote {
  coin: string
  notes: string
  updated_at: string
}

export interface MonitorResponse {
  running: boolean
  reviews: PositionReview[]
  notes?: MonitorNote[]
}

export interface SlTpEvent {
  position_id: number
  coin: string
  stop_loss: number
  take_profit: number | null
  event: 'open' | 'update' | 'close'
  price: number | null
  created_at: string
}

export interface LLMCall {
  id: number
  temp_id?: string
  module: string
  model: string
  base_url: string
  system_prompt?: string
  user_prompt?: string
  response: string | null
  reasoning_content: string | null
  error: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  thinking_tokens: number | null
  duration_ms: number
  coin: string | null
  cycle_id: string | null
  created_at: string
  status?: 'running' | 'done'
}
