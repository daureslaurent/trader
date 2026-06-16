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

/** A named LLM endpoint in the shared catalog. Modules reference one by `id`
 *  (via `llm_<module>_endpoint`) instead of storing a URL/model each. */
export interface LLMEndpoint {
  /** Stable identifier referenced by per-module endpoint selections. */
  id: string
  /** Friendly label shown in the Settings dropdowns. */
  name: string
  baseURL: string
  model: string
  /** Default max-tokens for this endpoint (0 = fall back to the env-var default).
   *  A per-module override (`llm_<module>_max_tokens` > 0) takes precedence. */
  maxTokens: number
  /** When true, calls to this endpoint may run in parallel even while same-URL
   *  serialization is on — for a server that can handle concurrent requests. */
  parallel: boolean
  /** Max concurrent calls allowed when `parallel` is on (0 = unlimited). Calls
   *  beyond this queue and run as in-flight ones complete. */
  maxParallel: number
  /** When true, the endpoint is treated as permanently offline: the router never
   *  sends it traffic and any module selecting it routes to its configured
   *  failover (or the env default). Lets you take a model out of rotation without
   *  deleting it or re-pointing every module. */
  disabled: boolean
}

export interface BotSettings {
  watchlist: string[]
  pipeline_cron: string
  /** Trading horizon for new positions.
   *  - 'auto'              → no horizon thesis; SL/TP sized purely off ATR.
   *  - 'llm'               → the analyst LLM picks short/medium/long per trade as part of its decision.
   *  - 'short'|'medium'|'long' → force this horizon on every trade (overrides the LLM's pick).
   *  The chosen horizon is stamped on the position and can still be edited afterward. */
  default_horizon: 'auto' | 'llm' | 'short' | 'medium' | 'long'
  /** Candle timeframe for the price-history table shown in the analyst (decision) prompt (e.g. '1h'). */
  analyst_candle_tf: string
  /** Number of candles to include in the analyst prompt (1–100); 0 omits the table. */
  analyst_candle_count: number
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
  /** Which monitor configuration drives open-position review on the monitor cron:
   *  'a' = slot A only, 'b' = slot B only, 'alternate' = flip A/B each cycle,
   *  'ab' = run A and B together and keep the higher-confidence verdict (confidence-weighted),
   *  'abc' = run A and B, then model C synthesizes the final verdict from both,
   *  'd' = the Type D agentic per-position monitor (tool-calling loop, uses the Agent model).
   *  All modes are mutually exclusive — exactly one runs per tick (same cron). */
  monitor_model: 'a' | 'b' | 'alternate' | 'ab' | 'abc' | 'd'
  /** Type D only: review one position at a time (sequential) instead of all concurrently.
   *  Keeps a single-lane local LLM from being flooded and makes the live feed readable. */
  monitor_d_sequential: boolean
  /** Type D only: how many of the most recent run records (per coin per cycle) to keep in
   *  monitor_d_runs; older ones are pruned after each cycle. */
  monitor_d_retain_runs: number
  monitor_cron: string
  monitor_adjust_sltp: boolean
  /** When true, the monitor may propose/execute partial exits (REDUCE). When false, REDUCE is
   *  removed from the prompt entirely and any REDUCE the LLM still returns is downgraded to HOLD. */
  monitor_reduce_enabled: boolean
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
  /** How many distinct monitor cycles of position-review history to keep in the DB.
   *  Older cycles are pruned after each monitor run. These reviews are the diamond
   *  markers on the candle chart, so a larger value keeps marker history further back. */
  monitor_review_retain_cycles: number
  /** Hours to add to UTC when formatting dates in the monitor prompt (e.g. 5 for UTC+5, -3 for UTC-3). */
  utc_offset_hours: number
  /** Max rows to fetch in the LLM Debug page (default 200). */
  llm_debug_fetch_limit: number
  /** Delete llm_calls older than this many days, archiving aggregate stats first. 0 = keep forever. */
  llm_retain_days: number
  /** When false (default), calls to the same base URL are serialized through a per-URL waiting list so a
   *  single LLM endpoint only handles one request at a time. When true, same-URL calls may run in parallel.
   *  Calls to *different* base URLs always run concurrently regardless of this setting. */
  llm_allow_parallel_same_url: boolean
  /** When true, BUYs are deferred to the entry-timing engine (wait for a good fill) instead of firing at the cron-tick price. */
  entry_timing_enabled: boolean
  /** Target entry as % below the signal price — the "buy the dip" discount. */
  entry_pullback_pct: number
  /** Falling-knife cancel: abandon the intent if price drops this % below the signal price. */
  entry_invalidate_pct: number
  /** Chase cap: abandon the intent if price rises this % above the signal price (don't chase). */
  entry_max_chase_pct: number
  /** How long an entry intent stays live before it expires, in minutes. */
  entry_ttl_minutes: number
  /** On expiry: 'market' fires at the current (in-band) price; 'cancel' drops the intent. */
  entry_on_expiry: 'market' | 'cancel'
  /** How often the entry engine evaluates intents against the live price, in seconds. */
  entry_poll_seconds: number
  /** When true, the Entry Planner LLM decides the per-coin entry band (pullback /
   *  invalidate / chase cap / TTL) for each deferred BUY. When off (or on LLM
   *  failure/invalid output) the static entry_* values above are used. Only takes
   *  effect when entry_timing_enabled is on. */
  entry_planner_enabled: boolean
  /** Candle timeframe for the price-history table shown in the Entry Planner prompt (e.g. '15m').
   *  Shorter than the monitor's default since the entry band fires within minutes. */
  entry_planner_candle_tf: string
  /** Number of candles to include in the Entry Planner prompt (1–100). */
  entry_planner_candle_count: number
  /** Shared catalog of named LLM endpoints. Each module references one by id via
   *  `llm_<module>_endpoint`; a blank id falls back to the module's env-var config. */
  llm_endpoints: LLMEndpoint[]
  /** Per-module endpoint selection (id into `llm_endpoints`; blank = env default)
   *  plus a max-tokens override (0 = fall back to the env-var default). The monitor
   *  exposes its two slots (A/B) here; `monitor_model` still selects which slot runs. */
  llm_analyst_endpoint: string
  llm_analyst_max_tokens: number
  llm_extractor_endpoint: string
  llm_extractor_max_tokens: number
  llm_discoverer_endpoint: string
  llm_discoverer_max_tokens: number
  llm_discoverer_extractor_endpoint: string
  llm_discoverer_extractor_max_tokens: number
  llm_monitor_a_endpoint: string
  llm_monitor_a_max_tokens: number
  llm_monitor_b_endpoint: string
  llm_monitor_b_max_tokens: number
  /** Slot C — the synthesizer model used in 'abc' (A + B + C) mode to write the final verdict. */
  llm_monitor_c_endpoint: string
  llm_monitor_c_max_tokens: number
  llm_summary_endpoint: string
  llm_summary_max_tokens: number
  /** Entry Planner — picks the per-coin entry band for deferred BUYs. */
  llm_entry_planner_endpoint: string
  llm_entry_planner_max_tokens: number
  /** Conversational agent (Agent page). Needs a tool-calling-capable model. */
  llm_agent_endpoint: string
  llm_agent_max_tokens: number
  /** Per-module failover endpoint selection (id into `llm_endpoints`; blank = no
   *  fallback) + max-tokens (0 = reuse the primary's effective max-tokens). Tried
   *  only if the primary LLM call throws (endpoint down, timeout, 5xx, unknown model). */
  llm_analyst_fb_endpoint: string
  llm_analyst_fb_max_tokens: number
  llm_extractor_fb_endpoint: string
  llm_extractor_fb_max_tokens: number
  llm_discoverer_fb_endpoint: string
  llm_discoverer_fb_max_tokens: number
  llm_discoverer_extractor_fb_endpoint: string
  llm_discoverer_extractor_fb_max_tokens: number
  llm_monitor_a_fb_endpoint: string
  llm_monitor_a_fb_max_tokens: number
  llm_monitor_b_fb_endpoint: string
  llm_monitor_b_fb_max_tokens: number
  llm_monitor_c_fb_endpoint: string
  llm_monitor_c_fb_max_tokens: number
  llm_summary_fb_endpoint: string
  llm_summary_fb_max_tokens: number
  llm_entry_planner_fb_endpoint: string
  llm_entry_planner_fb_max_tokens: number
  llm_agent_fb_endpoint: string
  llm_agent_fb_max_tokens: number
  /** When auto-naming an Agent conversation, the title LLM summarizes only this many
   *  of the most recent (non-tool) messages — bounds the tokens spent per title. */
  agent_title_context_messages: number
  /** When true, the portfolio-summary engine runs on its own cron. */
  summary_auto_run: boolean
  /** Cron expression for the portfolio-summary engine. */
  summary_cron: string
  /** Delete portfolio summaries older than this many days. 0 = keep forever. */
  summary_retain_days: number
  /** How many hours of LLM-scheduler activity the Control Room retains (feed + per-URL
   *  timeline). The page rebuilds this much scrollback on reload. Default 3. */
  control_room_retain_hours: number
  /** Candle-chart marker controls (Trade page). How many candles the chart loads —
   *  this sets the visible time window, so a larger value keeps signal/trade/monitor
   *  markers on screen further back in time. Default 150. */
  chart_candle_limit: number
  /** Max per-coin signal & monitor-review markers the chart fetches. Default 200. */
  chart_marker_limit: number
  /** Master switch for outbound Telegram push notifications. When false, no event
   *  notifications are sent. Trade-approval prompts are unaffected — they're
   *  functional (you reply to them), not notifications. */
  telegram_notify_enabled: boolean
  /** "CryptoBot started" message on boot. */
  telegram_notify_startup: boolean
  /** A new position was opened. */
  telegram_notify_position_opened: boolean
  /** A position was closed (SL/TP hit, monitor, or manual). */
  telegram_notify_position_closed: boolean
  /** The monitor adjusted a position's SL/TP. */
  telegram_notify_sl_tp_adjusted: boolean
  /** In A+B / A+B+C monitor modes, the underlying models disagreed on the action for a position. */
  telegram_notify_monitor_disagreement: boolean
  /** Portfolio snapshot (total value + open-position count) after each cycle. Noisy. */
  telegram_notify_portfolio: boolean
  /** A portfolio summary was produced by the summary engine. */
  telegram_notify_summary: boolean
  /** A new candidate coin was discovered. */
  telegram_notify_discovery: boolean
  /** A trade failed to execute on the exchange. */
  telegram_notify_trade_failed: boolean
  /** System/runtime errors surfaced to Telegram. */
  telegram_notify_errors: boolean
  /** A new app update (origin/main ahead) was detected by the periodic checker. */
  telegram_notify_update: boolean
  /** Master switch for the in-app host self-update feature. Off by default — when
   *  on, the System page exposes the version status, periodic update checks (which
   *  drive the sidebar pin), and the button that signals the host watcher to pull
   *  latest main and rebuild/restart the stack. */
  update_enabled: boolean
  /** How often (hours) to check whether origin/main is ahead. Default 1. */
  update_check_interval_hours: number
}

