import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { usePrices } from '../hooks/usePrices'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { EntryBandChart } from '../components/EntryBandChart'
import { CancelEntryModal } from '../components/CancelEntryModal'
import { ManualEntryModal } from '../components/ManualEntryModal'
import { ValidateEntryModal } from '../components/ValidateEntryModal'
import { EditEntryModal } from '../components/EditEntryModal'
import { SignalDataModal, SignalDataTarget } from '../components/SignalDataModal'
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
    if (e.reason === 'expiry-market') return { label: 'Filled at expiry', cls: 'text-buy bg-buy/10', icon: 'M5 13l4 4L19 7' }
    if (e.reason === 'manual') return { label: 'Bought manually', cls: 'text-buy bg-buy/10', icon: 'M5 13l4 4L19 7' }
    return { label: 'Filled on pullback', cls: 'text-buy bg-buy/10', icon: 'M5 13l4 4L19 7' }
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
  const [validateTarget, setValidateTarget] = useState<EntryIntent | null>(null)
  const [editTarget, setEditTarget] = useState<EntryIntent | null>(null)
  const [signalDataTarget, setSignalDataTarget] = useState<SignalDataTarget | null>(null)
  const [approvalRequired, setApprovalRequired] = useState(false)
  const [now, setNow] = useState(Date.now())
  // The "Re-run agent" button only makes sense when the Entry Agent drives bands —
  // otherwise bands come from the static settings and there's no agent to re-run.
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [watchlist, setWatchlist] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const prices = usePrices()

  useEffect(() => {
    fetch('/api/entry-intents').then(r => r.json()).then((d: EntryIntent[]) => {
      if (Array.isArray(d)) setIntents(d)
    }).catch(() => {})
    fetch('/api/entry-events').then(r => r.json()).then((d: EntryEvent[]) => {
      if (Array.isArray(d)) setEvents(d)
    }).catch(() => {})
    fetch('/api/settings').then(r => r.json()).then((s: { entry_model?: string; watchlist?: string[]; approval_required?: boolean }) => {
      if (s && typeof s.entry_model === 'string') setAgentEnabled(s.entry_model === 'agent')
      if (s && Array.isArray(s.watchlist)) setWatchlist(s.watchlist)
      if (s && typeof s.approval_required === 'boolean') setApprovalRequired(s.approval_required)
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

  // Re-run the Entry Agent for the selected intent. It runs in the background; the new
  // band arrives via the entry_intent_update broadcast, so the chart/levels update on
  // their own — we only surface a failure to dispatch here.
  const onRerunAgent = useCallback(async (coin: string) => {
    setRefreshError(null)
    setRefreshing(true)
    try {
      const res = await fetch('/api/entry-intents/replan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setRefreshError(data.error ?? 'Refresh failed')
    } catch {
      setRefreshError('Request failed')
    } finally {
      setRefreshing(false)
    }
  }, [])

  // Drop a stale error when switching coins, and auto-dismiss it after a moment.
  const selectedCoin = selectedIntent?.coin
  useEffect(() => { setRefreshError(null) }, [selectedCoin])
  useEffect(() => {
    if (!refreshError) return
    const t = setTimeout(() => setRefreshError(null), 6000)
    return () => clearTimeout(t)
  }, [refreshError])

  // Session stats from the activity feed.
  const fills = events.filter(e => e.type === 'filled')
  const cancels = events.filter(e => e.type === 'cancelled')
  const avgSlip = fills.length
    ? fills.reduce((s, e) => s + (e.slippagePct ?? 0), 0) / fills.length
    : null
  const resolved = fills.length + cancels.length
  const fillRate = resolved > 0 ? (fills.length / resolved) * 100 : null

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
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">Entry Desk</h2>
            <p className="text-sm text-muted mt-1 leading-relaxed max-w-3xl">
              When the analyst issues a BUY, the bot doesn't fill immediately — it watches the live price and waits for a
              better entry. It <span className="text-accent font-medium">fills on a pullback</span> to the target, but
              <span className="text-sell font-medium"> cancels</span> if price breaks down (falling knife) or
              <span className="text-warn font-medium"> runs away</span> first. Below you can watch every pending intent
              and what the engine decided.
            </p>
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={() => setAddOpen(true)}
            className="shrink-0"
            title="Manually stage a coin onto the Entry Desk (the Entry Agent then manages its entry)"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add coin
          </Button>
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
                  {selectedIntent.bandSource === 'agent' && (
                    <Badge variant="accent" title={selectedIntent.planReason || 'Levels chosen by the Entry Agent'}>Agent levels</Badge>
                  )}
                  {selectedIntent.bandSource === 'manual' && (
                    <Badge variant="warning" title="Levels set manually">Manual levels</Badge>
                  )}
                  <Badge variant="accent" dot>Waiting</Badge>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setSignalDataTarget(selectedIntent)}
                    title="See the thesis, live market context, and full entry-band history behind this intent"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                    </svg>
                    Signal data
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={refreshing}
                    disabled={!agentEnabled || refreshing}
                    onClick={() => onRerunAgent(selectedIntent.coin)}
                    title={agentEnabled
                      ? 'Re-run the Entry Agent for this coin — it re-reads the setup and adapts the band / fires / cancels'
                      : 'Set Entry Model to “Entry Agent” in Settings to use this'}
                  >
                    {!refreshing && (
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                      </svg>
                    )}
                    Re-run agent
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditTarget(selectedIntent)}
                    title="Manually edit this entry window (target / invalidate / chase cap / TTL / notional)"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                    </svg>
                    Edit
                  </Button>
                  <Button
                    variant="success"
                    size="sm"
                    onClick={() => setValidateTarget(selectedIntent)}
                    title="Stop waiting and buy now at the live price"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Validate &amp; buy
                  </Button>
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
              {selectedIntent.bandSource === 'agent' && selectedIntent.planReason && (
                <p className="px-5 pb-1 text-xs text-muted leading-relaxed">
                  <span className="font-medium text-foreground">Entry Agent:</span> {selectedIntent.planReason}
                </p>
              )}
              {refreshError && (
                <div className="mx-5 mb-1 mt-1 flex items-center gap-2 rounded-lg bg-sell/10 border border-sell/20 px-3 py-2 text-xs text-sell">
                  <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 12.99A1.5 1.5 0 004.14 19.5h15.72a1.5 1.5 0 001.3-2.57l-7.5-12.99a1.5 1.5 0 00-2.62 0z" />
                  </svg>
                  {refreshError}
                </div>
              )}
              <EntryBandChart intent={selectedIntent} />
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
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => setAddOpen(true)}>
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Add a coin manually
              </Button>
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
                  {(e.signal || (e.bandHistory && e.bandHistory.length > 0)) && (
                    <button
                      type="button"
                      onClick={() => setSignalDataTarget(e)}
                      title="See the signal data and entry-band history for this entry"
                      aria-label={`Signal data for ${coin}`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors duration-150"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                      </svg>
                    </button>
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

      {/* Validate & open position now */}
      <ValidateEntryModal
        intent={validateTarget}
        currentPrice={validateTarget ? prices.get(validateTarget.coin)?.price : undefined}
        approvalRequired={approvalRequired}
        onClose={() => setValidateTarget(null)}
        onValidated={(coin) => { if (selected === coin) setSelected(null) }}
      />

      {/* Manually edit the entry window */}
      <EditEntryModal
        intent={editTarget}
        currentPrice={editTarget ? prices.get(editTarget.coin)?.price : undefined}
        onClose={() => setEditTarget(null)}
      />

      {/* Signal data + entry-band history */}
      <SignalDataModal target={signalDataTarget} onClose={() => setSignalDataTarget(null)} />

      {/* Manually stage a coin */}
      <ManualEntryModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        agentEnabled={agentEnabled}
        suggestions={watchlist}
        onStaged={(coin) => setSelected(coin)}
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
          {intent.bandSource === 'agent' && (
            <span
              title={intent.planReason || 'Levels chosen by the Entry Agent'}
              className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
            >
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.4 6.6L22 12l-6.6 2.4L13 21l-2.4-6.6L4 12l6.6-2.4L13 3z" />
              </svg>
              Agent
            </span>
          )}
          {intent.bandSource === 'manual' && (
            <span
              title="Levels set manually"
              className="inline-flex items-center gap-1 rounded-md bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold text-warn"
            >
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
              </svg>
              Manual
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

      {intent.bandSource === 'agent' && intent.planReason && (
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
