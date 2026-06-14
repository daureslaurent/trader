import { settings as settingsRepo, Row } from './repositories.js'
import { BotSettings, LLMEndpoint } from '../types.js'

// In-memory settings cache. getSettings() is called synchronously in dozens of
// hot paths (config resolution, every engine tick, every route), so we keep the
// key/value map in memory rather than making it an async DB read. The cache is
// loaded once at startup (loadSettings) and kept in sync on every updateSetting.
let rawMap: Record<string, string> = {}

export async function loadSettings(): Promise<void> {
  const rows = (await settingsRepo.find()) as Row[]
  const map: Record<string, string> = {}
  for (const row of rows) map[row._id as string] = row.value as string
  rawMap = map
}

// Parse the persisted endpoint catalog, defensively skipping malformed entries so
// a corrupt row can never crash settings reads (which run on every LLM call).
function parseEndpoints(raw: string | undefined): LLMEndpoint[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map(e => ({
        id: String(e.id ?? ''),
        name: String(e.name ?? ''),
        baseURL: String(e.baseURL ?? ''),
        model: String(e.model ?? ''),
        maxTokens: Number.isFinite(Number(e.maxTokens)) ? Math.max(0, Math.floor(Number(e.maxTokens))) : 0,
        parallel: e.parallel === true,
        maxParallel: Number.isFinite(Number(e.maxParallel)) ? Math.max(0, Math.floor(Number(e.maxParallel))) : 0,
        disabled: e.disabled === true,
      }))
      .filter(e => e.id)
  } catch {
    return []
  }
}

