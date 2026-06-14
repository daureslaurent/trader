export type Page = 'dashboard' | 'trading-state' | 'portfolio' | 'monitor' | 'summary' | 'trade' | 'entry' | 'pipeline' | 'charts' | 'logs' | 'cache' | 'settings' | 'discover' | 'llm-debug' | 'llm-stats' | 'agent'

/** One message in an Agent conversation (GET /api/agent/conversations/:id). */
export interface AgentMessage {
  id: number
  conversation_id: number
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  name: string | null
  created_at: string
}

export interface AgentConversation {
  id: number
  title: string
  /** Cumulative tokens (prompt + completion) across every model call in the thread. */
  total_tokens: number
  /** Peak single-request tokens of the most recent turn — the context-window usage to
   *  watch against the model's limit (grows as the conversation gets longer). */
  last_context_tokens: number
  created_at: string
  updated_at: string
}

export interface AgentToolInfo {
  name: string
  description: string
  readOnly: boolean
}

/** One portfolio-summary run, from GET /api/summary. Mirrors the backend row. */
export interface PortfolioSummary {
  id: number
  summary: string
  what_happened: string | null
  health: string | null
  risk_level: string | null
  /** JSON-encoded string[] — parse before rendering. */
  observations: string | null
  /** JSON-encoded string[] — parse before rendering. */
  suggestions: string | null
  /** JSON-encoded snapshot of the data fed to the LLM. */
  snapshot: string
  model: string | null
  cycle_id: string
  created_at: string
}

export interface SummaryResponse {
  running: boolean
  latest: PortfolioSummary | null
  history: PortfolioSummary[]
  model: { model: string; baseURL: string }
}

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
  /** Fee-adjusted break-even price: entry × (1 + 2·fee_rate). */
  break_even_price?: number
  /** True once the live price clears break-even — closing now nets a gain after fees. */
  past_break_even?: boolean
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

export interface EntryIntent {
  id: string
  coin: string
  signalPrice: number
  targetPrice: number
  invalidatePrice: number
  chaseCapPrice: number
  notionalUsdc: number
  /** Whether the band levels were chosen by the Entry Planner LLM or static settings. */
  bandSource?: 'llm' | 'static'
  /** The LLM's one-line rationale for these levels (present only when bandSource === 'llm'). */
  planReason?: string
  createdAt: number
  expiresAt: number
}

export interface EntryEvent {
  id: string
  coin: string
  type: 'registered' | 'filled' | 'cancelled'
  reason?: 'pullback' | 'expiry-market' | 'falling_knife' | 'ran_away' | 'expired' | 'manual'
  signalPrice: number
  targetPrice: number
  price?: number
  slippagePct?: number
  at: number
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
  model: string | null
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
  model: string | null
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

export interface MonitorModelSlot {
  model: string
  baseURL: string
}

export interface MonitorModelsResponse {
  active: 'a' | 'b'
  a: MonitorModelSlot
  b: MonitorModelSlot
}

/** A named LLM endpoint in the shared catalog. Modules reference one by `id`. */
export interface LLMEndpoint {
  id: string
  name: string
  baseURL: string
  model: string
  /** Default max-tokens for this endpoint (0 = use the env-var default). A
   *  per-module override takes precedence. */
  maxTokens: number
  /** When true, calls to this endpoint may run in parallel even while same-URL
   *  serialization is on. */
  parallel: boolean
  /** Max concurrent calls when `parallel` is on (0 = unlimited). */
  maxParallel: number
  /** When true, the endpoint is taken out of rotation: the router treats it as
   *  permanently offline and modules selecting it route to their failover. */
  disabled: boolean
}

/** Module keys whose LLM endpoint/model/max-tokens can be overridden from Settings. */
export type LLMModuleKey =
  | 'analyst'
  | 'extractor'
  | 'discoverer'
  | 'discovererExtractor'
  | 'monitorA'
  | 'monitorB'
  | 'summary'
  | 'entryPlanner'
  | 'agent'

/** Env-var fallback endpoint/model/max-tokens for a module, from GET /api/llm/defaults. */
export interface LLMDefault {
  model: string
  baseURL: string
  maxTokens: number
}

/** Env-var fallback per overridable module, from GET /api/llm/defaults. */
export type LLMDefaults = Record<LLMModuleKey, LLMDefault>

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
  /** JSON-encoded OpenAI tool_calls array when the model requested tools this turn. */
  tool_calls?: string | null
  error: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  thinking_tokens: number | null
  /** Pure LLM inference latency, excluding any time spent waiting in the per-URL queue. */
  duration_ms: number
  /** Time spent waiting in the per-URL serialization queue before going in flight. */
  queue_ms?: number | null
  /** When the call went in flight (live calls only); null/absent while still queued. */
  running_at?: string | null
  coin: string | null
  cycle_id: string | null
  created_at: string
  status?: 'queued' | 'running' | 'done'
}
