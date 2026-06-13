import { useMemo, useState, useCallback } from 'react'
import {
  AreaChart, Area, BarChart, Bar, Cell, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { Card, CardHeader } from '../components/ui/Card'
import { Stat } from '../components/ui/Stat'
import { statusBadge } from '../components/ui/Badge'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import { GainsResponse, PortfolioSnapshot, ActivePosition } from '../types'
import { cn, fmtUSD, fmtPct, fmtDuration, formatDate } from '../lib/utils'

type RangeKey = '24h' | '7d' | '30d' | 'all'

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'all', label: 'All' },
]

const BUY = 'rgb(var(--buy-rgb))'
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

const AXIS_TICK = { fontSize: 11, fill: 'var(--muted-fg)' }

function fmtCompactUSD(v: number): string {
  const abs = Math.abs(v)
  const num = abs < 100 ? abs.toFixed(2) : abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return (v < 0 ? '-$' : '$') + num
}

function fmtSignedUSD(v: number): string {
  return (v >= 0 ? '+' : '') + fmtUSD(v)
}

export default function TradingState() {
  const [range, setRange] = useState<RangeKey>('7d')
  const snaps = useApi<PortfolioSnapshot[]>(`/api/portfolio/snapshots?range=${range}`)
  const gains = useApi<GainsResponse>('/api/portfolio/gains')
  const positions = useApi<ActivePosition[]>('/api/positions')

  const reloadAll = useCallback(() => {
    snaps.reload()
    gains.reload()
    positions.reload()
  }, [snaps.reload, gains.reload, positions.reload]) // eslint-disable-line react-hooks/exhaustive-deps

  useWebSocket(useCallback((event: string) => {
    if (['pipeline_completed', 'trade_executed', 'stop_loss_hit', 'take_profit_hit', 'portfolio_updated'].includes(event)) {
      reloadAll()
    }
  }, [reloadAll]))

  const closed = gains.data?.positions ?? []
  const open = positions.data ?? []

  const stats = useMemo(() => {
    const wins = closed.filter(p => p.pnl > 0)
    const losses = closed.filter(p => p.pnl <= 0)
    const grossProfit = wins.reduce((s, p) => s + p.pnl, 0)
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p.pnl, 0))
    const totalPnl = gains.data?.total_pnl ?? 0
    const invested = closed.reduce((s, p) => s + p.entry_price * p.quantity, 0)
    const sorted = [...closed].sort((a, b) => b.pnl - a.pnl)
    return {
      totalPnl,
      totalPnlPct: invested > 0 ? (totalPnl / invested) * 100 : null,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
      wins: wins.length,
      losses: losses.length,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      avgWin: wins.length > 0 ? grossProfit / wins.length : null,
      avgLoss: losses.length > 0 ? -grossLoss / losses.length : null,
      expectancy: closed.length > 0 ? totalPnl / closed.length : null,
      avgHold: closed.length > 0 ? closed.reduce((s, p) => s + p.duration_seconds, 0) / closed.length : null,
      best: sorted[0] ?? null,
      worst: sorted.length > 1 ? sorted[sorted.length - 1] : null,
      openPnl: open.reduce((s, p) => s + (p.pnl ?? 0), 0),
      fees: gains.data?.total_bnb_fees ?? 0,
    }
  }, [closed, open, gains.data])

  // Equity curve over the selected range
  const equity = snaps.data ?? []
  const equityDelta = equity.length >= 2 ? equity[equity.length - 1].total_value_usd - equity[0].total_value_usd : null
  const equityDeltaPct = equityDelta != null && equity[0].total_value_usd > 0
    ? (equityDelta / equity[0].total_value_usd) * 100
    : null

  // Cumulative realized PnL, oldest first
  const cumulative = useMemo(() => {
    let sum = 0
    return [...closed]
      .sort((a, b) => (a.closed_at ?? a.opened_at).localeCompare(b.closed_at ?? b.opened_at))
      .map(p => {
        sum += p.pnl
        return { date: p.closed_at ?? p.opened_at, pnl: Math.round(sum * 100) / 100, coin: p.coin.replace('/USDC', '') }
      })
  }, [closed])

  // Realized PnL aggregated per coin
  const byCoin = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of closed) {
      const coin = p.coin.replace('/USDC', '')
      m.set(coin, (m.get(coin) ?? 0) + p.pnl)
    }
    return [...m.entries()]
      .map(([coin, pnl]) => ({ coin, pnl: Math.round(pnl * 100) / 100 }))
      .sort((a, b) => b.pnl - a.pnl)
  }, [closed])

  const outcomes = useMemo(() => {
    const count = (s: string) => closed.filter(p => p.status === s).length
    return [
      { name: 'Take profit', value: count('TP_HIT'), color: BUY },
      { name: 'Stop loss', value: count('SL_HIT'), color: SELL },
      { name: 'Manual / bot close', value: count('CLOSED'), color: ACCENT },
    ].filter(o => o.value > 0)
  }, [closed])

  const timeTick = (v: string) => range === '24h'
    ? new Date(v.includes('T') ? v : v + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : formatDate(v)

  return (
    <div className="space-y-6 animate-fade-in">

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat
          label="Realized P&L"
          value={fmtSignedUSD(stats.totalPnl)}
          sub={stats.totalPnlPct != null ? `${fmtPct(stats.totalPnlPct)} on invested capital` : `${closed.length} closed trades`}
          trend={stats.totalPnl >= 0 ? 'up' : 'down'}
          icon={<TrendIcon up={stats.totalPnl >= 0} />}
        />
        <Stat
          label="Win Rate"
          value={stats.winRate != null ? `${stats.winRate.toFixed(0)}%` : '—'}
          sub={closed.length > 0 ? `${stats.wins} wins · ${stats.losses} losses` : 'No closed trades yet'}
          trend={stats.winRate == null ? 'neutral' : stats.winRate >= 50 ? 'up' : 'down'}
          icon={<TargetIcon />}
        />
        <Stat
          label="Profit Factor"
          value={stats.profitFactor != null ? stats.profitFactor.toFixed(2) : stats.wins > 0 ? '∞' : '—'}
          sub="Gross profit ÷ gross loss"
          trend={stats.profitFactor == null ? 'neutral' : stats.profitFactor >= 1 ? 'up' : 'down'}
          icon={<ScaleIcon />}
        />
        <Stat
          label="Avg Hold Time"
          value={stats.avgHold != null ? fmtDuration(Math.round(stats.avgHold)) : '—'}
          sub={`Open P&L ${fmtSignedUSD(stats.openPnl)} across ${open.length} position${open.length !== 1 ? 's' : ''}`}
          trend={stats.openPnl > 0 ? 'up' : stats.openPnl < 0 ? 'down' : 'neutral'}
          icon={<HourglassIcon />}
        />
      </div>

      {/* Equity curve */}
      <Card noPad>
        <div className="px-5 pt-5 pb-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardHeader
              title="Equity Curve"
              subtitle="Total portfolio value per pipeline cycle"
              className="mb-0"
            />
            {equityDelta != null && (
              <span className={cn(
                'mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums border',
                equityDelta >= 0 ? 'bg-buy/10 border-buy/20 text-buy' : 'bg-sell/10 border-sell/20 text-sell',
              )}>
                {fmtSignedUSD(equityDelta)}
                {equityDeltaPct != null && ` (${fmtPct(equityDeltaPct)})`}
                <span className="opacity-60 font-medium">over {RANGES.find(r => r.key === range)?.label}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 p-1 rounded-xl bg-surface-elevated border border-border">
            {RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  'px-3 py-1 rounded-lg text-xs font-semibold transition-colors duration-150',
                  range === r.key ? 'bg-accent/15 text-accent' : 'text-muted hover:text-foreground',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {snaps.loading ? (
          <ChartSpinner />
        ) : equity.length < 2 ? (
          <ChartEmpty message="Not enough snapshots in this range yet. Each pipeline cycle records one." />
        ) : (
          <div className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={equity} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <XAxis
                  dataKey="created_at"
                  tickFormatter={timeTick}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={48}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tickFormatter={fmtCompactUSD}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={70}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={formatDate}
                  formatter={(v: number) => [fmtUSD(v), 'Portfolio value']}
                  cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                />
                <Area
                  type="monotone"
                  dataKey="total_value_usd"
                  stroke={ACCENT}
                  strokeWidth={2}
                  fill="url(#equityFill)"
                  activeDot={{ r: 4, strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Cumulative PnL + exit outcomes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card noPad className="lg:col-span-2">
          <div className="px-5 pt-5 pb-2">
            <CardHeader title="Cumulative Realized P&L" subtitle="Running total across closed positions" />
          </div>
          {gains.loading ? (
            <ChartSpinner />
          ) : cumulative.length === 0 ? (
            <ChartEmpty message="No closed positions yet." />
          ) : (
            <div className="px-2 pb-4">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={cumulative} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={stats.totalPnl >= 0 ? BUY : SELL} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={stats.totalPnl >= 0 ? BUY : SELL} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDate}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={48}
                  />
                  <YAxis
                    tickFormatter={fmtCompactUSD}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={formatDate}
                    formatter={(v: number, _n, item) => [
                      `${fmtSignedUSD(v)} (after ${(item?.payload as { coin?: string })?.coin ?? '?'})`,
                      'Cumulative P&L',
                    ]}
                    cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                  />
                  <ReferenceLine y={0} stroke="var(--border-color)" strokeDasharray="4 4" />
                  <Area
                    type="monotone"
                    dataKey="pnl"
                    stroke={stats.totalPnl >= 0 ? BUY : SELL}
                    strokeWidth={2}
                    fill="url(#pnlFill)"
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card noPad>
          <div className="px-5 pt-5 pb-2">
            <CardHeader title="Exit Outcomes" subtitle="How positions were closed" />
          </div>
          {gains.loading ? (
            <ChartSpinner />
          ) : outcomes.length === 0 ? (
            <ChartEmpty message="No closed positions yet." />
          ) : (
            <div className="px-5 pb-5">
              <div className="relative">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={outcomes}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={56}
                      outerRadius={80}
                      paddingAngle={3}
                      strokeWidth={0}
                    >
                      {outcomes.map(o => <Cell key={o.name} fill={o.color} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number, name: string) => [`${v} trade${v !== 1 ? 's' : ''}`, name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-2xl font-bold text-foreground tabular-nums leading-none">{closed.length}</span>
                  <span className="text-[10px] font-semibold text-muted uppercase tracking-wider mt-1">closed</span>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                {outcomes.map(o => (
                  <div key={o.name} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: o.color }} />
                    <span className="text-muted flex-1">{o.name}</span>
                    <span className="text-foreground font-semibold tabular-nums">{o.value}</span>
                    <span className="text-muted tabular-nums w-10 text-right">
                      {Math.round((o.value / closed.length) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* PnL by coin + trade statistics */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card noPad className="lg:col-span-2">
          <div className="px-5 pt-5 pb-2">
            <CardHeader title="Realized P&L by Coin" subtitle="Aggregated across all closed positions" />
          </div>
          {gains.loading ? (
            <ChartSpinner />
          ) : byCoin.length === 0 ? (
            <ChartEmpty message="No closed positions yet." />
          ) : (
            <div className="px-2 pb-4">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={byCoin} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                  <XAxis
                    dataKey="coin"
                    tick={{ ...AXIS_TICK, fontWeight: 600 }}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                  />
                  <YAxis
                    tickFormatter={fmtCompactUSD}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v: number) => [fmtSignedUSD(v), 'Realized P&L']}
                    cursor={{ fill: 'var(--border-color)', opacity: 0.3 }}
                  />
                  <ReferenceLine y={0} stroke="var(--border-color)" />
                  <Bar dataKey="pnl" radius={[6, 6, 0, 0]} maxBarSize={48}>
                    {byCoin.map(c => <Cell key={c.coin} fill={c.pnl >= 0 ? BUY : SELL} fillOpacity={0.85} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Trade Statistics" subtitle="Closed positions only" />
          <div className="space-y-1">
            <StatRow label="Average win" value={stats.avgWin != null ? fmtSignedUSD(stats.avgWin) : '—'} tone="buy" />
            <StatRow label="Average loss" value={stats.avgLoss != null ? fmtUSD(stats.avgLoss) : '—'} tone="sell" />
            <StatRow label="Expectancy / trade" value={stats.expectancy != null ? fmtSignedUSD(stats.expectancy) : '—'} tone={stats.expectancy != null && stats.expectancy >= 0 ? 'buy' : 'sell'} />
            <StatRow
              label="Best trade"
              value={stats.best ? `${stats.best.coin.replace('/USDC', '')} ${fmtSignedUSD(stats.best.pnl)}` : '—'}
              tone="buy"
            />
            <StatRow
              label="Worst trade"
              value={stats.worst ? `${stats.worst.coin.replace('/USDC', '')} ${fmtSignedUSD(stats.worst.pnl)}` : '—'}
              tone="sell"
            />
            <StatRow label="BNB fees paid" value={stats.fees > 0 ? stats.fees.toFixed(6) + ' BNB' : '—'} />
          </div>
        </Card>
      </div>

      {/* Recent closed positions */}
      <Card noPad>
        <div className="px-5 pt-5 pb-3">
          <CardHeader title="Closed Positions" subtitle={`${closed.length} total`} />
        </div>
        {closed.length === 0 ? (
          <ChartEmpty message="The bot hasn't closed any positions yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-muted uppercase tracking-wider border-b border-border">
                  <th className="px-5 py-2.5">Coin</th>
                  <th className="px-3 py-2.5">Outcome</th>
                  <th className="px-3 py-2.5 text-right">Entry</th>
                  <th className="px-3 py-2.5 text-right">P&L</th>
                  <th className="px-3 py-2.5 text-right">P&L %</th>
                  <th className="px-3 py-2.5 text-right">Held</th>
                  <th className="px-5 py-2.5 text-right">Closed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {closed.slice(0, 12).map(p => (
                  <tr key={p.id} className="hover:bg-surface-elevated/40 transition-colors duration-100">
                    <td className="px-5 py-3 font-semibold text-foreground">{p.coin.replace('/USDC', '')}</td>
                    <td className="px-3 py-3">{statusBadge(p.status)}</td>
                    <td className="px-3 py-3 text-right text-muted tabular-nums">{fmtUSD(p.entry_price)}</td>
                    <td className={cn('px-3 py-3 text-right font-semibold tabular-nums', p.pnl >= 0 ? 'text-buy' : 'text-sell')}>
                      {fmtSignedUSD(p.pnl)}
                    </td>
                    <td className={cn('px-3 py-3 text-right tabular-nums', p.pnl_pct >= 0 ? 'text-buy/80' : 'text-sell/80')}>
                      {fmtPct(p.pnl_pct)}
                    </td>
                    <td className="px-3 py-3 text-right text-muted tabular-nums">{fmtDuration(p.duration_seconds)}</td>
                    <td className="px-5 py-3 text-right text-muted tabular-nums">
                      {p.closed_at ? formatDate(p.closed_at) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function StatRow({ label, value, tone }: { label: string; value: string; tone?: 'buy' | 'sell' }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={cn(
        'text-sm font-semibold tabular-nums',
        tone === 'buy' && value !== '—' ? 'text-buy' : tone === 'sell' && value !== '—' ? 'text-sell' : 'text-foreground',
      )}>
        {value}
      </span>
    </div>
  )
}

function ChartSpinner() {
  return (
    <div className="flex items-center justify-center h-52">
      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-52 px-6 text-center">
      <div className="w-9 h-9 rounded-full bg-surface-elevated flex items-center justify-center mb-2">
        <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
        </svg>
      </div>
      <p className="text-sm text-muted">{message}</p>
    </div>
  )
}

function TrendIcon({ up }: { up: boolean }) {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={up
        ? 'M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941'
        : 'M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898m0 0l3.182-5.511m-3.182 5.51l-5.511-3.181'} />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18z M12 17a5 5 0 100-10 5 5 0 000 10z M12 13a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  )
}

function ScaleIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0012 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 01-2.031.352 5.988 5.988 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 01-2.031.352 5.989 5.989 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971z" />
    </svg>
  )
}

function HourglassIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
