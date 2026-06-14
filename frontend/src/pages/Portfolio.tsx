import { useEffect, useState, useCallback, Fragment } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { TransferModal } from '../components/TransferModal'
import { PortfolioEntry, PortfolioResponse, GainsResponse, ClosedPosition, ActivePosition, PositionReview, MonitorResponse, MonitorNote } from '../types'
import { fmtUSD, fmtPct, fmt, formatDate, fmtDuration } from '../lib/utils'
import { cn } from '../lib/utils'
import { usePrices } from '../hooks/usePrices'
import { useWebSocket } from '../hooks/useWebSocket'

// ── Icons ──────────────────────────────────────────────────────────────────

const WalletIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
  </svg>
)

const ChevronRightIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
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

// ── Table helpers ──────────────────────────────────────────────────────────

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

const ACTION_STYLES: Record<string, { cls: string; label: string; leftBorder: string }> = {
  HOLD:   { cls: 'bg-surface-elevated text-muted border-border',   label: 'HOLD',   leftBorder: 'border-l-border' },
  CLOSE:  { cls: 'bg-sell/10 text-sell border-sell/20',            label: 'CLOSE',  leftBorder: 'border-l-sell' },
  REDUCE: { cls: 'bg-warn/10 text-warn border-warn/20',            label: 'REDUCE', leftBorder: 'border-l-warn' },
  ADJUST: { cls: 'bg-accent/10 text-accent border-accent/20',      label: 'ADJUST', leftBorder: 'border-l-accent' },
}

function ActionBadge({ action }: { action: string }) {
  const s = ACTION_STYLES[action] ?? ACTION_STYLES.HOLD
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 text-xs rounded-md border font-semibold tracking-wide', s.cls)}>
      {s.label}
    </span>
  )
}

// ── Break-even badge ───────────────────────────────────────────────────────
// Shown once a position's live price clears the fee-adjusted break-even, i.e.
// closing now would lock in a net gain after round-trip fees.

function BreakEvenBadge({ price, className }: { price?: number; className?: string }) {
  return (
    <span
      title={price != null
        ? `Past break-even — closing now is net-profitable after fees (B/E ${fmtUSD(price)})`
        : 'Past break-even — closing now is net-profitable after fees'}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold',
        'bg-buy/10 text-buy border border-buy/30',
        'shadow-[0_0_0_1px_var(--tw-shadow-color)] shadow-buy/10 animate-fade-in',
        className,
      )}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      Break-even
    </span>
  )
}

// ── Confidence bar ─────────────────────────────────────────────────────────

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

// ── Price track (SL → entry → TP) ─────────────────────────────────────────

function PriceTrack({ sl, tp, current, entry }: { sl: number; tp: number | null; current: number | null; entry: number }) {
  if (!current || !tp || tp <= sl) return null
  const range = tp - sl
  const pct = Math.max(2, Math.min(98, ((current - sl) / range) * 100))
  const entryPct = Math.max(2, Math.min(98, ((entry - sl) / range) * 100))
  const isAboveEntry = current >= entry
  return (
    <div className="mt-2.5 relative h-1 rounded-full bg-surface-hover">
      <div className="absolute inset-0 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-sell/20 to-transparent" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-buy/20 to-transparent" />
      </div>
      <div
        className="absolute top-1/2 w-px h-3 bg-border"
        style={{ left: `${entryPct}%`, transform: 'translate(-50%, -50%)' }}
        title="Entry price"
      />
      <div
        className={cn('absolute w-2.5 h-2.5 rounded-full border-2 border-surface-card shadow-sm', isAboveEntry ? 'bg-buy' : 'bg-sell')}
        style={{ left: `${pct}%`, top: '50%', transform: 'translate(-50%, -50%)' }}
        title={`Current: ${fmtUSD(current)}`}
      />
    </div>
  )
}

// ── Overview stat card ─────────────────────────────────────────────────────

