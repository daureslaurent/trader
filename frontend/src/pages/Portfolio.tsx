import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { TransferModal } from '../components/TransferModal'
import { PortfolioEntry, PortfolioResponse, GainsResponse, ClosedPosition, ActivePosition, PositionReview, MonitorResponse, MonitorNote, BenchmarkResponse } from '../types'
import { fmtUSD, fmtPct, fmt, formatDate, fmtDuration } from '../lib/utils'
import { cn } from '../lib/utils'
import { usePrices } from '../hooks/usePrices'
import { useWebSocket } from '../hooks/useWebSocket'

// ── Icons ──────────────────────────────────────────────────────────────────

const WalletIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
  </svg>
)

const TrendUpIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
  </svg>
)

const VaultIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9v7.5a2.25 2.25 0 002.25 2.25h15a2.25 2.25 0 002.25-2.25V9m-19.5 0V6.75A2.25 2.25 0 014.5 4.5h15a2.25 2.25 0 012.25 2.25V9" />
  </svg>
)

const StackIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
  </svg>
)

const ArrowUpRight = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" />
  </svg>
)

const ArrowDownRight = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 4.5l15 15m0 0V8.25m0 11.25H8.25" />
  </svg>
)

// ── Tone system (theme tokens + neon glow layer) ────────────────────────────

type Tone = 'pos' | 'neg' | 'neutral' | 'accent'

const TONE: Record<Tone, { text: string; glow: string; ring: string }> = {
  pos:     { text: 'text-buy',       glow: 'shadow-buy/30',    ring: 'border-buy/25' },
  neg:     { text: 'text-sell',      glow: 'shadow-sell/30',   ring: 'border-sell/25' },
  accent:  { text: 'text-accent',    glow: 'shadow-accent/30', ring: 'border-accent/25' },
  neutral: { text: 'text-foreground', glow: 'shadow-accent/10', ring: 'border-border' },
}

function pnlTone(v: number | null | undefined): Tone {
  if (v == null) return 'neutral'
  return v >= 0 ? 'pos' : 'neg'
}

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

// ── Table helpers (holdings + final gains) ──────────────────────────────────

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
  HOLD:   { cls: 'bg-surface-elevated text-muted border-border',   label: 'HOLD' },
  CLOSE:  { cls: 'bg-sell/10 text-sell border-sell/20',            label: 'CLOSE' },
  ADJUST: { cls: 'bg-accent/10 text-accent border-accent/20',      label: 'ADJUST' },
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

