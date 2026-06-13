export type TradeAction = 'BUY' | 'SELL' | 'HOLD'

export interface Signal {
  coin: string
  action: TradeAction
  quantity: number
  reason: string
  confidence: number
  horizon?: 'short' | 'medium' | 'long'
  stop_loss_pct?: number   // % below entry price (LLM-decided)
  take_profit_pct?: number // % above entry price (LLM-decided)
}

export interface TradeRecord {
  id: number
  coin: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  total: number
  fee_cost: number
  fee_currency: string
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
  pipeline_cron: string
  /** Trading horizon the bot uses for new positions. 'auto' = LLM decides SL/TP freely. */
  default_horizon: 'auto' | 'short' | 'medium' | 'long'
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
  cache_ttl_hours: number
  discover_cron: string
  discover_min_score: number
  discover_top_n: number
  discover_auto_add: boolean
  discover_min_volume_usd: number
  monitor_auto_run: boolean
  monitor_cron: string
  monitor_adjust_sltp: boolean
  monitor_auto_approve: boolean
  /** Per-horizon stop-loss distance as % below entry price */
  monitor_sl_pct_short: number
  monitor_sl_pct_medium: number
  monitor_sl_pct_long: number
  /** Per-horizon take-profit distance as % above entry price */
  monitor_tp_pct_short: number
  monitor_tp_pct_medium: number
  monitor_tp_pct_long: number
  /** Stop-limit buffer for the SL leg of exchange-side OCO orders, in % below the trigger. */
  oco_sl_buffer_pct: number
  /** Minimum USDC balance required to place a new BUY from the pipeline. */
  min_trade_usdc: number
  /** Exchange taker fee per side as a fraction (0.001 = 0.1%). Drives fee-aware PnL, break-even and edge checks. */
  fee_rate: number
  /** When true, bypass risk validation for monitor SL/TP adjustments — apply LLM values directly (only SL<price / TP>price sanity enforced). */
  monitor_trust_llm_sltp: boolean
  /** When true, inject per-horizon behavior guidance and SL/TP targets into the monitor LLM prompt. When false, the LLM decides freely. */
  monitor_use_horizon: boolean
  /** Timeframe for the historical candle table shown in the monitor prompt (e.g. '1h', '4h'). */
  monitor_history_tf: string
  /** Number of historical candles to include in the monitor prompt (1–100). */
  monitor_history_count: number
  /** Minimum LLM confidence required to execute a monitor CLOSE or REDUCE; lower-confidence proposals are downgraded to HOLD. */
  monitor_min_confidence: number
  /** P&L % above which the monitor prompt requires the stop-loss to sit at break-even or better (profit protection trigger).
   *  Applies when horizon guidance is off (or the position uses the 'llm' horizon); with horizon guidance on, the trigger is half the horizon's TP target.
   *  Also enforced engine-side: break-even-or-better stops proposed below this P&L are rejected. */
  monitor_breakeven_pct: number
  /** Minimum minutes between applied SL/TP adjustments per position (×0.5 for short horizon, ×2 for long). 0 disables the cooldown. */
  monitor_adjust_cooldown_min: number
  /** Hours to add to UTC when formatting dates in the monitor prompt (e.g. 5 for UTC+5, -3 for UTC-3). */
  utc_offset_hours: number
  /** Max rows to fetch in the LLM Debug page (default 200). */
  llm_debug_fetch_limit: number
  /** Delete llm_calls older than this many days, archiving aggregate stats first. 0 = keep forever. */
  llm_retain_days: number
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

export type DiscoveryStage =
  | 'discovery_started'
  | 'discovery_candidates_found'
  | 'discovery_evaluating'
  | 'discovery_scored'
  | 'discovery_completed'
  | 'discovery_error'

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
  | 'selection_started'
  | 'selection_completed'
  | 'analysis_started'
  | 'signal_generated'
  | 'pipeline_error'
  | 'pipeline_timeout'
  | 'pipeline_failed'
  | 'pipeline_cancelled'
  | 'pipeline_completed'
  | 'trade_executed'
  | 'trade_skipped'
  | 'discovery_started'
  | 'discovery_candidates_found'
  | 'discovery_evaluating'
  | 'discovery_scored'
  | 'discovery_completed'
  | 'discovery_error'

export interface PipelineEvent {
  id: number
  coin: string
  cycle_id: string
  stage: PipelineStage
  data: string
  created_at: string
}

export interface MarketData {
  symbol: string
  price: number
  change24h?: number
  volume?: number
  bid?: number
  ask?: number
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

export interface PortfolioEntry {
  id: number
  coin: string
  quantity: number
  buy_price: number
  buy_date: string
  status: 'OPEN' | 'CLOSED'
  source: 'trade' | 'manual'
  trade_id: number | null
  current_price: number | null
  delta_usd: number | null
  delta_pct: number | null
  created_at: string
}

export interface PortfolioState {
  totalValueUsd: number
  positions: { coin: string; allocationPct: number; deltaPct: number; entryPrice: number; currentPrice: number; quantity: number }[]
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

export interface PositionReview {
  id: number
  coin: string
  action: 'HOLD' | 'CLOSE' | 'REDUCE' | 'ADJUST'
  confidence: number
  reasoning: string
  reduce_to_pct: number | null
  old_stop_loss: number | null
  old_take_profit: number | null
  new_stop_loss: number | null
  new_take_profit: number | null
  market_data: string
  cycle_id: string
  created_at: string
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

/** Bus payload describing a monitor-proposed SL/TP change to an open position. */
export interface SlTpAdjustmentProposal {
  positionId: number
  coin: string
  oldStopLoss: number | null
  oldTakeProfit: number | null
  newStopLoss: number | null
  newTakeProfit: number | null
  reasoning: string
  confidence: number
  cycleId: string
}

export interface LLMCall {
  id: number
  module: string
  model: string
  base_url: string
  system_prompt?: string
  user_prompt?: string
  response: string | null
  error: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  duration_ms: number
  coin: string | null
  cycle_id: string | null
  created_at: string
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
  horizon: 'short' | 'medium' | 'long'
  oco_order_list_id: string | null
  oco_sl_order_id: string | null
  oco_tp_order_id: string | null
  oco_status: 'NONE' | 'ACTIVE' | 'FAILED'
  oco_synced_at: string | null
  created_at: string
}