import { BandSnapshot, EntrySignal } from '../types'
import { Badge } from './ui/Badge'
import { fmtUSD, fmtPct, cn } from '../lib/utils'

export interface SignalDataTarget {
  coin: string
  signal?: EntrySignal
  bandHistory?: BandSnapshot[]
}

interface SignalDataModalProps {
  target: SignalDataTarget | null
  onClose: () => void
}

const SOURCE_STYLE: Record<BandSnapshot['source'], { label: string; cls: string; dot: string }> = {
  agent:  { label: 'Entry Agent', cls: 'bg-accent/10 text-accent border-accent/20', dot: 'bg-accent' },
  static: { label: 'Static settings', cls: 'bg-surface-elevated text-muted border-border', dot: 'bg-muted' },
  manual: { label: 'Manual edit', cls: 'bg-warn/10 text-warn border-warn/20', dot: 'bg-warn' },
}

function timeAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function Delta({ from, to, suffix = '' }: { from: number; to: number; suffix?: string }) {
  const pct = from !== 0 ? ((to - from) / from) * 100 : 0
  if (Math.abs(to - from) < 1e-9) {
    return <span className="text-[10px] text-muted">unchanged</span>
  }
  const up = to > from
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums', up ? 'text-buy' : 'text-sell')}>
      <svg className={cn('h-2.5 w-2.5', !up && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" />
      </svg>
      {fmtPct(pct)}{suffix}
    </span>
  )
}

function MarketTile({ label, value, tone }: { label: string; value: string; tone?: 'buy' | 'sell' }) {
  return (
    <div className="rounded-xl bg-surface-elevated border border-border px-3 py-2.5">
      <p className="text-[10px] font-semibold text-muted uppercase tracking-wider">{label}</p>
      <p className={cn(
        'mt-1 text-sm font-semibold tabular-nums',
        tone === 'buy' ? 'text-buy' : tone === 'sell' ? 'text-sell' : 'text-foreground',
      )}>{value}</p>
    </div>
  )
}

/**
 * Shows what fed an entry-band decision (the analyst/agent's BUY thesis + the live
 * market context at the time) and a timeline of every band assignment since
 * registration — the initial band, each Entry Agent pass, and manual edits —
 * so a re-run's effect on the levels is visible as a diff, not just the latest state.
 */
export function SignalDataModal({ target, onClose }: SignalDataModalProps) {
  if (!target) return null
  const coin = target.coin.replace('/USDC', '')
  const signal = target.signal
  const history = target.bandHistory ?? []
  const initialMarket = history.find(h => h.market)?.market

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-2xl mx-4 max-h-[85vh] overflow-y-auto bg-surface-card border border-border rounded-2xl shadow-2xl animate-fade-in">

        {/* Header */}
        <div className="sticky top-0 bg-surface-card flex items-start gap-3 px-6 py-5 border-b border-border z-10">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 002.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{coin} — signal &amp; entry data</h2>
            <p className="text-xs text-muted mt-0.5 leading-relaxed">
              What the entry decision was based on, and how the band changed over {history.length || 0} update{history.length === 1 ? '' : 's'}.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-foreground hover:bg-surface-elevated transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">

          {/* Signal / thesis */}
          {signal && (
            <section>
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2.5">Signal</h3>
              <div className="rounded-xl border border-border bg-surface-elevated p-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={signal.action === 'BUY' ? 'buy' : signal.action === 'SELL' ? 'sell' : 'hold'}>{signal.action}</Badge>
                  <Badge variant="neutral">{Math.round(signal.confidence * 100)}% confidence</Badge>
                  {signal.horizon && <Badge variant="neutral">{signal.horizon} horizon</Badge>}
                  {signal.stop_loss_pct != null && <Badge variant="sell">SL {signal.stop_loss_pct.toFixed(1)}%</Badge>}
                  {signal.take_profit_pct != null && <Badge variant="buy">TP {signal.take_profit_pct.toFixed(1)}%</Badge>}
                </div>
                {/* Confidence bar */}
                <div className="h-1.5 rounded-full bg-border overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.round(signal.confidence * 100)}%` }} />
                </div>
                <p className="text-sm text-foreground leading-relaxed italic">&ldquo;{signal.reason}&rdquo;</p>
              </div>
            </section>
          )}

          {/* Market context at signal time */}
          {initialMarket && (
            <section>
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2.5">Market context at signal time</h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                <MarketTile label="Price" value={fmtUSD(initialMarket.price)} />
                <MarketTile label="24h change" value={fmtPct(initialMarket.change24h)} tone={initialMarket.change24h >= 0 ? 'buy' : 'sell'} />
                <MarketTile label="7d perf" value={fmtPct(initialMarket.perf7d)} tone={initialMarket.perf7d >= 0 ? 'buy' : 'sell'} />
                <MarketTile label="RSI(14)" value={initialMarket.rsi14.toFixed(1)} />
                <MarketTile label="ATR(14)" value={fmtUSD(initialMarket.atr14)} />
                <MarketTile label="SMA 7" value={fmtUSD(initialMarket.sma7)} />
                <MarketTile label="SMA 25" value={fmtUSD(initialMarket.sma25)} />
                <MarketTile label="SMA 99" value={fmtUSD(initialMarket.sma99)} />
              </div>
              <div className="flex items-center gap-2 mt-2.5">
                <Badge variant={initialMarket.trend === 'uptrend' ? 'buy' : initialMarket.trend === 'downtrend' ? 'sell' : 'hold'}>
                  {initialMarket.trend}
                </Badge>
                <Badge variant="neutral">{initialMarket.volatility} volatility</Badge>
              </div>
            </section>
          )}

          {/* Band history timeline */}
          {history.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2.5">Entry band history</h3>
              <div className="space-y-3">
                {history.map((h, i) => {
                  const prev = i > 0 ? history[i - 1] : null
                  const st = SOURCE_STYLE[h.source]
                  return (
                    <div key={h.at} className="relative pl-6">
                      {i < history.length - 1 && (
                        <span className="absolute left-[5px] top-5 bottom-[-12px] w-px bg-border" aria-hidden />
                      )}
                      <span className={cn('absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface-card', st.dot)} aria-hidden />
                      <div className="rounded-xl border border-border bg-surface-elevated p-3.5">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className={cn('text-[11px] font-semibold px-2 py-0.5 rounded-full border', st.cls)}>
                              {i === 0 ? 'Created — ' : ''}{st.label}
                            </span>
                            <span className="text-[11px] text-muted">{timeAgo(Date.now() - h.at)}</span>
                          </div>
                        </div>
                        {h.reason && <p className="text-xs text-muted mt-2 leading-relaxed">{h.reason}</p>}
                        <div className="grid grid-cols-3 gap-3 mt-3 text-xs tabular-nums">
                          <div>
                            <p className="text-[10px] text-muted uppercase tracking-wide">Target</p>
                            <p className="font-semibold text-accent">{fmtUSD(h.targetPrice)}</p>
                            {prev && <Delta from={prev.targetPrice} to={h.targetPrice} />}
                          </div>
                          <div>
                            <p className="text-[10px] text-muted uppercase tracking-wide">Invalidate</p>
                            <p className="font-semibold text-sell">{fmtUSD(h.invalidatePrice)}</p>
                            {prev && <Delta from={prev.invalidatePrice} to={h.invalidatePrice} />}
                          </div>
                          <div>
                            <p className="text-[10px] text-muted uppercase tracking-wide">Chase cap</p>
                            <p className="font-semibold text-warn">{fmtUSD(h.chaseCapPrice)}</p>
                            {prev && <Delta from={prev.chaseCapPrice} to={h.chaseCapPrice} />}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          TTL {Math.round(h.ttlMinutes)}m
                          {prev && Math.round(prev.ttlMinutes) !== Math.round(h.ttlMinutes) && (
                            <span className="text-foreground/70">(was {Math.round(prev.ttlMinutes)}m)</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {!signal && history.length === 0 && (
            <p className="text-sm text-muted text-center py-6">No signal data captured for this entry.</p>
          )}
        </div>
      </div>
    </div>
  )
}
