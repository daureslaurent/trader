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

export type PipelineStage =
  | 'research_started'
  | 'research_completed'
  | 'extraction_started'
  | 'extraction_completed'
  | 'analysis_started'
  | 'signal_generated'
  | 'pipeline_error'

export interface PipelineEvent {
  id: number
  coin: string
  cycle_id: string
  stage: PipelineStage
  data: string
  created_at: string
}

export interface MarketContext {
  price: number
  change24h: number
  volume: number
  rsi14: number
  sma7: number
  sma25: number
  sma99: number
  atr14: number
  trend: 'uptrend' | 'downtrend' | 'ranging'
  perf7d: number
  volatility: 'high' | 'normal' | 'low'
}

export interface PortfolioState {
  totalValueUsd: number
  positions: { coin: string; allocationPct: number; pnlPct: number }[]
  diversificationScore: number
  openPositionCount: number
  maxOpenPositions: number
  targetAllocationPct: number
}

export interface RiskConfig {
  stopLossAtrMultiplier: number
  takeProfitAtrMultiplier: number
  maxRiskPerTrade: number
  maxOpenPositions: number
}

export interface PositionRecord {
  id: number
  coin: string
  side: 'BUY'
  quantity: number
  entry_price: number
  stop_loss: number
  take_profit: number | null
  current_sl: number
  status: string
  pnl: number | null
  created_at: string
}