export function getSettings(): BotSettings {
  const map = rawMap
  return {
    watchlist: JSON.parse(map.watchlist || '[]'),
    pipeline_cron: map.pipeline_cron || '0 * * * *',
    default_horizon: (['auto', 'llm', 'short', 'medium', 'long'].includes(map.default_horizon) ? map.default_horizon : 'llm') as 'auto' | 'llm' | 'short' | 'medium' | 'long',
    analyst_candle_tf: map.analyst_candle_tf || '1h',
    analyst_candle_count: parseInt(map.analyst_candle_count || '24', 10),
    min_confidence: parseFloat(map.min_confidence || '0.3'),
    max_position_size_usd: parseFloat(map.max_position_size_usd || '100'),
    approval_required: map.approval_required === 'true',
    stop_loss_atr: parseFloat(map.stop_loss_atr || '1.5'),
    take_profit_atr: parseFloat(map.take_profit_atr || '3.0'),
    max_risk_per_trade: parseFloat(map.max_risk_per_trade || '0.02'),
    max_open_positions: parseInt(map.max_open_positions || '5', 10),
    cache_ttl_hours: parseInt(map.cache_ttl_hours || '13', 10),
    discover_cron: map.discover_cron || '0 6 * * *',
    discover_min_score: parseFloat(map.discover_min_score || '0.65'),
    discover_top_n: parseInt(map.discover_top_n || '30', 10),
    discover_auto_add: map.discover_auto_add === 'true',
    discover_min_volume_usd: parseFloat(map.discover_min_volume_usd || '5000000'),
    monitor_auto_run: map.monitor_auto_run === 'true',
    monitor_model: (['a', 'b', 'alternate'].includes(map.monitor_model) ? map.monitor_model : 'a') as 'a' | 'b' | 'alternate',
    monitor_cron: map.monitor_cron || '0 */4 * * *',
    monitor_adjust_sltp: (map.monitor_adjust_sltp ?? 'true') === 'true',
    monitor_auto_approve: map.monitor_auto_approve === 'true',
    monitor_sl_pct_short: parseFloat(map.monitor_sl_pct_short || '3'),
    monitor_sl_pct_medium: parseFloat(map.monitor_sl_pct_medium || '5'),
    monitor_sl_pct_long: parseFloat(map.monitor_sl_pct_long || '10'),
    monitor_tp_pct_short: parseFloat(map.monitor_tp_pct_short || '6'),
    monitor_tp_pct_medium: parseFloat(map.monitor_tp_pct_medium || '10'),
    monitor_tp_pct_long: parseFloat(map.monitor_tp_pct_long || '20'),
    oco_sl_buffer_pct: parseFloat(map.oco_sl_buffer_pct || '0.5'),
    min_trade_usdc: parseFloat(map.min_trade_usdc || '12'),
    fee_rate: parseFloat(map.fee_rate || '0.001'),
    monitor_trust_llm_sltp: map.monitor_trust_llm_sltp === 'true',
    monitor_use_horizon: (map.monitor_use_horizon ?? 'true') === 'true',
    monitor_history_tf: map.monitor_history_tf || '1h',
    monitor_history_count: parseInt(map.monitor_history_count || '24', 10),
    monitor_min_confidence: parseFloat(map.monitor_min_confidence || '0.6'),
    monitor_breakeven_pct: parseFloat(map.monitor_breakeven_pct || '3'),
    monitor_adjust_cooldown_min: parseFloat(map.monitor_adjust_cooldown_min || '60'),
    utc_offset_hours: parseFloat(map.utc_offset_hours || '0'),
    llm_debug_fetch_limit: parseInt(map.llm_debug_fetch_limit || '200', 10),
    llm_retain_days: parseInt(map.llm_retain_days || '0', 10),
    llm_allow_parallel_same_url: map.llm_allow_parallel_same_url === 'true',
    entry_timing_enabled: (map.entry_timing_enabled ?? 'true') === 'true',
    entry_pullback_pct: parseFloat(map.entry_pullback_pct || '0.5'),
    entry_invalidate_pct: parseFloat(map.entry_invalidate_pct || '3'),
    entry_max_chase_pct: parseFloat(map.entry_max_chase_pct || '1.5'),
    entry_ttl_minutes: parseFloat(map.entry_ttl_minutes || '20'),
    entry_on_expiry: (map.entry_on_expiry === 'cancel' ? 'cancel' : 'market'),
    entry_poll_seconds: parseFloat(map.entry_poll_seconds || '3'),
    entry_planner_enabled: map.entry_planner_enabled === 'true',
    entry_planner_candle_tf: map.entry_planner_candle_tf || '15m',
    entry_planner_candle_count: parseInt(map.entry_planner_candle_count || '24', 10),
    llm_endpoints: parseEndpoints(map.llm_endpoints),
    llm_analyst_endpoint: map.llm_analyst_endpoint || '',
    llm_analyst_max_tokens: parseInt(map.llm_analyst_max_tokens || '0', 10),
    llm_extractor_endpoint: map.llm_extractor_endpoint || '',
    llm_extractor_max_tokens: parseInt(map.llm_extractor_max_tokens || '0', 10),
    llm_discoverer_endpoint: map.llm_discoverer_endpoint || '',
    llm_discoverer_max_tokens: parseInt(map.llm_discoverer_max_tokens || '0', 10),
    llm_discoverer_extractor_endpoint: map.llm_discoverer_extractor_endpoint || '',
    llm_discoverer_extractor_max_tokens: parseInt(map.llm_discoverer_extractor_max_tokens || '0', 10),
    llm_monitor_a_endpoint: map.llm_monitor_a_endpoint || '',
    llm_monitor_a_max_tokens: parseInt(map.llm_monitor_a_max_tokens || '0', 10),
    llm_monitor_b_endpoint: map.llm_monitor_b_endpoint || '',
    llm_monitor_b_max_tokens: parseInt(map.llm_monitor_b_max_tokens || '0', 10),
    llm_summary_endpoint: map.llm_summary_endpoint || '',
    llm_summary_max_tokens: parseInt(map.llm_summary_max_tokens || '0', 10),
    llm_entry_planner_endpoint: map.llm_entry_planner_endpoint || '',
    llm_entry_planner_max_tokens: parseInt(map.llm_entry_planner_max_tokens || '0', 10),
    llm_agent_endpoint: map.llm_agent_endpoint || '',
    llm_agent_max_tokens: parseInt(map.llm_agent_max_tokens || '0', 10),
    llm_analyst_fb_endpoint: map.llm_analyst_fb_endpoint || '',
    llm_analyst_fb_max_tokens: parseInt(map.llm_analyst_fb_max_tokens || '0', 10),
    llm_extractor_fb_endpoint: map.llm_extractor_fb_endpoint || '',
    llm_extractor_fb_max_tokens: parseInt(map.llm_extractor_fb_max_tokens || '0', 10),
    llm_discoverer_fb_endpoint: map.llm_discoverer_fb_endpoint || '',
    llm_discoverer_fb_max_tokens: parseInt(map.llm_discoverer_fb_max_tokens || '0', 10),
    llm_discoverer_extractor_fb_endpoint: map.llm_discoverer_extractor_fb_endpoint || '',
    llm_discoverer_extractor_fb_max_tokens: parseInt(map.llm_discoverer_extractor_fb_max_tokens || '0', 10),
    llm_monitor_a_fb_endpoint: map.llm_monitor_a_fb_endpoint || '',
    llm_monitor_a_fb_max_tokens: parseInt(map.llm_monitor_a_fb_max_tokens || '0', 10),
    llm_monitor_b_fb_endpoint: map.llm_monitor_b_fb_endpoint || '',
    llm_monitor_b_fb_max_tokens: parseInt(map.llm_monitor_b_fb_max_tokens || '0', 10),
    llm_summary_fb_endpoint: map.llm_summary_fb_endpoint || '',
    llm_summary_fb_max_tokens: parseInt(map.llm_summary_fb_max_tokens || '0', 10),
    llm_entry_planner_fb_endpoint: map.llm_entry_planner_fb_endpoint || '',
    llm_entry_planner_fb_max_tokens: parseInt(map.llm_entry_planner_fb_max_tokens || '0', 10),
    llm_agent_fb_endpoint: map.llm_agent_fb_endpoint || '',
    llm_agent_fb_max_tokens: parseInt(map.llm_agent_fb_max_tokens || '0', 10),
    agent_title_context_messages: parseInt(map.agent_title_context_messages || '6', 10),
    summary_auto_run: map.summary_auto_run === 'true',
    summary_cron: map.summary_cron || '0 */6 * * *',
    summary_retain_days: parseInt(map.summary_retain_days || '30', 10),
    telegram_notify_enabled: (map.telegram_notify_enabled ?? 'true') === 'true',
    telegram_notify_startup: (map.telegram_notify_startup ?? 'true') === 'true',
    telegram_notify_position_opened: (map.telegram_notify_position_opened ?? 'true') === 'true',
    telegram_notify_position_closed: (map.telegram_notify_position_closed ?? 'true') === 'true',
    telegram_notify_sl_tp_adjusted: (map.telegram_notify_sl_tp_adjusted ?? 'true') === 'true',
    telegram_notify_portfolio: (map.telegram_notify_portfolio ?? 'true') === 'true',
    telegram_notify_summary: (map.telegram_notify_summary ?? 'true') === 'true',
    telegram_notify_discovery: (map.telegram_notify_discovery ?? 'true') === 'true',
    telegram_notify_trade_failed: (map.telegram_notify_trade_failed ?? 'true') === 'true',
    telegram_notify_errors: (map.telegram_notify_errors ?? 'true') === 'true',
  }
}

export async function updateSetting(key: string, value: string): Promise<void> {
  rawMap[key] = value  // keep the in-memory cache consistent for the next read
  await settingsRepo.upsert(key, { value })
}

// Synchronous read of a raw setting value for keys that aren't part of the typed
// BotSettings shape (e.g. monitor_alternate_last). Served from the same cache.
export function getRawSetting(key: string): string | undefined {
  return rawMap[key]
}
