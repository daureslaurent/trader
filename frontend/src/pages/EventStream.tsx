import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { cn } from '../lib/utils'

/**
 * Catalog of known event types, mirroring backend `core/bus.ts`'s `SystemEvent`
 * enum + category map. Listed up front so every toggle is visible in the panel
 * even before that event type has ever fired; any event type the backend adds
 * later still shows up automatically (folded in from live traffic, see
 * `knownEvents` below).
 */
const EVENT_CATALOG: { event: string; category: string }[] = [
  { event: 'MARKET.KLINE_CLOSED', category: 'market' },
  { event: 'MARKET.PRICE_TICK', category: 'market' },
  { event: 'STRATEGY.SIGNAL_GENERATED', category: 'strategy' },
  { event: 'STRATEGY.ENTRY_PLANNED', category: 'strategy' },
  { event: 'EXECUTION.ORDER_SUBMITTED', category: 'execution' },
  { event: 'EXECUTION.ORDER_FILLED', category: 'execution' },
  { event: 'EXECUTION.ORDER_FAILED', category: 'critical' },
  { event: 'RISK.STOP_TRIGGERED', category: 'critical' },
  { event: 'RISK.TAKE_PROFIT', category: 'risk' },
  { event: 'RISK.POSITION_ADJUSTED', category: 'risk' },
  { event: 'SYSTEM.ENGINE_TICK', category: 'system' },
  { event: 'SYSTEM.ALERT', category: 'system' },
]

const DISABLED_EVENTS_KEY = 'cb-event-stream-disabled-events'

function loadDisabledEvents(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_EVENTS_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* ignore */
  }
  return new Set()
}

/** Mirror of backend `BufferedEvent`. */
interface StreamEvent {
  id: string
  seq: number
  event: string
  category: string
  timestamp: number
  payload: unknown
}

interface StreamTick {
  events: StreamEvent[]
  lastSeq: number
}

/** Keep the browser feed bounded regardless of how hard the backend firehoses. */
const MAX_ROWS = 100

/**
 * Category → theme token. We deliberately map onto the app's existing theme
 * variables (buy/sell/warn/accent/accent2/muted) rather than hard-coded neon,
 * so the stream recolours with the active theme instead of clashing with it.
 */
const CATEGORY_STYLE: Record<string, { text: string; dot: string; label: string }> = {
  execution: { text: 'text-buy', dot: 'bg-buy', label: 'Execution' },
  critical: { text: 'text-sell', dot: 'bg-sell', label: 'Critical' },
  risk: { text: 'text-warn', dot: 'bg-warn', label: 'Risk' },
  market: { text: 'text-accent', dot: 'bg-accent', label: 'Market' },
  strategy: { text: 'text-accent2', dot: 'bg-accent2', label: 'Strategy' },
  system: { text: 'text-muted', dot: 'bg-muted', label: 'System' },
}

const CATEGORY_ORDER = ['execution', 'critical', 'risk', 'market', 'strategy', 'system']

