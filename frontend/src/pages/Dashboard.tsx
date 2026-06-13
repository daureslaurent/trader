import { useEffect, useState, useCallback, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { usePrices } from '../hooks/usePrices'
import { TradeApproval } from '../components/TradeApproval'
import { TradeHistory } from '../components/TradeHistory'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge, actionBadge } from '../components/ui/Badge'
import { ApprovalRequest, Trade, ActivePosition, Decision, PortfolioResponse, AdjustmentRequest, PositionAdjustment, GainsResponse, EntryIntent } from '../types'
import { Button } from '../components/ui/Button'
import { fmtUSD, fmtPct, cn } from '../lib/utils'

interface Alert {
  id: number
  type: 'SL' | 'TP'
  coin: string
  price: number
}

interface LiveCoin {
  coin: string
  stage: string
  action?: string
  confidence?: number
}

interface Props {
  onApprovalAction?: () => void
}

const STAGE_CHIP: Record<string, { label: string; cls: string; pulse?: boolean }> = {
  researching: { label: 'Researching', cls: 'text-blue-400 bg-blue-400/10',     pulse: true  },
  researched:  { label: 'Researched',  cls: 'text-blue-400 bg-blue-400/10'                   },
  extracting:  { label: 'Extracting',  cls: 'text-violet-400 bg-violet-400/10', pulse: true  },
  extracted:   { label: 'Extracted',   cls: 'text-violet-400 bg-violet-400/10'               },
  selecting:   { label: 'Selecting',   cls: 'text-amber-400 bg-amber-400/10',   pulse: true  },
  selected:    { label: 'Selected',    cls: 'text-amber-400 bg-amber-400/10'                 },
  analyzing:   { label: 'Analysing',   cls: 'text-accent bg-accent/10',         pulse: true  },
  signal:      { label: 'Signal',      cls: 'text-buy bg-buy/10'                             },
  entry_queued:{ label: 'Entry queued',cls: 'text-accent bg-accent/10',         pulse: true  },
  traded:      { label: 'Traded',      cls: 'text-buy bg-buy/10'                             },
  skipped:     { label: 'Skipped',     cls: 'text-muted bg-muted/10'                         },
  error:       { label: 'Error',       cls: 'text-sell bg-sell/10'                           },
  cancelled:   { label: 'Cancelled',   cls: 'text-muted bg-muted/10'                         },
}

function mapStage(stage: string): string {
  const m: Record<string, string> = {
    research_started: 'researching', research_completed: 'researched',
    extraction_started: 'extracting', extraction_completed: 'extracted',
    selection_started: 'selecting', selection_completed: 'selected',
    analysis_started: 'analyzing',
    signal_generated: 'signal',
    entry_intent_created: 'entry_queued',
    trade_executed: 'traded', trade_skipped: 'skipped',
    pipeline_error: 'error', pipeline_timeout: 'error', pipeline_failed: 'error',
    pipeline_cancelled: 'cancelled',
  }
  return m[stage] ?? stage
}

