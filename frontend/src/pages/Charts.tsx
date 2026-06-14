import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { Card, CardHeader } from '../components/ui/Card'
import { Stat } from '../components/ui/Stat'
import { actionBadge } from '../components/ui/Badge'
import { useWebSocket } from '../hooks/useWebSocket'
import { ChartPoint, Decision, PipelineEvent } from '../types'
import { formatDate, timeAgo, cn } from '../lib/utils'

interface ApiPoint extends ChartPoint {
  action: string
  confidence: number
}

interface ChartRow {
  created_at: string
  [coin: string]: number | string
}

const COIN_COLORS = [
  'rgb(var(--accent-rgb))',
  '#3b82f6',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#22d3ee',
  '#a3e635',
  '#fb7185',
]

function coinColor(coin: string, coins: string[]): string {
  const i = coins.indexOf(coin)
  return COIN_COLORS[(i < 0 ? 0 : i) % COIN_COLORS.length]
}

const RANGES = [
  { key: '24h', label: '24H', ms: 24 * 3600 * 1000 },
  { key: '7d',  label: '7D',  ms: 7 * 24 * 3600 * 1000 },
  { key: '30d', label: '30D', ms: 30 * 24 * 3600 * 1000 },
  { key: 'all', label: 'All', ms: Infinity },
] as const

type RangeKey = typeof RANGES[number]['key']

function parseTime(iso: string) {
  return new Date(iso.includes('T') ? iso : iso + 'Z').getTime()
}