function styleFor(category: string) {
  return CATEGORY_STYLE[category] ?? CATEGORY_STYLE.system
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

/** A compact, single-line summary of the most notable payload fields. */
function summarize(payload: unknown): string {
  if (payload == null || typeof payload !== 'object') return String(payload ?? '')
  const p = payload as Record<string, unknown>
  const parts: string[] = []
  const push = (label: string, v: unknown, fmt?: (n: number) => string) => {
    if (v == null) return
    if (typeof v === 'number') parts.push(`${label}${fmt ? fmt(v) : v}`)
    else parts.push(`${label}${v}`)
  }
  if (p.symbol) parts.push(String(p.symbol).replace('/USDC', ''))
  if (p.side) parts.push(String(p.side))
  if (p.action) parts.push(String(p.action))
  push('$', p.price, (n) => n.toLocaleString(undefined, { maximumFractionDigits: 6 }))
  push('×', p.qty)
  push('≈$', p.notionalUsd, (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 }))
  push('', p.changePct, (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`)
  push('conf=', p.confidence, (n) => n.toFixed(2))
  if (p.engine) parts.push(String(p.engine))
  if (p.message) parts.push(String(p.message))
  if (p.error) parts.push(String(p.error))
  if (p.reason && parts.length < 3) parts.push(String(p.reason))
  return parts.join('  ')
}

/** Compact on/off switch — same visual language as the Settings page Toggle. */
function EventToggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'group relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        checked ? 'bg-accent' : 'bg-surface-elevated border border-border',
      )}
    >
      <span
        className={cn(
          'pointer-events-none h-[14px] w-[14px] rounded-full shadow-sm transition-all duration-200',
          checked ? 'translate-x-[18px] bg-surface-base' : 'translate-x-[3px] bg-muted group-hover:bg-foreground/70',
        )}
      />
    </button>
  )
}

export default function EventStream() {
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [active, setActive] = useState<Set<string>>(new Set(CATEGORY_ORDER))
  const [disabledEvents, setDisabledEvents] = useState<Set<string>>(loadDisabledEvents)
  const [eventsPanelOpen, setEventsPanelOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const eventsPanelRef = useRef<HTMLDivElement>(null)

  // Highest seq we've applied — the resync cursor + the monotonic dedup guard.
  const lastSeqRef = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  /** Merge a batch, dropping anything we've already seen and capping length. */
  const ingest = useCallback((incoming: StreamEvent[]) => {
    if (incoming.length === 0) return
    const fresh = incoming
      .filter((e) => e.seq > lastSeqRef.current)
      .sort((a, b) => a.seq - b.seq)
    if (fresh.length === 0) return
    lastSeqRef.current = Math.max(lastSeqRef.current, ...fresh.map((e) => e.seq))
    if (pausedRef.current) return // frozen feed: cursor still advances, view doesn't
    setEvents((prev) => {
      // Newest first; cap to MAX_ROWS to prevent unbounded browser memory.
      const next = [...fresh.reverse(), ...prev]
      return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next
    })
  }, [])

  // Seed from history on mount.
  useEffect(() => {
    let cancelled = false
    fetch('/api/events/history')
      .then((r) => r.json())
      .then((d: StreamTick) => {
        if (cancelled) return
        lastSeqRef.current = d.lastSeq ?? 0
        setEvents((d.events ?? []).slice().reverse().slice(0, MAX_ROWS))
      })
      .catch(() => { /* endpoint not ready — live ticks will populate it */ })
    return () => { cancelled = true }
  }, [])

  const handleMessage = useCallback((event: string, data: unknown) => {
    if (event === 'EVENT_STREAM_TICK') {
      const tick = data as StreamTick
      if (tick?.events) ingest(tick.events)
    }
  }, [ingest])

  const { send } = useWebSocket(handleMessage, useCallback((isConnected: boolean) => {
    setConnected(isConnected)
    // On (re)connect, ask the server to replay only the gap since our cursor.
    if (isConnected) send({ type: 'event_stream_sync', lastSeq: lastSeqRef.current })
  }, []))

  // Persist per-event-type mute preferences across reloads.
  useEffect(() => {
    localStorage.setItem(DISABLED_EVENTS_KEY, JSON.stringify([...disabledEvents]))
  }, [disabledEvents])

  // Close the "Manage Events" panel on outside click.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (eventsPanelRef.current && !eventsPanelRef.current.contains(e.target as Node)) setEventsPanelOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggleEvent = (eventType: string) => {
    setDisabledEvents((prev) => {
      const next = new Set(prev)
      if (next.has(eventType)) next.delete(eventType)
      else next.add(eventType)
      return next
    })
  }

  // Every event type the panel should list: the static catalog plus anything
  // seen live that the catalog doesn't know about yet (forward-compatible with
  // new backend SystemEvent additions).
  const knownEvents = useMemo(() => {
    const seen = new Map(EVENT_CATALOG.map((e) => [e.event, e.category]))
    for (const e of events) if (!seen.has(e.event)) seen.set(e.event, e.category)
    return [...seen.entries()].map(([event, category]) => ({ event, category }))
  }, [events])

  const eventsByCategory = useMemo(() => {
    const grouped = new Map<string, { event: string; category: string }[]>()
    for (const e of knownEvents) {
      const list = grouped.get(e.category) ?? []
      list.push(e)
      grouped.set(e.category, list)
    }
    return CATEGORY_ORDER
      .filter((cat) => grouped.has(cat))
      .map((cat) => ({ category: cat, items: grouped.get(cat)! }))
  }, [knownEvents])

  const toggleCategory = (cat: string) => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const visible = useMemo(
    () => events.filter((e) => active.has(e.category) && !disabledEvents.has(e.event)),
    [events, active, disabledEvents],
  )

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of events) c[e.category] = (c[e.category] ?? 0) + 1
    return c
  }, [events])

  return (
    <div className="flex flex-col gap-4">
      {/* Control bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border font-mono',
            connected ? 'text-buy bg-buy/10 border-buy/20' : 'text-muted bg-surface-elevated border-border',
          )}>
            <span className={cn('w-1.5 h-1.5 rounded-full bg-current', connected && 'animate-pulse')} />
            {connected ? 'STREAMING' : 'OFFLINE'}
          </span>
          <span className="text-xs text-muted font-mono">{visible.length} / {events.length} events</span>
        </div>

        <div className="flex items-center gap-2">
          <div ref={eventsPanelRef} className="relative">
            <button
              onClick={() => setEventsPanelOpen((o) => !o)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
                disabledEvents.size > 0
                  ? 'text-accent border-accent/30 bg-accent/10'
                  : 'text-muted border-border hover:text-foreground hover:bg-surface-hover',
              )}
            >
              Events
              {disabledEvents.size > 0 && (
                <span className="text-[10px] font-mono opacity-80">{disabledEvents.size} muted</span>
              )}
              <svg className={cn('w-3 h-3 transition-transform', eventsPanelOpen && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {eventsPanelOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 max-h-96 overflow-y-auto bg-surface-card border border-border rounded-2xl shadow-xl py-2 z-50 animate-slide-down">
                <div className="flex items-center justify-between px-3 pb-1.5 mb-1 border-b border-border/60">
                  <span className="text-[11px] font-semibold text-muted uppercase tracking-wide">Event types</span>
                  <button
                    onClick={() => setDisabledEvents(new Set())}
                    className="text-[11px] text-accent hover:underline disabled:opacity-40 disabled:hover:no-underline"
                    disabled={disabledEvents.size === 0}
                  >
                    Reset
                  </button>
                </div>
                {eventsByCategory.map(({ category, items }) => {
                  const s = styleFor(category)
                  return (
                    <div key={category} className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className={cn('w-1.5 h-1.5 rounded-full', s.dot)} />
                        <span className="text-[11px] font-semibold text-muted">{s.label}</span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {items.map(({ event }) => (
                          <div key={event} className="flex items-center justify-between gap-2 pl-3">
                            <span className="text-xs font-mono text-foreground/80 truncate">{event}</span>
                            <EventToggle
                              checked={!disabledEvents.has(event)}
                              onChange={() => toggleEvent(event)}
                              label={`Toggle ${event}`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <button
            onClick={() => setPaused((p) => !p)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
              paused
                ? 'text-warn bg-warn/10 border-warn/30'
                : 'text-muted border-border hover:text-foreground hover:bg-surface-hover',
            )}
          >
            {paused ? '❚❚ Paused' : '▶ Live'}
          </button>
          <button
            onClick={() => { setEvents([]); setExpanded(null) }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-muted border border-border hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Category filter chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {CATEGORY_ORDER.map((cat) => {
          const s = styleFor(cat)
          const on = active.has(cat)
          return (
            <button
              key={cat}
              onClick={() => toggleCategory(cat)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-medium border transition-all',
                on
                  ? 'border-border bg-surface-card text-foreground'
                  : 'border-transparent bg-surface-elevated/40 text-muted opacity-50 hover:opacity-80',
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full', s.dot, !on && 'opacity-40')} />
              {s.label}
              <span className="text-muted">{counts[cat] ?? 0}</span>
            </button>
          )
        })}
      </div>

      {/* The terminal feed */}
      <div className="rounded-2xl border border-border bg-surface-card/60 glass overflow-hidden shadow-soft">
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border bg-surface-elevated/40">
          <span className="w-2.5 h-2.5 rounded-full bg-sell/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-warn/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-buy/60" />
          <span className="ml-3 text-[11px] font-mono text-muted tracking-wider">event-stream://reactive-bus</span>
        </div>

        <div className="max-h-[calc(100vh-19rem)] overflow-y-auto font-mono text-[12px] leading-relaxed">
          {visible.length === 0 ? (
            <div className="px-4 py-16 text-center text-muted text-sm">
              {events.length === 0 ? 'Awaiting events from the bus…' : 'No events match the active filters.'}
            </div>
          ) : (
            visible.map((e) => {
              const s = styleFor(e.category)
              const isOpen = expanded === e.id
              return (
                <div key={e.id} className="animate-slide-down border-b border-border/40 last:border-0">
                  <button
                    onClick={() => setExpanded(isOpen ? null : e.id)}
                    className="w-full flex items-center gap-3 px-4 py-1.5 text-left hover:bg-surface-hover/60 transition-colors group"
                  >
                    <span className="text-muted shrink-0 tabular-nums">{formatTime(e.timestamp)}</span>
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', s.dot)} />
                    <span className={cn('shrink-0 font-semibold w-56 truncate', s.text)}>{e.event}</span>
                    <span className="text-foreground/80 truncate flex-1">{summarize(e.payload)}</span>
                    <span className={cn(
                      'text-muted shrink-0 transition-transform opacity-0 group-hover:opacity-100',
                      isOpen && 'rotate-90 opacity-100',
                    )}>›</span>
                  </button>
                  {isOpen && (
                    <pre className="px-4 pb-3 pt-1 ml-[5.5rem] text-[11px] text-muted whitespace-pre-wrap break-all border-l-2 border-border/60">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
