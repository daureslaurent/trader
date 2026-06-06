import { useEffect, useState, FormEvent } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { useTheme, THEMES } from '../contexts/ThemeContext'
import { cn } from '../lib/utils'

interface SettingsData {
  watchlist: string[]
  pipeline_cron: string
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
  cache_ttl_hours: number
  fee_rate: number
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
              onClick={() => set('approval_required', !settings.approval_required)}
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
        <Row label="Stop loss (ATR ×)" hint="Stop loss distance in ATR multiples">
          <Input type="number" step="0.1" min="0" value={settings.stop_loss_atr} onChange={e => set('stop_loss_atr', parseFloat(e.target.value) || 0)} />
        </Row>
        <Row label="Take profit (ATR ×)" hint="Take profit distance in ATR multiples">
          <Input type="number" step="0.1" min="0" value={settings.take_profit_atr} onChange={e => set('take_profit_atr', parseFloat(e.target.value) || 0)} />
        </Row>
        <Row label="Fee rate" hint="Exchange fee per trade (e.g. 0.001 = 0.1%) — used in break-even and position sizing">
          <Input type="number" step="0.0001" min="0" max="0.1" value={settings.fee_rate ?? 0.001} onChange={e => set('fee_rate', parseFloat(e.target.value) || 0)} />
        </Row>
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
