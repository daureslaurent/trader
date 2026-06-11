import { useEffect, useState, useCallback } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Stat } from '../components/ui/Stat'
import { Input } from '../components/ui/Input'
import { PnlCard } from '../components/PnlCard'
import { TransferModal } from '../components/TransferModal'
import { PortfolioEntry, PortfolioResponse, GainsResponse, ClosedPosition, ActivePosition, PositionReview, MonitorResponse } from '../types'
import { fmtUSD, fmtPct, fmt } from '../lib/utils'
import { cn } from '../lib/utils'
import { usePrices } from '../hooks/usePrices'
import { useWebSocket } from '../hooks/useWebSocket'

// ── Icons ──────────────────────────────────────────────────────────────────

const WalletIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
  </svg>
)

// ── Source badge ───────────────────────────────────────────────────────────

const SOURCE: Record<string, { label: string; cls: string }> = {
  trade:    { label: 'Bot',      cls: 'bg-accent/10 text-accent border-accent/20' },
  transfer: { label: 'Transfer', cls: 'bg-surface-hover text-foreground border-border' },
  manual:   { label: 'Manual',   cls: 'bg-surface-hover text-muted border-border' },
}

function SourceBadge({ source }: { source?: string }) {
  const s = SOURCE[source ?? ''] ?? SOURCE.manual
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 text-xs rounded-md border font-medium', s.cls)}>
      {s.label}
    </span>
  )
}

// ── Th / Td helpers ────────────────────────────────────────────────────────

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={cn('py-2.5 px-4 text-xs font-medium text-muted uppercase tracking-wide', right ? 'text-right' : 'text-left')}>
      {children}
    </th>
  )
}

function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn('py-3 px-4', right && 'text-right tabular-nums', className)}>
      {children}
    </td>
  )
}

// ── Action badge ───────────────────────────────────────────────────────────

const ACTION_STYLES: Record<string, { cls: string; label: string }> = {
  HOLD:   { cls: 'bg-surface-elevated text-muted border-border',    label: 'HOLD'   },
  CLOSE:  { cls: 'bg-sell/10 text-sell border-sell/20',             label: 'CLOSE'  },
  REDUCE: { cls: 'bg-warn/10 text-warn border-warn/20',             label: 'REDUCE' },
  ADJUST: { cls: 'bg-accent/10 text-accent border-accent/20',       label: 'ADJUST' },
}

