import { useEffect, useRef, useState, FormEvent, ReactNode, KeyboardEvent } from 'react'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { useTheme, THEMES } from '../contexts/ThemeContext'
import { cn } from '../lib/utils'
import { MonitorModelsResponse, LLMDefaults, LLMModuleKey } from '../types'

interface SettingsData {
  watchlist: string[]
  pipeline_cron: string
  default_horizon: 'auto' | 'llm' | 'short' | 'medium' | 'long'
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
  cache_ttl_hours: number
  monitor_auto_run: boolean
  monitor_model: 'a' | 'b' | 'alternate'
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
  llm_analyst_base_url: string
  llm_analyst_model: string
  llm_analyst_max_tokens: number
  llm_extractor_base_url: string
  llm_extractor_model: string
  llm_extractor_max_tokens: number
  llm_discoverer_base_url: string
  llm_discoverer_model: string
  llm_discoverer_max_tokens: number
  llm_discoverer_extractor_base_url: string
  llm_discoverer_extractor_model: string
  llm_discoverer_extractor_max_tokens: number
  llm_monitor_a_base_url: string
  llm_monitor_a_model: string
  llm_monitor_a_max_tokens: number
  llm_monitor_b_base_url: string
  llm_monitor_b_model: string
  llm_monitor_b_max_tokens: number
  llm_summary_base_url: string
  llm_summary_model: string
  llm_summary_max_tokens: number
  llm_agent_base_url: string
  llm_agent_model: string
  llm_agent_max_tokens: number
  llm_analyst_fb_base_url: string
  llm_analyst_fb_model: string
  llm_analyst_fb_max_tokens: number
  llm_extractor_fb_base_url: string
  llm_extractor_fb_model: string
  llm_extractor_fb_max_tokens: number
  llm_discoverer_fb_base_url: string
  llm_discoverer_fb_model: string
  llm_discoverer_fb_max_tokens: number
  llm_discoverer_extractor_fb_base_url: string
  llm_discoverer_extractor_fb_model: string
  llm_discoverer_extractor_fb_max_tokens: number
  llm_monitor_a_fb_base_url: string
  llm_monitor_a_fb_model: string
  llm_monitor_a_fb_max_tokens: number
  llm_monitor_b_fb_base_url: string
  llm_monitor_b_fb_model: string
  llm_monitor_b_fb_max_tokens: number
  llm_summary_fb_base_url: string
  llm_summary_fb_model: string
  llm_summary_fb_max_tokens: number
  llm_agent_fb_base_url: string
  llm_agent_fb_model: string
  llm_agent_fb_max_tokens: number
  agent_title_context_messages: number
  summary_auto_run: boolean
  summary_cron: string
  summary_retain_days: number
}

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
  urlKey: keyof SettingsData
  modelKey: keyof SettingsData
  maxTokensKey: keyof SettingsData
  fbUrlKey: keyof SettingsData
  fbModelKey: keyof SettingsData
  fbMaxTokensKey: keyof SettingsData
}[] = [
  { key: 'analyst',             label: 'Analyst',              hint: 'Main BUY/SELL/HOLD decision per coin.',                   urlKey: 'llm_analyst_base_url',             modelKey: 'llm_analyst_model',             maxTokensKey: 'llm_analyst_max_tokens',             fbUrlKey: 'llm_analyst_fb_base_url',             fbModelKey: 'llm_analyst_fb_model',             fbMaxTokensKey: 'llm_analyst_fb_max_tokens' },
  { key: 'extractor',           label: 'Extractor',            hint: 'Compresses research articles into structured sentiment.', urlKey: 'llm_extractor_base_url',           modelKey: 'llm_extractor_model',           maxTokensKey: 'llm_extractor_max_tokens',           fbUrlKey: 'llm_extractor_fb_base_url',           fbModelKey: 'llm_extractor_fb_model',           fbMaxTokensKey: 'llm_extractor_fb_max_tokens' },
  { key: 'discoverer',          label: 'Discoverer',           hint: 'Scores new coin candidates during discovery.',            urlKey: 'llm_discoverer_base_url',          modelKey: 'llm_discoverer_model',          maxTokensKey: 'llm_discoverer_max_tokens',          fbUrlKey: 'llm_discoverer_fb_base_url',          fbModelKey: 'llm_discoverer_fb_model',          fbMaxTokensKey: 'llm_discoverer_fb_max_tokens' },
  { key: 'discovererExtractor', label: 'Discoverer extractor', hint: 'Extractor used inside the discovery pipeline.',            urlKey: 'llm_discoverer_extractor_base_url', modelKey: 'llm_discoverer_extractor_model', maxTokensKey: 'llm_discoverer_extractor_max_tokens', fbUrlKey: 'llm_discoverer_extractor_fb_base_url', fbModelKey: 'llm_discoverer_extractor_fb_model', fbMaxTokensKey: 'llm_discoverer_extractor_fb_max_tokens' },
  { key: 'monitorA',            label: 'Monitor A',            hint: 'Slot A — primary model that reviews open positions.',     urlKey: 'llm_monitor_a_base_url',           modelKey: 'llm_monitor_a_model',           maxTokensKey: 'llm_monitor_a_max_tokens',           fbUrlKey: 'llm_monitor_a_fb_base_url',           fbModelKey: 'llm_monitor_a_fb_model',           fbMaxTokensKey: 'llm_monitor_a_fb_max_tokens' },
  { key: 'monitorB',            label: 'Monitor B',            hint: 'Slot B — alternate model for the position monitor (used in B / Alternate mode).', urlKey: 'llm_monitor_b_base_url', modelKey: 'llm_monitor_b_model', maxTokensKey: 'llm_monitor_b_max_tokens', fbUrlKey: 'llm_monitor_b_fb_base_url', fbModelKey: 'llm_monitor_b_fb_model', fbMaxTokensKey: 'llm_monitor_b_fb_max_tokens' },
  { key: 'summary',             label: 'Portfolio Summary',    hint: 'Writes the scheduled portfolio briefing from holdings + Binance market data.', urlKey: 'llm_summary_base_url', modelKey: 'llm_summary_model', maxTokensKey: 'llm_summary_max_tokens', fbUrlKey: 'llm_summary_fb_base_url', fbModelKey: 'llm_summary_fb_model', fbMaxTokensKey: 'llm_summary_fb_max_tokens' },
  { key: 'agent',               label: 'Agent',                hint: 'Conversational assistant on the Agent page. Use a tool-calling-capable model.', urlKey: 'llm_agent_base_url', modelKey: 'llm_agent_model', maxTokensKey: 'llm_agent_max_tokens', fbUrlKey: 'llm_agent_fb_base_url', fbModelKey: 'llm_agent_fb_model', fbMaxTokensKey: 'llm_agent_fb_max_tokens' },
]

