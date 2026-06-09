import { useEffect, useState, FormEvent } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { useTheme, THEMES } from '../contexts/ThemeContext'
import { cn } from '../lib/utils'

interface SettingsData {
  watchlist: string[]
  pipeline_cron: string
  default_horizon: 'auto' | 'short' | 'medium' | 'long'
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
  cache_ttl_hours: number
  monitor_auto_run: boolean
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
  utc_offset_hours: number
  min_trade_usdc: number
  llm_debug_fetch_limit: number
  llm_retain_days: number
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
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every(p => /^(\*|[0-9,\-\/]+)$/.test(p))
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-border last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted mt-0.5">{hint}</p>}
      </div>
      <div className="w-48 shrink-0">{children}</div>
    </div>
  )
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings).catch(() => {})
  }, [])

  function set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    setSettings(s => s ? { ...s, [key]: value } : s)
    setSaved(false)
  }

  async function toggleMonitorAutoRun() {
    if (!settings) return
    const next = !settings.monitor_auto_run
    set('monitor_auto_run', next)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor_auto_run: next }),
    }).catch(() => {})
  }

  async function toggleMonitorAdjust() {
    if (!settings) return
    const next = !settings.monitor_adjust_sltp
    set('monitor_adjust_sltp', next)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor_adjust_sltp: next }),
    }).catch(() => {})
  }

  async function toggleMonitorAutoApprove() {
    if (!settings) return
    const next = !settings.monitor_auto_approve
    set('monitor_auto_approve', next)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor_auto_approve: next }),
    }).catch(() => {})
  }

  async function toggleMonitorTrustLlm() {
    if (!settings) return
    const next = !settings.monitor_trust_llm_sltp
    set('monitor_trust_llm_sltp', next)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor_trust_llm_sltp: next }),
    }).catch(() => {})
  }

  async function toggleMonitorUseHorizon() {
    if (!settings) return
    const next = !settings.monitor_use_horizon
    set('monitor_use_horizon', next)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor_use_horizon: next }),
    }).catch(() => {})
  }

  async function toggleApproval() {
    if (!settings) return
    const next = !settings.approval_required
    set('approval_required', next)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_required: next }),
    }).catch(() => {})
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <form onSubmit={save} className="space-y-6 max-w-2xl animate-fade-in">

      {/* Trading */}
      <Card>
        <CardHeader title="Trading" subtitle="Core bot behavior" />

        {/* Horizon selector */}
        <div className="py-4 border-b border-border">
          <p className="text-sm font-medium text-foreground mb-1">Trading horizon</p>
          <p className="text-xs text-muted mb-3">
            Controls how the analyst LLM sizes stop-loss / take-profit and how aggressively the position monitor acts.
          </p>
          <div className="grid grid-cols-4 gap-2">
            {([
              { id: 'auto',   label: 'Auto',   hint: 'LLM decides' },
              { id: 'short',  label: 'Short',  hint: 'Days–weeks' },
              { id: 'medium', label: 'Medium', hint: 'Weeks–months' },
              { id: 'long',   label: 'Long',   hint: 'Months–years' },
            ] as const).map(({ id, label, hint }) => {
              const active = settings.default_horizon === id
              const color = id === 'auto'
                ? active ? 'bg-surface-hover border-foreground/30 text-foreground' : 'border-border text-muted hover:border-foreground/20 hover:text-foreground'
                : id === 'short'
                ? active ? 'bg-sell/10 border-sell/40 text-sell' : 'border-border text-muted hover:border-sell/30 hover:text-foreground'
                : id === 'medium'
                ? active ? 'bg-accent/10 border-accent/40 text-accent' : 'border-border text-muted hover:border-accent/30 hover:text-foreground'
                : active ? 'bg-buy/10 border-buy/40 text-buy' : 'border-border text-muted hover:border-buy/30 hover:text-foreground'
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => set('default_horizon', id)}
                  className={cn(
                    'flex flex-col items-center gap-1 px-3 py-3 rounded-xl border text-sm font-semibold transition-all duration-150',
                    color,
                  )}
                >
                  {label}
                  <span className="text-[10px] font-normal opacity-70">{hint}</span>
                </button>
              )
            })}
          </div>
        </div>

        <Row
          label="UTC offset (hours)"
          hint="Applied to all timestamps in the monitor prompt — e.g. 5 for UTC+5, -3 for UTC-3, 5.5 for UTC+5:30"
        >
          <Input
            type="number"
            step="0.5"
            min="-12"
            max="14"
            value={settings.utc_offset_hours}
            onChange={e => set('utc_offset_hours', parseFloat(e.target.value) || 0)}
          />
        </Row>
        <Row label="Watchlist" hint="Comma-separated pairs — e.g. BTC, ETH, SOL">
          <Input
            type="text"
            value={settings.watchlist.map(s => s.replace('/USDC', '')).join(', ')}
            onChange={e => set('watchlist', e.target.value.split(',').map(s => s.trim()).filter(Boolean).map(s => s.endsWith('/USDC') ? s : s + '/USDC'))}
            placeholder="BTC, ETH, SOL"
          />
        </Row>
        <div className="flex items-start justify-between gap-6 py-4 border-b border-border">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Pipeline schedule</p>
            <p className="text-xs text-muted mt-0.5">
              Cron expression — currently: <span className="text-accent font-mono">{describeCron(settings.pipeline_cron)}</span>
            </p>
          </div>
          <div className="w-64 shrink-0 space-y-2">
            <div className="flex flex-wrap gap-1">
              {CRON_PRESETS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => set('pipeline_cron', p.value)}
                  className={cn(
                    'px-2 py-1 text-xs rounded-lg border transition-all duration-150',
                    settings.pipeline_cron === p.value
                      ? 'bg-accent/10 border-accent/40 text-accent'
                      : 'bg-surface-elevated border-border text-muted hover:text-foreground',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Input
              type="text"
              value={settings.pipeline_cron}
              onChange={e => set('pipeline_cron', e.target.value)}
              placeholder="*/30 * * * *"
              error={!isValidCron(settings.pipeline_cron) ? 'Invalid cron expression' : undefined}
            />
          </div>
        </div>
        <Row label="Article cache TTL" hint="Hours before a cached article extraction expires">
          <Input type="number" step="1" min="1" max="168" value={settings.cache_ttl_hours} onChange={e => set('cache_ttl_hours', parseInt(e.target.value) || 13)} />
        </Row>
        <Row label="Require approval" hint="Pause for human approval before executing">
          <label className="relative inline-flex items-center gap-3 cursor-pointer">
            <div
              onClick={toggleApproval}
              className={cn(
                'w-10 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5',
                settings.approval_required ? 'bg-accent' : 'bg-surface-elevated border border-border',
              )}
            >
              <div className={cn(
                'w-5 h-5 bg-foreground rounded-full shadow transition-transform duration-200',
                settings.approval_required ? 'translate-x-4' : 'translate-x-0',
                !settings.approval_required && 'opacity-50',
              )} />
            </div>
            <span className="text-sm text-muted">{settings.approval_required ? 'On' : 'Off'}</span>
          </label>
        </Row>
      </Card>

      {/* Risk */}
      <Card>
        <CardHeader title="Risk Management" subtitle="Position sizing and protection levels" />
        <Row label="Min confidence" hint="Skip signals below this threshold (0–1)">
          <Input type="number" step="0.05" min="0" max="1" value={settings.min_confidence} onChange={e => set('min_confidence', parseFloat(e.target.value) || 0)} />
        </Row>
        <Row label="Max position size ($)" hint="Maximum dollar amount per trade">
          <Input type="number" min="0" value={settings.max_position_size_usd} onChange={e => set('max_position_size_usd', parseInt(e.target.value) || 0)} />
        </Row>
        <Row label="Risk per trade" hint="Fraction of portfolio at risk (0–1)">
          <Input type="number" step="0.01" min="0" max="1" value={settings.max_risk_per_trade} onChange={e => set('max_risk_per_trade', parseFloat(e.target.value) || 0)} />
        </Row>
        <Row label="Max open positions">
          <Input type="number" step="1" min="1" value={settings.max_open_positions} onChange={e => set('max_open_positions', parseInt(e.target.value) || 0)} />
        </Row>
        <Row label="Min USDC to trade ($)" hint="Skip BUY if available USDC is below this amount">
          <Input type="number" step="1" min="0" value={settings.min_trade_usdc} onChange={e => set('min_trade_usdc', parseFloat(e.target.value) || 0)} />
        </Row>
        <Row label="Stop loss (ATR ×)" hint="Stop loss distance in ATR multiples">
          <Input type="number" step="0.1" min="0" value={settings.stop_loss_atr} onChange={e => set('stop_loss_atr', parseFloat(e.target.value) || 0)} />
        </Row>
        <Row label="Take profit (ATR ×)" hint="Take profit distance in ATR multiples">
          <Input type="number" step="0.1" min="0" value={settings.take_profit_atr} onChange={e => set('take_profit_atr', parseFloat(e.target.value) || 0)} />
        </Row>
      </Card>

      {/* Position Monitor */}
      <Card>
        <CardHeader title="Position Monitor" subtitle="Automatically review open positions on a schedule" />
        <Row label="Auto-run" hint="Periodically run the monitor to check positions">
          <label className="relative inline-flex items-center gap-3 cursor-pointer">
            <div
              onClick={toggleMonitorAutoRun}
              className={cn(
                'w-10 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5',
                settings.monitor_auto_run ? 'bg-accent' : 'bg-surface-elevated border border-border',
              )}
            >
              <div className={cn(
                'w-5 h-5 bg-foreground rounded-full shadow transition-transform duration-200',
                settings.monitor_auto_run ? 'translate-x-4' : 'translate-x-0',
                !settings.monitor_auto_run && 'opacity-50',
              )} />
            </div>
            <span className="text-sm text-muted">{settings.monitor_auto_run ? 'On' : 'Off'}</span>
          </label>
        </Row>
        {settings.monitor_auto_run && (
          <div className="flex items-start justify-between gap-6 py-4 border-b border-border last:border-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Monitor schedule</p>
              <p className="text-xs text-muted mt-0.5">
                Cron expression — currently: <span className="text-accent font-mono">{describeCron(settings.monitor_cron)}</span>
              </p>
            </div>
            <div className="w-64 shrink-0 space-y-2">
              <div className="flex flex-wrap gap-1">
                {CRON_PRESETS.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => set('monitor_cron', p.value)}
                    className={cn(
                      'px-2 py-1 text-xs rounded-lg border transition-all duration-150',
                      settings.monitor_cron === p.value
                        ? 'bg-accent/10 border-accent/40 text-accent'
                        : 'bg-surface-elevated border-border text-muted hover:text-foreground',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Input
                type="text"
                value={settings.monitor_cron}
                onChange={e => set('monitor_cron', e.target.value)}
                placeholder="0 */4 * * *"
                error={!isValidCron(settings.monitor_cron) ? 'Invalid cron expression' : undefined}
              />
            </div>
          </div>
        )}
        <Row label="Adapt SL/TP" hint="Let the monitor LLM tighten stops / adjust take-profit on open positions (risk-checked)">
          <label className="relative inline-flex items-center gap-3 cursor-pointer">
            <div
              onClick={toggleMonitorAdjust}
              className={cn(
                'w-10 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5',
                settings.monitor_adjust_sltp ? 'bg-accent' : 'bg-surface-elevated border border-border',
              )}
            >
              <div className={cn(
                'w-5 h-5 bg-foreground rounded-full shadow transition-transform duration-200',
                settings.monitor_adjust_sltp ? 'translate-x-4' : 'translate-x-0',
                !settings.monitor_adjust_sltp && 'opacity-50',
              )} />
            </div>
            <span className="text-sm text-muted">{settings.monitor_adjust_sltp ? 'On' : 'Off'}</span>
          </label>
        </Row>
        {settings.monitor_adjust_sltp && (
          <Row label="Auto-approve adjustments" hint="Apply SL/TP changes immediately without waiting for manual approval, even when approval mode is on">
            <label className="relative inline-flex items-center gap-3 cursor-pointer">
              <div
                onClick={toggleMonitorAutoApprove}
                className={cn(
                  'w-10 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5',
                  settings.monitor_auto_approve ? 'bg-accent' : 'bg-surface-elevated border border-border',
                )}
              >
                <div className={cn(
                  'w-5 h-5 bg-foreground rounded-full shadow transition-transform duration-200',
                  settings.monitor_auto_approve ? 'translate-x-4' : 'translate-x-0',
                  !settings.monitor_auto_approve && 'opacity-50',
                )} />
              </div>
              <span className="text-sm text-muted">{settings.monitor_auto_approve ? 'On' : 'Off'}</span>
            </label>
          </Row>
        )}

        {settings.monitor_adjust_sltp && (
          <Row label="Trust LLM SL/TP" hint="Bypass risk validation — apply the monitor LLM's SL/TP values directly (only SL < price / TP > price enforced). Use with care: loosening stops is allowed.">
            <label className="relative inline-flex items-center gap-3 cursor-pointer">
              <div
                onClick={toggleMonitorTrustLlm}
                className={cn(
                  'w-10 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5',
                  settings.monitor_trust_llm_sltp ? 'bg-sell/80' : 'bg-surface-elevated border border-border',
                )}
              >
                <div className={cn(
                  'w-5 h-5 bg-foreground rounded-full shadow transition-transform duration-200',
                  settings.monitor_trust_llm_sltp ? 'translate-x-4' : 'translate-x-0',
                  !settings.monitor_trust_llm_sltp && 'opacity-50',
                )} />
              </div>
              <span className="text-sm text-muted">{settings.monitor_trust_llm_sltp ? 'On' : 'Off'}</span>
            </label>
          </Row>
        )}

        <Row label="Horizon guidance" hint="Inject per-horizon behavior rules and SL/TP targets into the monitor prompt. Disable to let the LLM decide freely.">
          <label className="relative inline-flex items-center gap-3 cursor-pointer">
            <div
              onClick={toggleMonitorUseHorizon}
              className={cn(
                'w-10 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5',
                settings.monitor_use_horizon ? 'bg-accent' : 'bg-surface-elevated border border-border',
              )}
            >
              <div className={cn(
                'w-5 h-5 bg-foreground rounded-full shadow transition-transform duration-200',
                settings.monitor_use_horizon ? 'translate-x-4' : 'translate-x-0',
                !settings.monitor_use_horizon && 'opacity-50',
              )} />
            </div>
            <span className="text-sm text-muted">{settings.monitor_use_horizon ? 'On' : 'Off'}</span>
          </label>
        </Row>

        <Row label="Price history" hint="Candle timeframe and number of candles included in the monitor LLM prompt as market context.">
          <div className="flex items-center gap-2">
            <select
              value={settings.monitor_history_tf}
              onChange={e => set('monitor_history_tf', e.target.value)}
              className="text-sm bg-surface-elevated border border-border rounded-lg px-2 py-1.5 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
            >
              {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
            <span className="text-xs text-muted">×</span>
            <Input
              type="number"
              step="1"
              min="1"
              max="100"
              value={settings.monitor_history_count}
              onChange={e => set('monitor_history_count', parseInt(e.target.value) || 24)}
              className="w-20"
            />
            <span className="text-xs text-muted">candles</span>
          </div>
        </Row>

        {/* Per-horizon SL/TP configuration */}
        {settings.monitor_use_horizon && (
        <div className="py-4">
          <p className="text-sm font-medium text-foreground mb-1">Horizon SL/TP targets</p>
          <p className="text-xs text-muted mb-4">
            Stop-loss and take-profit percentages from entry price the monitor LLM uses as guidance per investment horizon.
          </p>
          <div className="grid grid-cols-3 gap-3">
            {(['short', 'medium', 'long'] as const).map(h => {
              const slKey = `monitor_sl_pct_${h}` as keyof SettingsData
              const tpKey = `monitor_tp_pct_${h}` as keyof SettingsData
              return (
                <div key={h} className="bg-surface-elevated rounded-xl p-3 space-y-3">
                  <p className={cn(
                    'text-xs font-semibold uppercase tracking-wide',
                    h === 'short' ? 'text-sell' : h === 'medium' ? 'text-accent' : 'text-buy',
                  )}>
                    {h}
                  </p>
                  <div>
                    <label className="text-xs text-muted mb-1 block">Stop loss (%)</label>
                    <Input
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="50"
                      value={settings[slKey] as number}
                      onChange={e => set(slKey, parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted mb-1 block">Take profit (%)</label>
                    <Input
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="200"
                      value={settings[tpKey] as number}
                      onChange={e => set(tpKey, parseFloat(e.target.value) || 0)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        )}
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader title="Appearance" subtitle="Visual theme" />
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-sm transition-all duration-150',
                theme === t.id
                  ? 'border-accent/40 bg-accent/5 text-foreground'
                  : 'border-border bg-surface-elevated text-muted hover:bg-surface-hover',
              )}
            >
              <span
                className="w-4 h-4 rounded-full shrink-0 border border-border/50"
                style={{ background: t.bg, boxShadow: `0 0 0 2px ${t.swatch}40` }}
              />
              <span className="flex-1 text-left font-medium">{t.label}</span>
              {theme === t.id && (
                <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </Card>

      {/* LLM Data */}
      <Card>
        <CardHeader title="LLM Data" subtitle="Debug fetch limit and retention policy" />
        <Row
          label="Debug fetch limit"
          hint="Max LLM calls loaded in the Debug page. Higher values may slow the page."
        >
          <Input
            type="number"
            step="50"
            min="50"
            max="2000"
            value={settings.llm_debug_fetch_limit}
            onChange={e => set('llm_debug_fetch_limit', parseInt(e.target.value) || 200)}
          />
        </Row>
        <Row
          label="Retain LLM data (days)"
          hint="Delete raw LLM call records older than this many days, keeping aggregate stats. 0 = keep forever."
        >
          <Input
            type="number"
            step="1"
            min="0"
            max="3650"
            value={settings.llm_retain_days}
            onChange={e => set('llm_retain_days', parseInt(e.target.value) || 0)}
          />
        </Row>
      </Card>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="lg" loading={saving}>
          Save Settings
        </Button>
        {saved && (
          <span className="text-sm text-buy animate-fade-in">Settings saved successfully</span>
        )}
      </div>
    </form>
  )
}
