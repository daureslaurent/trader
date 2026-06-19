import { useState, useEffect, useMemo, useCallback } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { Card, CardHeader } from '../components/ui/Card'
import { Stat } from '../components/ui/Stat'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import { PositionReview, MonitorNote, MonitorResponse, ActivePosition, PositionAdjustment } from '../types'
import { cn, timeAgo, formatDate } from '../lib/utils'

const SELL = 'rgb(var(--sell-rgb))'
const ACCENT = 'rgb(var(--accent-rgb))'
const MUTED = 'var(--muted-fg)'

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--surface-elevated)',
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  fontSize: '12px',
  color: 'var(--foreground)',
}

const ACTION_STYLES: Record<string, { cls: string; leftBorder: string; chart: string }> = {
  HOLD:   { cls: 'bg-surface-elevated text-muted border-border', leftBorder: 'border-l-border', chart: MUTED },
  CLOSE:  { cls: 'bg-sell/10 text-sell border-sell/20',          leftBorder: 'border-l-sell',   chart: SELL },
  ADJUST: { cls: 'bg-accent/10 text-accent border-accent/20',    leftBorder: 'border-l-accent', chart: ACCENT },
}

const ADJUSTMENT_VARIANTS = {
  PENDING: 'pending', APPLIED: 'executed', REJECTED: 'failed', EXPIRED: 'neutral',
} as const

function fmtPrice(v: number): string {
  const decimals = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals })
}

function parseMarketData(raw: string): Record<string, number | string | null> {
  try { return JSON.parse(raw) } catch { return {} }
}

function ModelBadge({ model }: { model: string | null }) {
  if (!model) return <span className="text-muted">—</span>
  return (
    <Badge variant="accent" dot className="max-w-[140px]" title={model}>
      <span className="truncate">{model}</span>
    </Badge>
  )
}

function ActionBadge({ action }: { action: string }) {
  const s = ACTION_STYLES[action] ?? ACTION_STYLES.HOLD
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 text-xs rounded-md border font-semibold tracking-wide', s.cls)}>
      {action}
    </span>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const color = pct >= 75 ? 'bg-buy' : pct >= 50 ? 'bg-warn' : 'bg-sell'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-surface-hover overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted tabular-nums w-8 text-right">{pct}%</span>
    </div>
  )
}

// ── Latest review card ──────────────────────────────────────────────────────

