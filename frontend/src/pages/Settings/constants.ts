import { LLMModuleKey } from '../../types'
import { SettingsData } from './types'

/* ---------------------------------- Sections ---------------------------------- */

export const SECTIONS = [
  { id: 'trading',    label: 'Trading',           subtitle: 'Core bot behavior',                                  icon: 'M22 7l-8.5 8.5-5-5L2 17M16 7h6v6' },
  { id: 'entry',      label: 'Entry Timing',      subtitle: 'Wait for a good price before filling a BUY',         icon: 'M12 8v4l3 3M3 12a9 9 0 1018 0 9 9 0 00-18 0z' },
  { id: 'risk',       label: 'Risk Management',   subtitle: 'Position sizing and protection levels',              icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  { id: 'monitor',    label: 'Position Monitor',  subtitle: 'Auto-review open positions on a schedule',           icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
  { id: 'chart',      label: 'Chart Markers',     subtitle: 'History the candle chart keeps for marks',           icon: 'M3 3v18h18M7 14l3-3 3 3 4-5M16 9h2v2' },
  { id: 'summary',    label: 'Portfolio Summary', subtitle: 'LLM briefing of the whole portfolio',                icon: 'M9 17v-6h13M9 11V5h13M3 5h.01M3 11h.01M3 17h.01' },
  { id: 'models',     label: 'LLM Models',        subtitle: 'Endpoints + per-module model assignment',            icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  { id: 'agent',      label: 'Agent',             subtitle: 'The conversational assistant + tool grants',         icon: 'M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z' },
  { id: 'appearance', label: 'Appearance',        subtitle: 'Visual theme',                                       icon: 'M12 2.69l5.66 5.66a8 8 0 11-11.31 0z' },
  { id: 'llm',        label: 'LLM Data',          subtitle: 'Debug fetch limit and retention policy',             icon: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5' },
  { id: 'telegram',   label: 'Telegram',          subtitle: 'Which events get pushed to your chat',               icon: 'M21.5 4.5L2.5 12l6 2m13-9.5l-3 15-7-5.5m10-9.5L8.5 16m0 0v4.5l3.5-3.5' },
  { id: 'account',    label: 'Account & Exchange', subtitle: 'Binance API keys and admin password',               icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
  { id: 'apiKeys',    label: 'API Keys',          subtitle: 'Keys for the tools/ debug API',                      icon: 'M15 7a2 2 0 110 4m4-2a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1119 9z' },
  { id: 'system',     label: 'System',            subtitle: 'Maintenance and app lifecycle',                      icon: 'M4 7v10a2 2 0 002 2h12a2 2 0 002-2V7M4 7l8-4 8 4M4 7l8 4 8-4M12 11v8' },
  { id: 'database',   label: 'Database',          subtitle: 'Backup, restore, retention & maintenance',           icon: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5' },
] as const

export type SectionId = typeof SECTIONS[number]['id']

export const secIcon = (id: SectionId): string => SECTIONS.find(s => s.id === id)!.icon

/* ----------------------------------- Crons ----------------------------------- */

export const CRON_PRESETS = [
  { label: '5 min',  value: '*/5 * * * *' },
  { label: '15 min', value: '*/15 * * * *' },
  { label: '30 min', value: '*/30 * * * *' },
  { label: '1 hr',   value: '0 * * * *' },
  { label: '4 hr',   value: '0 */4 * * *' },
  { label: '12 hr',  value: '0 */12 * * *' },
  { label: 'Daily',  value: '0 0 * * *' },
]

const CRON_LABELS: Record<string, string> = Object.fromEntries(CRON_PRESETS.map(p => [p.value, p.label]))

export function describeCron(expr: string): string {
  return CRON_LABELS[expr] ?? 'Custom schedule'
}

// Very lightweight 5-field cron validator
// Each field: * | n | n-m, optionally /step, comma-separated lists allowed
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every(p => CRON_FIELD.test(p))
}

/* ---------------------------------- Horizons ---------------------------------- */

export const HORIZONS = [
  { id: 'auto',   label: 'Auto',   hint: 'ATR-sized' },
  { id: 'llm',    label: 'LLM',    hint: 'Decides per trade' },
  { id: 'short',  label: 'Short',  hint: 'Days–weeks' },
  { id: 'medium', label: 'Medium', hint: 'Weeks–months' },
  { id: 'long',   label: 'Long',   hint: 'Months–years' },
] as const

export const HORIZON_COLORS: Record<string, { active: string; idle: string; dot: string }> = {
  auto:   { active: 'bg-surface-hover border-foreground/30 text-foreground', idle: 'border-border text-muted hover:border-foreground/20 hover:text-foreground', dot: 'bg-foreground/50' },
  llm:    { active: 'bg-accent/10 border-accent/40 text-accent',             idle: 'border-border text-muted hover:border-accent/30 hover:text-foreground',     dot: 'bg-accent' },
  short:  { active: 'bg-sell/10 border-sell/40 text-sell',                   idle: 'border-border text-muted hover:border-sell/30 hover:text-foreground',       dot: 'bg-sell' },
  medium: { active: 'bg-accent/10 border-accent/40 text-accent',             idle: 'border-border text-muted hover:border-accent/30 hover:text-foreground',     dot: 'bg-accent' },
  long:   { active: 'bg-buy/10 border-buy/40 text-buy',                      idle: 'border-border text-muted hover:border-buy/30 hover:text-foreground',        dot: 'bg-buy' },
}

/* ------------------------------ Telegram events ------------------------------ */

export const TELEGRAM_EVENTS: { key: keyof SettingsData; label: string; hint: string }[] = [
  { key: 'telegram_notify_position_opened', label: 'Position opened', hint: 'A new position was opened.' },
  { key: 'telegram_notify_position_closed', label: 'Position closed', hint: 'A position was closed — stop-loss / take-profit hit, monitor exit, or manual close.' },
  { key: 'telegram_notify_sl_tp_adjusted', label: 'SL/TP adjusted', hint: 'The monitor moved a position’s stop-loss or take-profit.' },
  { key: 'telegram_notify_trade_failed', label: 'Trade failed', hint: 'An order failed to execute on the exchange.' },
  { key: 'telegram_notify_summary', label: 'Portfolio summary', hint: 'A new portfolio summary briefing was produced.' },
  { key: 'telegram_notify_discovery', label: 'Coin discovered', hint: 'The discoverer found a new candidate coin.' },
  { key: 'telegram_notify_portfolio', label: 'Portfolio snapshot', hint: 'Total value + open-position count after each cycle. Can be noisy.' },
  { key: 'telegram_notify_errors', label: 'System errors', hint: 'Runtime errors surfaced by the bot.' },
  { key: 'telegram_notify_update', label: 'Update available', hint: 'A new app update (origin/main is ahead) was detected by the periodic checker.' },
  { key: 'telegram_notify_startup', label: 'Startup message', hint: '“CryptoBot started” notice when the bot boots.' },
]

/* ------------------------------- LLM modules -------------------------------- */

// Modules whose LLM endpoint/model/max-tokens can be overridden from Settings.
// Keep in sync with the backend SPECS registry in config/llm.ts.
export const LLM_MODULES: {
  key: LLMModuleKey
  label: string
  hint: string
  endpointKey: keyof SettingsData
  maxTokensKey: keyof SettingsData
  fbEndpointKey: keyof SettingsData
  fbMaxTokensKey: keyof SettingsData
  streamKey: keyof SettingsData
}[] = [
  { key: 'analyst',             label: 'Analyst',              hint: 'Main BUY/SELL/HOLD decision per coin.',                   endpointKey: 'llm_analyst_endpoint',             maxTokensKey: 'llm_analyst_max_tokens',             fbEndpointKey: 'llm_analyst_fb_endpoint',             fbMaxTokensKey: 'llm_analyst_fb_max_tokens',             streamKey: 'llm_stream_analyst' },
  { key: 'extractor',           label: 'Extractor',            hint: 'Compresses research articles into structured sentiment.', endpointKey: 'llm_extractor_endpoint',           maxTokensKey: 'llm_extractor_max_tokens',           fbEndpointKey: 'llm_extractor_fb_endpoint',           fbMaxTokensKey: 'llm_extractor_fb_max_tokens',           streamKey: 'llm_stream_extractor' },
  { key: 'discoverer',          label: 'Discoverer',           hint: 'Scores new coin candidates during discovery.',            endpointKey: 'llm_discoverer_endpoint',          maxTokensKey: 'llm_discoverer_max_tokens',          fbEndpointKey: 'llm_discoverer_fb_endpoint',          fbMaxTokensKey: 'llm_discoverer_fb_max_tokens',          streamKey: 'llm_stream_discoverer' },
  { key: 'discovererExtractor', label: 'Discoverer extractor', hint: 'Extractor used inside the discovery pipeline.',            endpointKey: 'llm_discoverer_extractor_endpoint', maxTokensKey: 'llm_discoverer_extractor_max_tokens', fbEndpointKey: 'llm_discoverer_extractor_fb_endpoint', fbMaxTokensKey: 'llm_discoverer_extractor_fb_max_tokens', streamKey: 'llm_stream_discovererExtractor' },
  { key: 'summary',             label: 'Portfolio Summary',    hint: 'Writes the scheduled portfolio briefing from holdings + Binance market data.', endpointKey: 'llm_summary_endpoint', maxTokensKey: 'llm_summary_max_tokens', fbEndpointKey: 'llm_summary_fb_endpoint', fbMaxTokensKey: 'llm_summary_fb_max_tokens', streamKey: 'llm_stream_summary' },
  { key: 'entryAgent',          label: 'Entry Agent',          hint: 'The agentic per-coin entry engine: drives each deferred BUY (adjusts the band / fires / cancels) via tool calls. Use a tool-calling-capable model.', endpointKey: 'llm_entryAgent_endpoint', maxTokensKey: 'llm_entryAgent_max_tokens', fbEndpointKey: 'llm_entryAgent_fb_endpoint', fbMaxTokensKey: 'llm_entryAgent_fb_max_tokens', streamKey: 'llm_stream_entryAgent' },
  { key: 'agent',               label: 'Agent',                hint: 'Conversational assistant on the Agent page. Use a tool-calling-capable model.', endpointKey: 'llm_agent_endpoint', maxTokensKey: 'llm_agent_max_tokens', fbEndpointKey: 'llm_agent_fb_endpoint', fbMaxTokensKey: 'llm_agent_fb_max_tokens', streamKey: 'llm_stream_agent' },
  { key: 'monitor',             label: 'Agent Monitor',        hint: 'The agentic position monitor. Runs a tool-calling loop per open position, so use a tool-calling-capable model.', endpointKey: 'llm_monitor_endpoint', maxTokensKey: 'llm_monitor_max_tokens', fbEndpointKey: 'llm_monitor_fb_endpoint', fbMaxTokensKey: 'llm_monitor_fb_max_tokens', streamKey: 'llm_stream_monitor' },
  { key: 'agentSignal',         label: 'Agent Signal',         hint: 'The agentic entry engine (entry model “Agent Signal”). Runs a tool-calling loop per watchlist coin, so use a tool-calling-capable model.', endpointKey: 'llm_agentSignal_endpoint', maxTokensKey: 'llm_agentSignal_max_tokens', fbEndpointKey: 'llm_agentSignal_fb_endpoint', fbMaxTokensKey: 'llm_agentSignal_fb_max_tokens', streamKey: 'llm_stream_agentSignal' },
  { key: 'webSearch',           label: 'Web Search',           hint: 'The generic web_search agent tool: per-page extraction that summarizes search results against the query. Used by the chat agent and the signal/monitor/entry agents.', endpointKey: 'llm_webSearch_endpoint', maxTokensKey: 'llm_webSearch_max_tokens', fbEndpointKey: 'llm_webSearch_fb_endpoint', fbMaxTokensKey: 'llm_webSearch_fb_max_tokens', streamKey: 'llm_stream_webSearch' },
]

export type LLMModule = typeof LLM_MODULES[number]