/** One run of the portfolio-summary engine: an LLM narrative + structured read of
 *  the whole portfolio at a point in time, persisted to `portfolio_summaries`. */
export interface PortfolioSummary {
  id: number
  /** Prose overview of the portfolio's current state. */
  summary: string
  /** What changed since the previous summary (recent trades, fills, P&L moves). */
  what_happened: string | null
  /** Coarse health label: 'strong' | 'stable' | 'cautious' | 'at_risk'. */
  health: string | null
  /** Risk label: 'low' | 'moderate' | 'elevated' | 'high'. */
  risk_level: string | null
  /** JSON array of short key observations. */
  observations: string | null
  /** JSON array of short, actionable suggestions. */
  suggestions: string | null
  /** JSON snapshot of the portfolio + market data fed to the LLM. */
  snapshot: string
  model: string | null
  cycle_id: string
  created_at: string
}

/** One Agent chat thread. Messages live in `agent_messages`. */
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

/** A single message in an Agent conversation. Mirrors the OpenAI chat roles so the
 *  thread can be replayed straight back into the model:
 *  - 'user'      → the human's message (content set)
 *  - 'assistant' → the model's reply; `content` may be null when it only emitted
 *                  `tool_calls` (a JSON array of the requested tool calls)
 *  - 'tool'      → the result of one tool call, keyed by `tool_call_id` + `name` */