function OverviewStat({ label, value, sub, valueClass, icon }: {
  label: string
  value: string
  sub?: string
  valueClass?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="bg-surface-card border border-border rounded-2xl p-4 neon-border">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted uppercase tracking-wider">{label}</p>
          <p className={cn('mt-1.5 text-xl font-semibold tabular-nums leading-none', valueClass ?? 'text-foreground')}>
            {value}
          </p>
          {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
        </div>
        {icon && (
          <div className="shrink-0 p-2 rounded-xl bg-accent/10 text-accent mt-0.5">
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}

// ── LLM persistent notes ───────────────────────────────────────────────────

function noteAge(updatedAt: string): string {
  const ms = Date.now() - new Date(updatedAt.includes('T') ? updatedAt : updatedAt.replace(' ', 'T') + 'Z').getTime()
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(0, Math.round(ms / 60_000))}m ago`
  if (h < 48) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

function NoteBlock({ note }: { note: MonitorNote }) {
  return (
    <div className="rounded-lg bg-surface-hover/50 border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">📝 LLM Notes</span>
        <span className="text-[10px] text-muted whitespace-nowrap">updated {noteAge(note.updated_at)}</span>
      </div>
      <p className="text-xs text-muted leading-relaxed whitespace-pre-wrap">{note.notes}</p>
    </div>
  )
}

// ── Review card ────────────────────────────────────────────────────────────

function ReviewCard({ review, holdings, closingCoin, onClose, note }: {
  review: PositionReview
  holdings: PortfolioEntry[]
  closingCoin: string | null
  onClose: (coin: string) => void
  note?: MonitorNote | null
}) {
  const mdata = (() => { try { return JSON.parse(review.market_data) } catch { return {} } })()
  const coin = review.coin.replace('/USDC', '')
  const hasHolding = holdings.some(h => h.coin === review.coin)
  const isClosing = closingCoin === review.coin
  const s = ACTION_STYLES[review.action] ?? ACTION_STYLES.HOLD

  return (
    <div className={cn('rounded-xl border border-border border-l-4 bg-surface-elevated/30 overflow-hidden', s.leftBorder)}>
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <span className="font-semibold text-foreground">{coin}</span>
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

      <div className="flex items-center gap-5 px-4 pb-2 text-xs text-muted flex-wrap">
        {mdata.pnlPct != null && (
          <span className={cn('font-medium', mdata.pnlPct >= 0 ? 'text-buy' : 'text-sell')}>
            P&L {mdata.pnlPct >= 0 ? '+' : ''}{mdata.pnlPct.toFixed(2)}%
          </span>
        )}
        {mdata.rsi14 != null && <span>RSI {mdata.rsi14.toFixed(0)}</span>}
        {mdata.change24h != null && (
          <span className={cn(mdata.change24h >= 0 ? 'text-buy' : 'text-sell')}>
            24h {mdata.change24h >= 0 ? '+' : ''}{mdata.change24h.toFixed(2)}%
          </span>
        )}
        {review.action === 'REDUCE' && review.reduce_to_pct != null && (
          <span className="text-warn">Keep {review.reduce_to_pct}%</span>
        )}
      </div>

      {review.action === 'ADJUST' && (review.new_stop_loss != null || review.new_take_profit != null) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2 text-xs">
          {review.new_stop_loss != null && (() => {
            const deltaPct = review.old_stop_loss && review.old_stop_loss !== 0
              ? ((review.new_stop_loss - review.old_stop_loss) / Math.abs(review.old_stop_loss)) * 100
              : null
            return (
              <span className="px-2 py-0.5 rounded-md bg-sell/10 text-sell border border-sell/20 tabular-nums">
                SL → {fmtUSD(review.new_stop_loss)}
                {deltaPct != null && <span className="ml-1 opacity-70">({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)</span>}
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
                {deltaPct != null && <span className="ml-1 opacity-70">({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)</span>}
              </span>
            )
          })()}
        </div>
      )}

      <div className="px-4 pb-3.5 space-y-2">
        <ConfidenceBar value={review.confidence} />
        <p className="text-sm text-muted leading-relaxed">{review.reasoning}</p>
        {note && <NoteBlock note={note} />}
      </div>
    </div>
  )
}

// ── Review carousel ─────────────────────────────────────────────────────────
// Hero presentation: one review at a time, flanked by prev/next controls with
// dot indicators below. Keeps the monitor scannable when many coins are held.

const NavArrowIcon = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.25} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d={dir === 'left' ? 'M15.75 19.5L8.25 12l7.5-7.5' : 'M8.25 4.5l7.5 7.5-7.5 7.5'} />
  </svg>
)

function ReviewCarousel({ reviews, holdings, closingCoin, onClose, notesByCoin }: {
  reviews: PositionReview[]
  holdings: PortfolioEntry[]
  closingCoin: string | null
  onClose: (coin: string) => void
  notesByCoin: Map<string, MonitorNote>
}) {
  const [idx, setIdx] = useState(0)
  const count = reviews.length

  // Clamp the index whenever the review set changes (e.g. a new monitor run).
  useEffect(() => { setIdx(i => Math.min(i, Math.max(0, count - 1))) }, [count])

  if (count === 0) return null

  const safeIdx = Math.min(idx, count - 1)
  const review = reviews[safeIdx]
  const go = (delta: number) => setIdx(i => (i + delta + count) % count)

  const NavButton = ({ dir }: { dir: 'left' | 'right' }) => (
    <button
      type="button"
      aria-label={dir === 'left' ? 'Previous position' : 'Next position'}
      onClick={() => go(dir === 'left' ? -1 : 1)}
      disabled={count <= 1}
      className={cn(
        'shrink-0 grid place-items-center w-10 h-10 rounded-full border border-border bg-surface-card text-muted',
        'transition-colors hover:text-foreground hover:border-accent/40 hover:bg-surface-hover',
        'disabled:opacity-30 disabled:pointer-events-none',
      )}
    >
      <NavArrowIcon dir={dir} />
    </button>
  )

  return (
    <div className="px-4 pb-5">
      <div className="flex items-stretch gap-3">
        <div className="flex items-center"><NavButton dir="left" /></div>

        <div className="flex-1 min-w-0">
          <ReviewCard
            key={review.id}
            review={review}
            holdings={holdings}
            closingCoin={closingCoin}
            onClose={onClose}
            note={notesByCoin.get(review.coin) ?? null}
          />
        </div>

        <div className="flex items-center"><NavButton dir="right" /></div>
      </div>

      {count > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <div className="flex items-center gap-1.5">
            {reviews.map((r, i) => (
              <button
                key={r.id}
                type="button"
                aria-label={`Go to position ${i + 1}`}
                onClick={() => setIdx(i)}
                className={cn(
                  'h-2 rounded-full transition-all',
                  i === safeIdx ? 'w-6 bg-accent' : 'w-2 bg-border hover:bg-muted',
                )}
              />
            ))}
          </div>
          <span className="text-xs text-muted tabular-nums">{safeIdx + 1} / {count}</span>
        </div>
      )}
    </div>
  )
}

// ── Position Detail Modal ──────────────────────────────────────────────────

function PositionDetailModal({ pos, latestReview, note, closingCoin, markingClosed, onClose, onClosePosition, onMarkAlreadyClosed, onHorizonChange }: {
  pos: ActivePosition
  latestReview: PositionReview | null
  note: MonitorNote | null
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

  const openedAt = pos.created_at ? new Date(pos.created_at.includes('T') ? pos.created_at : pos.created_at + 'Z') : null
  const durationSeconds = openedAt ? Math.floor((Date.now() - openedAt.getTime()) / 1000) : null

  const riskReward = pos.stop_loss && pos.take_profit && pos.entry_price
    ? Math.abs((pos.take_profit - pos.entry_price) / (pos.entry_price - pos.stop_loss))
    : null

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
            {pos.status === 'OPEN' && pos.past_break_even && (
              <BreakEvenBadge price={pos.break_even_price} />
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-surface-elevated shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          <div className="grid grid-cols-2 gap-3">
            <div className="px-4 py-3 rounded-xl bg-surface-elevated border border-border">
              <p className="text-xs text-muted mb-1">Current Price</p>
              <p className="text-base font-bold tabular-nums text-foreground">
                {pos.current_price != null ? fmtUSD(pos.current_price) : '—'}
              </p>
              <p className="text-xs text-muted mt-0.5">Entry: {fmtUSD(pos.entry_price)}</p>
              {pos.break_even_price != null && (
                <p className={cn('text-xs mt-0.5', pos.past_break_even ? 'text-buy' : 'text-muted')}>
                  B/E: {fmtUSD(pos.break_even_price)}{pos.past_break_even && ' ✓'}
                </p>
              )}
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
              <p className="text-xs text-muted mb-0.5">Duration</p>
              <p className="font-medium tabular-nums">{durationSeconds != null ? fmtDuration(durationSeconds) : '—'}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-muted mb-0.5">Opened</p>
              <p className="font-medium tabular-nums">{openedAt ? formatDate(pos.created_at) : '—'}</p>
            </div>
            {riskReward != null && (
              <div>
                <p className="text-xs text-muted mb-0.5">Risk / Reward</p>
                <p className="font-medium tabular-nums">1 : {riskReward.toFixed(2)}</p>
              </div>
            )}
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

          {note && <NoteBlock note={note} />}

        </div>

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

// ── Monitor history modal ──────────────────────────────────────────────────

function HistoryModal({ runs, onClose }: {
  runs: { cycleId: string; reviews: PositionReview[] }[]
  onClose: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface-card border border-border rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl animate-fade-in" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Monitor History</h2>
            <p className="text-xs text-muted mt-0.5">{runs.length} previous run{runs.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground transition-colors p-1 rounded-lg hover:bg-surface-elevated">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-6">
          {runs.map(({ cycleId, reviews }) => {
            const ts = reviews[0]?.created_at ?? ''
            const dateLabel = ts
              ? new Date(ts.includes('T') ? ts : ts + 'Z').toLocaleString()
              : cycleId
            return (
              <div key={cycleId}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-semibold text-muted uppercase tracking-wide">{dateLabel}</span>
                  <span className="text-xs text-muted">· {reviews.length} position{reviews.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="space-y-2">
                  {reviews.map(r => (
                    <ReviewCard key={r.id} review={r} holdings={[]} closingCoin={null} onClose={() => {}} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
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
  const [monitorNotes, setMonitorNotes] = useState<MonitorNote[]>([])
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
      setMonitorNotes(data.notes ?? [])
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
    const pastBreakEven = pos.break_even_price != null ? currentPrice >= pos.break_even_price : undefined
    return { ...pos, current_price: currentPrice, pnl, pnl_pct: pnlPct, distance_to_sl_pct: distanceToSlPct, distance_to_tp_pct: distanceToTpPct, past_break_even: pastBreakEven }
  })

  const totalValue = usdcBalance + holdings.reduce((sum, h) => sum + (h.current_price != null ? h.current_price * h.quantity : 0), 0)
  const liveUsd = livePositions.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const liveBasis = livePositions.reduce((s, p) => s + p.entry_price * p.quantity, 0)
  const livePct = liveBasis > 0 ? (liveUsd / liveBasis) * 100 : null
  const realizedUsd = gains?.total_pnl ?? 0
  const totalBought = gains?.positions.reduce((s, p) => s + p.entry_price * p.quantity, 0) ?? 0
  const realizedPct = totalBought > 0 ? (realizedUsd / totalBought) * 100 : null

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

  const reviewsByCycle = reviews.reduce<Map<string, PositionReview[]>>((acc, r) => {
    const list = acc.get(r.cycle_id) ?? []
    list.push(r)
    acc.set(r.cycle_id, list)
    return acc
  }, new Map())

  const notesByCoin = new Map(monitorNotes.map(n => [n.coin, n]))

  const cycleIds = Array.from(reviewsByCycle.keys())
  const latestCycleId = cycleIds[0] ?? null
  const latestReviews = latestCycleId ? (reviewsByCycle.get(latestCycleId) ?? []) : []
  const historyRuns = cycleIds.slice(1).map(id => ({ cycleId: id, reviews: reviewsByCycle.get(id)! }))

  const winCount = gains?.positions.filter(p => p.pnl >= 0).length ?? 0
  const totalTrades = gains?.positions.length ?? 0
  const winRate = totalTrades > 0 ? Math.round((winCount / totalTrades) * 100) : null

  if (loading && !portfolio) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Overview stats strip ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <OverviewStat
          label="Total Value"
          value={fmtUSD(livePrices.size > 0 ? totalValue : (portfolio?.total_value ?? 0))}
          icon={<WalletIcon />}
        />
        <OverviewStat
          label="Live P&L"
          value={`${liveUsd >= 0 ? '+' : ''}${fmtUSD(liveUsd)}`}
          valueClass={liveUsd >= 0 ? 'text-buy' : 'text-sell'}
          sub={livePct != null ? fmtPct(livePct) + ' unrealized' : 'no open positions'}
        />
        <OverviewStat
          label="Realized P&L"
          value={`${realizedUsd >= 0 ? '+' : ''}${fmtUSD(realizedUsd)}`}
          valueClass={realizedUsd >= 0 ? 'text-buy' : 'text-sell'}
          sub={realizedPct != null ? fmtPct(realizedPct) + ' total return' : 'no closed trades'}
        />
        <OverviewStat
          label="USDC Balance"
          value={fmtUSD(usdcBalance)}
          sub={portfolio?.binance_usdc != null ? `${fmtUSD(portfolio.available_usdc ?? 0)} available` : undefined}
        />
        <OverviewStat
          label="Positions"
          value={`${openCount} / ${maxPositions}`}
          sub={openCount >= maxPositions ? 'limit reached' : `${maxPositions - openCount} slot${maxPositions - openCount !== 1 ? 's' : ''} free`}
          valueClass={openCount >= maxPositions ? 'text-warn' : 'text-foreground'}
        />
      </div>

      {/* ── Active Positions ───────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Active Positions"
            subtitle="Bot-managed trades with stop-loss and take-profit monitoring"
          />
        </div>

        {positions.length === 0 ? (
          <div className="px-5 pb-8 text-center">
            <p className="text-sm text-muted">No active bot positions.</p>
            <p className="text-xs text-muted mt-1 opacity-70">The trading engine hasn't opened any monitored trades yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto pb-2">
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="border-b border-border">
                  <Th>Asset</Th>
                  <Th>Duration</Th>
                  <Th right>P&L</Th>
                  <Th right>Entry</Th>
                  <Th right>Current</Th>
                  <Th right>Stop Loss</Th>
                  <Th right>Take Profit</Th>
                </tr>
              </thead>
              <tbody>
                {livePositions.map(pos => {
                  const pnlPos = (pos.pnl ?? 0) >= 0
                  const pnlCls = pos.pnl != null ? (pnlPos ? 'text-buy' : 'text-sell') : 'text-muted'
                  const coin = pos.coin.replace('/USDC', '')
                  const slPct = pos.distance_to_sl_pct
                  const tpPct = pos.distance_to_tp_pct
                  const openedAt = pos.created_at ? new Date(pos.created_at.includes('T') ? pos.created_at : pos.created_at + 'Z') : null
                  const durationSec = openedAt ? Math.floor((Date.now() - openedAt.getTime()) / 1000) : null
                  const hasPriceTrack = pos.stop_loss && pos.take_profit && pos.current_price

                  return (
                    <Fragment key={pos.id}>
                      <tr
                        onClick={() => setSelectedPos(pos)}
                        className="border-b border-border cursor-pointer hover:bg-surface-elevated/50 transition-colors duration-100 group"
                      >
                        <Td>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold">{coin}</span>
                            <span className={cn(
                              'text-xs px-1.5 py-0.5 rounded-md font-medium',
                              pos.status === 'OPEN' ? 'bg-buy/10 text-buy' : 'bg-muted/10 text-muted',
                            )}>
                              {pos.status}
                            </span>
                            {pos.status === 'OPEN' && pos.oco_status === 'ACTIVE' && (
                              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-buy/10 text-buy" title="Exchange-side OCO active">
                                🛡
                              </span>
                            )}
                            {pos.status === 'OPEN' && pos.oco_status === 'FAILED' && (
                              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-sell/10 text-sell" title="OCO failed — software fallback">
                                ⚠
                              </span>
                            )}
                            {pos.status === 'OPEN' && pos.past_break_even && (
                              <BreakEvenBadge price={pos.break_even_price} />
                            )}
                          </div>
                          <div className="flex items-center gap-1 mt-1">
                            <span className={cn(
                              'text-xs px-1.5 py-0.5 rounded border font-medium',
                              pos.horizon === 'disabled' ? 'text-muted border-border bg-surface-hover' : 'text-muted border-border bg-surface-hover',
                            )}>
                              {pos.horizon ?? 'medium'}
                            </span>
                          </div>
                        </Td>
                        <Td>
                          <span className="text-muted text-xs tabular-nums">
                            {durationSec != null ? fmtDuration(durationSec) : '—'}
                          </span>
                        </Td>
                        <Td right className={pnlCls}>
                          {pos.pnl != null ? (
                            <div>
                              <div className="font-semibold">{pnlPos ? '+' : ''}{fmtUSD(pos.pnl)}</div>
                              {pos.pnl_pct != null && <div className="text-xs opacity-75">{fmtPct(pos.pnl_pct)}</div>}
                            </div>
                          ) : <span className="text-muted">—</span>}
                        </Td>
                        <Td right>
                          <span className="text-muted tabular-nums">{fmtUSD(pos.entry_price)}</span>
                        </Td>
                        <Td right>
                          {pos.current_price != null ? (
                            <span className={cn('font-medium tabular-nums', pnlCls)}>
                              {fmtUSD(pos.current_price)}
                            </span>
                          ) : <span className="text-muted">—</span>}
                        </Td>
                        <Td right>
                          <div>
                            <div className="font-medium text-sell tabular-nums">{fmtUSD(pos.stop_loss)}</div>
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
                              <div className="font-medium text-buy tabular-nums">{fmtUSD(pos.take_profit)}</div>
                              {tpPct != null && (
                                <div className="text-xs text-buy">+{tpPct.toFixed(1)}%</div>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1 text-muted">
                              <span>—</span>
                              <ChevronRightIcon />
                            </div>
                          )}
                        </Td>
                      </tr>
                      {hasPriceTrack && (
                        <tr className="border-b border-border bg-surface-elevated/20">
                          <td colSpan={7} className="px-4 pb-2.5 pt-0">
                            <PriceTrack
                              sl={pos.stop_loss}
                              tp={pos.take_profit}
                              current={pos.current_price}
                              entry={pos.entry_price}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Position Monitor ───────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Position Monitor</h3>
              <p className="text-xs text-muted mt-0.5">LLM-powered review — HOLD, CLOSE, REDUCE, or ADJUST</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
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
          </div>
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
          <div className="px-5 pb-8 text-center">
            <p className="text-sm text-muted">
              {holdings.length === 0
                ? 'No open holdings to analyse.'
                : 'Click "Run Monitor" to get an LLM review of your open positions.'}
            </p>
          </div>
        )}

        {latestReviews.length > 0 && (
          <ReviewCarousel
            reviews={latestReviews}
            holdings={holdings}
            closingCoin={closingCoin}
            onClose={handleClosePosition}
            notesByCoin={notesByCoin}
          />
        )}
      </Card>

      {/* ── Holdings + USDC ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Holdings */}
        <div className="lg:col-span-2">
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
              <div className="px-5 pb-8 text-center">
                <p className="text-sm text-muted">No holdings.</p>
                <p className="text-xs text-muted mt-1 opacity-70">Deposit USDC and let the bot trade, or transfer a coin.</p>
              </div>
            ) : (
              <div className="overflow-x-auto pb-2">
                <table className="w-full text-sm min-w-[520px]">
                  <thead>
                    <tr className="border-b border-border">
                      <Th>Coin</Th>
                      <Th>Source</Th>
                      <Th right>Qty</Th>
                      <Th right>Cost</Th>
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
                          <Td right className="text-muted">{fmt(h.quantity, 6)}</Td>
                          <Td right className="text-muted">{h.buy_price ? fmtUSD(h.buy_price) : '—'}</Td>
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
        </div>

        {/* USDC Balance */}
        <div>
          <Card className="h-full">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-foreground">USDC Balance</h3>
              <div className="mt-2 space-y-0.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted">Local</span>
                  <span className="tabular-nums font-medium text-foreground">{fmtUSD(usdcBalance)}</span>
                </div>
                {portfolio?.binance_usdc != null && (
                  <>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Binance</span>
                      <span className="tabular-nums text-foreground">{fmtUSD(portfolio.binance_usdc)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Available</span>
                      <span className="tabular-nums text-foreground">{fmtUSD(portfolio.available_usdc ?? 0)}</span>
                    </div>
                  </>
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
                <Button
                  variant="success"
                  size="md"
                  loading={txPending === 'deposit'}
                  disabled={txPending !== null}
                  onClick={() => handleTransaction('deposit')}
                  className="flex-1"
                >
                  Deposit
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  loading={txPending === 'withdraw'}
                  disabled={txPending !== null}
                  onClick={() => handleTransaction('withdraw')}
                  className="flex-1"
                >
                  Withdraw
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* ── Final Gains ────────────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Final Gains</h3>
              <p className="text-xs text-muted mt-0.5">Realized P&L from closed positions</p>
            </div>
            {totalTrades > 0 && (
              <div className="flex items-center gap-4 text-right shrink-0">
                <div>
                  <p className="text-xs text-muted">Win rate</p>
                  <p className={cn('text-sm font-semibold tabular-nums mt-0.5', (winRate ?? 0) >= 50 ? 'text-buy' : 'text-sell')}>
                    {winRate}% <span className="text-xs font-normal text-muted">({winCount}/{totalTrades})</span>
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted">Total P&L</p>
                  <p className={cn('text-sm font-bold tabular-nums mt-0.5', realizedUsd >= 0 ? 'text-buy' : 'text-sell')}>
                    {realizedUsd >= 0 ? '+' : ''}{fmtUSD(realizedUsd)}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {!gains || gains.positions.length === 0 ? (
          <div className="px-5 pb-8 text-center">
            <p className="text-sm text-muted">No closed positions yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto pb-2">
            <table className="w-full text-sm min-w-[520px]">
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

      {/* ── Modals ─────────────────────────────────────────────────────── */}

      {selectedPos && (() => {
        const latestReview = latestReviews.find(r => r.coin === selectedPos.coin) ?? null
        const livePos = livePositions.find(p => p.id === selectedPos.id) ?? selectedPos
        return (
          <PositionDetailModal
            pos={livePos}
            latestReview={latestReview}
            note={notesByCoin.get(selectedPos.coin) ?? null}
            closingCoin={closingCoin}
            markingClosed={markingClosed}
            onClose={() => setSelectedPos(null)}
            onClosePosition={handleClosePosition}
            onMarkAlreadyClosed={handleMarkAlreadyClosed}
            onHorizonChange={handleHorizonChange}
          />
        )
      })()}

      {historyOpen && (
        <HistoryModal runs={historyRuns} onClose={() => setHistoryOpen(false)} />
      )}

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        onSuccess={load}
        localEntries={portfolio?.entries ?? []}
      />
    </div>
  )
}