export default function Dashboard({ onApprovalAction }: Props) {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [gains, setGains] = useState<GainsResponse | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [positions, setPositions] = useState<ActivePosition[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [entryIntents, setEntryIntents] = useState<EntryIntent[]>([])
  const [adjustments, setAdjustments] = useState<AdjustmentRequest[]>([])
  const [adjHistory, setAdjHistory] = useState<PositionAdjustment[]>([])
  const [adjHistoryOpen, setAdjHistoryOpen] = useState(false)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [discoveryRunning, setDiscoveryRunning] = useState(false)
  const [monitorRunning, setMonitorRunning] = useState(false)
  const [pendingDiscoveries, setPendingDiscoveries] = useState(0)
  const [watchlistCount, setWatchlistCount] = useState(0)
  const [discoverCron, setDiscoverCron] = useState('')
  const [liveCoins, setLiveCoins] = useState<Map<string, LiveCoin>>(new Map())
  const [now, setNow] = useState(Date.now())
  const prices = usePrices()
  const pipelineWasRunning = useRef(false)

  function loadAll() {
    Promise.allSettled([
      fetch('/api/portfolio').then(r => r.json()),
      fetch('/api/portfolio/gains').then(r => r.json()),
      fetch('/api/trades').then(r => r.json()),
      fetch('/api/positions').then(r => r.json()),
      fetch('/api/decisions').then(r => r.json()),
      fetch('/api/pipeline/status').then(r => r.json()),
      fetch('/api/discover').then(r => r.json()),
      fetch('/api/monitor').then(r => r.json()),
      fetch('/api/settings').then(r => r.json()),
    ]).then(([port, gns, trd, pos, dec, pipe, disc, mon, sett]) => {
      if (port.status === 'fulfilled') setPortfolio(port.value)
      if (gns.status === 'fulfilled') setGains(gns.value)
      if (trd.status === 'fulfilled') setTrades(trd.value)
      if (pos.status === 'fulfilled') setPositions(pos.value)
      if (dec.status === 'fulfilled') setDecisions(dec.value)
      if (pipe.status === 'fulfilled') {
        const running = pipe.value.running ?? false
        setPipelineRunning(running)
        if (!running) pipelineWasRunning.current = false
      }
      if (disc.status === 'fulfilled') {
        setDiscoveryRunning(disc.value.running ?? false)
        setPendingDiscoveries((disc.value.discoveries ?? []).filter((d: { status: string }) => d.status === 'pending').length)
      }
      if (mon.status === 'fulfilled') setMonitorRunning(mon.value.running ?? false)
      if (sett.status === 'fulfilled') {
        setWatchlistCount((sett.value.watchlist ?? []).length)
        setDiscoverCron(sett.value.discover_cron ?? '')
      }
    })
  }

  function loadAdjustments() {
    fetch('/api/adjustments?status=PENDING')
      .then(r => r.json())
      .then((rows: PositionAdjustment[]) => {
        if (!Array.isArray(rows)) return
        setAdjustments(rows.map(a => ({
          adjustmentId: a.id,
          coin: a.coin,
          oldStopLoss: a.old_stop_loss,
          oldTakeProfit: a.old_take_profit,
          newStopLoss: a.new_stop_loss,
          newTakeProfit: a.new_take_profit,
          reasoning: a.reasoning ?? '',
          confidence: a.confidence ?? 0,
          expiresAt: '',
        })))
      })
      .catch(() => {})
  }

  function loadAdjHistory() {
    fetch('/api/adjustments?limit=30')
      .then(r => r.json())
      .then((rows: PositionAdjustment[]) => {
        if (Array.isArray(rows)) setAdjHistory(rows)
      })
      .catch(() => {})
  }

  function loadPendingApprovals() {
    fetch('/api/approvals')
      .then(r => r.json())
      .then((data: ApprovalRequest[]) => {
        if (Array.isArray(data)) setApprovals(data)
      })
      .catch(() => {})
  }

  function loadEntryIntents() {
    fetch('/api/entry-intents')
      .then(r => r.json())
      .then((data: EntryIntent[]) => {
        if (Array.isArray(data)) setEntryIntents(data)
      })
      .catch(() => {})
  }

  useEffect(() => { loadAll(); loadAdjustments(); loadAdjHistory(); loadPendingApprovals(); loadEntryIntents() }, [])

  useEffect(() => {
    if (!pipelineRunning) return
    const t = setInterval(() => {
      fetch('/api/pipeline/status').then(r => r.json()).then(d => {
        const running = d.running ?? false
        setPipelineRunning(running)
        if (!running) {
          pipelineWasRunning.current = false
          loadAll()
        }
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [pipelineRunning])

  useWebSocket(useCallback((event: string, data: unknown) => {
    if (event === 'approval_requested') {
      setApprovals(prev => [...prev, data as ApprovalRequest])
    } else if (event === 'trade_rejected') {
      setApprovals(prev => prev.filter(a => a.tradeId !== (data as number)))
    } else if (event === 'adjustment_requested') {
      setAdjustments(prev => [...prev, data as AdjustmentRequest])
      loadAdjHistory()
    } else if (event === 'adjustment_resolved') {
      const d = data as { adjustmentId: number }
      setAdjustments(prev => prev.filter(a => a.adjustmentId !== d.adjustmentId))
      loadAll()
      loadAdjHistory()
    } else if (event === 'position_adjusted') {
      loadAll()
      loadAdjHistory()
    } else if (event === 'stop_loss_hit') {
      const d = data as { coin: string; price: number }
      setAlerts(prev => [{ id: Date.now(), type: 'SL' as const, coin: d.coin, price: d.price }, ...prev].slice(0, 5))
      loadAll()
    } else if (event === 'take_profit_hit') {
      const d = data as { coin: string; price: number }
      setAlerts(prev => [{ id: Date.now(), type: 'TP' as const, coin: d.coin, price: d.price }, ...prev].slice(0, 5))
      loadAll()
    } else if (event === 'entry_intent_update') {
      const d = data as { intents?: EntryIntent[] }
      if (Array.isArray(d.intents)) setEntryIntents(d.intents)
    } else if (event === 'trade_executed' || event === 'portfolio_updated') {
      loadAll()
    } else if (event === 'coin_discovered') {
      setPendingDiscoveries(n => n + 1)
    } else if (event === 'pipeline_event') {
      const e = data as { coin: string; stage: string; cycle_id: string; data: string; created_at: string }
      if (e.stage.startsWith('discovery_')) {
        if (e.stage === 'discovery_started') setDiscoveryRunning(true)
        if (e.stage === 'discovery_completed') { setDiscoveryRunning(false); loadAll() }
        return
      }
      const stage = mapStage(e.stage)
      const edata: Record<string, unknown> = (() => { try { return JSON.parse(e.data) } catch { return {} } })()
      if (e.stage === 'research_started') {
        if (!pipelineWasRunning.current) {
          setLiveCoins(new Map())
          pipelineWasRunning.current = true
        }
        setPipelineRunning(true)
      }
      setLiveCoins(prev => {
        const m = new Map(prev)
        const cur = m.get(e.coin) ?? { coin: e.coin, stage }
        m.set(e.coin, {
          ...cur, stage,
          ...(e.stage === 'signal_generated' ? { action: edata.action as string, confidence: edata.confidence as number } : {}),
        })
        return m
      })
      if (['trade_executed', 'trade_skipped', 'signal_generated'].includes(e.stage)) {
        loadAll()
      }
    }
  }, []))

  useEffect(() => {
    if (entryIntents.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [entryIntents.length])

  function handleApprovalAction(tradeId: number) {
    setApprovals(prev => prev.filter(a => a.tradeId !== tradeId))
    onApprovalAction?.()
    loadAll()
  }

  async function handleAdjustment(id: number, action: 'approve' | 'reject') {
    setAdjustments(prev => prev.filter(a => a.adjustmentId !== id))
    onApprovalAction?.()
    try {
      await fetch(`/api/adjustment/${action}/${id}`, { method: 'POST' })
    } catch { /* ignore */ }
    loadAll()
  }

  const totalValue = portfolio?.total_value ?? 0
  const openPositions = portfolio?.open_position_count ?? 0
  const maxPositions = portfolio?.max_open_positions ?? 5
  const availableUsdc = portfolio?.available_usdc ?? null
  const liveList = Array.from(liveCoins.values())

  const finalGainUsd = gains?.total_pnl ?? 0
  const totalBought = gains?.positions.reduce((s, p) => s + p.entry_price * p.quantity, 0) ?? 0
  const finalGainPct = totalBought > 0 ? (finalGainUsd / totalBought) * 100 : null
  const liveGainUsd = positions.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const liveCostBasis = positions.reduce((s, p) => s + p.entry_price * p.quantity, 0)
  const liveGainPct = liveCostBasis > 0 ? (liveGainUsd / liveCostBasis) * 100 : null

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map(a => (
            <div key={a.id} className={cn(
              'flex items-center justify-between px-4 py-3 rounded-xl border text-sm',
              a.type === 'SL' ? 'bg-sell/5 border-sell/20' : 'bg-buy/5 border-buy/20',
            )}>
              <div className="flex items-center gap-2">
                <Badge variant={a.type === 'SL' ? 'sell' : 'executed'} dot>
                  {a.type === 'SL' ? 'Stop Loss' : 'Take Profit'}
                </Badge>
                <span className="text-foreground">{a.coin.replace('/USDC', '')} at {fmtUSD(a.price)}</span>
              </div>
              <button
                onClick={() => setAlerts(prev => prev.filter(x => x.id !== a.id))}
                className="text-muted hover:text-foreground transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hero — portfolio value + P&L + key metrics */}
      <Card className="relative overflow-hidden">
        <div aria-hidden className="absolute -top-28 -right-20 w-80 h-80 rounded-full bg-accent/10 blur-3xl pointer-events-none" />
        <div aria-hidden className="absolute -bottom-32 left-1/3 w-72 h-72 rounded-full bg-accent2/[0.07] blur-3xl pointer-events-none" />
        <div className="relative flex flex-col lg:flex-row lg:items-center gap-8">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">Portfolio Value</p>
            <p className="mt-2.5 text-4xl font-bold text-foreground tabular-nums tracking-tight leading-none">
              {fmtUSD(totalValue)}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <PnlChip label="Realized" usd={finalGainUsd} pct={finalGainPct} />
              <PnlChip label="Open" usd={liveGainUsd} pct={liveGainPct} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 lg:w-[440px] shrink-0">
            <HeroMetric
              icon={<CoinsIcon />}
              label="Available"
              value={availableUsdc != null ? fmtUSD(availableUsdc) : '—'}
              sub={availableUsdc != null ? 'USDC on Binance' : 'Binance offline'}
            />
            <HeroMetric
              icon={<ChartBarIcon />}
              label="Positions"
              value={`${openPositions} / ${maxPositions}`}
              sub={openPositions >= maxPositions ? 'limit reached' : `${maxPositions - openPositions} slots free`}
            >
              <div className="mt-2 flex items-center gap-1">
                {Array.from({ length: Math.min(maxPositions, 12) }).map((_, i) => (
                  <span
                    key={i}
                    className={cn('h-1.5 flex-1 rounded-full', i < openPositions ? 'bg-accent' : 'bg-border')}
                  />
                ))}
              </div>
            </HeroMetric>
            <HeroMetric
              icon={<ClockIcon />}
              label="Pending"
              value={approvals.length + adjustments.length}
              sub={approvals.length + adjustments.length > 0 ? 'awaiting approval' : 'all clear'}
              highlight={approvals.length + adjustments.length > 0}
            />
          </div>
        </div>
      </Card>

      {/* Bot Services */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ServiceCard
          label="Trading Pipeline"
          icon={<BoltIcon />}
          running={pipelineRunning}
          statusText={pipelineRunning ? 'Running' : 'Idle'}
          detail={watchlistCount > 0 ? `${watchlistCount} coin${watchlistCount !== 1 ? 's' : ''} on watchlist` : 'No watchlist'}
        />
        <ServiceCard
          label="Discovery"
          icon={<RadarIcon />}
          running={discoveryRunning}
          statusText={discoveryRunning ? 'Scanning' : 'Idle'}
          detail={pendingDiscoveries > 0 ? `${pendingDiscoveries} pending review` : 'No pending reviews'}
          extra={discoverCron ? `Cron: ${discoverCron}` : undefined}
        />
        <ServiceCard
          label="Position Monitor"
          icon={<EyeIcon />}
          running={monitorRunning}
          statusText={monitorRunning ? 'Checking' : 'Idle'}
          detail={`${openPositions} position${openPositions !== 1 ? 's' : ''} tracked`}
        />
      </div>

      {/* Live Pipeline Activity */}
      {liveList.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <span className={cn('w-2 h-2 rounded-full shrink-0', pipelineRunning ? 'bg-accent animate-pulse' : 'bg-muted')} />
            <span className="text-sm font-semibold text-foreground">
              {pipelineRunning ? 'Pipeline running' : 'Last pipeline run'}
            </span>
            <span className="text-xs text-muted ml-auto">
              {liveList.length} coin{liveList.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2">
            {liveList.map(c => {
              const chip = STAGE_CHIP[c.stage] ?? { label: c.stage, cls: 'text-muted bg-muted/10' }
              const coin = c.coin.replace('/USDC', '')
              return (
                <div key={c.coin} className="bg-surface-elevated rounded-xl p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold font-mono text-foreground truncate">{coin}</span>
                    {c.action && actionBadge(c.action)}
                  </div>
                  <span className={cn(
                    'text-[10px] font-semibold px-1.5 py-0.5 rounded-md inline-block',
                    chip.cls,
                    chip.pulse && 'animate-pulse',
                  )}>
                    {chip.label}
                  </span>
                  {c.confidence != null && (
                    <div className="flex items-center gap-1.5">
                      <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
                        <div
                          className={cn('h-full rounded-full', c.action === 'BUY' ? 'bg-buy' : c.action === 'SELL' ? 'bg-sell' : 'bg-warn')}
                          style={{ width: `${Math.round(c.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted tabular-nums">
                        {Math.round(c.confidence * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Pending Approvals */}
      {approvals.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            Pending Approvals
            <Badge variant="warning">{approvals.length}</Badge>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {approvals.map(a => (
              <TradeApproval key={a.tradeId} request={a} onAction={() => handleApprovalAction(a.tradeId)} />
            ))}
          </div>
        </div>
      )}

      {/* Pending Entry Intents — BUYs waiting for a good fill */}
      {entryIntents.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            Waiting for Entry
            <Badge variant="accent">{entryIntents.length}</Badge>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {entryIntents.map(i => (
              <EntryIntentCard key={i.id} intent={i} now={now} currentPrice={prices.get(i.coin)?.price} />
            ))}
          </div>
        </div>
      )}

      {/* Pending SL/TP Adjustments */}
      {adjustments.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            SL/TP Changes Awaiting Approval
            <Badge variant="warning">{adjustments.length}</Badge>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {adjustments.map(a => (
              <AdjustmentApproval key={a.adjustmentId} request={a} onAction={handleAdjustment} />
            ))}
          </div>
        </div>
      )}

      {/* Active Positions + Recent Signals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card noPad>
          <div className="px-5 pt-5 pb-3">
            <CardHeader title="Active Positions" subtitle={`${positions.length} open`} />
          </div>
          {positions.length === 0 ? (
            <EmptyState message="No active bot positions." />
          ) : (
            <div className="divide-y divide-border">
              {positions.map(p => (
                <div key={p.id} className="px-5 py-3 flex items-center gap-3 hover:bg-surface-elevated/40 transition-colors duration-100">
                  <CoinAvatar coin={p.coin} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{p.coin.replace('/USDC', '')}</p>
                    <p className="text-xs text-muted tabular-nums">Entry {fmtUSD(p.entry_price)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    {p.pnl_pct != null ? (
                      <p className={cn('text-sm font-semibold tabular-nums', p.pnl_pct >= 0 ? 'text-buy' : 'text-sell')}>
                        {fmtPct(p.pnl_pct)}
                      </p>
                    ) : (
                      <p className="text-sm text-muted">—</p>
                    )}
                    {p.pnl != null && (
                      <p className={cn('text-xs tabular-nums', p.pnl >= 0 ? 'text-buy/70' : 'text-sell/70')}>
                        {p.pnl >= 0 ? '+' : ''}{fmtUSD(p.pnl)}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0 space-y-0.5 w-16">
                    {p.distance_to_sl_pct != null && (
                      <p className="text-[11px] text-sell/80 tabular-nums">SL {fmtPct(p.distance_to_sl_pct)}</p>
                    )}
                    {p.distance_to_tp_pct != null && (
                      <p className="text-[11px] text-buy/80 tabular-nums">TP {fmtPct(p.distance_to_tp_pct)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card noPad>
          <div className="px-5 pt-5 pb-3">
            <CardHeader title="Recent Signals" subtitle="Analyst decisions" />
          </div>
          {decisions.length === 0 ? (
            <EmptyState message="No signals yet." />
          ) : (
            <div className="divide-y divide-border">
              {decisions.slice(0, 7).map(d => (
                <div key={d.id} className="px-5 py-3 flex items-start gap-3 hover:bg-surface-elevated/40 transition-colors duration-100">
                  <div className="shrink-0 mt-0.5">{actionBadge(d.action)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{d.coin.replace('/USDC', '')}</p>
                      <span className="text-xs text-muted tabular-nums shrink-0">
                        {Math.round(d.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-xs text-muted truncate mt-0.5">{d.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Recent Trades */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader title="Recent Trades" subtitle={`${trades.length} total`} />
        </div>
        <div className="px-5 pb-5">
          <TradeHistory trades={trades.slice(0, 15)} />
        </div>
      </Card>

      {/* Monitor Adjustment History */}
      <Card noPad>
        <button
          className="w-full px-5 py-4 flex items-center justify-between gap-2 text-left"
          onClick={() => setAdjHistoryOpen(o => !o)}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Monitor Adjustments</span>
            {adjHistory.length > 0 && (
              <span className="text-xs text-muted tabular-nums">({adjHistory.length})</span>
            )}
          </div>
          <svg
            className={cn('w-4 h-4 text-muted transition-transform duration-200', adjHistoryOpen && 'rotate-180')}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {adjHistoryOpen && (
          adjHistory.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted">No adjustments recorded yet.</p>
          ) : (
            <div className="divide-y divide-border border-t border-border">
              {adjHistory.map(a => {
                const coin = a.coin.replace('/USDC', '')
                const slChanged = a.new_stop_loss != null && a.new_stop_loss !== a.old_stop_loss
                const tpChanged = a.new_take_profit != null && a.new_take_profit !== a.old_take_profit
                const fmtLevel = (n: number | null | undefined) => (n != null ? fmtUSD(n) : '—')
                const statusCls: Record<string, string> = {
                  APPLIED:  'text-buy bg-buy/10',
                  REJECTED: 'text-sell bg-sell/10',
                  PENDING:  'text-warn bg-warn/10',
                  EXPIRED:  'text-muted bg-muted/10',
                }
                const cls = statusCls[a.status] ?? 'text-muted bg-muted/10'
                return (
                  <div key={a.id} className="px-5 py-3 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-foreground">{coin}</span>
                        <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-md', cls)}>
                          {a.status}
                        </span>
                        {a.confidence != null && (
                          <span className="text-xs text-muted tabular-nums ml-auto shrink-0">
                            {Math.round(a.confidence * 100)}%
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs tabular-nums mb-1">
                        {slChanged && (
                          <span>
                            <span className="text-muted">SL </span>
                            <span className="text-muted line-through">{fmtLevel(a.old_stop_loss)}</span>
                            <span className="text-muted mx-1">→</span>
                            <span className="text-sell font-medium">{fmtLevel(a.new_stop_loss)}</span>
                          </span>
                        )}
                        {tpChanged && (
                          <span>
                            <span className="text-muted">TP </span>
                            <span className="text-muted line-through">{fmtLevel(a.old_take_profit)}</span>
                            <span className="text-muted mx-1">→</span>
                            <span className="text-buy font-medium">{fmtLevel(a.new_take_profit)}</span>
                          </span>
                        )}
                      </div>
                      {a.reasoning && (
                        <p className="text-xs text-muted truncate">{a.reasoning}</p>
                      )}
                    </div>
                    <span className="text-[11px] text-muted tabular-nums shrink-0 mt-0.5">
                      {a.created_at.slice(0, 16).replace('T', ' ')}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        )}
      </Card>
    </div>
  )
}

function AdjustmentApproval({ request, onAction }: {
  request: AdjustmentRequest
  onAction: (id: number, action: 'approve' | 'reject') => void
}) {
  const coin = request.coin.replace('/USDC', '')
  const slChanged = request.newStopLoss != null && request.newStopLoss !== request.oldStopLoss
  const tpChanged = request.newTakeProfit != null && request.newTakeProfit !== request.oldTakeProfit
  const fmtLevel = (n: number | null) => (n != null ? fmtUSD(n) : '—')

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{coin}</span>
          <Badge variant="accent">Adjust SL/TP</Badge>
        </div>
        <span className="text-xs text-muted tabular-nums">{Math.round(request.confidence * 100)}%</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {slChanged && (
          <div className="bg-surface-elevated rounded-xl p-2.5">
            <p className="text-[11px] text-muted mb-0.5">Stop loss</p>
            <p className="text-xs tabular-nums">
              <span className="text-muted line-through">{fmtLevel(request.oldStopLoss)}</span>
              <span className="mx-1 text-muted">→</span>
              <span className="text-sell font-semibold">{fmtLevel(request.newStopLoss)}</span>
            </p>
          </div>
        )}
        {tpChanged && (
          <div className="bg-surface-elevated rounded-xl p-2.5">
            <p className="text-[11px] text-muted mb-0.5">Take profit</p>
            <p className="text-xs tabular-nums">
              <span className="text-muted line-through">{fmtLevel(request.oldTakeProfit)}</span>
              <span className="mx-1 text-muted">→</span>
              <span className="text-buy font-semibold">{fmtLevel(request.newTakeProfit)}</span>
            </p>
          </div>
        )}
      </div>

      {request.reasoning && (
        <p className="text-xs text-muted leading-relaxed line-clamp-3">{request.reasoning}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="success" size="sm" className="flex-1" onClick={() => onAction(request.adjustmentId, 'approve')}>
          Approve
        </Button>
        <Button variant="danger" size="sm" className="flex-1" onClick={() => onAction(request.adjustmentId, 'reject')}>
          Reject
        </Button>
      </div>
    </Card>
  )
}

function EntryIntentCard({ intent, now, currentPrice }: {
  intent: EntryIntent
  now: number
  currentPrice?: number
}) {
  const coin = intent.coin.replace('/USDC', '')
  const msLeft = Math.max(0, intent.expiresAt - now)
  const mins = Math.floor(msLeft / 60000)
  const secs = Math.floor((msLeft % 60000) / 1000)

  // Position of the live price within the [invalidate, chaseCap] band, 0–100%.
  const lo = intent.invalidatePrice
  const hi = intent.chaseCapPrice
  const pos = currentPrice != null && hi > lo
    ? Math.min(100, Math.max(0, ((currentPrice - lo) / (hi - lo)) * 100))
    : null
  // Where the target sits within the same band.
  const targetPos = hi > lo ? Math.min(100, Math.max(0, ((intent.targetPrice - lo) / (hi - lo)) * 100)) : 50
  const atOrBelowTarget = currentPrice != null && currentPrice <= intent.targetPrice

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{coin}</span>
          <Badge variant="accent">Waiting to buy</Badge>
        </div>
        <span className="text-xs text-muted tabular-nums">
          {mins}:{secs.toString().padStart(2, '0')} left
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-surface-elevated rounded-xl p-2">
          <p className="text-[10px] text-muted mb-0.5">Signal</p>
          <p className="text-xs font-medium text-foreground tabular-nums">{fmtUSD(intent.signalPrice)}</p>
        </div>
        <div className="bg-surface-elevated rounded-xl p-2 ring-1 ring-accent/20">
          <p className="text-[10px] text-muted mb-0.5">Buy ≤</p>
          <p className="text-xs font-semibold text-accent tabular-nums">{fmtUSD(intent.targetPrice)}</p>
        </div>
        <div className="bg-surface-elevated rounded-xl p-2">
          <p className="text-[10px] text-muted mb-0.5">Now</p>
          <p className={cn('text-xs font-medium tabular-nums', atOrBelowTarget ? 'text-buy' : 'text-foreground')}>
            {currentPrice != null ? fmtUSD(currentPrice) : '—'}
          </p>
        </div>
      </div>

      {/* Band: invalidate ── target ── chase cap, with a live marker */}
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-sell/30 via-border to-warn/30">
        <span
          className="absolute top-1/2 -translate-y-1/2 h-3 w-0.5 rounded-full bg-accent"
          style={{ left: `${targetPos}%` }}
        />
        {pos != null && (
          <span
            className="absolute top-1/2 -translate-y-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-foreground shadow ring-2 ring-surface-card transition-all duration-300"
            style={{ left: `${pos}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-muted tabular-nums">
        <span className="text-sell/80">invalidate {fmtUSD(intent.invalidatePrice)}</span>
        <span className="text-warn/80">cap {fmtUSD(intent.chaseCapPrice)}</span>
      </div>
    </Card>
  )
}

function PnlChip({ label, usd, pct }: { label: string; usd: number; pct: number | null }) {
  const pos = usd >= 0
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full border text-xs font-semibold tabular-nums',
      pos ? 'bg-buy/10 border-buy/20 text-buy' : 'bg-sell/10 border-sell/20 text-sell',
    )}>
      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d={pos ? 'M4.5 15.75l7.5-7.5 7.5 7.5' : 'M19.5 8.25l-7.5 7.5-7.5-7.5'} />
      </svg>
      <span className="opacity-70 font-medium">{label}</span>
      <span>
        {pos ? '+' : ''}{fmtUSD(usd)}
        {pct != null && ` (${pos ? '+' : ''}${pct.toFixed(2)}%)`}
      </span>
    </span>
  )
}

function HeroMetric({ icon, label, value, sub, highlight, children }: {
  icon: React.ReactNode
  label: string
  value: string | number
  sub?: string
  highlight?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={cn(
      'rounded-xl border p-3.5 bg-surface-elevated/60',
      highlight ? 'border-warn/30' : 'border-border',
    )}>
      <div className="flex items-center gap-2">
        <span className={cn(highlight ? 'text-warn' : 'text-accent/80')}>{icon}</span>
        <span className="text-[11px] font-semibold text-muted uppercase tracking-wider truncate">{label}</span>
      </div>
      <p className="mt-2 text-lg font-bold text-foreground tabular-nums tracking-tight leading-none">{value}</p>
      {children}
      {sub && <p className={cn('mt-1.5 text-[11px]', highlight ? 'text-warn' : 'text-muted')}>{sub}</p>}
    </div>
  )
}

function CoinAvatar({ coin }: { coin: string }) {
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent/20 to-accent2/10 ring-1 ring-accent/15 flex items-center justify-center shrink-0">
      <span className="text-[10px] font-bold text-accent">{coin.replace('/USDC', '').slice(0, 3)}</span>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-5 pb-6 pt-2 flex flex-col items-center text-center">
      <div className="w-9 h-9 rounded-full bg-surface-elevated flex items-center justify-center mb-2">
        <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661l-2.074-6.742a2.25 2.25 0 00-2.15-1.588H6.574a2.25 2.25 0 00-2.15 1.588l-2.075 6.742a2.25 2.25 0 00-.1.661z" />
        </svg>
      </div>
      <p className="text-sm text-muted">{message}</p>
    </div>
  )
}

function ServiceCard({ label, icon, running, statusText, detail, extra }: {
  label: string
  icon: React.ReactNode
  running: boolean
  statusText: string
  detail: string
  extra?: string
}) {
  return (
    <Card className={cn('relative overflow-hidden transition-colors duration-200', running && 'border-accent/25')}>
      {running && (
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
      )}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
            running ? 'bg-accent/15 text-accent' : 'bg-surface-elevated text-muted',
          )}>
            {icon}
          </span>
          <span className="text-xs font-semibold text-foreground">{label}</span>
        </div>
        <span className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold',
          running ? 'bg-accent/10 text-accent' : 'bg-surface-elevated text-muted',
        )}>
          <span className={cn('w-1 h-1 rounded-full bg-current', running && 'animate-pulse')} />
          {statusText}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{detail}</p>
      {extra && <p className="text-xs text-muted mt-1 font-mono">{extra}</p>}
    </Card>
  )
}

function CoinsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33" />
    </svg>
  )
}

function ChartBarIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function BoltIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  )
}

function RadarIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}