type LLMModule = typeof LLM_MODULES[number]
type SetFn = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => void

// One row in the LLM Models section: the primary endpoint/model/max-tokens grid
// plus a collapsible "failover" block. The fallback only fires when the primary
// call throws, so it's presented as a subordinate, opt-in panel — auto-expanded
// when already configured, with a live status dot so an active fallback reads at
// a glance.
function LLMModuleRow({ m, settings, set, def }: {
  m: LLMModule
  settings: SettingsData
  set: SetFn
  def?: { model: string; baseURL: string; maxTokens: number }
}) {
  const maxTokens = settings[m.maxTokensKey] as number
  const fbUrl = (settings[m.fbUrlKey] as string) ?? ''
  const fbModel = (settings[m.fbModelKey] as string) ?? ''
  const fbMaxTokens = settings[m.fbMaxTokensKey] as number
  const fbActive = !!(fbUrl.trim() || fbModel.trim())
  const [open, setOpen] = useState(fbActive)

  // Placeholders for the fallback fields echo the primary's effective values, so a
  // blank fallback field visibly reads as "inherit the primary here".
  const primModel = (settings[m.modelKey] as string).trim() || def?.model || 'model'
  const primUrl = (settings[m.urlKey] as string).trim() || def?.baseURL || 'base URL'

  function clearFallback() {
    set(m.fbUrlKey, '' as SettingsData[typeof m.fbUrlKey])
    set(m.fbModelKey, '' as SettingsData[typeof m.fbModelKey])
    set(m.fbMaxTokensKey, 0 as SettingsData[typeof m.fbMaxTokensKey])
  }

  return (
    <Row label={m.label} hint={m.hint} stacked>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_120px]">
        <Input
          type="text"
          value={settings[m.modelKey] as string}
          onChange={e => set(m.modelKey, e.target.value as SettingsData[typeof m.modelKey])}
          placeholder={def ? `${def.model} (default)` : 'model'}
          className="font-mono text-xs"
          aria-label={`${m.label} model`}
        />
        <Input
          type="text"
          value={settings[m.urlKey] as string}
          onChange={e => set(m.urlKey, e.target.value as SettingsData[typeof m.urlKey])}
          placeholder={def ? `${def.baseURL} (default)` : 'base URL'}
          className="font-mono text-xs"
          aria-label={`${m.label} base URL`}
        />
        <UnitInput
          type="number"
          min="0"
          step="256"
          unit="tok"
          value={maxTokens || ''}
          onChange={e => set(m.maxTokensKey, (parseInt(e.target.value) || 0) as SettingsData[typeof m.maxTokensKey])}
          placeholder={def ? `${def.maxTokens}` : 'max'}
          className="font-mono text-xs"
          aria-label={`${m.label} max tokens`}
        />
      </div>

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
              Leave a field blank to reuse the primary's value.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_120px]">
              <Input
                type="text"
                value={fbModel}
                onChange={e => set(m.fbModelKey, e.target.value as SettingsData[typeof m.fbModelKey])}
                placeholder={`${primModel} (same as primary)`}
                className="font-mono text-xs"
                aria-label={`${m.label} fallback model`}
              />
              <Input
                type="text"
                value={fbUrl}
                onChange={e => set(m.fbUrlKey, e.target.value as SettingsData[typeof m.fbUrlKey])}
                placeholder={`${primUrl} (same as primary)`}
                className="font-mono text-xs"
                aria-label={`${m.label} fallback base URL`}
              />
              <UnitInput
                type="number"
                min="0"
                step="256"
                unit="tok"
                value={fbMaxTokens || ''}
                onChange={e => set(m.fbMaxTokensKey, (parseInt(e.target.value) || 0) as SettingsData[typeof m.fbMaxTokensKey])}
                placeholder={maxTokens ? `${maxTokens}` : (def ? `${def.maxTokens}` : 'max')}
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

/* ------------------------------------- Page ------------------------------------- */

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [baseline, setBaseline] = useState<SettingsData | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('trading')
  const [monitorModels, setMonitorModels] = useState<MonitorModelsResponse | null>(null)
  const [llmDefaults, setLlmDefaults] = useState<LLMDefaults | null>(null)
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
  async function toggle(key: keyof SettingsData & ('approval_required' | 'monitor_auto_run' | 'monitor_adjust_sltp' | 'monitor_auto_approve' | 'monitor_trust_llm_sltp' | 'monitor_use_horizon' | 'entry_timing_enabled' | 'llm_allow_parallel_same_url' | 'summary_auto_run')) {
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
              <Row label="Pullback target" hint="Aim to buy this % below the signal price (the dip). Fires as soon as price reaches the target.">
                <UnitInput type="number" step="0.1" min="0" max="10" unit="%" value={settings.entry_pullback_pct} onChange={e => set('entry_pullback_pct', parseFloat(e.target.value) || 0)} />
              </Row>
              <Row label="Invalidate (falling knife)" hint="Abandon the intent if price drops this % below the signal price before filling — likely a breakdown, not a dip.">
                <UnitInput type="number" step="0.5" min="0.5" max="50" unit="%" value={settings.entry_invalidate_pct} onChange={e => set('entry_invalidate_pct', parseFloat(e.target.value) || 0)} />
              </Row>
              <Row label="Chase cap" hint="Abandon the intent if price runs this % above the signal price — the move got away; wait for the next cycle rather than chasing.">
                <UnitInput type="number" step="0.5" min="0.5" max="50" unit="%" value={settings.entry_max_chase_pct} onChange={e => set('entry_max_chase_pct', parseFloat(e.target.value) || 0)} />
              </Row>
              <Row label="Intent lifetime" hint="How long to wait for a good entry before the intent expires.">
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
            hint="Which LLM reviews open positions. Configure the two slots (model, endpoint, max tokens) in the LLM Models section below. Alternate flips between A and B on each monitor cycle."
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(['a', 'b'] as const).map(slot => {
                const info = monitorModels?.[slot]
                const active = settings.monitor_model === slot
                const alternating = settings.monitor_model === 'alternate'
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => set('monitor_model', slot)}
                    className={cn(
                      'flex flex-col items-start gap-1.5 px-3.5 py-3 rounded-xl border text-left transition-all duration-150',
                      active
                        ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20'
                        : 'border-border hover:border-foreground/20',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 w-full">
                      <span className={cn(
                        'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded',
                        active ? 'bg-accent/20 text-accent' : 'bg-surface-elevated text-muted',
                      )}>
                        {slot === 'a' ? 'Slot A' : 'Slot B'}
                      </span>
                      {active && (
                        <svg className="w-3.5 h-3.5 text-accent shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {alternating && (
                        <span className="text-[10px] font-semibold text-accent shrink-0">in rotation</span>
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
              })}
            </div>
            <button
              type="button"
              onClick={() => set('monitor_model', 'alternate')}
              className={cn(
                'mt-2 flex items-center justify-between gap-2 w-full px-3.5 py-3 rounded-xl border text-left transition-all duration-150',
                settings.monitor_model === 'alternate'
                  ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20'
                  : 'border-border hover:border-foreground/20',
              )}
            >
              <div className="flex items-center gap-2.5">
                <span className={cn(
                  'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded',
                  settings.monitor_model === 'alternate' ? 'bg-accent/20 text-accent' : 'bg-surface-elevated text-muted',
                )}>
                  Alternate
                </span>
                <span className="text-sm font-medium text-foreground">A ⇄ B each cycle</span>
                <span className="text-[10px] text-muted hidden sm:inline">one model per run, flips on the next</span>
              </div>
              {settings.monitor_model === 'alternate' && (
                <svg className="w-3.5 h-3.5 text-accent shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
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
        <Section id="models" title="LLM Models" subtitle="Pick the endpoint, model & max tokens each module uses. Leave a field blank (max tokens 0) to use the env-var default. Add a Fallback to keep a module running if its primary endpoint goes down." icon={SECTIONS[5].icon}>
          <Row
            label="Parallel calls per endpoint"
            hint="Off (recommended): calls to the same base URL queue and run one at a time — best for a local server that handles one request at a time. On: allow concurrent calls to the same endpoint. Different endpoints always run in parallel either way."
          >
            <Toggle
              label="Allow parallel same-endpoint calls"
              checked={settings.llm_allow_parallel_same_url}
              onChange={() => toggle('llm_allow_parallel_same_url')}
            />
          </Row>
          {LLM_MODULES.map(m => (
            <LLMModuleRow key={m.key} m={m} settings={settings} set={set} def={llmDefaults?.[m.key]} />
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
    </div>
  )
}