function ReviewCard({ review, note }: { review: PositionReview; note: MonitorNote | null }) {
  const [expanded, setExpanded] = useState(false)
  const mdata = parseMarketData(review.market_data)
  const coin = review.coin.replace('/USDC', '')
  const s = ACTION_STYLES[review.action] ?? ACTION_STYLES.HOLD
  const clampable = review.reasoning.length > 220

  return (
    <div className={cn('rounded-xl border border-border border-l-4 bg-surface-elevated/30 overflow-hidden', s.leftBorder)}>
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <span className="font-semibold text-foreground">{coin}</span>
          <ActionBadge action={review.action} />
          {typeof mdata.trend === 'string' && (
            <span className={cn(
              'text-xs px-1.5 py-0.5 rounded border font-medium',
              mdata.trend === 'uptrend' ? 'bg-buy/10 text-buy border-buy/20'
              : mdata.trend === 'downtrend' ? 'bg-sell/10 text-sell border-sell/20'
              : 'bg-surface-hover text-muted border-border',
            )}>
              {mdata.trend}
            </span>
          )}
          {typeof mdata.horizon === 'string' && (
            <span className="text-xs px-1.5 py-0.5 rounded border font-medium bg-surface-hover text-muted border-border">
              {mdata.horizon}
            </span>
          )}
        </div>
        <span className="text-xs text-muted whitespace-nowrap shrink-0">{timeAgo(review.created_at)}</span>
      </div>

      <div className="flex items-center gap-5 px-4 pb-2 text-xs text-muted flex-wrap">
        {typeof mdata.pnlPct === 'number' && (
          <span className={cn('font-medium', mdata.pnlPct >= 0 ? 'text-buy' : 'text-sell')}>
            P&L {mdata.pnlPct >= 0 ? '+' : ''}{mdata.pnlPct.toFixed(2)}%
          </span>
        )}
        {typeof mdata.currentPrice === 'number' && <span className="tabular-nums">{fmtPrice(mdata.currentPrice)}</span>}
        {typeof mdata.rsi14 === 'number' && <span>RSI {mdata.rsi14.toFixed(0)}</span>}
        {typeof mdata.change24h === 'number' && (
          <span className={cn(mdata.change24h >= 0 ? 'text-buy' : 'text-sell')}>
            24h {mdata.change24h >= 0 ? '+' : ''}{mdata.change24h.toFixed(2)}%
          </span>
        )}
      </div>

      {review.action === 'ADJUST' && (review.new_stop_loss != null || review.new_take_profit != null) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2 text-xs">
          {review.new_stop_loss != null && (
            <span className="px-2 py-0.5 rounded-md bg-sell/10 text-sell border border-sell/20 tabular-nums">
              SL {review.old_stop_loss != null ? `${fmtPrice(review.old_stop_loss)} → ` : '→ '}{fmtPrice(review.new_stop_loss)}
            </span>
          )}
          {review.new_take_profit != null && (
            <span className="px-2 py-0.5 rounded-md bg-buy/10 text-buy border border-buy/20 tabular-nums">
              TP {review.old_take_profit != null ? `${fmtPrice(review.old_take_profit)} → ` : '→ '}{fmtPrice(review.new_take_profit)}
            </span>
          )}
        </div>
      )}

      <div className="px-4 pb-3.5 space-y-2">
        <ConfidenceBar value={review.confidence} />
        <p
          className="text-sm text-muted leading-relaxed"
          style={!expanded && clampable
            ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
            : undefined}
        >
          {review.reasoning}
        </p>
        {clampable && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs font-medium text-accent hover:underline"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {note && (
          <div className="rounded-lg bg-surface-hover/50 border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">LLM Notes</span>
              <span className="text-[10px] text-muted whitespace-nowrap">updated {timeAgo(note.updated_at)}</span>
            </div>
            <p className="text-xs text-muted leading-relaxed whitespace-pre-wrap">{note.notes}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Empty / loading states ──────────────────────────────────────────────────

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
      <div className="w-10 h-10 rounded-full bg-surface-elevated flex items-center justify-center mb-3">
        <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted mt-1 max-w-sm">{message}</p>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Monitor() {
  const [running, setRunning] = useState(false)
  const [reviews, setReviews] = useState<PositionReview[]>([])
  const [notes, setNotes] = useState<MonitorNote[]>([])
  const [loading, setLoading] = useState(true)
  const [monitorError, setMonitorError] = useState<string | null>(null)

  const positions = useApi<ActivePosition[]>('/api/positions')
  const adjustments = useApi<PositionAdjustment[]>('/api/adjustments?limit=40')

  const loadMonitor = useCallback(() => {
    fetch('/api/monitor?limit=200')
      .then(r => r.json())
      .then((data: MonitorResponse) => {
        setRunning(data.running)
        setReviews(data.reviews)
        setNotes(data.notes ?? [])
        setLoading(false)
      })
      .catch(() => {
        setMonitorError('Failed to load monitor data')
        setLoading(false)
      })
  }, [])

  useEffect(() => { loadMonitor() }, [loadMonitor])

  useWebSocket(useCallback((event: string, data: unknown) => {
    if (event === 'monitor_started') {
      setRunning(true)
      setMonitorError(null)
    } else if (event === 'monitor_coin_completed') {
      const { review } = data as { review: PositionReview }
      setReviews(rs => [review, ...rs.filter(r => r.id !== review.id)])
    } else if (event === 'monitor_coin_error') {
      const d = data as { coin: string; error: string }
      setMonitorError(`${d.coin.replace('/USDC', '')}: ${d.error}`)
    } else if (event === 'monitor_completed') {
      setRunning(false)
      loadMonitor()
      positions.reload()
      adjustments.reload()
    } else if (event === 'monitor_error') {
      setRunning(false)
      setMonitorError((data as { error?: string })?.error ?? 'Monitor failed')
    } else if (event === 'position_adjusted' || event === 'adjustment_resolved') {
      adjustments.reload()
      positions.reload()
    }
  }, [loadMonitor, positions.reload, adjustments.reload])) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRun() {
    setMonitorError(null)
    setRunning(true)
    try {
      const res = await fetch('/api/monitor/run', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setMonitorError(d.error ?? 'Failed to start monitor')
        setRunning(false)
      }
    } catch {
      setMonitorError('Request failed')
      setRunning(false)
    }
  }

  const open = positions.data ?? []
  const notesByCoin = useMemo(() => new Map(notes.map(n => [n.coin, n])), [notes])

  // Latest review per coin (reviews arrive sorted newest-first)
  const latestByCoin = useMemo(() => {
    const m = new Map<string, PositionReview>()
    for (const r of reviews) if (!m.has(r.coin)) m.set(r.coin, r)
    return [...m.values()]
  }, [reviews])

  // Reviews belonging to the most recent monitor cycle
  const lastCycle = useMemo(() => {
    const cycleId = reviews[0]?.cycle_id
    return cycleId ? reviews.filter(r => r.cycle_id === cycleId) : []
  }, [reviews])

  const stats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of lastCycle) counts.set(r.action, (counts.get(r.action) ?? 0) + 1)
    const breakdown = ['CLOSE', 'ADJUST', 'HOLD']
      .filter(a => counts.has(a))
      .map(a => `${counts.get(a)} ${a}`)
      .join(' · ')
    return {
      lastRun: reviews[0]?.created_at ?? null,
      cycleSize: lastCycle.length,
      breakdown,
      avgConfidence: lastCycle.length > 0
        ? lastCycle.reduce((s, r) => s + r.confidence, 0) / lastCycle.length
        : null,
      ocoActive: open.filter(p => p.oco_status === 'ACTIVE').length,
      ocoFailed: open.filter(p => p.oco_status === 'FAILED').length,
    }
  }, [reviews, lastCycle, open])

  // Action mix across the loaded review history
  const actionMix = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of reviews) counts.set(r.action, (counts.get(r.action) ?? 0) + 1)
    return ['HOLD', 'ADJUST', 'CLOSE']
      .filter(a => counts.has(a))
      .map(a => ({ name: a, value: counts.get(a)!, color: ACTION_STYLES[a].chart }))
  }, [reviews])

  const recentAdjustments = adjustments.data ?? []

  return (
    <div className="space-y-6 animate-fade-in">

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat
          label="Monitor Status"
          value={running ? 'Running' : 'Idle'}
          sub={running ? 'Reviewing open positions…' : stats.lastRun ? `Last review ${timeAgo(stats.lastRun)}` : 'No reviews yet'}
          trend={running ? 'up' : 'neutral'}
          icon={<RadarIcon spinning={running} />}
        />
        <Stat
          label="Positions Watched"
          value={open.length}
          sub={open.length > 0
            ? `${stats.ocoActive} OCO protected${stats.ocoFailed > 0 ? ` · ${stats.ocoFailed} software fallback` : ''}`
            : 'No open positions'}
          trend={stats.ocoFailed > 0 ? 'down' : 'neutral'}
          icon={<EyeIcon />}
        />
        <Stat
          label="Last Cycle"
          value={stats.cycleSize}
          sub={stats.breakdown || 'Reviews in the most recent run'}
          icon={<ClipboardIcon />}
        />
        <Stat
          label="Avg Confidence"
          value={stats.avgConfidence != null ? `${Math.round(stats.avgConfidence * 100)}%` : '—'}
          sub="Across the latest cycle"
          trend={stats.avgConfidence == null ? 'neutral' : stats.avgConfidence >= 0.75 ? 'up' : stats.avgConfidence >= 0.5 ? 'neutral' : 'down'}
          icon={<GaugeIcon />}
        />
      </div>

      {monitorError && (
        <div className="px-4 py-3 rounded-xl bg-sell/10 border border-sell/20 text-sm text-sell">
          {monitorError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* Latest reviews */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Latest Reviews"
            subtitle="Most recent LLM verdict per open position"
            action={
              <Button
                variant="primary"
                size="sm"
                loading={running}
                disabled={running || open.length === 0}
                onClick={handleRun}
              >
                {running ? 'Analysing…' : 'Run Monitor'}
              </Button>
            }
          />
          {loading ? (
            <Spinner />
          ) : latestByCoin.length === 0 ? (
            <EmptyState
              title="No reviews yet"
              message={open.length === 0
                ? 'The monitor reviews open positions. Once the bot opens a trade, its reviews will show up here.'
                : 'Click "Run Monitor" to get an LLM review of your open positions, or wait for the next scheduled run.'}
            />
          ) : (
            <div className="space-y-3">
              {running && (
                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-accent/5 border border-accent/15 text-xs text-accent">
                  <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                  Reviewing positions — new verdicts stream in as each coin completes.
                </div>
              )}
              {latestByCoin.map(r => (
                <ReviewCard key={r.coin} review={r} note={notesByCoin.get(r.coin) ?? null} />
              ))}
            </div>
          )}
        </Card>

        {/* Right rail: action mix + confidence per coin */}
        <div className="space-y-4">
          <Card>
            <CardHeader title="Action Mix" subtitle={`Last ${reviews.length} reviews`} />
            {loading ? (
              <Spinner />
            ) : actionMix.length === 0 ? (
              <EmptyState title="Nothing to chart" message="Action distribution appears after the first monitor run." />
            ) : (
              <>
                <div className="relative">
                  <ResponsiveContainer width="100%" height={170}>
                    <PieChart>
                      <Pie
                        data={actionMix}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={52}
                        outerRadius={76}
                        paddingAngle={3}
                        strokeWidth={0}
                      >
                        {actionMix.map(a => <Cell key={a.name} fill={a.color} />)}
                      </Pie>
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number, name: string) => [`${v} review${v !== 1 ? 's' : ''}`, name]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-2xl font-bold text-foreground tabular-nums leading-none">{reviews.length}</span>
                    <span className="text-[10px] font-semibold text-muted uppercase tracking-wider mt-1">reviews</span>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  {actionMix.map(a => (
                    <div key={a.name} className="flex items-center gap-2 text-xs">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: a.color }} />
                      <span className="text-muted flex-1">{a.name}</span>
                      <span className="text-foreground font-semibold tabular-nums">{a.value}</span>
                      <span className="text-muted tabular-nums w-10 text-right">
                        {Math.round((a.value / reviews.length) * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card>
            <CardHeader title="Conviction by Coin" subtitle="Confidence of the latest verdict" />
            {latestByCoin.length === 0 ? (
              <p className="text-xs text-muted py-2">No reviews yet.</p>
            ) : (
              <div className="space-y-3">
                {latestByCoin.map(r => (
                  <div key={r.coin} className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-foreground w-12 shrink-0">{r.coin.replace('/USDC', '')}</span>
                    <div className="flex-1"><ConfidenceBar value={r.confidence} /></div>
                    <ActionBadge action={r.action} />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* SL/TP adjustments */}
      <Card noPad>
        <div className="px-5 pt-5 pb-3">
          <CardHeader title="SL/TP Adjustments" subtitle="Protection changes proposed by the monitor" className="mb-0" />
        </div>
        {adjustments.loading ? (
          <Spinner />
        ) : recentAdjustments.length === 0 ? (
          <EmptyState title="No adjustments yet" message="When the monitor trails a stop or moves a target, the change is recorded here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-muted uppercase tracking-wider border-b border-border">
                  <th className="px-5 py-2.5">Coin</th>
                  <th className="px-3 py-2.5">Stop Loss</th>
                  <th className="px-3 py-2.5">Take Profit</th>
                  <th className="px-3 py-2.5 text-right">Confidence</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Model</th>
                  <th className="px-5 py-2.5 text-right">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recentAdjustments.slice(0, 12).map(a => (
                  <tr key={a.id} className="hover:bg-surface-elevated/40 transition-colors duration-100">
                    <td className="px-5 py-3 font-semibold text-foreground">{a.coin.replace('/USDC', '')}</td>
                    <td className="px-3 py-3 tabular-nums">
                      <DeltaCell oldVal={a.old_stop_loss} newVal={a.new_stop_loss} tone="sell" />
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <DeltaCell oldVal={a.old_take_profit} newVal={a.new_take_profit} tone="buy" />
                    </td>
                    <td className="px-3 py-3 text-right text-muted tabular-nums">
                      {a.confidence != null ? `${Math.round(a.confidence * 100)}%` : '—'}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={ADJUSTMENT_VARIANTS[a.status] ?? 'neutral'}>{a.status}</Badge>
                    </td>
                    <td className="px-3 py-3"><ModelBadge model={a.model} /></td>
                    <td className="px-5 py-3 text-right text-muted tabular-nums">{formatDate(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Review history */}
      <Card noPad>
        <div className="px-5 pt-5 pb-3">
          <CardHeader title="Review History" subtitle="Recent verdicts across monitor cycles" className="mb-0" />
        </div>
        {loading ? (
          <Spinner />
        ) : reviews.length === 0 ? (
          <EmptyState title="No history yet" message="Each monitor run appends one review per open position." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-muted uppercase tracking-wider border-b border-border">
                  <th className="px-5 py-2.5">Coin</th>
                  <th className="px-3 py-2.5">Action</th>
                  <th className="px-3 py-2.5 text-right">Confidence</th>
                  <th className="px-3 py-2.5 text-right">P&L at review</th>
                  <th className="px-3 py-2.5">Model</th>
                  <th className="px-3 py-2.5">Reasoning</th>
                  <th className="px-5 py-2.5 text-right">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {reviews.slice(0, 25).map(r => {
                  const mdata = parseMarketData(r.market_data)
                  const pnl = typeof mdata.pnlPct === 'number' ? mdata.pnlPct : null
                  return (
                    <tr key={r.id} className="hover:bg-surface-elevated/40 transition-colors duration-100">
                      <td className="px-5 py-3 font-semibold text-foreground whitespace-nowrap">{r.coin.replace('/USDC', '')}</td>
                      <td className="px-3 py-3"><ActionBadge action={r.action} /></td>
                      <td className="px-3 py-3 text-right text-muted tabular-nums">{Math.round(r.confidence * 100)}%</td>
                      <td className={cn(
                        'px-3 py-3 text-right tabular-nums',
                        pnl == null ? 'text-muted' : pnl >= 0 ? 'text-buy' : 'text-sell',
                      )}>
                        {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : '—'}
                      </td>
                      <td className="px-3 py-3"><ModelBadge model={r.model} /></td>
                      <td className="px-3 py-3 text-muted max-w-md">
                        <span className="line-clamp-1" title={r.reasoning}>{r.reasoning}</span>
                      </td>
                      <td className="px-5 py-3 text-right text-muted tabular-nums whitespace-nowrap">{formatDate(r.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function DeltaCell({ oldVal, newVal, tone }: { oldVal: number | null; newVal: number | null; tone: 'buy' | 'sell' }) {
  if (newVal == null) return <span className="text-muted">unchanged</span>
  const deltaPct = oldVal != null && oldVal !== 0
    ? ((newVal - oldVal) / Math.abs(oldVal)) * 100
    : null
  return (
    <span className={cn(tone === 'buy' ? 'text-buy' : 'text-sell')}>
      {oldVal != null && <span className="text-muted">{fmtPrice(oldVal)} → </span>}
      {fmtPrice(newVal)}
      {deltaPct != null && (
        <span className="ml-1.5 text-[11px] font-medium opacity-70">
          ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(2)}%)
        </span>
      )}
    </span>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────────

function RadarIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg className={cn('w-4 h-4', spinning && 'animate-pulse')} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.79M12 12h.008v.007H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function ClipboardIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
    </svg>
  )
}

function GaugeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  )
}
