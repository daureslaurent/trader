import { useEndpointHealth, EndpointHealth } from '../../hooks/useEndpointHealth'
import { cn } from '../../lib/utils'

type Tone = 'up' | 'degraded' | 'down' | 'idle'

const PILL: Record<Tone, string> = {
  up:       'text-buy bg-buy/10 border-buy/20',
  degraded: 'text-warn bg-warn/10 border-warn/20',
  down:     'text-sell bg-sell/10 border-sell/20',
  idle:     'text-muted bg-surface-elevated border-border',
}

const DOT: Record<EndpointHealth['status'], string> = {
  up:       'bg-buy',
  degraded: 'bg-warn',
  down:     'bg-sell',
}

function relativeTime(d: Date | null): string {
  if (!d) return 'never'
  const secs = Math.round((Date.now() - d.getTime()) / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  return `${Math.floor(secs / 60)}m ago`
}

function EndpointRow({ ep }: { ep: EndpointHealth }) {
  return (
    <li className="flex items-start gap-2.5 px-3 py-2">
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', DOT[ep.status])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-semibold text-foreground">{ep.name || 'Unnamed'}</span>
          <span
            className={cn(
              'shrink-0 text-[10px] font-semibold tabular-nums',
              ep.status === 'up' ? 'text-muted' : ep.status === 'degraded' ? 'text-warn' : 'text-sell',
            )}
          >
            {ep.status === 'down' ? 'Offline' : `${ep.latencyMs}ms`}
          </span>
        </div>
        <p className="truncate text-[10px] text-muted">{ep.model || '—'}</p>
        {ep.status === 'degraded' && (
          <p className="mt-0.5 text-[10px] text-warn">Reachable, but model not advertised</p>
        )}
        {ep.status === 'down' && ep.error && (
          <p className="mt-0.5 truncate text-[10px] text-sell/80" title={ep.error}>{ep.error}</p>
        )}
      </div>
    </li>
  )
}

/**
 * Header badge reflecting the live health of every LLM catalog endpoint. The pill
 * summarises the worst current state (all online / some degraded / some offline);
 * hovering (or focusing) reveals a card with a per-endpoint breakdown — model,
 * latency, and failure reason. Mirrors the look of the LLM activity badge.
 */
export function EndpointStatusBadge() {
  const { endpoints, loading, unreachable, checking, lastChecked, refetch } = useEndpointHealth()

  const total = endpoints.length
  const up = endpoints.filter(e => e.status === 'up').length
  const degraded = endpoints.filter(e => e.status === 'degraded').length
  const down = endpoints.filter(e => e.status === 'down').length

  const tone: Tone =
    unreachable || total === 0 ? 'idle' : down > 0 ? 'down' : degraded > 0 ? 'degraded' : 'up'

  const animate = tone !== 'idle'

  return (
    <div className="group relative">
      <button
        type="button"
        aria-label="LLM endpoint status"
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
          PILL[tone],
        )}
      >
        <span className="relative flex h-1.5 w-1.5">
          {animate && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
          )}
          <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full bg-current', !animate && 'opacity-50')} />
        </span>
        Endpoints
        {!unreachable && total > 0 && (
          <span
            className={cn(
              'ml-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-[10px] leading-none tabular-nums',
              tone === 'up' ? 'bg-buy/20 text-buy' : tone === 'degraded' ? 'bg-warn/20 text-warn' : 'bg-sell/20 text-sell',
            )}
          >
            {up}/{total}
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
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">LLM Endpoints</span>
              {!unreachable && total > 0 && (
                <span className="text-[10px] text-muted">
                  {up} up{degraded > 0 ? ` · ${degraded} degraded` : ''}{down > 0 ? ` · ${down} down` : ''}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={refetch}
              disabled={checking}
              className="inline-flex items-center gap-1 text-[10px] font-medium text-muted hover:text-foreground transition-colors disabled:opacity-60"
              title="Re-check now"
            >
              <svg
                className={cn('h-3 w-3', checking && 'animate-spin')}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992V4.356M3.985 19.644v-4.992h4.992m-4.494-4.5a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99m-.001-.001H16.49m-12.49 8.25a8.25 8.25 0 0013.803 3.7l3.181-3.182m0 0h-4.99m4.99 0v4.99" />
              </svg>
              {checking ? 'Checking…' : relativeTime(lastChecked)}
            </button>
          </div>

          {unreachable ? (
            <p className="px-3 py-4 text-xs text-muted">Can’t reach the backend to check endpoints.</p>
          ) : loading ? (
            <p className="px-3 py-4 text-xs text-muted">Checking endpoints…</p>
          ) : total === 0 ? (
            <p className="px-3 py-4 text-xs text-muted">
              No endpoints configured. Add them in <span className="text-foreground">Settings → LLM Models</span>.
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {endpoints.map(ep => (
                <EndpointRow key={ep.id} ep={ep} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
