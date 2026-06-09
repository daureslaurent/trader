import { queryAll, runSQL } from './helpers.js'
import { BotSettings } from '../types.js'

export function getSettings(): BotSettings {
  const rows = queryAll('SELECT key, value FROM settings')
  const map: Record<string, string> = {}
  for (const row of rows) map[row.key as string] = row.value as string
  return {
    watchlist: JSON.parse(map.watchlist || '[]'),
    pipeline_cron: map.pipeline_cron || '0 * * * *',
    default_horizon: (['auto', 'short', 'medium', 'long'].includes(map.default_horizon) ? map.default_horizon : 'auto') as 'auto' | 'short' | 'medium' | 'long',
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
  }
}

export function updateSetting(key: string, value: string): void {
  runSQL('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
}
