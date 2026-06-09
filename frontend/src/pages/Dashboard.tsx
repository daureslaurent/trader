import { useEffect, useState, useCallback, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { TradeApproval } from '../components/TradeApproval'
import { TradeHistory } from '../components/TradeHistory'
import { Stat } from '../components/ui/Stat'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge, actionBadge } from '../components/ui/Badge'
import { ApprovalRequest, Trade, ActivePosition, Decision, PortfolioResponse, AdjustmentRequest, PositionAdjustment, GainsResponse } from '../types'
import { Button } from '../components/ui/Button'
import { PnlCard } from '../components/PnlCard'
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

  useEffect(() => { loadAll(); loadAdjustments(); loadAdjHistory(); loadPendingApprovals() }, [])

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
  const totalBought = gains?.coins.reduce((s, c) => s + c.total_bought, 0) ?? 0
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

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Portfolio Value" value={fmtUSD(totalValue)} icon={<WalletIcon />} />
        <Stat
          label="Available USDC"
          value={availableUsdc != null ? fmtUSD(availableUsdc) : '—'}
          sub={availableUsdc != null ? 'on Binance' : 'Binance offline'}
          icon={<CoinsIcon />}
        />
        <Stat
          label="Bot Positions"
          value={`${openPositions} / ${maxPositions}`}
          sub={openPositions >= maxPositions ? 'limit reached' : `${maxPositions - openPositions} slots free`}
          icon={<ChartBarIcon />}
        />
        <Stat
          label="Pending Approval"
          value={approvals.length}
          trend={approvals.length > 0 ? 'down' : 'neutral'}
          icon={<ClockIcon />}
        />
      </div>

      {/* P&L Summary */}
      <PnlCard
        finalUsd={finalGainUsd}
        finalPct={finalGainPct}
        liveUsd={liveGainUsd}
        livePct={liveGainPct}
      />

      {/* Bot Services */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ServiceCard
          label="Trading Pipeline"
          running={pipelineRunning}
          statusText={pipelineRunning ? 'Running' : 'Idle'}
          detail={watchlistCount > 0 ? `${watchlistCount} coin${watchlistCount !== 1 ? 's' : ''} on watchlist` : 'No watchlist'}
        />
        <ServiceCard
          label="Discovery"
          running={discoveryRunning}
          statusText={discoveryRunning ? 'Scanning' : 'Idle'}
          detail={pendingDiscoveries > 0 ? `${pendingDiscoveries} pending review` : 'No pending reviews'}
          extra={discoverCron ? `Cron: ${discoverCron}` : undefined}
        />
        <ServiceCard
          label="Position Monitor"
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
                      <div className="flex-1 h-1 bg-surface rounded-full overflow-hidden">
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
            <p className="px-5 pb-5 text-sm text-muted">No active bot positions.</p>
          ) : (
            <div className="divide-y divide-border">
              {positions.map(p => (
                <div key={p.id} className="px-5 py-3 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{p.coin.replace('/USDC', '')}</p>
                    <p className="text-xs text-muted">Entry {fmtUSD(p.entry_price)}</p>
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
            <p className="px-5 pb-5 text-sm text-muted">No signals yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {decisions.slice(0, 7).map(d => (
                <div key={d.id} className="px-5 py-3 flex items-start gap-3">
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

function ServiceCard({ label, running, statusText, detail, extra }: {
  label: string
  running: boolean
  statusText: string
  detail: string
  extra?: string
}) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={cn(
            'w-2 h-2 rounded-full shrink-0',
            running ? 'bg-accent animate-pulse' : 'bg-border',
          )} />
          <span className="text-xs font-semibold text-foreground">{label}</span>
        </div>
        <span className={cn('text-xs font-medium', running ? 'text-accent' : 'text-muted')}>
          {statusText}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{detail}</p>
      {extra && <p className="text-xs text-muted mt-1 font-mono">{extra}</p>}
    </Card>
  )
}

function WalletIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18-3a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0v3M3 9v3" />
    </svg>
  )
}

function CoinsIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33" />
    </svg>
  )
}

function ChartBarIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