function ActionBadge({ action }: { action: string }) {
  const s = ACTION_STYLES[action] ?? ACTION_STYLES.HOLD
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 text-xs rounded-md border font-semibold tracking-wide', s.cls)}>
      {s.label}
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

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`
}

// ── Position Detail Modal ──────────────────────────────────────────────────

function PositionDetailModal({ pos, latestReview, closingCoin, markingClosed, onClose, onClosePosition, onMarkAlreadyClosed, onHorizonChange }: {
  pos: ActivePosition
  latestReview: PositionReview | null
  closingCoin: string | null
  markingClosed: string | null
  onClose: () => void
  onClosePosition: (coin: string) => void
  onMarkAlreadyClosed: (pos: ActivePosition) => void
  onHorizonChange: (positionId: number, horizon: 'short' | 'medium' | 'long' | 'disabled' | 'llm') => void
}) {
  const coin = pos.coin.replace('/USDC', '')
  const pnlPos = (pos.pnl ?? 0) >= 0
  const pnlCls = pos.pnl != null ? (pnlPos ? 'text-buy' : 'text-sell') : 'text-muted'
  const entryValue = pos.entry_price * pos.quantity
  const currentValue = pos.current_price != null ? pos.current_price * pos.quantity : null
  const isClosing = closingCoin === pos.coin
  const isMarkingClosed = markingClosed === pos.coin

  const reviewMdata = latestReview ? (() => { try { return JSON.parse(latestReview.market_data) } catch { return {} } })() : null

  // Price progress: where is current price between SL and TP?
  const slProgress = pos.stop_loss && pos.current_price && pos.entry_price
    ? Math.max(0, Math.min(100, ((pos.current_price - pos.stop_loss) / (pos.entry_price - pos.stop_loss)) * 100))
    : null

  const tpProgress = pos.take_profit && pos.current_price && pos.entry_price
    ? Math.max(0, Math.min(100, ((pos.current_price - pos.entry_price) / (pos.take_profit - pos.entry_price)) * 100))
    : null

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="relative bg-surface-card border border-border rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl animate-fade-in" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-lg font-bold text-foreground">{coin}</span>
            <span className={cn(
              'text-xs px-2 py-0.5 rounded-md font-medium',
              pos.status === 'OPEN' ? 'bg-buy/10 text-buy' : 'bg-muted/10 text-muted',
            )}>{pos.status}</span>
            {pos.status === 'OPEN' && pos.oco_status === 'ACTIVE' && (
              <span className="text-xs px-2 py-0.5 rounded-md font-medium bg-buy/10 text-buy" title="Exchange-side OCO active">🛡 OCO</span>
            )}
            {pos.status === 'OPEN' && pos.oco_status === 'FAILED' && (
              <span className="text-xs px-2 py-0.5 rounded-md font-medium bg-sell/10 text-sell" title="OCO failed — software fallback">⚠ Fallback</span>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-surface-elevated shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* Live P&L */}
          <div className="grid grid-cols-2 gap-3">
            <div className="px-4 py-3 rounded-xl bg-surface-elevated border border-border">
              <p className="text-xs text-muted mb-1">Current Price</p>
              <p className="text-base font-bold tabular-nums text-foreground">
                {pos.current_price != null ? fmtUSD(pos.current_price) : '—'}
              </p>
              <p className="text-xs text-muted mt-0.5">Entry: {fmtUSD(pos.entry_price)}</p>
            </div>
            <div className={cn('px-4 py-3 rounded-xl border', pnlPos ? 'bg-buy/5 border-buy/20' : 'bg-sell/5 border-sell/20')}>
              <p className="text-xs text-muted mb-1">Unrealised P&L</p>
              <p className={cn('text-base font-bold tabular-nums', pnlCls)}>
                {pos.pnl != null ? `${pnlPos ? '+' : ''}${fmtUSD(pos.pnl)}` : '—'}
              </p>
              {pos.pnl_pct != null && (
                <p className={cn('text-xs mt-0.5', pnlCls)}>{fmtPct(pos.pnl_pct)}</p>
              )}
            </div>
          </div>

          {/* Position Details */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <p className="text-xs text-muted mb-0.5">Quantity</p>
              <p className="font-medium tabular-nums">{fmt(pos.quantity, 6)}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-0.5">Entry Value</p>
              <p className="font-medium tabular-nums">{fmtUSD(entryValue)}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-0.5">Current Value</p>
              <p className="font-medium tabular-nums">{currentValue != null ? fmtUSD(currentValue) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-0.5">Horizon</p>
              <select
                value={pos.horizon ?? 'medium'}
                onChange={e => onHorizonChange(pos.id, e.target.value as 'short' | 'medium' | 'long' | 'disabled' | 'llm')}
                className="text-sm bg-surface-elevated border border-border rounded-lg px-2 py-1 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
              >
                <option value="short">Short</option>
                <option value="medium">Medium</option>
                <option value="long">Long</option>
                <option value="llm">LLM</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>

          {/* Stop Loss */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs font-medium text-muted uppercase tracking-wide">Stop Loss</span>
              <div className="flex items-center gap-3">
                <span className="font-semibold tabular-nums text-sell">{fmtUSD(pos.stop_loss)}</span>
                {pos.distance_to_sl_pct != null && (
                  <span className={cn('text-xs tabular-nums', pos.distance_to_sl_pct < 2 ? 'text-sell font-semibold' : 'text-muted')}>
                    {pos.distance_to_sl_pct.toFixed(1)}% away
                  </span>
                )}
              </div>
            </div>
            {slProgress != null && (
              <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
                <div className="h-full rounded-full bg-sell/60 transition-all" style={{ width: `${slProgress}%` }} />
              </div>
            )}
          </div>

          {/* Take Profit */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs font-medium text-muted uppercase tracking-wide">Take Profit</span>
              <div className="flex items-center gap-3">
                {pos.take_profit != null ? (
                  <>
                    <span className="font-semibold tabular-nums text-buy">{fmtUSD(pos.take_profit)}</span>
                    {pos.distance_to_tp_pct != null && (
                      <span className="text-xs text-buy tabular-nums">+{pos.distance_to_tp_pct.toFixed(1)}% away</span>
                    )}
                  </>
                ) : <span className="text-muted text-sm">Not set</span>}
              </div>
            </div>
            {tpProgress != null && (
              <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
                <div className="h-full rounded-full bg-buy/60 transition-all" style={{ width: `${tpProgress}%` }} />
              </div>
            )}
          </div>

          {/* Latest Monitor Review */}
          {latestReview && (
            <div className="rounded-xl border border-border bg-surface-elevated overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted uppercase tracking-wide">Latest Monitor Review</span>
                <div className="flex items-center gap-2">
                  <ActionBadge action={latestReview.action} />
                  <span className="text-xs text-muted">{latestReview.created_at.slice(0, 16).replace('T', ' ')}</span>
                </div>
              </div>
              <div className="px-4 py-3 space-y-2.5">
                <ConfidenceBar value={latestReview.confidence} />
                {reviewMdata && (
                  <div className="flex flex-wrap gap-4 text-xs text-muted">
                    {reviewMdata.pnlPct != null && (
                      <span className={cn('font-medium', reviewMdata.pnlPct >= 0 ? 'text-buy' : 'text-sell')}>
                        P&L: {reviewMdata.pnlPct >= 0 ? '+' : ''}{reviewMdata.pnlPct.toFixed(2)}%
                      </span>
                    )}
                    {reviewMdata.rsi14 != null && <span>RSI {reviewMdata.rsi14.toFixed(0)}</span>}
                    {reviewMdata.change24h != null && (
                      <span className={cn(reviewMdata.change24h >= 0 ? 'text-buy' : 'text-sell')}>
                        24h: {reviewMdata.change24h >= 0 ? '+' : ''}{reviewMdata.change24h.toFixed(2)}%
                      </span>
                    )}
                  </div>
                )}
                <p className="text-sm text-muted leading-relaxed">{latestReview.reasoning}</p>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-4 border-t border-border flex flex-col gap-2 shrink-0">
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2 text-sm font-medium rounded-xl border border-border text-muted hover:text-foreground hover:bg-surface-elevated transition-colors">
              Cancel
            </button>
            <Button variant="danger" size="md" loading={isClosing} disabled={isClosing || isMarkingClosed} onClick={() => onClosePosition(pos.coin)} className="flex-1">
              Close Position
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            loading={isMarkingClosed}
            disabled={isClosing || isMarkingClosed}
            onClick={() => onMarkAlreadyClosed(pos)}
            className="w-full text-muted border border-border/50 hover:border-border"
            title="Use this if you already sold this position manually on Binance — reconciles the local DB without placing any order"
          >
            Already sold on Binance
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Review list (shared between current run and history modal) ────────────

function ReviewList({ reviews, holdings, closingCoin, onClose }: {
  reviews: PositionReview[]
  holdings: PortfolioEntry[]
  closingCoin: string | null
  onClose: (coin: string) => void
}) {
  return (
    <div className="divide-y divide-border">
      {reviews.map(review => {
        const mdata = (() => { try { return JSON.parse(review.market_data) } catch { return {} } })()
        const coin = review.coin.replace('/USDC', '')
        const hasHolding = holdings.some(h => h.coin === review.coin)
        const isClosing = closingCoin === review.coin
        return (
          <div key={review.id} className="px-5 py-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-semibold text-foreground shrink-0">{coin}</span>
                <ActionBadge action={review.action} />
                {mdata.trend && (
                  <span className={cn(
                    'text-xs px-1.5 py-0.5 rounded border font-medium',
                    mdata.trend === 'uptrend' ? 'bg-buy/10 text-buy border-buy/20'
                    : mdata.trend === 'downtrend' ? 'bg-sell/10 text-sell border-sell/20'
                    : 'bg-surface-hover text-muted border-border',
                  )}>
                    {mdata.trend}
                  </span>
                )}
                {mdata.horizon && (
                  <span className="text-xs px-1.5 py-0.5 rounded border font-medium bg-surface-hover text-muted border-border">
                    {mdata.horizon}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {(review.action === 'CLOSE' || review.action === 'REDUCE') && hasHolding && (
                  <Button variant="danger" size="sm" loading={isClosing} disabled={isClosing} onClick={() => onClose(review.coin)}>
                    {review.action === 'REDUCE'
                      ? `Sell ${review.reduce_to_pct != null ? (100 - review.reduce_to_pct) + '%' : 'partial'}`
                      : 'Close'}
                  </Button>
                )}
                <span className="text-xs text-muted whitespace-nowrap">{review.created_at.slice(11, 16)}</span>
              </div>
            </div>

            <div className="flex items-center gap-6 text-xs text-muted">
              {mdata.pnlPct != null && (
                <span className={cn('font-medium', mdata.pnlPct >= 0 ? 'text-buy' : 'text-sell')}>
                  P&L: {mdata.pnlPct >= 0 ? '+' : ''}{mdata.pnlPct.toFixed(2)}%
                </span>
              )}
              {mdata.rsi14 != null && <span>RSI {mdata.rsi14.toFixed(0)}</span>}
              {mdata.change24h != null && (
                <span className={cn(mdata.change24h >= 0 ? 'text-buy' : 'text-sell')}>
                  24h: {mdata.change24h >= 0 ? '+' : ''}{mdata.change24h.toFixed(2)}%
                </span>
              )}
              {review.action === 'REDUCE' && review.reduce_to_pct != null && (
                <span className="text-warn">Keep {review.reduce_to_pct}%</span>
              )}
            </div>

            {review.action === 'ADJUST' && (review.new_stop_loss != null || review.new_take_profit != null) && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {review.new_stop_loss != null && (() => {
                  const deltaPct = review.old_stop_loss && review.old_stop_loss !== 0
                    ? ((review.new_stop_loss - review.old_stop_loss) / Math.abs(review.old_stop_loss)) * 100
                    : null
                  return (
                    <span className="px-2 py-0.5 rounded-md bg-sell/10 text-sell border border-sell/20 tabular-nums">
                      SL → {fmtUSD(review.new_stop_loss)}
                      {deltaPct != null && (
                        <span className="ml-1 opacity-70">({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)</span>
                      )}
                    </span>
                  )
                })()}
                {review.new_take_profit != null && (() => {
                  const deltaPct = review.old_take_profit && review.old_take_profit !== 0
                    ? ((review.new_take_profit - review.old_take_profit) / Math.abs(review.old_take_profit)) * 100
                    : null
                  return (
                    <span className="px-2 py-0.5 rounded-md bg-buy/10 text-buy border border-buy/20 tabular-nums">
                      TP → {fmtUSD(review.new_take_profit)}
                      {deltaPct != null && (
                        <span className="ml-1 opacity-70">({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)</span>
                      )}
                    </span>
                  )
                })()}
              </div>
            )}

            <ConfidenceBar value={review.confidence} />
            <p className="text-sm text-muted leading-relaxed">{review.reasoning}</p>
          </div>
        )
      })}
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────

export default function Portfolio() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [gains, setGains] = useState<GainsResponse | null>(null)
  const [positions, setPositions] = useState<ActivePosition[]>([])
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [txError, setTxError] = useState<string | null>(null)
  const [txPending, setTxPending] = useState<'deposit' | 'withdraw' | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)

  const [monitorRunning, setMonitorRunning] = useState(false)
  const [reviews, setReviews] = useState<PositionReview[]>([])
  const [closingCoin, setClosingCoin] = useState<string | null>(null)
  const [markingClosed, setMarkingClosed] = useState<string | null>(null)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedPos, setSelectedPos] = useState<ActivePosition | null>(null)

  const livePrices = usePrices()

  function load() {
    setLoading(true)
    Promise.all([
      fetch('/api/portfolio').then(r => r.json()),
      fetch('/api/portfolio/gains').then(r => r.json()),
      fetch('/api/positions').then(r => r.json()),
    ]).then(([p, g, pos]) => {
      setPortfolio(p)
      setGains(g)
      setPositions(Array.isArray(pos) ? pos : [])
    }).catch(() => {}).finally(() => setLoading(false))
  }

  function loadMonitor() {
    fetch('/api/monitor').then(r => r.json()).then((data: MonitorResponse) => {
      setMonitorRunning(data.running)
      setReviews(data.reviews ?? [])
    }).catch(() => {})
  }

  useWebSocket(useCallback((event: string, data: unknown) => {
    if (event === 'monitor_started') setMonitorRunning(true)
    if (event === 'monitor_completed') {
      setMonitorRunning(false)
      loadMonitor()
    }
    if (event === 'monitor_error') {
      setMonitorRunning(false)
      setMonitorError((data as { error?: string })?.error ?? 'Monitor failed')
    }
  }, []))

  useEffect(() => { load(); loadMonitor() }, [])

  const usdcEntry = portfolio?.entries.find(e => e.coin === 'USDC')
  const usdcBalance = usdcEntry?.quantity ?? 0
  const openCount = portfolio?.open_position_count ?? 0
  const maxPositions = portfolio?.max_open_positions ?? 5

  const holdings: PortfolioEntry[] = (portfolio?.entries.filter(e => e.coin !== 'USDC') ?? []).map(h => {
    const live = livePrices.get(h.coin)
    if (!live) return h
    const currentPrice = live.price
    const deltaUsd = h.buy_price > 0 ? Math.round((currentPrice - h.buy_price) * h.quantity * 100) / 100 : null
    const deltaPct = h.buy_price > 0 ? Math.round(((currentPrice - h.buy_price) / h.buy_price) * 10000) / 100 : null
    return { ...h, current_price: currentPrice, delta_usd: deltaUsd, delta_pct: deltaPct }
  })

  const livePositions: ActivePosition[] = positions.map(pos => {
    const live = livePrices.get(pos.coin as string)
    if (!live) return pos
    const currentPrice = live.price
    const entryPrice = pos.entry_price as number
    const qty = pos.quantity as number
    const pnl = Math.round((qty * (currentPrice - entryPrice)) * 100) / 100
    const pnlPct = Math.round(((currentPrice - entryPrice) / entryPrice) * 10000) / 100
    const distanceToSlPct = pos.stop_loss ? Math.round(((currentPrice - (pos.stop_loss as number)) / currentPrice) * 10000) / 100 : null
    const distanceToTpPct = pos.take_profit ? Math.round((((pos.take_profit as number) - currentPrice) / currentPrice) * 10000) / 100 : null
    return { ...pos, current_price: currentPrice, pnl, pnl_pct: pnlPct, distance_to_sl_pct: distanceToSlPct, distance_to_tp_pct: distanceToTpPct }
  })

  const totalValue = usdcBalance + holdings.reduce((sum, h) => sum + (h.current_price != null ? h.current_price * h.quantity : 0), 0)

  async function handleTransaction(type: 'deposit' | 'withdraw') {
    const parsed = parseFloat(amount)
    if (!parsed || parsed <= 0) { setTxError('Enter a positive amount'); return }
    setTxPending(type)
    setTxError(null)
    try {
      const res = await fetch(`/api/portfolio/usdc/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: parsed }),
      })
      const data = await res.json()
      if (!res.ok) { setTxError(data.error ?? 'Failed'); return }
      setAmount('')
      load()
    } catch {
      setTxError('Request failed')
    } finally {
      setTxPending(null)
    }
  }

  async function handleHorizonChange(positionId: number, horizon: 'short' | 'medium' | 'long' | 'disabled' | 'llm') {
    setPositions(prev => prev.map(p => p.id === positionId ? { ...p, horizon } : p))
    await fetch(`/api/positions/${positionId}/horizon`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ horizon }),
    }).catch(() => {})
  }

  async function handleRunMonitor() {
    setMonitorError(null)
    setMonitorRunning(true)
    try {
      const res = await fetch('/api/monitor/run', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json()
        setMonitorError(d.error ?? 'Failed to start monitor')
        setMonitorRunning(false)
      }
    } catch {
      setMonitorError('Request failed')
      setMonitorRunning(false)
    }
  }

  async function handleClosePosition(coin: string) {
    const entry = holdings.find(h => h.coin === coin)
    if (!entry || !entry.quantity) return
    setClosingCoin(coin)
    try {
      const baseCoin = coin.includes('/') ? coin.split('/')[0] : coin
      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: baseCoin, to: 'USDC', amount: entry.quantity }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMonitorError(data.error ?? 'Close failed')
      } else {
        load()
        loadMonitor()
      }
    } catch {
      setMonitorError('Request failed')
    } finally {
      setClosingCoin(null)
      setSelectedPos(null)
    }
  }

  async function handleMarkAlreadyClosed(pos: ActivePosition) {
    setMarkingClosed(pos.coin)
    try {
      const res = await fetch(`/api/positions/${pos.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        setMonitorError(data.error ?? 'Reconcile failed')
      } else {
        load()
        loadMonitor()
        setSelectedPos(null)
      }
    } catch {
      setMonitorError('Request failed')
    } finally {
      setMarkingClosed(null)
    }
  }

  // Group reviews by cycle_id; latest run = most recent cycle_id
  const reviewsByCycle = reviews.reduce<Map<string, PositionReview[]>>((acc, r) => {
    const list = acc.get(r.cycle_id) ?? []
    list.push(r)
    acc.set(r.cycle_id, list)
    return acc
  }, new Map())

  const cycleIds = Array.from(reviewsByCycle.keys())
  const latestCycleId = cycleIds[0] ?? null
  const latestReviews = latestCycleId ? (reviewsByCycle.get(latestCycleId) ?? []) : []
  const historyRuns = cycleIds.slice(1).map(id => ({ cycleId: id, reviews: reviewsByCycle.get(id)! }))

  if (loading && !portfolio) {
    return <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>
  }

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Stats ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat label="Total Value" value={fmtUSD(livePrices.size > 0 ? totalValue : (portfolio?.total_value ?? 0))} icon={<WalletIcon />} />
        <Stat
          label="Bot Positions"
          value={`${openCount} / ${maxPositions}`}
          sub={openCount >= maxPositions ? 'limit reached' : `${maxPositions - openCount} slot${maxPositions - openCount !== 1 ? 's' : ''} free`}
          trend={openCount >= maxPositions ? 'down' : 'neutral'}
        />
        <Stat label="USDC Balance" value={fmtUSD(usdcBalance)} trend="neutral" />
      </div>

      {/* ── P&L Summary ───────────────────────────────────────────────── */}
      {(() => {
        const finalUsd = gains?.total_pnl ?? 0
        const totalBought = gains?.positions.reduce((s, p) => s + p.entry_price * p.quantity, 0) ?? 0
        const finalPct = totalBought > 0 ? (finalUsd / totalBought) * 100 : null
        const liveUsd = livePositions.reduce((s, p) => s + (p.pnl ?? 0), 0)
        const liveBasis = livePositions.reduce((s, p) => s + p.entry_price * p.quantity, 0)
        const livePct = liveBasis > 0 ? (liveUsd / liveBasis) * 100 : null
        return <PnlCard finalUsd={finalUsd} finalPct={finalPct} liveUsd={liveUsd} livePct={livePct} />
      })()}

      {/* ── Active Positions ──────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Active Positions"
            subtitle="Bot-managed trades with stop-loss and take-profit monitoring"
          />
        </div>

        {positions.length === 0 ? (
          <div className="px-5 pb-6 text-center text-sm text-muted">
            No active bot positions — the trading engine hasn't opened any monitored trades yet.
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="border-b border-border">
                  <Th>Coin</Th>
                  <Th>Horizon</Th>
                  <Th right>Qty</Th>
                  <Th right>Entry</Th>
                  <Th right>Current</Th>
                  <Th right>P&L</Th>
                  <Th right>Stop Loss</Th>
                  <Th right>Take Profit</Th>
                  <th className="py-2.5 px-3 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {livePositions.map(pos => {
                  const pnlPos = (pos.pnl ?? 0) >= 0
                  const pnlCls = pos.pnl != null ? (pnlPos ? 'text-buy' : 'text-sell') : 'text-muted'
                  const coin = pos.coin.replace('/USDC', '')
                  const slPct = pos.distance_to_sl_pct
                  const tpPct = pos.distance_to_tp_pct
                  return (
                    <tr key={pos.id} className="hover:bg-surface-elevated/50 transition-colors duration-100">
                      <Td>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{coin}</span>
                          <span className={cn(
                            'text-xs px-1.5 py-0.5 rounded-md font-medium',
                            pos.status === 'OPEN' ? 'bg-buy/10 text-buy' : 'bg-muted/10 text-muted',
                          )}>
                            {pos.status}
                          </span>
                          {pos.status === 'OPEN' && pos.oco_status === 'ACTIVE' && (
                            <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-buy/10 text-buy" title="Stop-loss / take-profit enforced on Binance (exchange-side OCO)">
                              🛡 OCO
                            </span>
                          )}
                          {pos.status === 'OPEN' && pos.oco_status === 'FAILED' && (
                            <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-sell/10 text-sell" title="Exchange OCO could not be placed — bot is enforcing SL/TP in software as a fallback">
                              ⚠ Fallback
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <select
                          value={pos.horizon ?? 'medium'}
                          onChange={e => handleHorizonChange(pos.id, e.target.value as 'short' | 'medium' | 'long' | 'disabled' | 'llm')}
                          className={cn(
                            'text-xs border rounded-lg px-2 py-1 cursor-pointer focus:outline-none transition-colors',
                            pos.horizon === 'disabled'
                              ? 'bg-surface-elevated border-border text-muted hover:border-accent/50 focus:border-accent'
                              : 'bg-surface-elevated border-border text-foreground hover:border-accent/50 focus:border-accent',
                          )}
                        >
                          <option value="short">Short</option>
                          <option value="medium">Medium</option>
                          <option value="long">Long</option>
                          <option value="llm">LLM</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      </Td>
                      <Td right>{fmt(pos.quantity, 6)}</Td>
                      <Td right>{fmtUSD(pos.entry_price)}</Td>
                      <Td right>{pos.current_price != null ? fmtUSD(pos.current_price) : '—'}</Td>
                      <Td right className={pnlCls}>
                        {pos.pnl != null ? (
                          <div>
                            <div className="font-medium">{pnlPos ? '+' : ''}{fmtUSD(pos.pnl)}</div>
                            {pos.pnl_pct != null && <div className="text-xs opacity-75">{fmtPct(pos.pnl_pct)}</div>}
                          </div>
                        ) : '—'}
                      </Td>
                      <Td right>
                        <div>
                          <div className="font-medium">{fmtUSD(pos.stop_loss)}</div>
                          {slPct != null && (
                            <div className={cn('text-xs', slPct < 2 ? 'text-sell font-semibold' : 'text-muted')}>
                              {slPct.toFixed(1)}% away
                            </div>
                          )}
                        </div>
                      </Td>
                      <Td right>
                        {pos.take_profit != null ? (
                          <div>
                            <div className="font-medium">{fmtUSD(pos.take_profit)}</div>
                            {tpPct != null && (
                              <div className="text-xs text-buy">+{tpPct.toFixed(1)}%</div>
                            )}
                          </div>
                        ) : <span className="text-muted">—</span>}
                      </Td>
                      <td className="py-3 px-3">
                        <button
                          onClick={() => setSelectedPos(pos)}
                          className="text-muted hover:text-foreground p-1.5 rounded-lg hover:bg-surface-elevated transition-colors"
                          title="Position details"
                        >
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Holdings ──────────────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Holdings"
            subtitle={`${holdings.length} coin${holdings.length !== 1 ? 's' : ''} — all sources`}
            action={
              <Button variant="secondary" size="sm" onClick={() => setTransferOpen(true)}>
                Transfer
              </Button>
            }
          />
        </div>

        {holdings.length === 0 ? (
          <div className="px-5 pb-6 text-center text-sm text-muted">
            No holdings — deposit USDC and let the bot trade, or transfer a coin from Binance.
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="border-b border-border">
                  <Th>Coin</Th>
                  <Th>Source</Th>
                  <Th right>Qty</Th>
                  <Th right>Cost Basis</Th>
                  <Th right>Current</Th>
                  <Th right>Value</Th>
                  <Th right>P&L</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {holdings.map(h => {
                  const up = h.delta_pct != null && h.delta_pct >= 0
                  const pnlCls = h.delta_pct != null ? (up ? 'text-buy' : 'text-sell') : 'text-muted'
                  const value = h.current_price != null ? h.current_price * h.quantity : null
                  return (
                    <tr key={h.id} className="hover:bg-surface-elevated/50 transition-colors duration-100">
                      <Td><span className="font-semibold">{h.coin.replace('/USDC', '')}</span></Td>
                      <Td><SourceBadge source={h.source} /></Td>
                      <Td right>{fmt(h.quantity, 6)}</Td>
                      <Td right>{h.buy_price ? fmtUSD(h.buy_price) : '—'}</Td>
                      <Td right>{h.current_price != null ? fmtUSD(h.current_price) : '—'}</Td>
                      <Td right className="font-medium">{value != null ? fmtUSD(value) : '—'}</Td>
                      <Td right className={pnlCls}>
                        {h.delta_usd != null ? (
                          <div>
                            <div className="font-medium">{up ? '+' : ''}{fmtUSD(h.delta_usd)}</div>
                            {h.delta_pct != null && <div className="text-xs opacity-75">{fmtPct(h.delta_pct)}</div>}
                          </div>
                        ) : '—'}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Position Monitor ──────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Position Monitor"
            subtitle="LLM-powered review of all open holdings — HOLD, CLOSE, or REDUCE recommendations"
            action={
              <div className="flex items-center gap-2">
                {historyRuns.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
                    History ({historyRuns.length})
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  loading={monitorRunning}
                  disabled={monitorRunning || holdings.length === 0}
                  onClick={handleRunMonitor}
                >
                  {monitorRunning ? 'Analysing…' : 'Run Monitor'}
                </Button>
              </div>
            }
          />
        </div>

        {monitorError && (
          <div className="mx-5 mb-4 px-4 py-3 rounded-xl bg-sell/10 border border-sell/20 text-sell text-sm">
            {monitorError}
          </div>
        )}

        {monitorRunning && latestReviews.length === 0 && (
          <div className="px-5 pb-6 flex items-center gap-3 text-sm text-muted">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
            Fetching market data and requesting LLM analysis…
          </div>
        )}

        {!monitorRunning && latestReviews.length === 0 && !monitorError && (
          <div className="px-5 pb-6 text-center text-sm text-muted">
            {holdings.length === 0
              ? 'No open holdings to analyse.'
              : 'Click "Run Monitor" to get an LLM review of your open positions.'}
          </div>
        )}

        {latestReviews.length > 0 && (
          <ReviewList reviews={latestReviews} holdings={holdings} closingCoin={closingCoin} onClose={handleClosePosition} />
        )}
      </Card>

      {/* ── Monitor History Modal ─────────────────────────────────────── */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setHistoryOpen(false)}>
          <div className="bg-surface-card border border-border rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Monitor History</h2>
                <p className="text-xs text-muted mt-0.5">{historyRuns.length} previous run{historyRuns.length !== 1 ? 's' : ''}</p>
              </div>
              <button onClick={() => setHistoryOpen(false)} className="text-muted hover:text-foreground transition-colors p-1 rounded-lg hover:bg-surface-elevated">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {historyRuns.map(({ cycleId, reviews: runReviews }) => {
                const ts = runReviews[0]?.created_at ?? ''
                return (
                  <div key={cycleId}>
                    <div className="px-6 py-2.5 bg-surface-elevated border-b border-border sticky top-0">
                      <p className="text-xs font-semibold text-muted uppercase tracking-wide">
                        {ts ? new Date(ts.includes('T') ? ts : ts + 'Z').toLocaleString() : cycleId}
                        <span className="ml-2 font-normal normal-case">{runReviews.length} position{runReviews.length !== 1 ? 's' : ''}</span>
                      </p>
                    </div>
                    <ReviewList reviews={runReviews} holdings={[]} closingCoin={null} onClose={() => {}} />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── USDC Balance ──────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">USDC Balance</h3>
            <p className="text-xs text-muted mt-0.5">Local: {fmtUSD(usdcBalance)}</p>
            {portfolio?.binance_usdc != null && (
              <p className="text-xs text-muted mt-0.5">
                Binance: {fmtUSD(portfolio.binance_usdc)}
                <span className="mx-1.5 text-border">·</span>
                Available: {fmtUSD(portfolio.available_usdc ?? 0)}
              </p>
            )}
          </div>
        </div>
        <div className="space-y-3">
          <Input
            label="Amount (USDC)"
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={e => { setAmount(e.target.value); setTxError(null) }}
            placeholder="0.00"
            error={txError ?? undefined}
          />
          <div className="flex gap-2">
            <Button variant="success" size="md" loading={txPending === 'deposit'} disabled={txPending !== null} onClick={() => handleTransaction('deposit')} className="flex-1">
              Deposit
            </Button>
            <Button variant="danger" size="md" loading={txPending === 'withdraw'} disabled={txPending !== null} onClick={() => handleTransaction('withdraw')} className="flex-1">
              Withdraw
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Final Gains ───────────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Final Gains"
            subtitle="Realized P&L from closed positions"
            action={gains && gains.positions.length > 0 ? (
              <div className="text-right">
                <div className={cn('text-lg font-bold tabular-nums', gains.total_pnl >= 0 ? 'text-buy' : 'text-sell')}>
                  {gains.total_pnl >= 0 ? '+' : ''}{fmtUSD(gains.total_pnl)}
                </div>
              </div>
            ) : undefined}
          />
        </div>

        {!gains || gains.positions.length === 0 ? (
          <div className="px-5 pb-6 text-center text-sm text-muted">
            No closed positions yet.
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="border-b border-border">
                  {['Coin', 'Opened', 'Duration', 'Entry', 'P&L', '%'].map((h, i) => (
                    <th key={h} className={cn('py-2.5 px-4 text-xs font-medium text-muted uppercase tracking-wide', i === 0 ? 'text-left' : 'text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {gains.positions.map((p: ClosedPosition) => {
                  const win = p.pnl >= 0
                  const cls = win ? 'text-buy' : 'text-sell'
                  const statusLabel = p.status === 'SL_HIT' ? 'SL' : p.status === 'TP_HIT' ? 'TP' : null
                  const statusCls = p.status === 'SL_HIT'
                    ? 'bg-sell/10 text-sell border-sell/20'
                    : p.status === 'TP_HIT'
                    ? 'bg-buy/10 text-buy border-buy/20'
                    : null
                  const openedDate = p.opened_at
                    ? new Date(p.opened_at.includes('T') ? p.opened_at : p.opened_at + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    : '—'
                  return (
                    <tr key={p.id} className="hover:bg-surface-elevated/50 transition-colors duration-100">
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{p.coin.replace('/USDC', '')}</span>
                          {statusLabel && statusCls && (
                            <span className={cn('inline-flex items-center px-1.5 py-0.5 text-xs rounded-md border font-medium', statusCls)}>
                              {statusLabel}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums text-muted text-xs">{openedDate}</td>
                      <td className="py-3 px-4 text-right tabular-nums text-muted text-xs">{fmtDuration(p.duration_seconds)}</td>
                      <td className="py-3 px-4 text-right tabular-nums text-muted">{fmtUSD(p.entry_price)}</td>
                      <td className={cn('py-3 px-4 text-right tabular-nums font-semibold', cls)}>
                        {win ? '+' : ''}{fmtUSD(p.pnl)}
                      </td>
                      <td className={cn('py-3 px-4 text-right tabular-nums font-medium', cls)}>
                        {win ? '+' : ''}{p.pnl_pct.toFixed(2)}%
                      </td>
                    </tr>
                  )
                })}
                {(gains.total_bnb_fees ?? 0) > 0 && (
                  <tr className="border-t-2 border-border/60 bg-surface-elevated/30">
                    <td className="py-3 px-4 font-semibold text-muted" colSpan={4}>BNB fees</td>
                    <td className="py-3 px-4 text-right tabular-nums font-semibold text-sell">
                      -{fmt(gains.total_bnb_fees, 6)} BNB
                    </td>
                    <td className="py-3 px-4 text-right text-muted">—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedPos && (() => {
        const latestReview = latestReviews.find(r => r.coin === selectedPos.coin) ?? null
        const livePos = livePositions.find(p => p.id === selectedPos.id) ?? selectedPos
        return (
          <PositionDetailModal
            pos={livePos}
            latestReview={latestReview}
            closingCoin={closingCoin}
            markingClosed={markingClosed}
            onClose={() => setSelectedPos(null)}
            onClosePosition={handleClosePosition}
            onMarkAlreadyClosed={handleMarkAlreadyClosed}
            onHorizonChange={handleHorizonChange}
          />
        )
      })()}

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        onSuccess={load}
        localEntries={portfolio?.entries ?? []}
      />
    </div>
  )
}
