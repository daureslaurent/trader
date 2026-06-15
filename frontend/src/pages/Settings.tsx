import { useEffect, useRef, useState, FormEvent, ReactNode, KeyboardEvent } from 'react'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, Select } from '../components/ui/Input'
import { useTheme, THEMES } from '../contexts/ThemeContext'
import { cn } from '../lib/utils'
import { MonitorModelsResponse, LLMDefaults, LLMModuleKey, LLMEndpoint } from '../types'

interface SettingsData {
  watchlist: string[]
  pipeline_cron: string
  default_horizon: 'auto' | 'llm' | 'short' | 'medium' | 'long'
  analyst_candle_tf: string
  analyst_candle_count: number
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
  cache_ttl_hours: number
  monitor_auto_run: boolean
  monitor_model: 'a' | 'b' | 'alternate' | 'ab' | 'abc'
  monitor_cron: string
  monitor_adjust_sltp: boolean
  monitor_reduce_enabled: boolean
  monitor_auto_approve: boolean
  monitor_sl_pct_short: number
  monitor_sl_pct_medium: number
  monitor_sl_pct_long: number
  monitor_tp_pct_short: number
  monitor_tp_pct_medium: number
  monitor_tp_pct_long: number
  monitor_trust_llm_sltp: boolean
  monitor_use_horizon: boolean
  monitor_history_tf: string
  monitor_history_count: number
  monitor_min_confidence: number
  monitor_breakeven_pct: number
  monitor_adjust_cooldown_min: number
  utc_offset_hours: number
  min_trade_usdc: number
  fee_rate: number
  llm_debug_fetch_limit: number
  llm_retain_days: number
  llm_allow_parallel_same_url: boolean
  entry_timing_enabled: boolean
  entry_pullback_pct: number
  entry_invalidate_pct: number
  entry_max_chase_pct: number
  entry_ttl_minutes: number
  entry_on_expiry: 'market' | 'cancel'
  entry_poll_seconds: number
  entry_planner_enabled: boolean
  entry_planner_candle_tf: string
  entry_planner_candle_count: number
  llm_endpoints: LLMEndpoint[]
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
  llm_monitor_c_endpoint: string
  llm_monitor_c_max_tokens: number
  llm_summary_endpoint: string
  llm_summary_max_tokens: number
  llm_entry_planner_endpoint: string
  llm_entry_planner_max_tokens: number
  llm_agent_endpoint: string
  llm_agent_max_tokens: number
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
  agent_title_context_messages: number
  summary_auto_run: boolean
  summary_cron: string
  summary_retain_days: number
  telegram_notify_enabled: boolean
  telegram_notify_startup: boolean
  telegram_notify_position_opened: boolean
  telegram_notify_position_closed: boolean
  telegram_notify_sl_tp_adjusted: boolean
  telegram_notify_monitor_disagreement: boolean
  telegram_notify_portfolio: boolean
  telegram_notify_summary: boolean
  telegram_notify_discovery: boolean
  telegram_notify_trade_failed: boolean
  telegram_notify_errors: boolean
  telegram_notify_update: boolean
  update_enabled: boolean
  update_check_interval_hours: number
}

// Telegram per-event notification toggles, rendered as one row each.
const TELEGRAM_EVENTS: { key: keyof SettingsData; label: string; hint: string }[] = [
  { key: 'telegram_notify_position_opened', label: 'Position opened', hint: 'A new position was opened.' },
  { key: 'telegram_notify_position_closed', label: 'Position closed', hint: 'A position was closed — stop-loss / take-profit hit, monitor exit, or manual close.' },
  { key: 'telegram_notify_sl_tp_adjusted', label: 'SL/TP adjusted', hint: 'The monitor moved a position’s stop-loss or take-profit.' },
  { key: 'telegram_notify_monitor_disagreement', label: 'Monitor disagreement', hint: 'In A + B / A + B + C monitor modes, the underlying models disagreed on the action for a position.' },
  { key: 'telegram_notify_trade_failed', label: 'Trade failed', hint: 'An order failed to execute on the exchange.' },
  { key: 'telegram_notify_summary', label: 'Portfolio summary', hint: 'A new portfolio summary briefing was produced.' },
  { key: 'telegram_notify_discovery', label: 'Coin discovered', hint: 'The discoverer found a new candidate coin.' },
  { key: 'telegram_notify_portfolio', label: 'Portfolio snapshot', hint: 'Total value + open-position count after each cycle. Can be noisy.' },
  { key: 'telegram_notify_errors', label: 'System errors', hint: 'Runtime errors surfaced by the bot.' },
  { key: 'telegram_notify_update', label: 'Update available', hint: 'A new app update (origin/main is ahead) was detected by the periodic checker.' },
  { key: 'telegram_notify_startup', label: 'Startup message', hint: '“CryptoBot started” notice when the bot boots.' },
]

const CRON_PRESETS = [
  { label: '5 min',  value: '*/5 * * * *' },
  { label: '15 min', value: '*/15 * * * *' },
  { label: '30 min', value: '*/30 * * * *' },
  { label: '1 hr',   value: '0 * * * *' },
  { label: '4 hr',   value: '0 */4 * * *' },
  { label: '12 hr',  value: '0 */12 * * *' },
  { label: 'Daily',  value: '0 0 * * *' },
]

const CRON_LABELS: Record<string, string> = Object.fromEntries(CRON_PRESETS.map(p => [p.value, p.label]))

function describeCron(expr: string): string {
  return CRON_LABELS[expr] ?? 'Custom schedule'
}

// Very lightweight 5-field cron validator
// Each field: * | n | n-m, optionally /step, comma-separated lists allowed
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every(p => CRON_FIELD.test(p))
}

/* ---------------------------------- Section nav ---------------------------------- */

const SECTIONS = [
  { id: 'trading',    label: 'Trading',          icon: 'M22 7l-8.5 8.5-5-5L2 17M16 7h6v6' },
  { id: 'entry',      label: 'Entry Timing',     icon: 'M12 8v4l3 3M3 12a9 9 0 1018 0 9 9 0 00-18 0z' },
  { id: 'risk',       label: 'Risk Management',  icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  { id: 'monitor',    label: 'Position Monitor', icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
  { id: 'summary',    label: 'Portfolio Summary', icon: 'M9 17v-6h13M9 11V5h13M3 5h.01M3 11h.01M3 17h.01' },
  { id: 'models',     label: 'LLM Models',       icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  { id: 'agent',      label: 'Agent',            icon: 'M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z' },
  { id: 'appearance', label: 'Appearance',       icon: 'M12 2.69l5.66 5.66a8 8 0 11-11.31 0z' },
  { id: 'llm',        label: 'LLM Data',         icon: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5' },
  { id: 'telegram',   label: 'Telegram',         icon: 'M21.5 4.5L2.5 12l6 2m13-9.5l-3 15-7-5.5m10-9.5L8.5 16m0 0v4.5l3.5-3.5' },
  { id: 'system',     label: 'System',           icon: 'M4 7v10a2 2 0 002 2h12a2 2 0 002-2V7M4 7l8-4 8 4M4 7l8 4 8-4M12 11v8' },
] as const

type SectionId = typeof SECTIONS[number]['id']

function SectionIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d={path} />
    </svg>
  )
}

/* --------------------------------- UI primitives --------------------------------- */

function Toggle({ checked, onChange, danger, label }: {
  checked: boolean
  onChange: () => void
  danger?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'group relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card',
        checked
          ? danger ? 'bg-sell' : 'bg-accent'
          : 'bg-surface-elevated border border-border',
      )}
    >
      <span
        className={cn(
          'pointer-events-none h-[18px] w-[18px] rounded-full shadow-sm transition-all duration-200',
          checked
            ? 'translate-x-[22px] bg-surface-base'
            : 'translate-x-[3px] bg-muted group-hover:bg-foreground/70',
        )}
      />
    </button>
  )
}