export interface AgentMessage {
  id: number
  conversation_id: number
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  /** JSON-encoded OpenAI tool_calls array (assistant messages that called tools). */
  tool_calls: string | null
  /** Links a 'tool' result message back to the assistant tool_call it answers. */
  tool_call_id: string | null
  /** Tool name for 'tool' messages. */
  name: string | null
  created_at: string
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
  | 'entry_intent_created'
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
  model: string | null
  cycle_id: string
  created_at: string
}

// One persisted Type D (agentic monitor) review: the resolved verdict for a single
// coin in a single cycle, plus the full transcript of the agent's tool-calling loop
// (the same frames streamed live to the Agent Monitor page). Lets the page rehydrate
// after a reload and power the per-run decision table + per-coin detail view.
// A single rendered transcript line. The server computes the presentation (icon/text/
// tone) so the live feed and the persisted/reloaded detail view render identically.
export interface MonitorDRunFrame {
  type: string
  icon: string
  text: string
  tone: 'muted' | 'accent' | 'buy' | 'sell' | 'warn'
  at: number
}

export interface MonitorDRun {
  id: number
  cycle_id: string
  coin: string
  action: 'HOLD' | 'CLOSE' | 'REDUCE' | 'ADJUST'
  confidence: number
  reasoning: string
  /** True when the position closed mid-analysis and the verdict was not applied. */
  discarded: boolean
  /** Model id credited (e.g. "type-d:<model>"). */
  model: string
  /** The agent's loop transcript (thinking / tool_call / tool_result / decision …). */
  frames: MonitorDRunFrame[]
  started_at_ms: number
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
  model: string | null
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
  model: string
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