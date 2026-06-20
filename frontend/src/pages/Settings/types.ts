import { LLMEndpoint, AgentToolPermissions } from '../../types'

export interface SettingsData {
  watchlist: string[]
  pipeline_cron: string
  signal_model: 'classic' | 'agent'
  agent_signal_check_portfolio: boolean
  agent_signal_retain_runs: number
  default_horizon: 'auto' | 'llm' | 'short' | 'medium' | 'long'
  analyst_candle_tf: string
  analyst_candle_count: number
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  binance_read_only: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
  cache_ttl_hours: number
  monitor_auto_run: boolean
  monitor_sequential: boolean
  monitor_retain_runs: number
  monitor_cron: string
  monitor_adjust_sltp: boolean
  monitor_auto_approve: boolean
  monitor_sl_pct_short: number
  monitor_sl_pct_medium: number
  monitor_sl_pct_long: number
  monitor_tp_pct_short: number
  monitor_tp_pct_medium: number
  monitor_tp_pct_long: number
  monitor_trust_llm_sltp: boolean
  monitor_use_horizon: boolean
  monitor_min_confidence: number
  monitor_protect_winners: boolean
  monitor_protect_winners_atr: number
  monitor_breakeven_pct: number
  monitor_adjust_cooldown_min: number
  monitor_review_retain_cycles: number
  utc_offset_hours: number
  min_trade_usdc: number
  fee_rate: number
  llm_debug_fetch_limit: number
  llm_retain_days: number
  pipeline_events_retain_days: number
  debug_logs_retain_days: number
  llm_allow_parallel_same_url: boolean
  entry_timing_enabled: boolean
  entry_pullback_pct: number
  entry_invalidate_pct: number
  entry_max_chase_pct: number
  entry_ttl_minutes: number
  entry_max_ttl_minutes: number
  entry_on_expiry: 'market' | 'cancel'
  entry_poll_seconds: number
  entry_confirm_rebound: boolean
  entry_rebound_pct: number
  entry_model: 'static' | 'agent'
  entry_agent_cron: string
  entry_agent_candle_tf: string
  entry_agent_candle_count: number
  entry_agent_retain_runs: number
  llm_endpoints: LLMEndpoint[]
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
  llm_entryAgent_endpoint: string
  llm_entryAgent_max_tokens: number
  llm_agent_endpoint: string
  llm_agent_max_tokens: number
  llm_monitor_endpoint: string
  llm_monitor_max_tokens: number
  llm_agentSignal_endpoint: string
  llm_agentSignal_max_tokens: number
  llm_webSearch_endpoint: string
  llm_webSearch_max_tokens: number
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
  agent_title_context_messages: number
  agent_tool_permissions: AgentToolPermissions
  summary_auto_run: boolean
  summary_cron: string
  summary_retain_days: number
  control_room_retain_hours: number
  chart_candle_limit: number
  chart_marker_limit: number
  telegram_notify_enabled: boolean
  telegram_notify_startup: boolean
  telegram_notify_position_opened: boolean
  telegram_notify_position_closed: boolean
  telegram_notify_sl_tp_adjusted: boolean
  telegram_notify_portfolio: boolean
  telegram_notify_summary: boolean
  telegram_notify_discovery: boolean
  telegram_notify_trade_failed: boolean
  telegram_notify_errors: boolean
  telegram_notify_update: boolean
  update_enabled: boolean
  update_check_interval_hours: number
}

// Sets a field and marks the form dirty (saved on the next Save).
export type SetFn = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => void

// Boolean settings that save immediately (and don't mark the form dirty).
export type ToggleKey =
  | 'approval_required' | 'binance_read_only' | 'monitor_auto_run' | 'monitor_adjust_sltp' | 'monitor_auto_approve'
  | 'monitor_trust_llm_sltp' | 'monitor_use_horizon' | 'monitor_protect_winners' | 'monitor_sequential'
  | 'agent_signal_check_portfolio' | 'entry_timing_enabled' | 'entry_confirm_rebound' | 'llm_allow_parallel_same_url'
  | 'summary_auto_run' | 'telegram_notify_enabled' | 'telegram_notify_startup'
  | 'telegram_notify_position_opened' | 'telegram_notify_position_closed' | 'telegram_notify_sl_tp_adjusted'
  | 'telegram_notify_portfolio' | 'telegram_notify_summary'
  | 'telegram_notify_discovery' | 'telegram_notify_trade_failed' | 'telegram_notify_errors'
  | 'telegram_notify_update' | 'update_enabled'

// Props every section component receives from the page shell.
export interface SectionProps {
  settings: SettingsData
  set: SetFn
  toggle: (key: ToggleKey) => void
}