function Section({ id, title, subtitle, icon, children }: {
  id: SectionId
  title: string
  subtitle: string
  icon: string
  children: ReactNode
}) {
  return (
    <Card className="scroll-mt-6" noPad>
      <div id={`section-${id}`} className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-border">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <SectionIcon path={icon} className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted mt-0.5">{subtitle}</p>
        </div>
      </div>
      <div className="px-5 divide-y divide-border">{children}</div>
    </Card>
  )
}

function Row({ label, hint, children, stacked }: {
  label: string
  hint?: string
  children: ReactNode
  stacked?: boolean
}) {
  if (stacked) {
    return (
      <div className="py-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          {hint && <p className="text-xs text-muted mt-1 leading-relaxed">{hint}</p>}
        </div>
        {children}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted mt-1 leading-relaxed">{hint}</p>}
      </div>
      <div className="shrink-0 sm:w-44">{children}</div>
    </div>
  )
}

function UnitInput({ unit, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { unit?: string }) {
  return (
    <div className="relative">
      <Input {...rest} className={cn(unit && 'pr-12', className)} />
      {unit && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
          {unit}
        </span>
      )}
    </div>
  )
}

function CronEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const valid = isValidCron(value)
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map(p => (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            className={cn(
              'px-2.5 py-1 text-xs rounded-full border transition-all duration-150',
              value === p.value
                ? 'bg-accent/10 border-accent/40 text-accent font-medium'
                : 'bg-surface-elevated border-border text-muted hover:text-foreground hover:border-foreground/20',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="*/30 * * * *"
          className="font-mono max-w-[180px]"
          error={!valid ? 'Invalid cron expression' : undefined}
        />
        {valid && (
          <span className="text-xs text-muted whitespace-nowrap">
            Runs: <span className="text-accent font-medium">{describeCron(value)}</span>
          </span>
        )}
      </div>
    </div>
  )
}

function WatchlistEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')

  function commit() {
    const parts = draft.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    if (!parts.length) return
    const next = [...value]
    for (const p of parts) {
      const pair = p.endsWith('/USDC') ? p : `${p}/USDC`
      if (!next.includes(pair)) next.push(pair)
    }
    onChange(next)
    setDraft('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 px-3 py-2 min-h-[42px]',
        'bg-surface-elevated border border-border rounded-xl',
        'focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/50 transition-colors duration-150',
      )}
    >
      {value.map(pair => {
        const sym = pair.replace('/USDC', '')
        return (
          <span
            key={pair}
            className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full bg-accent/10 border border-accent/20 text-xs font-medium text-accent"
          >
            {sym}
            <button
              type="button"
              aria-label={`Remove ${sym}`}
              onClick={() => onChange(value.filter(v => v !== pair))}
              className="flex h-4 w-4 items-center justify-center rounded-full text-accent/60 hover:text-accent hover:bg-accent/15 transition-colors"
            >
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        )
      })}
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={value.length ? 'Add coin…' : 'BTC, ETH, SOL…'}
        className="flex-1 min-w-[80px] bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none py-0.5"
      />
    </div>
  )
}

const HORIZONS = [
  { id: 'auto',   label: 'Auto',   hint: 'ATR-sized' },
  { id: 'llm',    label: 'LLM',    hint: 'Decides per trade' },
  { id: 'short',  label: 'Short',  hint: 'Days–weeks' },
  { id: 'medium', label: 'Medium', hint: 'Weeks–months' },
  { id: 'long',   label: 'Long',   hint: 'Months–years' },
] as const

const HORIZON_COLORS: Record<string, { active: string; idle: string; dot: string }> = {
  auto:   { active: 'bg-surface-hover border-foreground/30 text-foreground', idle: 'border-border text-muted hover:border-foreground/20 hover:text-foreground', dot: 'bg-foreground/50' },
  llm:    { active: 'bg-accent/10 border-accent/40 text-accent',             idle: 'border-border text-muted hover:border-accent/30 hover:text-foreground',     dot: 'bg-accent' },
  short:  { active: 'bg-sell/10 border-sell/40 text-sell',                   idle: 'border-border text-muted hover:border-sell/30 hover:text-foreground',       dot: 'bg-sell' },
  medium: { active: 'bg-accent/10 border-accent/40 text-accent',             idle: 'border-border text-muted hover:border-accent/30 hover:text-foreground',     dot: 'bg-accent' },
  long:   { active: 'bg-buy/10 border-buy/40 text-buy',                      idle: 'border-border text-muted hover:border-buy/30 hover:text-foreground',        dot: 'bg-buy' },
}

// Modules whose LLM endpoint/model/max-tokens can be overridden from Settings.
// Keep in sync with the backend SPECS registry in config/llm.ts. The two monitor
// slots (A/B) are configured here; the Position Monitor section picks which slot runs.
const LLM_MODULES: {
  key: LLMModuleKey
  label: string
  hint: string
  endpointKey: keyof SettingsData
  maxTokensKey: keyof SettingsData
  fbEndpointKey: keyof SettingsData
  fbMaxTokensKey: keyof SettingsData
}[] = [
  { key: 'analyst',             label: 'Analyst',              hint: 'Main BUY/SELL/HOLD decision per coin.',                   endpointKey: 'llm_analyst_endpoint',             maxTokensKey: 'llm_analyst_max_tokens',             fbEndpointKey: 'llm_analyst_fb_endpoint',             fbMaxTokensKey: 'llm_analyst_fb_max_tokens' },
  { key: 'extractor',           label: 'Extractor',            hint: 'Compresses research articles into structured sentiment.', endpointKey: 'llm_extractor_endpoint',           maxTokensKey: 'llm_extractor_max_tokens',           fbEndpointKey: 'llm_extractor_fb_endpoint',           fbMaxTokensKey: 'llm_extractor_fb_max_tokens' },
  { key: 'discoverer',          label: 'Discoverer',           hint: 'Scores new coin candidates during discovery.',            endpointKey: 'llm_discoverer_endpoint',          maxTokensKey: 'llm_discoverer_max_tokens',          fbEndpointKey: 'llm_discoverer_fb_endpoint',          fbMaxTokensKey: 'llm_discoverer_fb_max_tokens' },
  { key: 'discovererExtractor', label: 'Discoverer extractor', hint: 'Extractor used inside the discovery pipeline.',            endpointKey: 'llm_discoverer_extractor_endpoint', maxTokensKey: 'llm_discoverer_extractor_max_tokens', fbEndpointKey: 'llm_discoverer_extractor_fb_endpoint', fbMaxTokensKey: 'llm_discoverer_extractor_fb_max_tokens' },
  { key: 'monitorA',            label: 'Monitor A',            hint: 'Slot A — primary model that reviews open positions.',     endpointKey: 'llm_monitor_a_endpoint',           maxTokensKey: 'llm_monitor_a_max_tokens',           fbEndpointKey: 'llm_monitor_a_fb_endpoint',           fbMaxTokensKey: 'llm_monitor_a_fb_max_tokens' },
  { key: 'monitorB',            label: 'Monitor B',            hint: 'Slot B — second model for the position monitor (used in B / Alternate / A+B / A+B+C modes).', endpointKey: 'llm_monitor_b_endpoint', maxTokensKey: 'llm_monitor_b_max_tokens', fbEndpointKey: 'llm_monitor_b_fb_endpoint', fbMaxTokensKey: 'llm_monitor_b_fb_max_tokens' },
  { key: 'monitorC',            label: 'Monitor C',            hint: 'Slot C — the synthesizer in A+B+C mode. Sees A and B’s verdicts and writes the final decision. Use a strong, well-reasoned model.', endpointKey: 'llm_monitor_c_endpoint', maxTokensKey: 'llm_monitor_c_max_tokens', fbEndpointKey: 'llm_monitor_c_fb_endpoint', fbMaxTokensKey: 'llm_monitor_c_fb_max_tokens' },
  { key: 'summary',             label: 'Portfolio Summary',    hint: 'Writes the scheduled portfolio briefing from holdings + Binance market data.', endpointKey: 'llm_summary_endpoint', maxTokensKey: 'llm_summary_max_tokens', fbEndpointKey: 'llm_summary_fb_endpoint', fbMaxTokensKey: 'llm_summary_fb_max_tokens' },
  { key: 'entryPlanner',        label: 'Entry Planner',        hint: 'Picks the per-coin entry band (pullback / invalidate / chase cap / TTL) for deferred BUYs. A small fast model is enough.', endpointKey: 'llm_entry_planner_endpoint', maxTokensKey: 'llm_entry_planner_max_tokens', fbEndpointKey: 'llm_entry_planner_fb_endpoint', fbMaxTokensKey: 'llm_entry_planner_fb_max_tokens' },
  { key: 'agent',               label: 'Agent',                hint: 'Conversational assistant on the Agent page. Use a tool-calling-capable model.', endpointKey: 'llm_agent_endpoint', maxTokensKey: 'llm_agent_max_tokens', fbEndpointKey: 'llm_agent_fb_endpoint', fbMaxTokensKey: 'llm_agent_fb_max_tokens' },
]

type LLMModule = typeof LLM_MODULES[number]
type SetFn = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => void

// Short label for an endpoint in the dropdowns: "Name · model" (+ a ∥ marker when
// the endpoint is flagged parallel-capable, + a disabled marker when out of rotation).
function endpointLabel(e: LLMEndpoint): string {
  let s = e.name ? `${e.name} · ${e.model}` : (e.model || e.baseURL || 'endpoint')
  if (e.maxTokens > 0) s += ` · ${e.maxTokens} tok`
  if (e.parallel) s += e.maxParallel > 0 ? ` ∥${e.maxParallel}` : ' ∥'
  if (e.disabled) s += ' · disabled'
  return s
}

// A catalog-backed endpoint picker. `value` is the selected endpoint id; an empty
// id selects the first option (`emptyLabel`). If the stored id no longer matches a
// catalog entry (endpoint deleted), a disabled placeholder keeps it visible so the
// stale selection is obvious rather than silently snapping to the default.
function EndpointSelect({ value, onChange, endpoints, emptyLabel, ariaLabel }: {
  value: string
  onChange: (v: string) => void
  endpoints: LLMEndpoint[]
  emptyLabel: string
  ariaLabel: string
}) {
  const missing = !!value && !endpoints.some(e => e.id === value)
  return (
    <Select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="text-xs"
    >
      <option value="">{emptyLabel}</option>
      {endpoints.map(e => (
        <option key={e.id} value={e.id}>{endpointLabel(e)}</option>
      ))}
      {missing && <option value={value} disabled>⚠ deleted endpoint</option>}
    </Select>
  )
}

// One row in the LLM Models section: a primary endpoint picker + max-tokens, plus a
// collapsible "failover" block. The fallback only fires when the primary call
// throws, so it's a subordinate, opt-in panel — auto-expanded when already
// configured, with a live status dot so an active fallback reads at a glance.
function LLMModuleRow({ m, settings, set, def, endpoints, onManage }: {
  m: LLMModule
  settings: SettingsData
  set: SetFn
  def?: { model: string; baseURL: string; maxTokens: number }
  endpoints: LLMEndpoint[]
  onManage: () => void
}) {
  const maxTokens = settings[m.maxTokensKey] as number
  const fbEndpoint = (settings[m.fbEndpointKey] as string) ?? ''
  const fbMaxTokens = settings[m.fbMaxTokensKey] as number
  const fbActive = !!fbEndpoint && endpoints.some(e => e.id === fbEndpoint)
  const [open, setOpen] = useState(fbActive)

  // The env-var default the module uses when no endpoint is picked.
  const envLabel = def ? `Env default · ${def.model}` : 'Env default'

  // What a blank max-tokens field resolves to: the selected endpoint's own default
  // if set, else the env default. Mirrors resolveMaxTokens() on the backend so the
  // placeholder honestly previews the effective budget.
  const selectedEp = endpoints.find(e => e.id === (settings[m.endpointKey] as string))
  // Selected primary is disabled in the catalog → the backend treats it as offline
  // and routes to the fallback (or the env default when none is configured).
  const primaryDisabled = !!selectedEp?.disabled
  const primaryDefaultTokens = (selectedEp?.maxTokens && selectedEp.maxTokens > 0)
    ? selectedEp.maxTokens
    : def?.maxTokens
  const primaryEffectiveTokens = maxTokens > 0 ? maxTokens : primaryDefaultTokens
  const fbEp = endpoints.find(e => e.id === fbEndpoint)
  const fbDefaultTokens = (fbEp?.maxTokens && fbEp.maxTokens > 0)
    ? fbEp.maxTokens
    : primaryEffectiveTokens

  function clearFallback() {
    set(m.fbEndpointKey, '' as SettingsData[typeof m.fbEndpointKey])
    set(m.fbMaxTokensKey, 0 as SettingsData[typeof m.fbMaxTokensKey])
  }

  // No endpoints defined yet — nudge the user to the catalog modal instead of
  // showing an empty dropdown.
  if (endpoints.length === 0) {
    return (
      <Row label={m.label} hint={m.hint} stacked>
        <button
          type="button"
          onClick={onManage}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted transition-colors hover:border-accent/40 hover:text-foreground"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add an endpoint to assign — falls back to {def ? def.model : 'the env default'} until then
        </button>
      </Row>
    )
  }

  return (
    <Row label={m.label} hint={m.hint} stacked>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px]">
        <EndpointSelect
          value={settings[m.endpointKey] as string}
          onChange={v => set(m.endpointKey, v as SettingsData[typeof m.endpointKey])}
          endpoints={endpoints}
          emptyLabel={envLabel}
          ariaLabel={`${m.label} endpoint`}
        />
        <UnitInput
          type="number"
          min="0"
          step="256"
          unit="tok"
          value={maxTokens || ''}
          onChange={e => set(m.maxTokensKey, (parseInt(e.target.value) || 0) as SettingsData[typeof m.maxTokensKey])}
          placeholder={primaryDefaultTokens ? `${primaryDefaultTokens}` : 'max'}
          className="font-mono text-xs"
          aria-label={`${m.label} max tokens`}
        />
      </div>

      {primaryDisabled && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          <svg className="mt-px h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            This endpoint is disabled — calls route to {fbActive ? 'the fallback below' : 'the env default'}.
          </span>
        </div>
      )}

      {/* Failover disclosure */}
      <div className="mt-1.5">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="group flex items-center gap-2 text-xs text-muted transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          <svg
            className={cn('h-3 w-3 shrink-0 transition-transform duration-150', open && 'rotate-90')}
            fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-medium">Fallback</span>
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full transition-colors',
              fbActive ? 'bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15' : 'bg-border',
            )}
            aria-hidden
          />
          <span className={cn('text-[11px]', fbActive ? 'text-emerald-500' : 'text-muted/70')}>
            {fbActive ? 'active' : 'off'}
          </span>
        </button>

        {open && (
          <div className="mt-2 space-y-2 rounded-lg border border-border/60 border-l-2 border-l-accent/50 bg-surface-elevated/40 p-3">
            <p className="text-[11px] leading-relaxed text-muted">
              Used only if the primary call fails (endpoint down, timeout, 5xx, unknown model).
              Pick an endpoint to enable failover.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px]">
              <EndpointSelect
                value={fbEndpoint}
                onChange={v => set(m.fbEndpointKey, v as SettingsData[typeof m.fbEndpointKey])}
                endpoints={endpoints}
                emptyLabel="No fallback"
                ariaLabel={`${m.label} fallback endpoint`}
              />
              <UnitInput
                type="number"
                min="0"
                step="256"
                unit="tok"
                value={fbMaxTokens || ''}
                onChange={e => set(m.fbMaxTokensKey, (parseInt(e.target.value) || 0) as SettingsData[typeof m.fbMaxTokensKey])}
                placeholder={fbDefaultTokens ? `${fbDefaultTokens}` : 'max'}
                className="font-mono text-xs"
                aria-label={`${m.label} fallback max tokens`}
              />
            </div>
            {fbActive && (
              <button
                type="button"
                onClick={clearFallback}
                className="text-[11px] text-muted underline-offset-2 transition-colors hover:text-danger hover:underline"
              >
                Clear fallback
              </button>
            )}
          </div>
        )}
      </div>
    </Row>
  )
}