export default function Charts() {
  const [data, setData] = useState<ApiPoint[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<RangeKey>('7d')
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => {
    Promise.allSettled([
      fetch('/api/chart').then(r => r.json()),
      fetch('/api/decisions').then(r => r.json()),
    ]).then(([chart, decs]) => {
      if (chart.status === 'fulfilled' && Array.isArray(chart.value)) setData(chart.value)
      if (decs.status === 'fulfilled' && Array.isArray(decs.value)) setDecisions(decs.value)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Live: a fresh analyst signal appends to both the timeline and the feed.
  useWebSocket(useCallback((event: string, payload: unknown) => {
    if (event !== 'pipeline_event') return
    const pe = payload as PipelineEvent
    if (pe.stage !== 'signal_generated') return
    let d: Record<string, unknown> = {}
    try { d = JSON.parse(pe.data) } catch { return }
    const coin = String(d.symbol || pe.coin)
    const action = String(d.action || 'HOLD')
    const confidence = Number(d.confidence || 0)
    const created_at = pe.created_at
    const value = confidence * (action === 'BUY' ? 1 : action === 'SELL' ? -1 : 0)
    setData(prev => [...prev, { coin, action, confidence, value, created_at }])
    setDecisions(prev => [
      { id: pe.id, coin, action: action as Decision['action'], reason: String(d.reason || ''), confidence, created_at },
      ...prev,
    ].slice(0, 60))
  }, []))

  const now = Date.now()
  const rangeMs = RANGES.find(r => r.key === range)!.ms
  const filtered = useMemo(
    () => rangeMs === Infinity ? data : data.filter(d => now - parseTime(d.created_at) <= rangeMs),
    [data, rangeMs, now],
  )

  const coins = useMemo(() => [...new Set(filtered.map(d => d.coin))].sort(), [filtered])

  // Per-(time,coin) lookup so the tooltip can show the exact action + confidence.
  const lookup = useMemo(() => {
    const m = new Map<string, ApiPoint>()
    for (const p of filtered) m.set(`${p.created_at}|${p.coin}`, p)
    return m
  }, [filtered])

  const rows: ChartRow[] = useMemo(() => Object.values(
    filtered.reduce<Record<string, ChartRow>>((acc, pt) => {
      if (!acc[pt.created_at]) acc[pt.created_at] = { created_at: pt.created_at }
      acc[pt.created_at][pt.coin] = pt.value
      return acc
    }, {})
  ).sort((a, b) => parseTime(a.created_at as string) - parseTime(b.created_at as string)), [filtered])

  const stats = useMemo(() => {
    let buy = 0, sell = 0, hold = 0, confSum = 0
    for (const p of filtered) {
      if (p.action === 'BUY') buy++
      else if (p.action === 'SELL') sell++
      else hold++
      confSum += p.confidence
    }
    const total = filtered.length
    return {
      total, buy, sell, hold,
      avgConf: total > 0 ? confSum / total : 0,
      coins: coins.length,
    }
  }, [filtered, coins.length])

  // Per-coin rollup for the summary panel.
  const perCoin = useMemo(() => {
    const map = new Map<string, { coin: string; count: number; confSum: number; last: ApiPoint }>()
    for (const p of filtered) {
      const e = map.get(p.coin)
      if (!e) map.set(p.coin, { coin: p.coin, count: 1, confSum: p.confidence, last: p })
      else {
        e.count++; e.confSum += p.confidence
        if (parseTime(p.created_at) >= parseTime(e.last.created_at)) e.last = p
      }
    }
    return [...map.values()]
      .map(e => ({ ...e, avgConf: e.confSum / e.count }))
      .sort((a, b) => b.count - a.count)
  }, [filtered])

  const visibleCoins = coins.filter(c => !hidden.has(c))
  const single = visibleCoins.length === 1

  function toggleCoin(coin: string) {
    setHidden(prev => {
      const s = new Set(prev)
      if (s.has(coin)) s.delete(coin); else s.add(coin)
      return s
    })
  }

  return (
    <div className="space-y-5 animate-fade-in">

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Total Signals" value={stats.total} icon={<PulseIcon />} sub={`${stats.coins} coin${stats.coins !== 1 ? 's' : ''} tracked`} />
        <Stat
          label="Avg Confidence"
          value={`${Math.round(stats.avgConf * 100)}%`}
          icon={<GaugeIcon />}
          trend={stats.avgConf >= 0.6 ? 'up' : stats.avgConf >= 0.4 ? 'neutral' : 'down'}
          sub={stats.avgConf >= 0.6 ? 'high conviction' : stats.avgConf >= 0.4 ? 'moderate' : 'low conviction'}
        />
        <Stat label="Buy Signals" value={stats.buy} icon={<UpIcon />} trend="up" sub={stats.total ? `${Math.round(stats.buy / stats.total * 100)}% of signals` : '—'} className="!border-buy/15" />
        <Stat label="Sell Signals" value={stats.sell} icon={<DownIcon />} trend="down" sub={stats.total ? `${Math.round(stats.sell / stats.total * 100)}% of signals` : '—'} className="!border-sell/15" />
      </div>

      {/* Bias breakdown bar */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground tracking-tight">Signal Bias</h3>
          <span className="text-xs text-muted">{stats.total} decisions</span>
        </div>
        {stats.total === 0 ? (
          <p className="text-sm text-muted">No signals in range.</p>
        ) : (
          <>
            <div className="flex h-3 rounded-full overflow-hidden bg-surface-elevated">
              <div className="bg-buy/80 transition-all duration-500" style={{ width: `${stats.buy / stats.total * 100}%` }} />
              <div className="bg-warn/70 transition-all duration-500" style={{ width: `${stats.hold / stats.total * 100}%` }} />
              <div className="bg-sell/80 transition-all duration-500" style={{ width: `${stats.sell / stats.total * 100}%` }} />
            </div>
            <div className="flex items-center gap-5 mt-3 text-xs">
              <LegendDot cls="bg-buy" label="Buy" value={stats.buy} />
              <LegendDot cls="bg-warn" label="Hold" value={stats.hold} />
              <LegendDot cls="bg-sell" label="Sell" value={stats.sell} />
            </div>
          </>
        )}
      </Card>

      {/* Signal timeline */}
      <Card noPad>
        <div className="px-5 pt-5 pb-3 flex flex-wrap items-start justify-between gap-3">
          <CardHeader
            title="Signal Timeline"
            subtitle="Analyst conviction per coin — BUY above the line, SELL below"
            className="mb-0"
          />
          <div className="flex items-center gap-1 bg-surface-elevated rounded-xl p-1 border border-border">
            {RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors',
                  range === r.key ? 'bg-accent/15 text-accent' : 'text-muted hover:text-foreground',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Coin toggle chips */}
        {coins.length > 0 && (
          <div className="px-5 pb-3 flex flex-wrap items-center gap-1.5">
            {coins.map(coin => {
              const color = coinColor(coin, coins)
              const off = hidden.has(coin)
              return (
                <button
                  key={coin}
                  onClick={() => toggleCoin(coin)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all',
                    off ? 'border-border text-muted/60 bg-transparent' : 'border-border text-foreground bg-surface-elevated',
                  )}
                >
                  <span
                    className="w-2 h-2 rounded-full transition-opacity"
                    style={{ backgroundColor: color, opacity: off ? 0.3 : 1 }}
                  />
                  {coin.replace('/USDC', '')}
                </button>
              )
            })}
            {hidden.size > 0 && (
              <button onClick={() => setHidden(new Set())} className="text-xs text-accent hover:underline ml-1">
                Show all
              </button>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-80">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-80 text-sm text-muted gap-2">
            <PulseIcon />
            No signals recorded in this range.
          </div>
        ) : (
          <div className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={420}>
              <ComposedChart data={rows} margin={{ top: 10, right: 20, bottom: 6, left: -8 }}>
                <defs>
                  {coins.map(coin => {
                    const color = coinColor(coin, coins)
                    return (
                      <linearGradient key={coin} id={`fill-${coin.replace(/[^a-zA-Z0-9]/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                        <stop offset="50%" stopColor={color} stopOpacity={0.04} />
                        <stop offset="100%" stopColor={color} stopOpacity={0.35} />
                      </linearGradient>
                    )
                  })}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <XAxis
                  dataKey="created_at"
                  tickFormatter={formatDate}
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                />
                <YAxis
                  domain={[-1, 1]}
                  ticks={[-1, -0.5, 0, 0.5, 1]}
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={(v: number) => v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`}
                />
                <Tooltip content={<SignalTooltip coins={coins} lookup={lookup} />} cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }} />
                <ReferenceLine y={0} stroke="var(--muted-fg)" strokeOpacity={0.4} strokeDasharray="4 4" />
                {visibleCoins.map(coin => {
                  const color = coinColor(coin, coins)
                  const id = `fill-${coin.replace(/[^a-zA-Z0-9]/g, '')}`
                  return single ? (
                    <Area
                      key={coin}
                      type="monotone"
                      dataKey={coin}
                      name={coin}
                      stroke={color}
                      strokeWidth={2.5}
                      fill={`url(#${id})`}
                      baseValue={0}
                      dot={false}
                      connectNulls
                      activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface-card)' }}
                      isAnimationActive={false}
                    />
                  ) : (
                    <Line
                      key={coin}
                      type="monotone"
                      dataKey={coin}
                      name={coin}
                      stroke={color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-card)' }}
                      isAnimationActive={false}
                    />
                  )
                })}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* By coin + recent feed */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card noPad>
          <div className="px-5 pt-5 pb-3">
            <CardHeader title="By Coin" subtitle="Signal activity in range" className="mb-0" />
          </div>
          {perCoin.length === 0 ? (
            <EmptyRow message="No coins in range." />
          ) : (
            <div className="divide-y divide-border">
              {perCoin.map(c => (
                <div key={c.coin} className="px-5 py-3 flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: coinColor(c.coin, coins) }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{c.coin.replace('/USDC', '')}</span>
                      {actionBadge(c.last.action)}
                    </div>
                    <p className="text-[11px] text-muted mt-0.5">{c.count} signal{c.count !== 1 ? 's' : ''} · last {timeAgo(c.last.created_at)}</p>
                  </div>
                  <div className="w-24 shrink-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-muted uppercase tracking-wide">avg conf</span>
                      <span className="text-[11px] font-semibold text-foreground tabular-nums">{Math.round(c.avgConf * 100)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-surface-elevated overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', c.avgConf >= 0.6 ? 'bg-buy' : c.avgConf >= 0.4 ? 'bg-warn' : 'bg-sell')}
                        style={{ width: `${Math.round(c.avgConf * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card noPad>
          <div className="px-5 pt-5 pb-3">
            <CardHeader title="Recent Signals" subtitle="Latest analyst decisions" className="mb-0" />
          </div>
          {decisions.length === 0 ? (
            <EmptyRow message="No signals yet." />
          ) : (
            <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
              {decisions.slice(0, 30).map(d => (
                <div key={`${d.id}-${d.created_at}`} className="px-5 py-3 flex items-start gap-3 hover:bg-surface-elevated/40 transition-colors duration-100">
                  <div className="shrink-0 mt-0.5">{actionBadge(d.action)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{d.coin.replace('/USDC', '')}</span>
                      <span className="text-[11px] text-muted tabular-nums shrink-0">{timeAgo(d.created_at)}</span>
                    </div>
                    {d.reason && <p className="text-xs text-muted line-clamp-2 mt-0.5 leading-relaxed">{d.reason}</p>}
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="flex-1 h-1 rounded-full bg-surface-elevated overflow-hidden max-w-[140px]">
                        <div
                          className={cn('h-full rounded-full', d.action === 'BUY' ? 'bg-buy' : d.action === 'SELL' ? 'bg-sell' : 'bg-warn')}
                          style={{ width: `${Math.round(d.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted tabular-nums">{Math.round(d.confidence * 100)}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

/* ============================================================
   Custom tooltip
   ============================================================ */

interface TooltipProps {
  active?: boolean
  label?: string | number
  payload?: { dataKey: string; value: number; color: string }[]
  coins: string[]
  lookup: Map<string, ApiPoint>
}

function SignalTooltip({ active, label, payload, lookup }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const ts = String(label)
  return (
    <div className="bg-surface-elevated border border-border rounded-xl shadow-soft px-3 py-2 text-xs">
      <p className="text-muted font-medium mb-1.5">{formatDate(ts)}</p>
      <div className="space-y-1">
        {payload.map(p => {
          const pt = lookup.get(`${ts}|${p.dataKey}`)
          if (!pt) return null
          const v: ActionTone = pt.action === 'BUY' ? 'buy' : pt.action === 'SELL' ? 'sell' : 'hold'
          return (
            <div key={p.dataKey} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
              <span className="text-foreground font-medium">{p.dataKey.replace('/USDC', '')}</span>
              <span className={cn(
                'ml-auto font-semibold tabular-nums',
                v === 'buy' ? 'text-buy' : v === 'sell' ? 'text-sell' : 'text-warn',
              )}>
                {pt.action} {Math.round(pt.confidence * 100)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type ActionTone = 'buy' | 'sell' | 'hold'

/* ============================================================
   Small bits + icons
   ============================================================ */

function LegendDot({ cls, label, value }: { cls: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <span className={cn('w-2 h-2 rounded-full', cls)} />
      <span className="text-foreground font-medium">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  )
}

function EmptyRow({ message }: { message: string }) {
  return <p className="px-5 pb-6 pt-2 text-sm text-muted text-center">{message}</p>
}

function PulseIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h3l2.25-6 4.5 12 2.25-6h4.5" />
    </svg>
  )
}

function GaugeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3a9 9 0 00-9 9h3m6-9a9 9 0 019 9h-3m-6-9v3m4.5 1.5L12 12" />
    </svg>
  )
}

function UpIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.306a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.281m5.94 2.28l-2.28 5.941" />
    </svg>
  )
}

function DownIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898m0 0l3.182-5.511m-3.182 5.51l-5.511-3.181" />
    </svg>
  )
}
