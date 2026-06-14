import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import { cn } from '../lib/utils'
import { PortfolioSummary, SummaryResponse } from '../types'

/* ------------------------------- helpers ------------------------------- */

interface SnapshotHolding {
  coin: string
  valueUsd: number
  allocationPct: number
  unrealizedPnlPct: number | null
  change24h: number
  rsi14: number
  trend: string
}
interface Snapshot {
  generatedAt?: string
  totalValueUsd?: number
  usdcBalance?: number
  usdcPct?: number
  holdingsCount?: number
  openBotPositions?: number
  maxOpenPositions?: number
  valueChangePct?: number | null
  holdings?: SnapshotHolding[]
}

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}
function parseSnapshot(raw: string | null | undefined): Snapshot {
  if (!raw) return {}
  try { return JSON.parse(raw) as Snapshot } catch { return {} }
}

function fmtUsd(n: number | undefined | null): string {
  if (n == null || !isFinite(n)) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}
function relTime(iso: string): string {
  const t = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()
  const diff = Date.now() - t
  if (isNaN(diff)) return iso
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const HEALTH_META: Record<string, { label: string; cls: string; dot: string }> = {
  strong:  { label: 'Strong',  cls: 'text-buy bg-buy/10 border-buy/20',   dot: 'bg-buy' },
  stable:  { label: 'Stable',  cls: 'text-buy bg-buy/10 border-buy/20',   dot: 'bg-buy' },
  cautious:{ label: 'Cautious',cls: 'text-warn bg-warn/10 border-warn/20', dot: 'bg-warn' },
  at_risk: { label: 'At risk', cls: 'text-sell bg-sell/10 border-sell/20', dot: 'bg-sell' },
}
const RISK_META: Record<string, { label: string; cls: string }> = {
  low:      { label: 'Low risk',      cls: 'text-buy bg-buy/10 border-buy/20' },
  moderate: { label: 'Moderate risk', cls: 'text-warn bg-warn/10 border-warn/20' },
  elevated: { label: 'Elevated risk', cls: 'text-warn bg-warn/10 border-warn/20' },
  high:     { label: 'High risk',     cls: 'text-sell bg-sell/10 border-sell/20' },
}
const ALLOC_COLORS = ['bg-accent', 'bg-buy', 'bg-warn', 'bg-sell', 'bg-accent2', 'bg-muted']

/* ------------------------------- bullets ------------------------------- */

function BulletList({ items, tone }: { items: string[]; tone: 'observation' | 'suggestion' }) {
  if (!items.length) return null
  const icon = tone === 'suggestion'
    ? 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
    : 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
  const color = tone === 'suggestion' ? 'text-accent' : 'text-muted'
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5 text-sm text-foreground leading-relaxed">
          <svg className={cn('w-4 h-4 mt-0.5 shrink-0', color)} fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
          </svg>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------- detail ------------------------------- */

function SummaryDetail({ s }: { s: PortfolioSummary }) {
  const snap = useMemo(() => parseSnapshot(s.snapshot), [s.snapshot])
  const observations = useMemo(() => parseList(s.observations), [s.observations])
  const suggestions = useMemo(() => parseList(s.suggestions), [s.suggestions])
  const health = s.health ? HEALTH_META[s.health] : null
  const risk = s.risk_level ? RISK_META[s.risk_level] : null
  const holdings = (snap.holdings ?? []).slice(0, 8)
  const change = snap.valueChangePct

  return (
    <div className="space-y-5">
      {/* Hero */}
      <Card noPad className="overflow-hidden">
        <div className="px-6 pt-6 pb-5 bg-gradient-to-br from-accent/[0.07] to-transparent">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                {health && (
                  <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border', health.cls)}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', health.dot)} />
                    {health.label}
                  </span>
                )}
                {risk && (
                  <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border', risk.cls)}>
                    {risk.label}
                  </span>
                )}
                <span className="text-xs text-muted" title={s.created_at}>{relTime(s.created_at)}</span>
              </div>
              <p className="text-[15px] leading-relaxed text-foreground max-w-2xl">{s.summary}</p>
            </div>

            <div className="text-right shrink-0">
              <p className="text-[11px] uppercase tracking-wider text-muted font-semibold">Portfolio value</p>
              <p className="text-2xl font-bold text-foreground tabular-nums mt-0.5">{fmtUsd(snap.totalValueUsd)}</p>
              {change != null && (
                <p className={cn('text-sm font-semibold tabular-nums', change >= 0 ? 'text-buy' : 'text-sell')}>
                  {fmtPct(change)} <span className="text-muted font-normal text-xs">over window</span>
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Quick stats strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border border-t border-border">
          <Stat label="Cash (USDC)" value={fmtUsd(snap.usdcBalance)} sub={snap.usdcPct != null ? `${snap.usdcPct.toFixed(1)}%` : undefined} />
          <Stat label="Holdings" value={snap.holdingsCount != null ? String(snap.holdingsCount) : '—'} />
          <Stat label="Open positions" value={snap.openBotPositions != null ? `${snap.openBotPositions}/${snap.maxOpenPositions ?? '—'}` : '—'} />
          <Stat label="Model" value={s.model ? s.model.split('/').pop()!.slice(0, 14) : '—'} mono />
        </div>
      </Card>

      {/* Allocation bar */}
      {holdings.length > 0 && (
        <Card>
          <p className="text-sm font-semibold text-foreground mb-3">Allocation</p>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-elevated">
            {holdings.map((h, i) => (
              <div
                key={h.coin}
                className={cn('h-full', ALLOC_COLORS[i % ALLOC_COLORS.length])}
                style={{ width: `${Math.max(1, h.allocationPct)}%` }}
                title={`${h.coin.replace('/USDC', '')} ${h.allocationPct.toFixed(1)}%`}
              />
            ))}
          </div>
          <div className="mt-4 space-y-1.5">
            {holdings.map((h, i) => (
              <div key={h.coin} className="flex items-center gap-3 text-sm">
                <span className={cn('w-2.5 h-2.5 rounded-sm shrink-0', ALLOC_COLORS[i % ALLOC_COLORS.length])} />
                <span className="font-medium text-foreground w-14">{h.coin.replace('/USDC', '')}</span>
                <span className="text-muted tabular-nums w-12">{h.allocationPct.toFixed(1)}%</span>
                <span className="text-muted tabular-nums w-24">{fmtUsd(h.valueUsd)}</span>
                {h.unrealizedPnlPct != null && (
                  <span className={cn('tabular-nums w-16 font-medium', h.unrealizedPnlPct >= 0 ? 'text-buy' : 'text-sell')}>
                    {fmtPct(h.unrealizedPnlPct)}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                  <span title="RSI(14)">RSI {h.rsi14.toFixed(0)}</span>
                  <span className={cn(
                    'px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide',
                    h.trend === 'uptrend' ? 'text-buy bg-buy/10' : h.trend === 'downtrend' ? 'text-sell bg-sell/10' : 'text-muted bg-surface-elevated',
                  )}>
                    {h.trend}
                  </span>
                  <span className={cn('tabular-nums', h.change24h >= 0 ? 'text-buy' : 'text-sell')}>{fmtPct(h.change24h)}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* What happened */}
      {s.what_happened && (
        <Card>
          <div className="flex items-center gap-2 mb-2.5">
            <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-semibold text-foreground">What happened</p>
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">{s.what_happened}</p>
        </Card>
      )}

      {/* Observations + suggestions */}
      {(observations.length > 0 || suggestions.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {observations.length > 0 && (
            <Card>
              <p className="text-sm font-semibold text-foreground mb-3">Key observations</p>
              <BulletList items={observations} tone="observation" />
            </Card>
          )}
          {suggestions.length > 0 && (
            <Card>
              <p className="text-sm font-semibold text-foreground mb-3">Suggestions</p>
              <BulletList items={suggestions} tone="suggestion" />
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, mono }: { label: string; value: string; sub?: string; mono?: boolean }) {
  return (
    <div className="px-4 py-3.5">
      <p className="text-[11px] uppercase tracking-wider text-muted font-semibold">{label}</p>
      <p className={cn('text-sm font-semibold text-foreground mt-1 truncate', mono && 'font-mono text-xs')} title={value}>
        {value}{sub && <span className="text-muted font-normal ml-1">· {sub}</span>}
      </p>
    </div>
  )
}

/* ------------------------------- page ------------------------------- */

export default function Summary() {
  const { data, loading, error, reload } = useApi<SummaryResponse>('/api/summary')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [generating, setGenerating] = useState(false)

  // Live-reload when a scheduled or manual run finishes.
  const onMessage = useCallback((event: string) => {
    if (event === 'summary_started') setGenerating(true)
    if (event === 'summary_completed' || event === 'summary_error') {
      setGenerating(false)
      setSelectedId(null) // snap back to the (new) latest
      reload()
    }
  }, [reload])
  useWebSocket(onMessage)

  const history = data?.history ?? []
  const running = generating || !!data?.running
  const selected = selectedId != null ? history.find(h => h.id === selectedId) ?? data?.latest : data?.latest

  async function generate() {
    setGenerating(true)
    try {
      const res = await fetch('/api/summary/run', { method: 'POST' })
      if (!res.ok) setGenerating(false)
    } catch {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-6 animate-fade-in max-w-5xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Portfolio Summary</h2>
          <p className="text-sm text-muted mt-0.5">
            LLM briefing of your holdings &amp; live Binance market data
            {data?.model?.model && <> · <span className="font-mono text-xs">{data.model.model}</span></>}
          </p>
        </div>
        <Button variant="primary" size="md" loading={running} onClick={generate} disabled={running}>
          {running ? 'Generating…' : 'Generate now'}
        </Button>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center h-40">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <Card className="border-sell/30">
          <p className="text-sm text-sell">Failed to load summaries: {error}</p>
        </Card>
      )}

      {!loading && data && !selected && (
        <Card className="text-center py-14">
          <svg className="w-10 h-10 text-muted/50 mx-auto mb-3" fill="none" stroke="currentColor" strokeWidth={1.3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-6h13M9 11V5h13M3 5h.01M3 11h.01M3 17h.01" />
          </svg>
          <p className="text-sm font-medium text-foreground">No summaries yet</p>
          <p className="text-sm text-muted mt-1 max-w-sm mx-auto">
            Generate one now, or enable auto-run in Settings → Portfolio Summary to produce them on a schedule.
          </p>
        </Card>
      )}

      {selected && <SummaryDetail s={selected} />}

      {/* History */}
      {history.length > 1 && (
        <div>
          <p className="text-xs uppercase tracking-wider text-muted font-semibold mb-2.5">History</p>
          <div className="space-y-1.5">
            {history.map(h => {
              const snap = parseSnapshot(h.snapshot)
              const isActive = (selected?.id === h.id)
              const health = h.health ? HEALTH_META[h.health] : null
              return (
                <button
                  key={h.id}
                  onClick={() => setSelectedId(h.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all duration-150',
                    isActive
                      ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20'
                      : 'bg-surface-card border-border hover:border-foreground/20 hover:bg-surface-elevated',
                  )}
                >
                  {health
                    ? <span className={cn('w-2 h-2 rounded-full shrink-0', health.dot)} />
                    : <span className="w-2 h-2 rounded-full shrink-0 bg-muted" />}
                  <span className="text-sm text-foreground truncate flex-1">{h.summary}</span>
                  <span className="text-sm font-medium text-foreground tabular-nums shrink-0 hidden sm:block">{fmtUsd(snap.totalValueUsd)}</span>
                  <span className="text-xs text-muted shrink-0 w-16 text-right" title={h.created_at}>{relTime(h.created_at)}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
