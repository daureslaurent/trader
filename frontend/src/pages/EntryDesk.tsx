import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { usePrices } from '../hooks/usePrices'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { CandleChart, type ChartLevel, type ChartZone } from '../components/CandleChart'
import { CancelEntryModal } from '../components/CancelEntryModal'
import { Button } from '../components/ui/Button'
import { EntryIntent, EntryEvent } from '../types'
import { fmtUSD, fmtPct, cn } from '../lib/utils'

/* --------------------------------- helpers --------------------------------- */

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

function timeAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

interface EventStyle { label: string; cls: string; icon: string }

function eventStyle(e: EntryEvent): EventStyle {
  if (e.type === 'registered') {
    return { label: 'Queued', cls: 'text-accent bg-accent/10', icon: 'M12 6v6l4 2' }
  }
  if (e.type === 'filled') {
    return e.reason === 'expiry-market'
      ? { label: 'Filled at expiry', cls: 'text-buy bg-buy/10', icon: 'M5 13l4 4L19 7' }
      : { label: 'Filled on pullback', cls: 'text-buy bg-buy/10', icon: 'M5 13l4 4L19 7' }
  }
  // cancelled
  const map: Record<string, EventStyle> = {
    falling_knife: { label: 'Cancelled — falling knife', cls: 'text-sell bg-sell/10', icon: 'M19 14l-7 7m0 0l-7-7m7 7V3' },
    ran_away:      { label: 'Cancelled — ran away',      cls: 'text-warn bg-warn/10', icon: 'M5 10l7-7m0 0l7 7m-7-7v18' },
    expired:       { label: 'Cancelled — expired',       cls: 'text-muted bg-muted/10', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
    manual:        { label: 'Cancelled',                 cls: 'text-muted bg-muted/10', icon: 'M6 18L18 6M6 6l12 12' },
  }
  return map[e.reason ?? 'manual'] ?? map.manual
}

/* ---------------------------------- page ---------------------------------- */

export default function EntryDesk() {
  const [intents, setIntents] = useState<EntryIntent[]>([])
  const [events, setEvents] = useState<EntryEvent[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<EntryIntent | null>(null)
  const [now, setNow] = useState(Date.now())
  const prices = usePrices()

  useEffect(() => {
    fetch('/api/entry-intents').then(r => r.json()).then((d: EntryIntent[]) => {
      if (Array.isArray(d)) setIntents(d)
    }).catch(() => {})
    fetch('/api/entry-events').then(r => r.json()).then((d: EntryEvent[]) => {
      if (Array.isArray(d)) setEvents(d)
    }).catch(() => {})
  }, [])

  useWebSocket(useCallback((event: string, data: unknown) => {
    if (event === 'entry_intent_update') {
      const d = data as { intents?: EntryIntent[] }
      if (Array.isArray(d.intents)) setIntents(d.intents)
    } else if (event === 'entry_event') {
      setEvents(prev => [data as EntryEvent, ...prev].slice(0, 100))
    }
  }, []))

  // Countdown tick only while intents are live.
  useEffect(() => {
    if (intents.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [intents.length])

  // Keep a valid selection: default to the first intent, recover if the selected one resolves.
  const selectedIntent = useMemo(
    () => intents.find(i => i.coin === selected) ?? intents[0] ?? null,
    [intents, selected],
  )
  useEffect(() => {
    if (selectedIntent && selectedIntent.coin !== selected) setSelected(selectedIntent.coin)
  }, [selectedIntent, selected])

  // Session stats from the activity feed.
  const fills = events.filter(e => e.type === 'filled')
  const cancels = events.filter(e => e.type === 'cancelled')
  const avgSlip = fills.length
    ? fills.reduce((s, e) => s + (e.slippagePct ?? 0), 0) / fills.length
    : null
  const resolved = fills.length + cancels.length
  const fillRate = resolved > 0 ? (fills.length / resolved) * 100 : null

  const levels: ChartLevel[] = selectedIntent ? [
    { price: selectedIntent.chaseCapPrice, label: 'Chase cap', color: 'rgb(var(--warn-rgb))', dash: '5 3' },
    { price: selectedIntent.signalPrice, label: 'Signal', color: 'var(--muted-fg)', dash: '2 2' },
    { price: selectedIntent.targetPrice, label: 'Buy ≤', color: 'rgb(var(--accent-rgb))' },
    { price: selectedIntent.invalidatePrice, label: 'Invalidate', color: 'rgb(var(--sell-rgb))', dash: '5 3' },
  ] : []
  const zones: ChartZone[] = selectedIntent
    ? [{ y1: selectedIntent.invalidatePrice, y2: selectedIntent.targetPrice, color: 'rgb(var(--buy-rgb))' }]
    : []

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Explainer */}
      <Card className="relative overflow-hidden">
        <div aria-hidden className="absolute -top-24 -right-16 w-72 h-72 rounded-full bg-accent/10 blur-3xl pointer-events-none" />
        <div className="relative flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18zm0-4.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zm0-3a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">Entry Desk</h2>
            <p className="text-sm text-muted mt-1 leading-relaxed max-w-3xl">
              When the analyst issues a BUY, the bot doesn't fill immediately — it watches the live price and waits for a
              better entry. It <span className="text-accent font-medium">fills on a pullback</span> to the target, but
              <span className="text-sell font-medium"> cancels</span> if price breaks down (falling knife) or
              <span className="text-warn font-medium"> runs away</span> first. Below you can watch every pending intent
              and what the engine decided.
            </p>
          </div>
        </div>
      </Card>

      {/* Session stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Active intents" value={intents.length} hint={intents.length ? 'waiting for entry' : 'none pending'} accent />
        <StatCard label="Filled" value={fills.length} hint="recent" tone="buy" />
        <StatCard label="Cancelled" value={cancels.length} hint="recent" tone="sell" />
        <StatCard
          label="Avg entry vs signal"
          value={avgSlip != null ? `${avgSlip >= 0 ? '+' : ''}${avgSlip.toFixed(2)}%` : '—'}
          hint={fillRate != null ? `${Math.round(fillRate)}% fill rate` : 'no fills yet'}
          tone={avgSlip != null && avgSlip >= 0 ? 'buy' : avgSlip != null ? 'sell' : undefined}
        />
      </div>

      {/* Chart + active intents */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chart */}
        <Card noPad className="lg:col-span-2 overflow-hidden">
          {selectedIntent ? (
            <>
              <div className="flex items-start justify-between px-5 pt-5 pb-1 gap-3">
                <CardHeader
                  title={`${selectedIntent.coin.replace('/USDC', '')} — entry window`}
                  subtitle={`Signal ${fmtUSD(selectedIntent.signalPrice)} · expires in ${fmtCountdown(selectedIntent.expiresAt - now)}`}
                />
                <div className="flex items-center gap-2 shrink-0">
                  {selectedIntent.bandSource === 'llm' && (
                    <Badge variant="accent" title={selectedIntent.planReason || 'Levels chosen by the Entry Planner'}>AI levels</Badge>
                  )}
                  <Badge variant="accent" dot>Waiting</Badge>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setCancelTarget(selectedIntent)}
                    title="Cancel this deferred entry"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Cancel
                  </Button>
                </div>
              </div>
              {selectedIntent.bandSource === 'llm' && selectedIntent.planReason && (
                <p className="px-5 pb-1 text-xs text-muted leading-relaxed">
                  <span className="font-medium text-foreground">Entry Planner:</span> {selectedIntent.planReason}
                </p>
              )}
              <CandleChart symbol={selectedIntent.coin} levels={levels} zones={zones} hideSlTp />
            </>
          ) : (
            <div className="flex flex-col items-center justify-center text-center h-[420px] px-6">
              <div className="w-12 h-12 rounded-2xl bg-surface-elevated flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18zm0-4.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-foreground">No pending entries right now</p>
              <p className="text-sm text-muted mt-1 max-w-sm">
                When the pipeline issues a BUY, it'll appear here with its live entry window. Recent outcomes are shown below.
              </p>
            </div>
          )}
        </Card>

        {/* Active intent list */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            Waiting for Entry
            {intents.length > 0 && <Badge variant="accent">{intents.length}</Badge>}
          </h3>
          {intents.length === 0 ? (
            <Card className="text-sm text-muted">Nothing queued. New BUY signals will show up here.</Card>
          ) : (
            intents.map(i => (
              <IntentCard
                key={i.id}
                intent={i}
                now={now}
                currentPrice={prices.get(i.coin)?.price}
                selected={selectedIntent?.coin === i.coin}
                onSelect={() => setSelected(i.coin)}
                onCancel={() => setCancelTarget(i)}
              />
            ))
          )}
        </div>
      </div>

      {/* Activity feed */}
      <Card noPad>
        <div className="px-5 pt-5 pb-3">
          <CardHeader title="Activity" subtitle={`${events.length} recent event${events.length !== 1 ? 's' : ''}`} />
        </div>
        {events.length === 0 ? (
          <div className="px-5 pb-6 text-sm text-muted">No entry activity yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {events.map(e => {
              const st = eventStyle(e)
              const coin = e.coin.replace('/USDC', '')
              const slip = e.slippagePct
              return (
                <div key={e.id} className="px-5 py-3 flex items-center gap-3">
                  <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', st.cls)}>
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d={st.icon} />
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{coin}</span>
                      <span className={cn('text-[11px] font-semibold px-1.5 py-0.5 rounded-md', st.cls)}>{st.label}</span>
                    </div>
                    <p className="text-xs text-muted tabular-nums mt-0.5">
                      Signal {fmtUSD(e.signalPrice)}
                      {e.price != null && <> · {e.type === 'filled' ? 'fill' : 'at'} {fmtUSD(e.price)}</>}
                    </p>
                  </div>
                  {e.type === 'filled' && slip != null && (
                    <span className={cn('text-xs font-semibold tabular-nums shrink-0', slip >= 0 ? 'text-buy' : 'text-sell')}>
                      {slip >= 0 ? '+' : ''}{slip.toFixed(2)}%
                      <span className="block text-[10px] font-normal text-muted text-right">vs signal</span>
                    </span>
                  )}
                  <span className="text-[11px] text-muted tabular-nums shrink-0 w-16 text-right">{timeAgo(now - e.at)}</span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Cancel confirmation */}
      <CancelEntryModal
        intent={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={(coin) => { if (selected === coin) setSelected(null) }}
      />
    </div>
  )
}

/* -------------------------------- sub-components -------------------------------- */

function StatCard({ label, value, hint, tone, accent }: {
  label: string
  value: string | number
  hint?: string
  tone?: 'buy' | 'sell'
  accent?: boolean
}) {
  return (
    <Card className={cn(accent && 'border-accent/25')}>
      <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">{label}</p>
      <p className={cn(
        'mt-2 text-2xl font-bold tabular-nums tracking-tight leading-none',
        tone === 'buy' ? 'text-buy' : tone === 'sell' ? 'text-sell' : 'text-foreground',
      )}>
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[11px] text-muted">{hint}</p>}
    </Card>
  )
}

function IntentCard({ intent, now, currentPrice, selected, onSelect, onCancel }: {
  intent: EntryIntent
  now: number
  currentPrice?: number
  selected: boolean
  onSelect: () => void
  onCancel: () => void
}) {
  const coin = intent.coin.replace('/USDC', '')
  const lo = intent.invalidatePrice
  const hi = intent.chaseCapPrice
  const pct = (p: number) => (hi > lo ? Math.min(100, Math.max(0, ((p - lo) / (hi - lo)) * 100)) : 50)
  const targetPos = pct(intent.targetPrice)
  const pos = currentPrice != null ? pct(currentPrice) : null
  const atOrBelowTarget = currentPrice != null && currentPrice <= intent.targetPrice

  return (
    <Card
      onClick={onSelect}
      className={cn('!p-3.5 space-y-3', selected && 'border-accent/40 ring-1 ring-accent/20')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-semibold text-foreground">{coin}</span>
          {intent.bandSource === 'llm' && (
            <span
              title={intent.planReason || 'Levels chosen by the Entry Planner'}
              className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
            >
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.4 6.6L22 12l-6.6 2.4L13 21l-2.4-6.6L4 12l6.6-2.4L13 3z" />
              </svg>
              AI
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px] text-muted tabular-nums">{fmtCountdown(intent.expiresAt - now)} left</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCancel() }}
            title="Cancel this entry"
            aria-label={`Cancel entry for ${coin}`}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-muted hover:text-sell hover:bg-sell/10 transition-colors duration-150"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      </div>

      {intent.bandSource === 'llm' && intent.planReason && (
        <p className="text-[11px] text-muted leading-snug line-clamp-2">{intent.planReason}</p>
      )}

      <div className="flex items-center justify-between text-xs tabular-nums">
        <span className="text-muted">Buy ≤ <span className="text-accent font-semibold">{fmtUSD(intent.targetPrice)}</span></span>
        <span className={cn('font-medium', atOrBelowTarget ? 'text-buy' : 'text-foreground')}>
          {currentPrice != null ? fmtUSD(currentPrice) : '—'}
        </span>
      </div>

      {/* Band: invalidate ─ target ─ chase cap, with a live marker */}
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-sell/30 via-border to-warn/30">
        <span className="absolute top-1/2 -translate-y-1/2 h-3 w-0.5 rounded-full bg-accent" style={{ left: `${targetPos}%` }} />
        {pos != null && (
          <span
            className="absolute top-1/2 -translate-y-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-foreground shadow ring-2 ring-surface-card transition-all duration-300"
            style={{ left: `${pos}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-muted tabular-nums">
        <span className="text-sell/80">{fmtPct(((lo - intent.signalPrice) / intent.signalPrice) * 100)}</span>
        <span className="text-warn/80">+{(((hi - intent.signalPrice) / intent.signalPrice) * 100).toFixed(1)}%</span>
      </div>
    </Card>
  )
}