// Modal that manages the shared endpoint catalog: add / edit / delete named
// {URL, model, parallel} entries that the module dropdowns select from. Edits flow
// straight to the parent's settings state via `onChange`, so they join the dirty
// diff and persist with the main Save button (like the watchlist).
function EndpointModal({ open, onClose, endpoints, onChange, usage }: {
  open: boolean
  onClose: () => void
  endpoints: LLMEndpoint[]
  onChange: (next: LLMEndpoint[]) => void
  usage: (id: string) => string[]
}) {
  useEffect(() => {
    if (!open) return
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  function update(id: string, patch: Partial<LLMEndpoint>) {
    onChange(endpoints.map(e => e.id === id ? { ...e, ...patch } : e))
  }
  function add() {
    const id = (crypto.randomUUID?.() ?? `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    onChange([...endpoints, { id, name: '', baseURL: '', model: '', maxTokens: 0, parallel: false, maxParallel: 0, disabled: false }])
  }
  function remove(id: string) {
    onChange(endpoints.filter(e => e.id !== id))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-surface-card shadow-2xl neon-border animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-5">
          <div>
            <h2 className="text-base font-semibold text-foreground">LLM Endpoints</h2>
            <p className="mt-0.5 text-xs text-muted">Define each URL + model once; modules pick from these.</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-elevated hover:text-foreground"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {endpoints.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted">
              No endpoints yet. Add one to start assigning models to modules.
            </div>
          )}

          {endpoints.map(ep => {
            const used = usage(ep.id)
            const incomplete = !ep.baseURL.trim() || !ep.model.trim()
            const isDisabled = ep.disabled
            return (
              <div
                key={ep.id}
                className={cn(
                  'space-y-3 rounded-xl border p-4',
                  isDisabled ? 'border-dashed border-border bg-surface-elevated/20' : 'border-border bg-surface-elevated/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={ep.name}
                    onChange={e => update(ep.id, { name: e.target.value })}
                    placeholder="Name (e.g. Local Ollama)"
                    className="flex-1 text-sm"
                    aria-label="Endpoint name"
                  />
                  {isDisabled && (
                    <span className="shrink-0 rounded-md bg-surface-elevated px-2 py-0.5 text-[11px] font-medium text-muted">
                      Disabled
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(ep.id)}
                    className="shrink-0 rounded-lg p-2 text-muted transition-colors hover:bg-sell/10 hover:text-sell"
                    aria-label="Delete endpoint"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>

                <div className={cn('grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_120px]', isDisabled && 'opacity-50')}>
                  <Input
                    type="text"
                    value={ep.baseURL}
                    onChange={e => update(ep.id, { baseURL: e.target.value })}
                    placeholder="Base URL (http://localhost:11434/v1)"
                    className="font-mono text-xs"
                    aria-label="Endpoint base URL"
                  />
                  <Input
                    type="text"
                    value={ep.model}
                    onChange={e => update(ep.id, { model: e.target.value })}
                    placeholder="Model (qwen2.5:14b)"
                    className="font-mono text-xs"
                    aria-label="Endpoint model"
                  />
                  <UnitInput
                    type="number"
                    min="0"
                    step="256"
                    unit="tok"
                    value={ep.maxTokens || ''}
                    onChange={e => update(ep.id, { maxTokens: parseInt(e.target.value) || 0 })}
                    placeholder="default"
                    className="font-mono text-xs"
                    aria-label="Endpoint default max tokens"
                  />
                </div>

                <div className={cn('flex flex-wrap items-center justify-between gap-3', isDisabled && 'opacity-50')}>
                  <div className="flex items-center gap-2.5">
                    <Toggle
                      label="Allow parallel calls"
                      checked={ep.parallel}
                      onChange={() => update(ep.id, { parallel: !ep.parallel })}
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">Run in parallel</p>
                      <p className="text-[11px] leading-tight text-muted">Skip the per-URL queue even when serialization is on.</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ep.parallel && (
                      <label className="flex items-center gap-1.5 text-[11px] text-muted">
                        Max concurrent
                        <UnitInput
                          type="number"
                          min="0"
                          step="1"
                          unit="∥"
                          value={ep.maxParallel || ''}
                          onChange={e => update(ep.id, { maxParallel: parseInt(e.target.value) || 0 })}
                          placeholder="∞"
                          className="w-20 font-mono text-xs"
                          aria-label="Max concurrent calls"
                        />
                      </label>
                    )}
                    {incomplete && (
                      <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500">Incomplete</span>
                    )}
                    {used.length > 0 && (
                      <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[11px] text-accent" title={used.join(', ')}>
                        Used by {used.length} {used.length === 1 ? 'module' : 'modules'}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2.5 border-t border-border pt-3">
                  <Toggle
                    label="Disable endpoint"
                    danger
                    checked={isDisabled}
                    onChange={() => update(ep.id, { disabled: !isDisabled })}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">Disable (take out of rotation)</p>
                    <p className="text-[11px] leading-tight text-muted">
                      {isDisabled
                        ? used.length > 0
                          ? `Treated as offline — ${used.length === 1 ? 'the module' : 'modules'} using it route to their failover.`
                          : 'Treated as offline. Modules selecting it route to their failover.'
                        : 'Stop sending it traffic without deleting it or re-pointing modules.'}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}

          <button
            type="button"
            onClick={add}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-sm text-muted transition-colors hover:border-accent/40 hover:text-foreground"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add endpoint
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <p className="text-[11px] text-muted">Changes save with the page's Save button.</p>
          <Button variant="primary" size="md" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------- Page ------------------------------------- */

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [baseline, setBaseline] = useState<SettingsData | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('trading')
  const [monitorModels, setMonitorModels] = useState<MonitorModelsResponse | null>(null)
  const [llmDefaults, setLlmDefaults] = useState<LLMDefaults | null>(null)
  const [endpointModalOpen, setEndpointModalOpen] = useState(false)
  const { theme, setTheme } = useTheme()
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((data: SettingsData) => {
        setSettings(data)
        setBaseline(data)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/monitor/models')
      .then(r => r.json())
      .then((data: MonitorModelsResponse) => setMonitorModels(data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/llm/defaults')
      .then(r => r.json())
      .then((data: LLMDefaults) => setLlmDefaults(data))
      .catch(() => {})
  }, [])

  // Scroll-spy for the section nav
  useEffect(() => {
    if (!settings) return
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) {
          setActiveSection(visible[0].target.id.replace('section-', '') as SectionId)
        }
      },
      { rootMargin: '-10% 0px -75% 0px' },
    )
    SECTIONS.forEach(s => {
      const el = document.getElementById(`section-${s.id}`)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [settings])

  const dirty = !!settings && !!baseline && JSON.stringify(settings) !== JSON.stringify(baseline)

  function set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    setSettings(s => s ? { ...s, [key]: value } : s)
    setSaved(false)
  }

  // Toggles save immediately and don't mark the form dirty
  async function toggle(key: keyof SettingsData & ('approval_required' | 'monitor_auto_run' | 'monitor_adjust_sltp' | 'monitor_reduce_enabled' | 'monitor_auto_approve' | 'monitor_trust_llm_sltp' | 'monitor_use_horizon' | 'entry_timing_enabled' | 'entry_planner_enabled' | 'llm_allow_parallel_same_url' | 'summary_auto_run' | 'telegram_notify_enabled' | 'telegram_notify_startup' | 'telegram_notify_position_opened' | 'telegram_notify_position_closed' | 'telegram_notify_sl_tp_adjusted' | 'telegram_notify_monitor_disagreement' | 'telegram_notify_portfolio' | 'telegram_notify_summary' | 'telegram_notify_discovery' | 'telegram_notify_trade_failed' | 'telegram_notify_errors' | 'telegram_notify_update' | 'update_enabled')) {
    if (!settings) return
    const next = !settings[key]
    setSettings(s => s ? { ...s, [key]: next } : s)
    setBaseline(b => b ? { ...b, [key]: next } : b)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: next }),
    }).catch(() => {})
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!settings) return
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      setBaseline(settings)
      setSaved(true)
      clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    if (baseline) setSettings(baseline)
  }

  function scrollToSection(id: SectionId) {
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex gap-8 max-w-5xl animate-fade-in">

      {/* Section nav */}
      <nav className="hidden lg:block w-48 shrink-0 sticky top-0 self-start pt-1">
        <ul className="space-y-0.5">
          {SECTIONS.map(s => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => scrollToSection(s.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all duration-150 text-left',
                  activeSection === s.id
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                )}
              >
                <SectionIcon path={s.icon} className="h-4 w-4 shrink-0" />
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Settings form */}
      <form onSubmit={save} className="flex-1 min-w-0 space-y-6 pb-24">

        {/* Trading */}
        <Section id="trading" title="Trading" subtitle="Core bot behavior" icon={SECTIONS[0].icon}>
          <Row
            stacked
            label="Trading horizon"
            hint="Trade thesis for new positions — sets stop-loss / take-profit sizing and how aggressively the monitor manages the position. Auto: sized purely off ATR. LLM: the analyst picks short/medium/long per trade. Short/Medium/Long: forced on every trade. The horizon stays editable per position afterward."
          >
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {HORIZONS.map(({ id, label, hint }) => {
                const active = settings.default_horizon === id
                const colors = HORIZON_COLORS[id]
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => set('default_horizon', id)}
                    className={cn(
                      'flex flex-col items-center gap-1 px-3 py-3 rounded-xl border text-sm font-semibold transition-all duration-150',
                      active ? colors.active : colors.idle,
                    )}
                  >
                    {label}
                    <span className="text-[10px] font-normal opacity-70">{hint}</span>
                  </button>
                )
              })}
            </div>
          </Row>

          <Row stacked label="Watchlist" hint="Coins the pipeline researches and trades. Press Enter or comma to add.">
            <WatchlistEditor value={settings.watchlist} onChange={v => set('watchlist', v)} />
          </Row>

          <Row stacked label="Pipeline schedule" hint="How often the research → analysis → trade pipeline runs.">
            <CronEditor value={settings.pipeline_cron} onChange={v => set('pipeline_cron', v)} />
          </Row>

          <Row label="Analyst price history" hint="Candle timeframe and count fed to the analyst (BUY/SELL/HOLD) prompt as price-action context alongside the indicators. Set count to 0 to omit the table.">
            <div className="flex items-center gap-2">
              <select
                value={settings.analyst_candle_tf}
                onChange={e => set('analyst_candle_tf', e.target.value)}
                className="text-sm bg-surface-elevated border border-border rounded-xl px-2.5 py-2 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
              >
                {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
              <span className="text-xs text-muted">×</span>
              <UnitInput
                type="number"
                step="1"
                min="0"
                max="100"
                unit="candles"
                value={settings.analyst_candle_count}
                onChange={e => set('analyst_candle_count', parseInt(e.target.value) || 0)}
                className="w-28"
              />
            </div>
          </Row>

          <Row
            label="UTC offset"
            hint="Applied to all timestamps in the monitor prompt — e.g. 5 for UTC+5, -3 for UTC-3, 5.5 for UTC+5:30"
          >
            <UnitInput
              type="number"
              step="0.5"
              min="-12"
              max="14"
              unit="hrs"
              value={settings.utc_offset_hours}
              onChange={e => set('utc_offset_hours', parseFloat(e.target.value) || 0)}
            />
          </Row>

          <Row label="Article cache TTL" hint="Hours before a cached article extraction expires">
            <UnitInput type="number" step="1" min="1" max="168" unit="hrs" value={settings.cache_ttl_hours} onChange={e => set('cache_ttl_hours', parseInt(e.target.value) || 13)} />
          </Row>

          <Row label="Require approval" hint="Pause for human approval before executing trades">
            <Toggle label="Require approval" checked={settings.approval_required} onChange={() => toggle('approval_required')} />
          </Row>
        </Section>

        {/* Entry Timing */}
        <Section id="entry" title="Entry Timing" subtitle="Wait for a good price before filling a BUY, instead of buying at the cron tick" icon={SECTIONS[1].icon}>
          <Row label="Smart entry timing" hint="When on, a BUY signal becomes a pending intent: the bot watches the live price and fills on a pullback (or in-band) instead of buying wherever price sits at the cron tick. Turn off to fill immediately (legacy behavior).">
            <Toggle label="Smart entry timing" checked={settings.entry_timing_enabled} onChange={() => toggle('entry_timing_enabled')} />
          </Row>

          {settings.entry_timing_enabled && (
            <>
              <Row
                label="LLM-decided entry levels"
                hint="When on, the Entry Planner LLM picks the pullback, invalidate, chase-cap and lifetime per coin from live market data + the analyst's thesis — so the entry window fits each setup. The values below become the fallback used if the planner is off or its call fails. Configure its model under LLM Models → Entry Planner."
              >
                <Toggle label="LLM-decided entry levels" checked={settings.entry_planner_enabled} onChange={() => toggle('entry_planner_enabled')} />
              </Row>

              {settings.entry_planner_enabled && (
                <div className="flex items-start gap-2.5 rounded-xl border border-accent/25 bg-accent/5 px-3.5 py-3 text-xs text-muted leading-relaxed">
                  <svg className="h-4 w-4 shrink-0 mt-0.5 text-accent" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>
                    The <span className="font-medium text-foreground">Entry Planner</span> chooses these four levels per coin. The values below are used only as a
                    <span className="font-medium text-foreground"> fallback</span> when the planner is disabled or unavailable. Each pick is logged to LLM Debug and shown on the Entry Desk.
                  </span>
                </div>
              )}

              {settings.entry_planner_enabled && (
                <Row label="Price history" hint="Candle timeframe and count fed to the Entry Planner as price-action context so it can anchor the band on recent swing lows and ranges. A shorter timeframe than the monitor's suits entry timing, since the band fires within minutes.">
                  <div className="flex items-center gap-2">
                    <select
                      value={settings.entry_planner_candle_tf}
                      onChange={e => set('entry_planner_candle_tf', e.target.value)}
                      className="text-sm bg-surface-elevated border border-border rounded-xl px-2.5 py-2 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
                    >
                      {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                        <option key={tf} value={tf}>{tf}</option>
                      ))}
                    </select>
                    <span className="text-xs text-muted">×</span>
                    <UnitInput
                      type="number"
                      step="1"
                      min="1"
                      max="100"
                      unit="candles"
                      value={settings.entry_planner_candle_count}
                      onChange={e => set('entry_planner_candle_count', parseInt(e.target.value) || 24)}
                      className="w-28"
                    />
                  </div>
                </Row>
              )}

              <Row
                label={settings.entry_planner_enabled ? 'Pullback target (fallback)' : 'Pullback target'}
                hint="Aim to buy this % below the signal price (the dip). Fires as soon as price reaches the target."
              >
                <UnitInput type="number" step="0.1" min="0" max="10" unit="%" value={settings.entry_pullback_pct} onChange={e => set('entry_pullback_pct', parseFloat(e.target.value) || 0)} />
              </Row>
              <Row
                label={settings.entry_planner_enabled ? 'Invalidate / falling knife (fallback)' : 'Invalidate (falling knife)'}
                hint="Abandon the intent if price drops this % below the signal price before filling — likely a breakdown, not a dip."
              >
                <UnitInput type="number" step="0.5" min="0.5" max="50" unit="%" value={settings.entry_invalidate_pct} onChange={e => set('entry_invalidate_pct', parseFloat(e.target.value) || 0)} />
              </Row>
              <Row
                label={settings.entry_planner_enabled ? 'Chase cap (fallback)' : 'Chase cap'}
                hint="Abandon the intent if price runs this % above the signal price — the move got away; wait for the next cycle rather than chasing."
              >
                <UnitInput type="number" step="0.5" min="0.5" max="50" unit="%" value={settings.entry_max_chase_pct} onChange={e => set('entry_max_chase_pct', parseFloat(e.target.value) || 0)} />
              </Row>
              <Row
                label={settings.entry_planner_enabled ? 'Intent lifetime (fallback)' : 'Intent lifetime'}
                hint="How long to wait for a good entry before the intent expires."
              >
                <UnitInput type="number" step="1" min="1" max="240" unit="min" value={settings.entry_ttl_minutes} onChange={e => set('entry_ttl_minutes', parseFloat(e.target.value) || 0)} />
              </Row>
              <Row label="On expiry" hint="When the intent expires still in-band: fill at market so you don't keep missing valid setups, or cancel and wait for a fresh signal.">
                <select
                  value={settings.entry_on_expiry}
                  onChange={e => set('entry_on_expiry', e.target.value as 'market' | 'cancel')}
                  className="w-full text-sm bg-surface-elevated border border-border rounded-xl px-2.5 py-2 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
                >
                  <option value="market">Fill at market</option>
                  <option value="cancel">Cancel</option>
                </select>
              </Row>
              <Row label="Price check interval" hint="How often the engine re-checks the live price against pending intents.">
                <UnitInput type="number" step="1" min="1" max="60" unit="sec" value={settings.entry_poll_seconds} onChange={e => set('entry_poll_seconds', parseFloat(e.target.value) || 0)} />
              </Row>
            </>
          )}
        </Section>

        {/* Risk */}
        <Section id="risk" title="Risk Management" subtitle="Position sizing and protection levels" icon={SECTIONS[2].icon}>
          <Row label="Min confidence" hint="Skip signals below this threshold (0–1)">
            <Input type="number" step="0.05" min="0" max="1" value={settings.min_confidence} onChange={e => set('min_confidence', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row label="Max position size" hint="Maximum dollar amount per trade">
            <UnitInput type="number" min="0" unit="$" value={settings.max_position_size_usd} onChange={e => set('max_position_size_usd', parseInt(e.target.value) || 0)} />
          </Row>
          <Row label="Risk per trade" hint="Fraction of portfolio at risk (0–1)">
            <Input type="number" step="0.01" min="0" max="1" value={settings.max_risk_per_trade} onChange={e => set('max_risk_per_trade', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row label="Max open positions">
            <Input type="number" step="1" min="1" value={settings.max_open_positions} onChange={e => set('max_open_positions', parseInt(e.target.value) || 0)} />
          </Row>
          <Row label="Min order size" hint="Skip BUY if the calculated order is below this USDC amount (also skips when available balance is below this threshold)">
            <UnitInput type="number" step="1" min="0" unit="$" value={settings.min_trade_usdc} onChange={e => set('min_trade_usdc', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row label="Exchange fee rate" hint="Taker fee per side as a fraction (0.001 = 0.1%). Used for fee-aware PnL, break-even checks and the minimum-edge gate on new BUYs.">
            <Input type="number" step="0.0001" min="0" max="0.01" value={settings.fee_rate} onChange={e => set('fee_rate', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row label="Stop loss" hint="Stop loss distance in ATR multiples">
            <UnitInput type="number" step="0.1" min="0" unit="× ATR" value={settings.stop_loss_atr} onChange={e => set('stop_loss_atr', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row label="Take profit" hint="Take profit distance in ATR multiples">
            <UnitInput type="number" step="0.1" min="0" unit="× ATR" value={settings.take_profit_atr} onChange={e => set('take_profit_atr', parseFloat(e.target.value) || 0)} />
          </Row>
        </Section>

        {/* Position Monitor */}
        <Section id="monitor" title="Position Monitor" subtitle="Automatically review open positions on a schedule" icon={SECTIONS[3].icon}>
          <Row
            stacked
            label="Monitor model"
            hint="Which LLM(s) review open positions. Configure each slot (model, endpoint, max tokens) in the LLM Models section below. Single modes run one model; Alternate flips A/B each cycle; A+B runs both and keeps the higher-confidence verdict; A+B+C adds model C to synthesize the final decision from A and B."
          >
            {(() => {
              const mode = settings.monitor_model
              // Role of a slot under the current mode → drives its highlight + badge.
              const slotRole = (slot: 'a' | 'b' | 'c'): { active: boolean; badge: string } => {
                if (slot === 'c') return { active: mode === 'abc', badge: 'Synthesizer' }
                if (mode === slot) return { active: true, badge: 'Active' }
                if (mode === 'alternate') return { active: true, badge: 'In rotation' }
                if (mode === 'ab' || mode === 'abc') return { active: true, badge: 'Voter' }
                return { active: false, badge: '' }
              }
              // A/B are clickable (selects that single-model mode); C is informational.
              const renderSlot = (slot: 'a' | 'b' | 'c') => {
                const info = monitorModels?.[slot]
                const { active, badge } = slotRole(slot)
                const selectable = slot !== 'c'
                return (
                  <button
                    key={slot}
                    type="button"
                    disabled={!selectable}
                    onClick={selectable ? () => set('monitor_model', slot) : undefined}
                    className={cn(
                      'flex flex-col items-start gap-1.5 px-3.5 py-3 rounded-xl border text-left transition-all duration-150',
                      active ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20' : 'border-border',
                      selectable && !active && 'hover:border-foreground/20',
                      !selectable && 'cursor-default',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 w-full">
                      <span className={cn(
                        'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded',
                        active ? 'bg-accent/20 text-accent' : 'bg-surface-elevated text-muted',
                      )}>
                        {`Slot ${slot.toUpperCase()}`}
                      </span>
                      {active && badge && (
                        <span className="text-[10px] font-semibold text-accent shrink-0">{badge}</span>
                      )}
                    </div>
                    <span className={cn(
                      'text-sm font-medium font-mono truncate w-full',
                      active ? 'text-foreground' : 'text-muted',
                    )}>
                      {info?.model ?? '—'}
                    </span>
                    {info?.baseURL && (
                      <span className="text-[10px] text-muted truncate w-full" title={info.baseURL}>{info.baseURL}</span>
                    )}
                  </button>
                )
              }
              const modePills: { key: 'alternate' | 'ab' | 'abc'; badge: string; title: string; sub: string }[] = [
                { key: 'alternate', badge: 'Alternate', title: 'A ⇄ B each cycle', sub: 'one model per run, flips on the next' },
                { key: 'ab', badge: 'A + B', title: 'Both run · higher-confidence wins', sub: 'A and B review every position; the more confident verdict is kept' },
                { key: 'abc', badge: 'A + B + C', title: 'C synthesizes A + B', sub: 'A and B vote, then C weighs both and writes the final call' },
              ]
              return (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {renderSlot('a')}
                    {renderSlot('b')}
                  </div>
                  {mode === 'abc' && (
                    <div className="mt-2">{renderSlot('c')}</div>
                  )}
                  <div className="mt-2 flex flex-col gap-2">
                    {modePills.map(p => {
                      const on = mode === p.key
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => set('monitor_model', p.key)}
                          className={cn(
                            'flex items-center justify-between gap-2 w-full px-3.5 py-3 rounded-xl border text-left transition-all duration-150',
                            on ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20' : 'border-border hover:border-foreground/20',
                          )}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className={cn(
                              'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
                              on ? 'bg-accent/20 text-accent' : 'bg-surface-elevated text-muted',
                            )}>
                              {p.badge}
                            </span>
                            <span className="text-sm font-medium text-foreground shrink-0">{p.title}</span>
                            <span className="text-[10px] text-muted hidden md:inline truncate">{p.sub}</span>
                          </div>
                          {on && (
                            <svg className="w-3.5 h-3.5 text-accent shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </>
              )
            })()}
          </Row>

          <Row label="Auto-run" hint="Periodically run the monitor to check positions">
            <Toggle label="Auto-run monitor" checked={settings.monitor_auto_run} onChange={() => toggle('monitor_auto_run')} />
          </Row>

          {settings.monitor_auto_run && (
            <Row stacked label="Monitor schedule" hint="How often the monitor reviews open positions.">
              <CronEditor value={settings.monitor_cron} onChange={v => set('monitor_cron', v)} />
            </Row>
          )}

          <Row label="Adapt SL/TP" hint="Let the monitor LLM tighten stops / adjust take-profit on open positions (risk-checked)">
            <Toggle label="Adapt SL/TP" checked={settings.monitor_adjust_sltp} onChange={() => toggle('monitor_adjust_sltp')} />
          </Row>

          <Row label="Partial exits (REDUCE)" hint="Allow the monitor to sell part of a position to lock in gains or de-risk. When off, REDUCE is removed from the prompt and never executed (the monitor uses CLOSE / ADJUST only).">
            <Toggle label="Partial exits (REDUCE)" checked={settings.monitor_reduce_enabled} onChange={() => toggle('monitor_reduce_enabled')} />
          </Row>

          {settings.monitor_adjust_sltp && (
            <Row label="Auto-approve adjustments" hint="Apply SL/TP changes immediately without waiting for manual approval, even when approval mode is on">
              <Toggle label="Auto-approve adjustments" checked={settings.monitor_auto_approve} onChange={() => toggle('monitor_auto_approve')} />
            </Row>
          )}

          {settings.monitor_adjust_sltp && (
            <Row label="Trust LLM SL/TP" hint="Bypass risk validation — apply the monitor LLM's SL/TP values directly (only SL < price / TP > price enforced). Use with care: loosening stops is allowed.">
              <Toggle danger label="Trust LLM SL/TP" checked={settings.monitor_trust_llm_sltp} onChange={() => toggle('monitor_trust_llm_sltp')} />
            </Row>
          )}

          <Row label="Horizon guidance" hint="Inject per-horizon behavior rules and SL/TP targets into the monitor prompt. Disable to let the LLM decide freely.">
            <Toggle label="Horizon guidance" checked={settings.monitor_use_horizon} onChange={() => toggle('monitor_use_horizon')} />
          </Row>

          <Row label="Price history" hint="Candle timeframe and number of candles included in the monitor LLM prompt as market context.">
            <div className="flex items-center gap-2">
              <select
                value={settings.monitor_history_tf}
                onChange={e => set('monitor_history_tf', e.target.value)}
                className="text-sm bg-surface-elevated border border-border rounded-xl px-2.5 py-2 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
              >
                {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
              <span className="text-xs text-muted">×</span>
              <UnitInput
                type="number"
                step="1"
                min="1"
                max="100"
                unit="candles"
                value={settings.monitor_history_count}
                onChange={e => set('monitor_history_count', parseInt(e.target.value) || 24)}
                className="w-28"
              />
            </div>
          </Row>

          <Row label="Min confidence to sell" hint="Minimum LLM confidence (0–1) required to execute a monitor CLOSE or REDUCE. Lower-confidence proposals are recorded as HOLD instead.">
            <Input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={settings.monitor_min_confidence}
              onChange={e => set('monitor_min_confidence', parseFloat(e.target.value) || 0)}
            />
          </Row>

          <Row label="Break-even trigger" hint="Once a position's P&L passes this %, the monitor LLM must move the stop-loss to break-even or better (profit protection). Below it, break-even stops are rejected by the engine. Used when horizon guidance is off or the position has the LLM horizon; with horizon guidance on, the trigger is half the horizon's TP target.">
            <UnitInput
              type="number"
              step="0.5"
              min="0.5"
              max="50"
              unit="%"
              value={settings.monitor_breakeven_pct}
              onChange={e => set('monitor_breakeven_pct', parseFloat(e.target.value) || 0)}
            />
          </Row>

          {settings.monitor_adjust_sltp && (
            <Row label="Adjustment cooldown" hint="Minimum minutes between applied SL/TP adjustments per position (halved for short horizon, doubled for long). Prevents the monitor from re-trailing the stop every review. 0 disables.">
              <UnitInput
                type="number"
                step="5"
                min="0"
                max="1440"
                unit="min"
                value={settings.monitor_adjust_cooldown_min}
                onChange={e => set('monitor_adjust_cooldown_min', parseFloat(e.target.value) || 0)}
              />
            </Row>
          )}

          {settings.monitor_use_horizon && (
            <Row
              stacked
              label="Horizon SL/TP targets"
              hint="Stop-loss and take-profit percentages from entry price the monitor LLM uses as guidance per investment horizon."
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(['short', 'medium', 'long'] as const).map(h => {
                  const slKey = `monitor_sl_pct_${h}` as keyof SettingsData
                  const tpKey = `monitor_tp_pct_${h}` as keyof SettingsData
                  return (
                    <div key={h} className="bg-surface-elevated border border-border rounded-xl p-3.5 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-1.5 w-1.5 rounded-full', HORIZON_COLORS[h].dot)} />
                        <p className={cn(
                          'text-xs font-semibold uppercase tracking-wide',
                          h === 'short' ? 'text-sell' : h === 'medium' ? 'text-accent' : 'text-buy',
                        )}>
                          {h}
                        </p>
                      </div>
                      <div>
                        <label className="text-xs text-muted mb-1.5 block">Stop loss</label>
                        <UnitInput
                          type="number"
                          step="0.5"
                          min="0.5"
                          max="50"
                          unit="%"
                          value={settings[slKey] as number}
                          onChange={e => set(slKey, parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted mb-1.5 block">Take profit</label>
                        <UnitInput
                          type="number"
                          step="0.5"
                          min="0.5"
                          max="200"
                          unit="%"
                          value={settings[tpKey] as number}
                          onChange={e => set(tpKey, parseFloat(e.target.value) || 0)}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Row>
          )}
        </Section>

        {/* Portfolio Summary */}
        <Section id="summary" title="Portfolio Summary" subtitle="LLM briefing of the whole portfolio on a schedule" icon={SECTIONS[4].icon}>
          <Row label="Auto-run" hint="Periodically generate a portfolio summary (narrative + health/risk read + suggestions) from your holdings and live Binance market data. Configure the model in the LLM Models section below.">
            <Toggle label="Auto-run summary" checked={settings.summary_auto_run} onChange={() => toggle('summary_auto_run')} />
          </Row>

          {settings.summary_auto_run && (
            <Row stacked label="Summary schedule" hint="How often the portfolio summary is generated.">
              <CronEditor value={settings.summary_cron} onChange={v => set('summary_cron', v)} />
            </Row>
          )}

          <Row label="Retain summaries" hint="Delete portfolio summaries older than this many days. 0 = keep forever.">
            <UnitInput
              type="number"
              step="1"
              min="0"
              max="3650"
              unit="days"
              value={settings.summary_retain_days}
              onChange={e => set('summary_retain_days', parseInt(e.target.value) || 0)}
            />
          </Row>
        </Section>

        {/* LLM Models */}
        <Section id="models" title="LLM Models" subtitle="Define your endpoints once, then assign one to each module. Leave a module on “Env default” (or max tokens 0) to use the env-var config. Add a Fallback to keep a module running if its primary endpoint goes down." icon={SECTIONS[5].icon}>
          <Row
            label="Endpoint catalog"
            hint={`Your reusable URL + model entries. ${settings.llm_endpoints.length} defined.`}
          >
            <Button type="button" variant="secondary" size="sm" onClick={() => setEndpointModalOpen(true)}>
              Manage endpoints
            </Button>
          </Row>
          <Row
            label="Parallel calls per endpoint"
            hint="Off (recommended): calls to the same base URL queue and run one at a time — best for a local server that handles one request at a time. On: allow concurrent calls to the same endpoint. An endpoint flagged “Run in parallel” in the catalog bypasses the queue even when this is off. Different endpoints always run in parallel either way."
          >
            <Toggle
              label="Allow parallel same-endpoint calls"
              checked={settings.llm_allow_parallel_same_url}
              onChange={() => toggle('llm_allow_parallel_same_url')}
            />
          </Row>
          {LLM_MODULES.map(m => (
            <LLMModuleRow
              key={m.key}
              m={m}
              settings={settings}
              set={set}
              def={llmDefaults?.[m.key]}
              endpoints={settings.llm_endpoints}
              onManage={() => setEndpointModalOpen(true)}
            />
          ))}
        </Section>

        {/* Agent */}
        <Section id="agent" title="Agent" subtitle="The conversational assistant on the Agent page" icon={SECTIONS[6].icon}>
          <Row
            label="Auto-title context"
            hint="Conversations are auto-named by the Agent model, refreshed as the chat grows. To keep that cheap, only this many of the most recent messages are summarized for the title — lower uses fewer tokens, higher captures more context. The Agent model & endpoint are configured under LLM Models."
          >
            <UnitInput
              type="number"
              step="1"
              min="2"
              max="40"
              unit="messages"
              value={settings.agent_title_context_messages}
              onChange={e => set('agent_title_context_messages', parseInt(e.target.value) || 6)}
            />
          </Row>
        </Section>

        {/* Appearance */}
        <Section id="appearance" title="Appearance" subtitle="Visual theme" icon={SECTIONS[7].icon}>
          <div className="py-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {THEMES.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                className={cn(
                  'flex items-center gap-3 px-4 py-3 rounded-xl border text-sm transition-all duration-150',
                  theme === t.id
                    ? 'border-accent/40 bg-accent/5 text-foreground ring-1 ring-accent/20'
                    : 'border-border bg-surface-elevated text-muted hover:bg-surface-hover',
                )}
              >
                <span
                  className="w-7 h-7 rounded-lg shrink-0 border border-border/60 flex items-center justify-center"
                  style={{ background: t.bg }}
                >
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: t.swatch }} />
                </span>
                <span className="flex-1 text-left font-medium">{t.label}</span>
                {theme === t.id && (
                  <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </Section>

        {/* LLM Data */}
        <Section id="llm" title="LLM Data" subtitle="Debug fetch limit and retention policy" icon={SECTIONS[8].icon}>
          <Row
            label="Debug fetch limit"
            hint="Max LLM calls loaded in the LLM Stats and Debug pages. Higher values may slow the page."
          >
            <UnitInput
              type="number"
              step="50"
              min="50"
              max="2000"
              unit="calls"
              value={settings.llm_debug_fetch_limit}
              onChange={e => set('llm_debug_fetch_limit', parseInt(e.target.value) || 200)}
            />
          </Row>
          <Row
            label="Retain LLM data"
            hint="Delete raw LLM call records older than this many days, keeping aggregate stats. 0 = keep forever."
          >
            <UnitInput
              type="number"
              step="1"
              min="0"
              max="3650"
              unit="days"
              value={settings.llm_retain_days}
              onChange={e => set('llm_retain_days', parseInt(e.target.value) || 0)}
            />
          </Row>
        </Section>

        {/* Telegram */}
        <Section id="telegram" title="Telegram" subtitle="Choose which events get pushed to your Telegram chat" icon={SECTIONS[9].icon}>
          <Row
            label="Notifications"
            hint="Master switch for all outbound Telegram push notifications. Trade-approval prompts are always sent regardless — you reply to those to approve or reject a trade."
          >
            <Toggle
              label="Enable Telegram notifications"
              checked={settings.telegram_notify_enabled}
              onChange={() => toggle('telegram_notify_enabled')}
            />
          </Row>

          {settings.telegram_notify_enabled && TELEGRAM_EVENTS.map(ev => (
            <Row key={ev.key} label={ev.label} hint={ev.hint}>
              <Toggle
                label={ev.label}
                checked={settings[ev.key] as boolean}
                onChange={() => toggle(ev.key as Parameters<typeof toggle>[0])}
              />
            </Row>
          ))}
        </Section>

        <Section id="system" title="System" subtitle="Maintenance and app lifecycle" icon={SECTIONS[10].icon}>
          <Row
            label="Enable app updates"
            hint="Turn on the in-app updater: periodic checks for new commits on main (driving the System page pin) and the one-click rebuild. Requires the host watcher (tools/updater/install-updater.sh). Off by default so the rebuild can't be triggered by accident."
          >
            <Toggle
              label="Enable app updates"
              checked={settings.update_enabled}
              onChange={() => toggle('update_enabled')}
            />
          </Row>
          <Row
            label="Check for updates every"
            hint="How often to ask the host whether origin/main is ahead. A pin appears on the System entry in the sidebar when an update is available."
          >
            <UnitInput
              type="number"
              step="0.5"
              min="0.25"
              max="168"
              unit="hrs"
              value={settings.update_check_interval_hours}
              onChange={e => set('update_check_interval_hours', parseFloat(e.target.value) || 1)}
            />
          </Row>
          <div className="flex items-start gap-2 pt-1 text-[11px] text-muted">
            <svg className="mt-px h-3.5 w-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <span>The version status, commits-ahead list and the <span className="text-foreground font-medium">Update app</span> action live on the <span className="text-foreground font-medium">System</span> page.</span>
          </div>
        </Section>

        {/* Floating save bar */}
        {(dirty || saved) && (
          <div className="fixed bottom-6 left-[220px] right-0 z-30 flex justify-center px-8 pointer-events-none">
            {dirty ? (
              <div className="pointer-events-auto flex items-center gap-4 bg-surface-card border border-border rounded-2xl shadow-2xl pl-5 pr-3 py-2.5 animate-slide-up">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
                  <span className="text-sm text-foreground">Unsaved changes</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={discard}>
                    Discard
                  </Button>
                  <Button type="submit" variant="primary" size="md" loading={saving}>
                    Save changes
                  </Button>
                </div>
              </div>
            ) : (
              <div className="pointer-events-auto flex items-center gap-2 bg-surface-card border border-buy/30 rounded-2xl shadow-2xl px-5 py-2.5 animate-slide-up">
                <svg className="w-4 h-4 text-buy" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-buy">Settings saved</span>
              </div>
            )}
          </div>
        )}
      </form>

      <EndpointModal
        open={endpointModalOpen}
        onClose={() => setEndpointModalOpen(false)}
        endpoints={settings.llm_endpoints}
        onChange={next => set('llm_endpoints', next)}
        usage={id =>
          LLM_MODULES.flatMap(m =>
            settings[m.endpointKey] === id ? [m.label]
              : settings[m.fbEndpointKey] === id ? [`${m.label} (fallback)`]
              : [],
          )
        }
      />
    </div>
  )
}
