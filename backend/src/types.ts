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

/** One model served by an endpoint. Modules reference a model by its `id` (via
 *  `llm_<module>_endpoint`); resolution finds the parent endpoint for the URL. */
export interface LLMModelEntry {
  /** Globally-unique identifier referenced by per-module endpoint selections. */
  id: string
  /** The model id as advertised by the server (e.g. `qwen2.5:14b`). */
  model: string
  /** Default max-tokens for this model (0 = fall back to the env-var default).
   *  A per-module override (`llm_<module>_max_tokens` > 0) takes precedence. */
  maxTokens: number
  /** When true, this model is taken out of rotation: any module selecting it
   *  routes to its configured failover (or the env default). */
  disabled: boolean
}

/** A named LLM endpoint (a server URL) in the shared catalog, holding a list of
 *  models. Modules reference a model by its `id` (via `llm_<module>_endpoint`)
 *  instead of storing a URL/model each. */
export interface LLMEndpoint {
  /** Stable identifier for the endpoint (server). */
  id: string
  /** Friendly label shown in the Settings selectors. */
  name: string
  baseURL: string
  /** When true, calls to this endpoint may run in parallel even while same-URL
   *  serialization is on — for a server that can handle concurrent requests. */
  parallel: boolean
  /** Max concurrent calls allowed when `parallel` is on (0 = unlimited). Calls
   *  beyond this queue and run as in-flight ones complete. */
  maxParallel: number
  /** When true, the whole endpoint (server) is treated as permanently offline:
   *  the router never sends it traffic and any module selecting one of its models
   *  routes to its configured failover (or the env default). */
  disabled: boolean
  /** The models this endpoint serves. */
  models: LLMModelEntry[]
}

/** Per-(agent, tool) access level granted in Settings → Agent → Agentic Tools.
 *  'off' = the tool is not exposed to the agent at all; 'read' = the tool is
 *  exposed and read-only tools run normally, while write/action tools are exposed
 *  but their side effect is suppressed; 'readwrite' = full access (only meaningful
 *  for write/action tools — read-only tools treat it the same as 'read'). */
export type AgentToolPermission = 'off' | 'read' | 'readwrite'

/** Saved overrides keyed by agent id, then tool name. A missing agent or tool entry
 *  falls back to that agent's default grant in the backend registry, so this map only
 *  needs to hold the cells the user has actually changed. */
export type AgentToolPermissions = Record<string, Record<string, AgentToolPermission>>