function BreakEvenBadge({ price, className }: { price?: number; className?: string }) {
  return (
    <span
      title={price != null
        ? `Live price has cleared the fee-adjusted break-even (B/E ${fmtUSD(price)}) — closing now is net-profitable after fees. This is about the current price, NOT the stop-loss: it does not mean the stop has been moved to break-even.`
        : 'Live price has cleared the fee-adjusted break-even — closing now is net-profitable after fees. This is about the current price, NOT the stop-loss: it does not mean the stop has been moved to break-even.'}
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

// ── OCO chip ────────────────────────────────────────────────────────────────

function OcoChip({ status }: { status: ActivePosition['oco_status'] }) {
  if (status === 'ACTIVE') {
    return <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-buy/10 text-buy border border-buy/20" title="Exchange-side OCO active">🛡 OCO</span>
  }
  if (status === 'FAILED') {
    return <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-sell/10 text-sell border border-sell/20" title="OCO failed — software fallback">⚠ Fallback</span>
  }
  return null
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

// ── Live-flashing price ─────────────────────────────────────────────────────
// Subtle pulse on every tick: flashes buy/sell for ~0.6s on change, then settles.

function PriceTick({ value, className, base }: { value: number | null; className?: string; base?: string }) {
  const prev = useRef<number | null>(null)
  const [dir, setDir] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    if (value == null) return
    if (prev.current != null && value !== prev.current) {
      setDir(value > prev.current ? 'up' : 'down')
      const t = setTimeout(() => setDir(null), 600)
      prev.current = value
      return () => clearTimeout(t)
    }
    prev.current = value
  }, [value])

  return (
    <span
      className={cn(
        'tabular-nums transition-colors duration-500',
        dir === 'up' && 'text-buy',
        dir === 'down' && 'text-sell',
        !dir && base,
        className,
      )}
    >
      {value != null ? fmtUSD(value) : '—'}
    </span>
  )
}

// ── Price track (SL → entry → TP) ───────────────────────────────────────────

function PriceTrack({ sl, tp, current, entry }: { sl: number; tp: number | null; current: number | null; entry: number }) {
  if (!current || !tp || tp <= sl) return null
  const range = tp - sl
  const pct = Math.max(2, Math.min(98, ((current - sl) / range) * 100))
  const entryPct = Math.max(2, Math.min(98, ((entry - sl) / range) * 100))
  const isAboveEntry = current >= entry
  return (
    <div className="relative h-1.5 rounded-full bg-surface-hover">
      <div className="absolute inset-0 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-sell/25 to-transparent" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-buy/25 to-transparent" />
      </div>
      <div
        className="absolute top-1/2 w-px h-3.5 bg-border"
        style={{ left: `${entryPct}%`, transform: 'translate(-50%, -50%)' }}
        title="Entry price"
      />
      <div
        className={cn(
          'absolute w-3 h-3 rounded-full border-2 border-surface-card',
          'shadow-[0_0_10px_-1px_var(--tw-shadow-color)]',
          isAboveEntry ? 'bg-buy shadow-buy/60' : 'bg-sell shadow-sell/60',
        )}
        style={{ left: `${pct}%`, top: '50%', transform: 'translate(-50%, -50%)' }}
        title={`Current: ${fmtUSD(current)}`}
      />
    </div>
  )
}

// ── KPI / HUD card ──────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, tone = 'neutral', icon }: {
  label: string
  value: string
  sub?: string
  tone?: Tone
  icon?: React.ReactNode
}) {
  const t = TONE[tone]
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border p-4 sm:p-5',
        'bg-surface-card/70 backdrop-blur-xl',
        'shadow-[0_0_28px_-14px_var(--tw-shadow-color)] transition-all duration-300',
        'hover:-translate-y-0.5',
        t.ring, t.glow,
      )}
    >
      {/* top accent hairline */}
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent opacity-50', t.text, 'via-current')} />
      {/* corner glow */}
      <div className={cn('pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl opacity-10 transition-opacity duration-300 group-hover:opacity-20', t.text.replace('text-', 'bg-'))} />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted uppercase tracking-wider">{label}</p>
          <p className={cn('mt-2 text-2xl font-bold tabular-nums leading-none tracking-tight', t.text)}>
            {value}
          </p>
          {sub && <p className="mt-2 text-xs text-muted">{sub}</p>}
        </div>
        {icon && (
          <div className={cn('shrink-0 p-2 rounded-xl bg-surface-hover/60 border border-border/60', t.text)}>
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Benchmark delta stat (vs HODL strip) ────────────────────────────────────

function DeltaStat({ label, pct, usd, sub }: { label: string; pct: number | null; usd: number | null; sub?: string }) {
  const tone = pnlTone(pct)
  const t = TONE[tone]
  const up = (pct ?? 0) >= 0
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</span>
      <span className={cn('mt-1 flex items-center gap-1 text-lg font-bold tabular-nums leading-none', t.text)}>
        {pct != null ? (
          <>
            <span className="inline-flex">{up ? <ArrowUpRight /> : <ArrowDownRight />}</span>
            {up ? '+' : ''}{pct.toFixed(2)}%
          </>
        ) : <span className="text-muted">—</span>}
      </span>
      {usd != null && (
        <span className={cn('mt-1 text-xs tabular-nums', t.text)}>{usd >= 0 ? '+' : ''}{fmtUSD(usd)}</span>
      )}
      {sub && <span className="mt-0.5 text-[10px] text-muted">{sub}</span>}
    </div>
  )
}

// ── Position card (spacious DeFi-wallet style) ──────────────────────────────

function PositionCard({ pos, onSelect }: { pos: ActivePosition; onSelect: (p: ActivePosition) => void }) {
  const coin = pos.coin.replace('/USDC', '')
  const tone = pnlTone(pos.pnl)
  const t = TONE[tone]
  const pnlPos = (pos.pnl ?? 0) >= 0
  const slPnl = pos.stop_loss ? Math.round((pos.stop_loss - pos.entry_price) * pos.quantity * 100) / 100 : null
  const openedAt = pos.created_at ? new Date(pos.created_at.includes('T') ? pos.created_at : pos.created_at + 'Z') : null
  const durationSec = openedAt ? Math.floor((Date.now() - openedAt.getTime()) / 1000) : null

  return (
    <button
      type="button"
      onClick={() => onSelect(pos)}
      className={cn(
        'group relative w-full overflow-hidden rounded-2xl border p-4 text-left',
        'bg-surface-card/70 backdrop-blur-xl',
        'shadow-[0_0_30px_-18px_var(--tw-shadow-color)] transition-all duration-300',
        'hover:-translate-y-0.5 hover:border-accent/40',
        t.ring, t.glow,
      )}
    >
      {/* left status rail */}
      <div className={cn('pointer-events-none absolute inset-y-0 left-0 w-0.5', pnlPos ? 'bg-buy/60' : 'bg-sell/60')} />

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-bold tracking-tight text-foreground">{coin}</span>
          <span className={cn(
            'text-xs px-1.5 py-0.5 rounded-md font-medium border',
            pos.status === 'OPEN' ? 'bg-buy/10 text-buy border-buy/20' : 'bg-muted/10 text-muted border-border',
          )}>
            {pos.status}
          </span>
          {pos.status === 'OPEN' && <OcoChip status={pos.oco_status} />}
        </div>
        <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-md border border-border bg-surface-hover/60 text-muted font-medium capitalize">
          {pos.horizon ?? 'medium'}
        </span>
      </div>

      {pos.status === 'OPEN' && pos.past_break_even && (
        <div className="mt-2">
          <BreakEvenBadge price={pos.break_even_price} />
        </div>
      )}

      {/* PnL hero */}
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={cn('flex items-center gap-1.5 text-2xl font-bold tabular-nums leading-none', t.text)}>
            {pos.pnl != null ? (
              <>
                <span className={cn('inline-flex', t.text)}>{pnlPos ? <ArrowUpRight /> : <ArrowDownRight />}</span>
                {pnlPos ? '+' : ''}{fmtUSD(pos.pnl)}
              </>
            ) : <span className="text-muted">—</span>}
          </p>
          {pos.pnl_pct != null && (
            <p className={cn('mt-1 text-sm font-semibold tabular-nums', t.text)}>{fmtPct(pos.pnl_pct)}</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wide text-muted">Live</p>
          <PriceTick value={pos.current_price} base="text-foreground" className="text-sm font-semibold" />
          <p className="text-[10px] text-muted tabular-nums mt-0.5">entry {fmtUSD(pos.entry_price)}</p>
        </div>
      </div>

      {/* SL → entry → TP track */}
      {pos.stop_loss && pos.take_profit && pos.current_price ? (
        <div className="mt-4">
          <PriceTrack sl={pos.stop_loss} tp={pos.take_profit} current={pos.current_price} entry={pos.entry_price} />
          <div className="mt-1.5 flex items-center justify-between text-[11px] tabular-nums">
            <span className="text-sell">SL {fmtUSD(pos.stop_loss)}</span>
            <span className="text-buy">TP {fmtUSD(pos.take_profit)}</span>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center justify-between text-[11px] tabular-nums">
          <span className="text-sell">SL {fmtUSD(pos.stop_loss)}</span>
          <span className="text-muted">{pos.take_profit != null ? `TP ${fmtUSD(pos.take_profit)}` : 'No TP set'}</span>
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3 text-xs">
        <div className="flex items-center gap-3 text-muted tabular-nums">
          <span title="Time since opened">{durationSec != null ? fmtDuration(durationSec) : '—'}</span>
          {pos.distance_to_sl_pct != null && (
            <span className={cn(pos.distance_to_sl_pct < 2 ? 'text-sell font-semibold' : 'text-muted')} title="Distance to stop-loss">
              {pos.distance_to_sl_pct.toFixed(1)}% to SL
            </span>
          )}
        </div>
        {slPnl != null && (
          <span
            title="Realised P&L in USDC if this position is closed at the stop-loss"
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-semibold tabular-nums border',
              slPnl >= 0 ? 'bg-buy/10 text-buy border-buy/20' : 'bg-sell/10 text-sell border-sell/20',
            )}
          >
            {slPnl >= 0 ? '+' : ''}{fmtUSD(slPnl)} at stop
          </span>
        )}
      </div>
    </button>
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
            {pos.status === 'OPEN' && <OcoChip status={pos.oco_status} />}
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
            {pos.stop_loss != null && (() => {
              const slPnl = Math.round((pos.stop_loss - pos.entry_price) * pos.quantity * 100) / 100
              return (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted">If stopped out</span>
                  <span
                    title="Realised P&L in USDC if this position is closed at the stop-loss"
                    className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-md font-semibold tabular-nums border',
                      slPnl >= 0 ? 'bg-buy/10 text-buy border-buy/20' : 'bg-sell/10 text-sell border-sell/20',
                    )}
                  >
                    {slPnl >= 0 ? '+' : ''}{fmtUSD(slPnl)}
                  </span>
                </div>
              )
            })()}
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

// ── Loading skeletons ───────────────────────────────────────────────────────

function KpiSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-surface-card/70 backdrop-blur-xl p-5 animate-pulse">
      <div className="h-3 w-20 rounded bg-surface-hover" />
      <div className="mt-3 h-7 w-28 rounded bg-surface-hover" />
      <div className="mt-3 h-3 w-16 rounded bg-surface-hover" />
    </div>
  )
}

function PositionSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-surface-card/70 backdrop-blur-xl p-4 animate-pulse">
      <div className="flex justify-between">
        <div className="h-4 w-16 rounded bg-surface-hover" />
        <div className="h-4 w-12 rounded bg-surface-hover" />
      </div>
      <div className="mt-4 h-7 w-32 rounded bg-surface-hover" />
      <div className="mt-5 h-1.5 w-full rounded bg-surface-hover" />
      <div className="mt-4 h-3 w-full rounded bg-surface-hover" />
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

  const [reviews, setReviews] = useState<PositionReview[]>([])
  const [monitorNotes, setMonitorNotes] = useState<MonitorNote[]>([])
  const [closingCoin, setClosingCoin] = useState<string | null>(null)
  const [markingClosed, setMarkingClosed] = useState<string | null>(null)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const [selectedPos, setSelectedPos] = useState<ActivePosition | null>(null)

  const [benchmark, setBenchmark] = useState<BenchmarkResponse | null>(null)
  const [benchCoin, setBenchCoin] = useState('BTC')
  const [benchLoading, setBenchLoading] = useState(true)

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
      setReviews(data.reviews ?? [])
      setMonitorNotes(data.notes ?? [])
    }).catch(() => {})
  }

  // Benchmark anchors refresh on load / coin change; the deltas themselves recompute
  // live (client-side) against the live total value on every price tick.
  const loadBenchmark = useCallback((coin?: string) => {
    setBenchLoading(true)
    const q = coin ? `?coin=${encodeURIComponent(coin)}` : ''
    fetch(`/api/portfolio/benchmark${q}`).then(r => r.json()).then((b: BenchmarkResponse) => {
      setBenchmark(b)
      if (b?.coin) setBenchCoin(b.coin)
    }).catch(() => {}).finally(() => setBenchLoading(false))
  }, [])

  function handleBenchCoinChange(coin: string) {
    setBenchCoin(coin)
    loadBenchmark(coin)
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'benchmark_coin', value: coin }),
    }).catch(() => {})
  }

  useWebSocket(useCallback((event: string, data: unknown) => {
    if (event === 'monitor_completed') loadMonitor()
    if (event === 'monitor_error') setMonitorError((data as { error?: string })?.error ?? 'Monitor failed')
  }, []))

  useEffect(() => { load(); loadMonitor(); loadBenchmark() }, [loadBenchmark])

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

  // ── "vs HODL" benchmark: where the portfolio would stand had the whole book
  // been parked in the reference coin instead. Value-scaled (cash flows ignored).
  const benchAvailable = benchmark?.available === true
  const benchTotalValue = benchAvailable
    ? benchmark!.inception_value! * (benchmark!.coin_price_now! / benchmark!.inception_coin_price!)
    : null
  const benchDailyValue = benchAvailable
    ? benchmark!.day_ago_value! * (benchmark!.coin_price_now! / benchmark!.day_ago_coin_price!)
    : null
  const benchTotalPct = benchTotalValue && benchTotalValue > 0 ? (totalValue / benchTotalValue - 1) * 100 : null
  const benchTotalUsd = benchTotalValue != null ? totalValue - benchTotalValue : null
  const benchDailyPct = benchDailyValue && benchDailyValue > 0 ? (totalValue / benchDailyValue - 1) * 100 : null
  const benchDailyUsd = benchDailyValue != null ? totalValue - benchDailyValue : null
  const benchOptions = Array.from(new Set(
    ['BTC', 'ETH', 'SOL', 'BNB', ...holdings.map(h => h.coin.replace('/USDC', '')), benchCoin],
  )).filter(c => c && c !== 'USDC')
  const benchSince = benchmark?.inception_at ? benchmark.inception_at.slice(0, 10) : null

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

  const winCount = gains?.positions.filter(p => p.pnl >= 0).length ?? 0
  const totalTrades = gains?.positions.length ?? 0
  const winRate = totalTrades > 0 ? Math.round((winCount / totalTrades) * 100) : null

  const firstLoad = loading && !portfolio

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── HUD: KPI banners ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {firstLoad ? (
          Array.from({ length: 5 }).map((_, i) => <KpiSkeleton key={i} />)
        ) : (
          <>
            <KpiCard
              label="Total Value"
              value={fmtUSD(livePrices.size > 0 ? totalValue : (portfolio?.total_value ?? 0))}
              tone="accent"
              icon={<WalletIcon />}
              sub="USDC + open holdings"
            />
            <KpiCard
              label="Unrealized P&L"
              value={`${liveUsd >= 0 ? '+' : ''}${fmtUSD(liveUsd)}`}
              tone={pnlTone(liveUsd)}
              icon={<TrendUpIcon />}
              sub={livePct != null ? `${fmtPct(livePct)} open` : 'no open positions'}
            />
            <KpiCard
              label="Realized P&L"
              value={`${realizedUsd >= 0 ? '+' : ''}${fmtUSD(realizedUsd)}`}
              tone={pnlTone(realizedUsd)}
              sub={realizedPct != null ? `${fmtPct(realizedPct)} total return` : 'no closed trades'}
            />
            <KpiCard
              label="USDC Balance"
              value={fmtUSD(usdcBalance)}
              tone="accent"
              icon={<VaultIcon />}
              sub={portfolio?.binance_usdc != null ? `${fmtUSD(portfolio.available_usdc ?? 0)} available` : undefined}
            />
            <KpiCard
              label="Positions"
              value={`${openCount} / ${maxPositions}`}
              tone={openCount >= maxPositions ? 'neg' : 'neutral'}
              icon={<StackIcon />}
              sub={openCount >= maxPositions ? 'limit reached' : `${maxPositions - openCount} slot${maxPositions - openCount !== 1 ? 's' : ''} free`}
            />
          </>
        )}
      </div>

      {/* ── vs HODL benchmark strip ───────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-border bg-surface-card/70 backdrop-blur-xl px-5 py-3">
        <div
          className="flex items-center gap-2"
          title={`Compares your live total value against simply holding ${benchCoin} since your first portfolio snapshot. "Total" is outperformance since inception; "24h" is outperformance over the last day. Value-scaled — recent deposits/withdrawals are not cash-flow adjusted.`}
        >
          <span className="text-xs font-medium uppercase tracking-wider text-muted">vs HODL</span>
          <select
            value={benchCoin}
            onChange={e => handleBenchCoinChange(e.target.value)}
            className="text-sm font-semibold bg-surface-elevated border border-border rounded-lg px-2 py-1 text-accent cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
          >
            {benchOptions.map(c => <option key={c} value={c} className="text-foreground">{c}</option>)}
          </select>
          <svg className="w-3.5 h-3.5 text-muted/70" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
        </div>

        <div className="hidden sm:block h-9 w-px bg-border" />

        {benchAvailable ? (
          <>
            <DeltaStat label="Total" pct={benchTotalPct} usd={benchTotalUsd} sub={benchSince ? `since ${benchSince}` : undefined} />
            <DeltaStat label="24h" pct={benchDailyPct} usd={benchDailyUsd} />
            <div className="ml-auto hidden md:flex flex-col items-end justify-center text-[11px] tabular-nums leading-snug text-muted">
              <span>You <span className="text-foreground font-medium">{fmtUSD(totalValue)}</span></span>
              <span>{benchCoin} hold <span className="text-foreground font-medium">{benchTotalValue != null ? fmtUSD(benchTotalValue) : '—'}</span></span>
            </div>
          </>
        ) : (
          <span className="text-xs text-muted">
            {benchLoading
              ? 'Loading benchmark…'
              : `Not enough portfolio history yet to benchmark against ${benchCoin}.`}
          </span>
        )}
      </div>

      {/* Win-rate strip */}
      {totalTrades > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-surface-card/70 backdrop-blur-xl px-5 py-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">Win Rate</span>
            <span className={cn('text-lg font-bold tabular-nums', (winRate ?? 0) >= 50 ? 'text-buy' : 'text-sell')}>
              {winRate}%
            </span>
            <span className="text-xs text-muted">({winCount}/{totalTrades})</span>
          </div>
          <div className="hidden sm:block h-5 w-px bg-border" />
          <div className="flex-1 min-w-[140px] flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-surface-hover overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', (winRate ?? 0) >= 50 ? 'bg-buy' : 'bg-sell')}
                style={{ width: `${winRate ?? 0}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {monitorError && (
        <div className="px-4 py-3 rounded-xl bg-sell/10 border border-sell/20 text-sell text-sm">
          {monitorError}
        </div>
      )}

      {/* ── Active Positions (card grid) ───────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Active Positions"
            subtitle="Bot-managed trades with stop-loss and take-profit monitoring"
            action={
              <span className="text-xs px-2.5 py-1 rounded-md border border-border bg-surface-hover/60 text-muted font-medium tabular-nums">
                {livePositions.length} open
              </span>
            }
          />
        </div>

        <div className="px-5 pb-5">
          {firstLoad ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => <PositionSkeleton key={i} />)}
            </div>
          ) : livePositions.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted">No active bot positions.</p>
              <p className="text-xs text-muted mt-1 opacity-70">The trading engine hasn't opened any monitored trades yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {livePositions.map(pos => (
                <PositionCard key={pos.id} pos={pos} onSelect={setSelectedPos} />
              ))}
            </div>
          )}
        </div>
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
                          <Td right>{h.current_price != null ? <PriceTick value={h.current_price} base="text-foreground" /> : '—'}</Td>
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

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        onSuccess={load}
        localEntries={portfolio?.entries ?? []}
      />
    </div>
  )
}
