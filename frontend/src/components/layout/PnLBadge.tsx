import { useCallback, useEffect, useState } from 'react'
import { usePrices } from '../../hooks/usePrices'
import { useWebSocket } from '../../hooks/useWebSocket'
import { ActivePosition, ClosedPosition, GainsResponse } from '../../types'
import { cn, fmt } from '../../lib/utils'

// Signed USD — '+$42.10' / '-$3.00'. fmtUSD() in utils renders '$-3.00' which reads
// poorly for P&L, so the badge keeps its own signed formatter.
function signedUSD(value: number): string {
  const sign = value >= 0 ? '+' : '-'
  return `${sign}$${fmt(Math.abs(value), 2)}`
}
function signedPct(value: number): string {
  return `${value >= 0 ? '+' : '-'}${fmt(Math.abs(value), 2)}%`
}

// UTC 'YYYY-MM-DD HH:MM:SS' (or ISO) → ms; null/invalid → null.
function parseUtc(s: string | null): number | null {
  if (!s) return null
  const ms = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  return Number.isNaN(ms) ? null : ms
}

// Start of the current UTC day, in ms — the cut for "today's" realized P&L.
function utcMidnight(): number {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

interface LivePos {
  coin: string
  ticker: string
  value: number // qty × live price
  pnl: number
  pnlPct: number
  priced: boolean
}

/**
 * Top-bar P&L badge. The pill is a live read on **unrealized** P&L across open
 * positions (dollar + return %), recomputed every tick from the price WebSocket and
 * coloured green/red by sign. Hover/focus reveals a card splitting unrealized vs
 * realized (all-time + today) and lists each open position's live P&L, largest mover
 * first — with an "Open →" jump to the Portfolio page. Mirrors the look and behaviour
 * of the Control Room / Endpoints badges.
 */
export function PnLBadge({ onOpen }: { onOpen?: () => void }) {
  const livePrices = usePrices()
  const [positions, setPositions] = useState<ActivePosition[]>([])
  const [gains, setGains] = useState<GainsResponse | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/positions').then(r => r.json()),
      fetch('/api/portfolio/gains').then(r => r.json()),
    ])
      .then(([pos, g]) => {
        setPositions(Array.isArray(pos) ? pos : [])
        setGains(g && typeof g === 'object' ? g : null)
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => { load() }, [load])

  // The dollar number stays live via the price WebSocket; refetch the position set
  // only when one is opened, adjusted, or closed so new/exited coins appear promptly.
  useWebSocket(useCallback((event: string) => {
    if (event === 'trade_executed' || event === 'position_adjusted' || event === 'portfolio_updated') load()
  }, [load]))

  // Safety-net poll in case an event is missed (light cadence — prices carry the rest).
  useEffect(() => {
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [load])

  // ── Live unrealized, per position ───────────────────────────────────────────────
  const live: LivePos[] = positions.map(pos => {
    const p = livePrices.get(pos.coin)
    const ticker = pos.coin.replace('/USDC', '')
    if (!p) {
      // No live price yet — fall back to the server's last-known pnl so the row isn't blank.
      return { coin: pos.coin, ticker, value: pos.entry_price * pos.quantity, pnl: pos.pnl ?? 0, pnlPct: pos.pnl_pct ?? 0, priced: false }
    }
    const pnl = (p.price - pos.entry_price) * pos.quantity
    const pnlPct = pos.entry_price > 0 ? ((p.price - pos.entry_price) / pos.entry_price) * 100 : 0
    return { coin: pos.coin, ticker, value: p.price * pos.quantity, pnl, pnlPct, priced: true }
  })

  const unrealUsd = live.reduce((s, p) => s + p.pnl, 0)
  const basis = positions.reduce((s, p) => s + p.entry_price * p.quantity, 0)
  const unrealPct = basis > 0 ? (unrealUsd / basis) * 100 : null

  const realizedUsd = gains?.total_pnl ?? 0
  const realizedBasis = gains?.positions.reduce((s, p) => s + p.entry_price * p.quantity, 0) ?? 0
  const realizedPct = realizedBasis > 0 ? (realizedUsd / realizedBasis) * 100 : null

  const since = utcMidnight()
  const todayUsd = (gains?.positions ?? []).reduce((s, p) => {
    const t = parseUtc(p.closed_at)
    return t != null && t >= since ? s + p.pnl : s
  }, 0)

  const hasPositions = positions.length > 0
  const ordered = [...live].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))

  // Pill tone: green/red by sign while holding; muted when flat or no positions.
  const tone: 'buy' | 'sell' | 'idle' = !hasPositions ? 'idle' : unrealUsd >= 0 ? 'buy' : 'sell'
  const PILL: Record<typeof tone, string> = {
    buy: 'text-buy bg-buy/10 border-buy/20',
    sell: 'text-sell bg-sell/10 border-sell/20',
    idle: 'text-muted bg-surface-elevated border-border hover:text-foreground',
  }

  return (
    <div className="group relative">
      <button
        type="button"
        aria-label="Live profit and loss"
        aria-live="polite"
        onClick={onOpen}
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
          PILL[tone],
        )}
      >
        <span className="relative flex h-1.5 w-1.5">
          {hasPositions && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
          )}
          <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full bg-current', !hasPositions && 'opacity-50')} />
        </span>
        <span className="opacity-80">P&amp;L</span>
        {hasPositions ? (
          <span className="tabular-nums">
            {signedUSD(unrealUsd)}
            {unrealPct != null && <span className="ml-1 font-medium opacity-80">· {signedPct(unrealPct)}</span>}
          </span>
        ) : (
          <span className="font-medium text-muted">{loaded ? 'Flat' : '…'}</span>
        )}
      </button>

      {/* Hover / focus detail card */}
      <div
        className={cn(
          'absolute right-0 top-full z-30 mt-2 w-80 origin-top-right',
          'invisible translate-y-1 opacity-0 transition-all duration-150',
          'group-hover:visible group-hover:translate-y-0 group-hover:opacity-100',
          'group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100',
        )}
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-surface-card shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-foreground">Live P&amp;L</span>
            <button
              type="button"
              onClick={onOpen}
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-accent hover:opacity-80 transition-opacity"
            >
              Open
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Unrealized vs Realized split */}
          <div className="grid grid-cols-2 divide-x divide-border border-b border-border">
            <div className="px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Unrealized</p>
              <p className={cn('mt-0.5 text-base font-bold tabular-nums', hasPositions ? (unrealUsd >= 0 ? 'text-buy' : 'text-sell') : 'text-muted')}>
                {hasPositions ? signedUSD(unrealUsd) : '—'}
              </p>
              <p className={cn('text-[11px] tabular-nums', hasPositions && unrealPct != null ? (unrealUsd >= 0 ? 'text-buy' : 'text-sell') : 'text-muted')}>
                {hasPositions && unrealPct != null ? `${signedPct(unrealPct)} open` : 'no open positions'}
              </p>
            </div>
            <div className="px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Realized</p>
              <p className={cn('mt-0.5 text-base font-bold tabular-nums', realizedUsd >= 0 ? 'text-buy' : 'text-sell')}>
                {signedUSD(realizedUsd)}
              </p>
              <p className="text-[11px] tabular-nums text-muted">
                {realizedPct != null ? `${signedPct(realizedPct)} all-time` : 'no closed trades'}
                <span className={cn('ml-1', todayUsd >= 0 ? 'text-buy/80' : 'text-sell/80')}>· {signedUSD(todayUsd)} today</span>
              </p>
            </div>
          </div>

          {/* Per-position live P&L, largest mover first */}
          <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Positions</span>
            {hasPositions && <span className="text-[10px] tabular-nums text-muted">{positions.length} open</span>}
          </div>
          {!hasPositions ? (
            <p className="px-3 pb-3 text-xs text-muted">{loaded ? 'No open positions.' : 'Loading…'}</p>
          ) : (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto pb-1">
              {ordered.map(p => {
                const up = p.pnl >= 0
                return (
                  <li key={p.coin} className="flex items-center gap-2.5 px-3 py-2">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', up ? 'bg-buy' : 'bg-sell', !p.priced && 'opacity-40')} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-foreground">{p.ticker}</p>
                      <p className="truncate text-[10px] text-muted tabular-nums">${fmt(p.value, 2)} held</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={cn('text-xs font-semibold tabular-nums', up ? 'text-buy' : 'text-sell')}>{signedUSD(p.pnl)}</p>
                      <p className={cn('text-[10px] tabular-nums', up ? 'text-buy/80' : 'text-sell/80')}>{signedPct(p.pnlPct)}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