export interface BotSettings {
  watchlist: string[]
  pipeline_cron: string
  /** Which engine produces the entry (BUY/HOLD) signal for watchlist coins on the pipeline
   *  trigger: 'classic' = the research → extractor → analyst pipeline; 'agent' = the Agent
   *  Signal engine — one agentic, single-coin tool-calling agent per watchlist coin that keeps
   *  long-term per-coin memory and a thesis. Mutually exclusive. */
  signal_model: 'classic' | 'agent'
  /** Offline mode — force deterministic, LLM-free decisions. When on, the Analyst, Monitor and
   *  Discoverer run rule-based (technical-analysis) logic instead of calling any LLM; Summary and
   *  the conversational Agent are disabled. Trade mechanics (sizing, SL/TP, gates, OCO, exits) are
   *  unchanged. This is the manual override; `offline_auto` adds automatic fallback. */
  offline_mode_forced: boolean
  /** When true (default), the bot automatically enters offline mode whenever every configured LLM
   *  catalog endpoint is unreachable (per the endpoint health monitor), and returns to LLM mode
   *  once any endpoint recovers. The manual `offline_mode_forced` override always wins. */
  offline_auto: boolean
  /** Freshness window (minutes) for reusing recently-computed LLM artifacts while offline. The
   *  offline analyst may blend the last analyst decision / cached article sentiment for a coin as a
   *  confidence tilt when it is younger than this; older data is ignored (pure TA). */
  offline_reuse_max_age_min: number
  /** Agent Signal only: when true, skip coins currently held in the portfolio (they belong to
   *  the monitor); when false, run an agent on every watchlist coin regardless of holdings. */
  agent_signal_check_portfolio: boolean
  /** Agent Signal only: how many of the most recent run records (per coin per cycle) to keep
   *  in agent_signal_runs; older ones are pruned after each cycle. */
  agent_signal_retain_runs: number
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
  /** Read-only safety lock. When on (default), the bot never mutates Binance: trades,
   *  OCO placement/replacement/cancellation are all refused. Reads still work. */
  binance_read_only: boolean
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
  /** Agent Monitor: review one position at a time (sequential) instead of all concurrently.
   *  Keeps a single-lane local LLM from being flooded and makes the live feed readable. */
  monitor_sequential: boolean
  /** Agent Monitor: how many of the most recent run records (per coin per cycle) to keep in
   *  monitor_runs; older ones are pruned after each cycle. */
  monitor_retain_runs: number
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
  /** Minimum LLM confidence required to execute a monitor CLOSE; lower-confidence proposals are downgraded to HOLD. */
  monitor_min_confidence: number
  /** Profit-protection guard: when on, a monitor CLOSE on a position that is in profit, whose stop is
   *  NOT threatened (price ≥ `monitor_protect_winners_atr` × ATR above the stop) and whose trend has not
   *  reversed (uptrend) is downgraded to HOLD — UNLESS the model's own verdict justifies it
   *  (thesis_status = 'invalidated' or regime = 'risk_off'). Stops the engine from exiting healthy winners
   *  on a thin reward:risk reading alone. */
  monitor_protect_winners: boolean
  /** Stop-buffer for `monitor_protect_winners`, in ATR(14) multiples: a CLOSE is only guarded while the
   *  current price sits at least this many ATRs above the stop-loss (i.e. the stop is not imminent). */
  monitor_protect_winners_atr: number
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
  /** Delete pipeline_events rows older than this many days. 0 = keep forever. */
  pipeline_events_retain_days: number
  /** Delete debug_logs rows older than this many days. 0 = keep forever. */
  debug_logs_retain_days: number
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
  /** Hard cap on an entry intent's TTL, in minutes, regardless of source (static/agent/manual).
   *  Any chosen TTL is clamped to this ceiling. 0 disables the cap. */
  entry_max_ttl_minutes: number
  /** Hard cap on how far below the live price the buy target may sit, as a % (the pullback depth).
   *  Applied to the static band at registration and to every Entry Agent re-anchor, so no source
   *  can park the target so deep the pullback never plays out and the intent just expires. A deeper
   *  requested pullback is clamped up to this ceiling (target moved closer to market). 0 disables it. */
  entry_max_pullback_pct: number
  /** On expiry: 'market' fires at the current (in-band) price; 'cancel' drops the intent. */
  entry_on_expiry: 'market' | 'cancel'
  /** How often the entry engine evaluates intents against the live price, in seconds. */
  entry_poll_seconds: number
  /** When true, a deferred BUY is not filled the instant price touches the target. Instead the
   *  engine arms on entering the buy zone, tracks the running low (trailing it down as new lows
   *  print), and fires only once price bounces `entry_rebound_pct` off that low — confirming the
   *  dip has stabilized rather than buying mid-drop. The invalidate level stays the give-up floor.
   *  When false, the legacy behavior (fill immediately at the target) applies. */
  entry_confirm_rebound: boolean
  /** How far price must bounce off its tracked low (as %) to confirm a rebound and fire the BUY.
   *  Only used when entry_confirm_rebound is on. */
  entry_rebound_pct: number
  /** Who decides the per-coin entry band (pullback / invalidate / chase cap / TTL) for a
   *  deferred BUY: 'static' = the fixed entry_* values above (no LLM); 'agent' = the Entry
   *  Agent — a per-coin tool-calling loop that reasons about the best entry and can adjust
   *  the band, fire now, or cancel as the market moves. On any agent error the static band
   *  is the safe fallback. Only takes effect when entry_timing_enabled is on. */
  entry_model: 'static' | 'agent'
  /** Cron driving the periodic Entry Agent re-evaluation pass over all active intents
   *  (mirrors the managed engine timers; surfaced in the routing graph). */
  entry_agent_cron: string
  /** Candle timeframe for the price-history table shown in the Entry Agent's context (e.g. '15m').
   *  Shorter than the monitor's default since the entry band fires within minutes. */
  entry_agent_candle_tf: string
  /** Number of candles to include in the Entry Agent's context (1–100). */
  entry_agent_candle_count: number
  /** How many of the most recent Entry Agent run records to keep in entry_agent_runs;
   *  older ones are pruned after each pass. */
  entry_agent_retain_runs: number
  /** Shared catalog of named LLM endpoints. Each module references one by id via
   *  `llm_<module>_endpoint`; a blank id falls back to the module's env-var config. */
  llm_endpoints: LLMEndpoint[]
  /** Per-module endpoint selection (id into `llm_endpoints`; blank = env default)
   *  plus a max-tokens override (0 = fall back to the env-var default). */
  llm_analyst_endpoint: string
  llm_analyst_max_tokens: number
  llm_extractor_endpoint: string
  llm_extractor_max_tokens: number
  llm_discoverer_endpoint: string
  llm_discoverer_max_tokens: number
  llm_discoverer_extractor_endpoint: string
  llm_discoverer_extractor_max_tokens: number
  llm_summary_endpoint: string
  llm_summary_max_tokens: number
  /** Entry Agent — the agentic per-coin entry engine. Needs a tool-calling-capable model. */
  llm_entryAgent_endpoint: string
  llm_entryAgent_max_tokens: number
  /** Conversational agent (Agent page). Needs a tool-calling-capable model. */
  llm_agent_endpoint: string
  llm_agent_max_tokens: number
  /** Agent Monitor — the agentic position monitor. Needs a tool-calling-capable model. */
  llm_monitor_endpoint: string
  llm_monitor_max_tokens: number
  llm_agentSignal_endpoint: string
  llm_agentSignal_max_tokens: number
  /** Generic web_search agent tool — per-page query-relevant extraction. */
  llm_webSearch_endpoint: string
  llm_webSearch_max_tokens: number
  /** Per-module streaming toggle. When true (default), the module's chat completions
   *  are requested with `stream: true` — tokens arrive incrementally, which keeps the
   *  socket warm (avoids idle-timeout "Premature close" drops on local servers) and
   *  powers the live token view in LLM Debug. The streamed result is reconstructed
   *  into an identical ChatCompletion, so module behavior is unchanged. Keyed by the
   *  `LLMModule` name (e.g. `monitor`), matching the `module` recorded on each call. */
  llm_stream_analyst: boolean
  llm_stream_extractor: boolean
  llm_stream_discoverer: boolean
  llm_stream_discovererExtractor: boolean
  llm_stream_summary: boolean
  llm_stream_entryAgent: boolean
  llm_stream_agent: boolean
  llm_stream_monitor: boolean
  llm_stream_agentSignal: boolean
  llm_stream_webSearch: boolean
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
  llm_summary_fb_endpoint: string
  llm_summary_fb_max_tokens: number
  llm_entryAgent_fb_endpoint: string
  llm_entryAgent_fb_max_tokens: number
  llm_agent_fb_endpoint: string
  llm_agent_fb_max_tokens: number
  llm_monitor_fb_endpoint: string
  llm_monitor_fb_max_tokens: number
  llm_agentSignal_fb_endpoint: string
  llm_agentSignal_fb_max_tokens: number
  llm_webSearch_fb_endpoint: string
  llm_webSearch_fb_max_tokens: number
  /** When auto-naming an Agent conversation, the title LLM summarizes only this many
   *  of the most recent (non-tool) messages — bounds the tokens spent per title. */
  agent_title_context_messages: number
  /** Per-agent tool grants for the tool-calling agents (Chat Agent, Agent Monitor, …).
   *  Sparse: only holds cells the user changed away from each agent's registry default.
   *  Resolved/enforced by the backend agent registry. */
  agent_tool_permissions: AgentToolPermissions
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
  /** Reference coin the Portfolio page benchmarks the portfolio against
   *  ("what if I'd just held this coin since inception"). Default 'BTC'. */
  benchmark_coin: string
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

/** The original entry thesis re-validated at review time. */
export type ThesisStatus = 'intact' | 'weakening' | 'invalidated'
/** The prevailing BTC/market regime the reviewer read the position against. */
export type MarketRegime = 'risk_on' | 'risk_off' | 'neutral'

/** Optional structured risk metadata a reviewer may attach to a verdict, for auditability.
 *  Produced by the Agent Monitor's per-position review. */
export interface ReviewRiskFields {
  /** Entry-thesis re-validation. */
  thesis_status: ThesisStatus | null
  /** Remaining reward:risk as an R-multiple computed from the CURRENT price (upside-to-TP ÷ downside-to-SL). */
  risk_reward: number | null
  /** BTC/market regime read at review time. */
  regime: MarketRegime | null
}

export interface PositionReview extends ReviewRiskFields {
  id: number
  coin: string
  action: 'HOLD' | 'CLOSE' | 'ADJUST'
  confidence: number
  reasoning: string
  old_stop_loss: number | null
  old_take_profit: number | null
  new_stop_loss: number | null
  new_take_profit: number | null
  market_data: string
  model: string | null
  cycle_id: string
  created_at: string
}

// One persisted Agent Monitor review: the resolved verdict for a single coin in a single
// cycle, plus the full transcript of the agent's tool-calling loop (the same frames streamed
// live to the Agent Monitor page). Lets the page rehydrate after a reload and power the
// per-run decision table + per-coin detail view.
// A single rendered transcript line. The server computes the presentation (icon/text/
// tone) so the live feed and the persisted/reloaded detail view render identically.
export interface MonitorRunFrame {
  type: string
  icon: string
  text: string
  tone: 'muted' | 'accent' | 'buy' | 'sell' | 'warn'
  at: number
  /** Raw tool args (on tool_call frames) or raw tool result (on tool_result frames), for the hover/pin detail popover. */
  detail?: { tool: string; args?: Record<string, unknown>; result?: unknown }
}

export interface MonitorRun extends ReviewRiskFields {
  id: number
  cycle_id: string
  coin: string
  action: 'HOLD' | 'CLOSE' | 'ADJUST'
  confidence: number
  reasoning: string
  /** True when the position closed mid-analysis and the verdict was not applied. */
  discarded: boolean
  /** Model id credited (e.g. "monitor:<model>"). */
  model: string
  /** The agent's loop transcript (thinking / tool_call / tool_result / decision …). */
  frames: MonitorRunFrame[]
  /** Token accounting across every LLM call in this run. `peak_context_tokens` is the
   *  largest single request (prompt+completion) — what presses against the model's
   *  context window; `prompt`/`completion` are summed over all the round-trips. */
  prompt_tokens: number
  completion_tokens: number
  peak_context_tokens: number
  started_at_ms: number
  created_at: string
}

// ── Agent Signal (the agentic, single-coin entry engine) ────────────────────
// One agent per watchlist coin reasons with the shared tool belt and commits to BUY or
// HOLD. The transcript reuses the monitor frame shape so the page renders both identically.
export type SignalRunFrame = MonitorRunFrame

export interface SignalRun {
  id: number
  cycle_id: string
  coin: string
  action: 'BUY' | 'HOLD'
  confidence: number
  /** 0–100 conviction percentage the agent assigned to its thesis. */
  conviction: number
  /** The agent's one-paragraph thesis/strategy for this coin. */
  thesis: string
  reasoning: string
  /** True when a BUY passed analysis but the BUY gauntlet rejected it (e.g. max positions,
   *  fee-edge, already-held) — recorded so the page can show "BUY (not staged)". */
  rejected: boolean
  /** Rejection reason from the gauntlet, when `rejected`. */
  rejected_reason: string | null
  /** Model id credited (e.g. "agent-signal:<model>"). */
  model: string
  /** The agent's loop transcript (thinking / tool_call / tool_result / decision …). */
  frames: SignalRunFrame[]
  prompt_tokens: number
  completion_tokens: number
  peak_context_tokens: number
  started_at_ms: number
  created_at: string
}

// Persistent long-term memory the Agent Signal engine keeps per coin (one doc, _id = coin).
// Structured fields the engine rewrites each run, plus a freeform notes log it appends to.
export interface SignalMemory {
  coin: string
  /** Latest thesis/strategy narrative. */
  thesis: string | null
  /** 0–100 conviction percentage. */
  conviction: number | null
  /** Key price levels the agent is anchoring on. */
  support: number | null
  resistance: number | null
  /** The most recent verdict and when it was reached. */
  last_action: 'BUY' | 'HOLD' | null
  last_reviewed_at: string | null
  /** Appended running log of short memos to the agent's future self (newest last). */
  notes: { at: string; text: string }[]
  updated_at: string
}

// ── Entry Agent (the agentic, per-coin entry-position engine) ────────────────
// One agent per active entry intent reasons with the shared tool belt + the original
// BUY thesis / Agent Signal memory, then adapts the entry band, fires, waits, or cancels
// via action tools. The transcript reuses the monitor frame shape so the page renders it
// identically to Agent Signal / Agent Monitor.
export interface EntryAgentRun {
  id: number
  cycle_id: string
  coin: string
  /** What the agent did this pass. */
  action: 'ADJUST' | 'FIRE' | 'CANCEL' | 'WAIT'
  confidence: number
  reasoning: string
  /** Model id credited (e.g. "entry-agent:<model>"). */
  model: string
  /** The agent's loop transcript (thinking / tool_call / tool_result / decision …). */
  frames: SignalRunFrame[]
  prompt_tokens: number
  completion_tokens: number
  peak_context_tokens: number
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
  /** Deepest transport/error code from the failure's cause chain (ECONNRESET, UND_ERR_SOCKET, …). */
  error_code?: string | null
  /** HTTP status when the failure was an API response rather than a transport drop. */
  error_status?: number | null
  /** True when a streamed response was salvaged after the socket closed uncleanly
   *  (succeeded, but the token counts are estimated rather than server-reported). */
  stream_dirty?: boolean | null
  /** The `max_tokens` requested for this call (helps correlate big generations with mid-body drops). */
  max_tokens?: number | null
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