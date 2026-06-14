import { useEffect, useState } from 'react'
import { useLLMActivity, ActiveLLMCall } from '../../hooks/useLLMActivity'
import { useEndpointHealth, EndpointHealth } from '../../hooks/useEndpointHealth'
import { cn } from '../../lib/utils'

const MODULE_LABELS: Record<string, string> = {
  extractor: 'Extractor',
  analyst: 'Analyst',
  monitor: 'Monitor',
  discoverer: 'Discoverer',
}

function label(module: string) {
  return MODULE_LABELS[module] ?? module.charAt(0).toUpperCase() + module.slice(1)
}

// UTC 'YYYY-MM-DD HH:MM:SS' → ms. Empty/invalid → null.
function parseUtc(s: string | null): number | null {
  if (!s) return null
  const ms = Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isNaN(ms) ? null : ms
}

function elapsed(fromMs: number | null, now: number): string {
  if (fromMs == null) return ''
  const secs = Math.max(0, Math.round((now - fromMs) / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${s}s`
}

const DOT: Record<EndpointHealth['status'], string> = {
  up: 'bg-buy',
  degraded: 'bg-warn',
  down: 'bg-sell',
  disabled: 'bg-muted',
}

const HEALTH_LABEL: Record<EndpointHealth['status'], string> = {
  up: 'online',
  degraded: 'degraded',
  down: 'offline',
  disabled: 'disabled',
}

/** Find the catalog endpoint a call is bound to by its base URL + model. */
function matchEndpoint(call: ActiveLLMCall, endpoints: EndpointHealth[]): EndpointHealth | undefined {
  return endpoints.find(e => e.baseURL === call.base_url && e.model === call.model)
}

function CallRow({ call, endpoints, now }: { call: ActiveLLMCall; endpoints: EndpointHealth[]; now: number }) {
  const queued = call.status === 'queued'
  const ep = matchEndpoint(call, endpoints)
  const since = queued ? parseUtc(call.created_at) : parseUtc(call.running_at) ?? parseUtc(call.created_at)
  const time = elapsed(since, now)
  // Endpoint dot reflects live health when we can resolve it; otherwise neutral.
  const dot = ep ? DOT[ep.status] : 'bg-muted'

  return (
    <li className="flex items-start gap-2.5 px-3 py-2">
      <span className="relative mt-1.5 flex h-2 w-2 shrink-0">
        {!queued && (
          <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping', dot)} />
        )}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', dot, queued && 'opacity-50')} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-semibold text-foreground">
            {label(call.module)}
            {call.coin && <span className="text-muted"> · {call.coin.replace('/USDC', '')}</span>}
          </span>
          <span
            className={cn(
              'shrink-0 text-[10px] font-semibold tabular-nums',
              queued ? 'text-warn' : 'text-muted',
            )}
          >
            {queued ? 'queued' : 'running'}
            {time && <span className="ml-1 font-normal opacity-80">{time}</span>}
          </span>
        </div>
        <p className="truncate text-[10px] text-muted" title={`${ep?.model || call.model || '—'}${call.base_url ? ` @ ${call.base_url}` : ''}`}>
          {ep?.name ? (
            <>
              {ep.name}
              <span className="opacity-70"> · {HEALTH_LABEL[ep.status]}</span>
            </>
          ) : (
            call.model || '—'
          )}
        </p>
      </div>
    </li>
  )
}

/**
 * Header badge reflecting whether any LLM call is in flight. Idle is a quiet muted
 * chip; active shows an animated accent chip with the in-flight count. Hovering (or
 * focusing) reveals a card listing every scheduled call — module/coin, the catalog
 * endpoint it's bound to with live health, its state (queued/running) and elapsed
 * time. Mirrors the look of the endpoint status badge.
 */
export function LLMActivityBadge() {
  const active = useLLMActivity()
  const { endpoints } = useEndpointHealth()
  const count = active.length
  const busy = count > 0
  const queued = active.filter(c => c.status === 'queued').length
  const running = count - queued

  // Tick once a second so elapsed times stay live while any call is in flight.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy])

  // Running first, then queued; within each, longest-waiting at the top.
  const ordered = [...active].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1
    return (parseUtc(a.created_at) ?? 0) - (parseUtc(b.created_at) ?? 0)
  })

  return (
    <div className="group relative">
      <button
        type="button"
        aria-label="LLM activity"
        aria-live="polite"
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
          busy ? 'text-accent bg-accent/10 border-accent/20' : 'text-muted bg-surface-elevated border-border',
        )}
      >
        {busy ? (
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
          </span>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
        )}
        {busy ? (running === 0 ? 'Queued' : 'Thinking') : 'LLM Idle'}
        {count > 1 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-accent/20 text-accent text-[10px] leading-none tabular-nums">
            {queued > 0 && running > 0 ? `${running}+${queued}` : count}
          </span>
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
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-foreground">LLM Activity</span>
            {busy && (
              <span className="text-[10px] text-muted tabular-nums">
                {running} running{queued > 0 ? ` · ${queued} queued` : ''}
              </span>
            )}
          </div>

          {!busy ? (
            <p className="px-3 py-4 text-xs text-muted">No LLM calls running.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {ordered.map((call, i) => (
                <CallRow key={`${call.module}-${call.coin}-${call.created_at}-${i}`} call={call} endpoints={endpoints} now={now} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
