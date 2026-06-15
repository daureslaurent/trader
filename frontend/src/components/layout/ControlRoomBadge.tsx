import { useEffect, useRef, useState } from 'react'
import { useLLMActivity, ActiveLLMCall } from '../../hooks/useLLMActivity'
import { useEndpointHealth, EndpointHealth } from '../../hooks/useEndpointHealth'
import { useApi } from '../../hooks/useApi'
import { useWebSocket } from '../../hooks/useWebSocket'
import { cn } from '../../lib/utils'

// ── Scheduler snapshot (mirrors backend getSchedulerState / the Control Room) ────
interface SchedulerSnapshot {
  lanes: { analyse: { active: number; limit: number }; parallel: { active: number; limit: number } }
  queueDepth: number
  gates: { key: string; active: number; residentModel: string | null; streak: number }[]
  waiting: { id: string; module: string; lane: string; coin: string | null; priority: number; waitedMs: number }[]
}

const MODULE_LABELS: Record<string, string> = {
  extractor: 'Extractor',
  analyst: 'Analyst',
  monitor: 'Monitor',
  discoverer: 'Discoverer',
}

function label(module: string) {
  return MODULE_LABELS[module] ?? module.charAt(0).toUpperCase() + module.slice(1)
}

// Deterministic color per model id — kept identical to the Control Room page so the
// same model wears the same hue in the badge and on the full page.
const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444', '#84cc16']
function modelColor(model: string): string {
  if (!model) return 'rgb(var(--muted-rgb))'
  let h = 0
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
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

function shortGate(key: string): string {
  const [url, model] = key.split('::')
  let host = url
  try { host = new URL(url).host } catch { /* keep raw */ }
  return model ? `${host} · ${model}` : host
}

// ── Lane occupancy meter ────────────────────────────────────────────────────────
function LaneMeter({ name, occ }: { name: string; occ?: { active: number; limit: number } }) {
  const active = occ?.active ?? 0
  const limit = occ?.limit
  const finite = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
  const pct = finite ? Math.min(100, (active / limit) * 100) : active > 0 ? 100 : 0
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-14 shrink-0 text-[10px] font-medium text-muted">{name}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-elevated">
        <div
          className={cn('h-full rounded-full transition-all duration-300', active > 0 ? 'bg-accent' : 'bg-transparent')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-[10px] font-semibold tabular-nums text-foreground">
        {active}/{finite ? limit : '∞'}
      </span>
    </div>
  )
}

function CallRow({ call, endpoints, now }: { call: ActiveLLMCall; endpoints: EndpointHealth[]; now: number }) {
  const queued = call.status === 'queued'
  const ep = matchEndpoint(call, endpoints)
  const since = queued ? parseUtc(call.created_at) : parseUtc(call.running_at) ?? parseUtc(call.created_at)
  const time = elapsed(since, now)
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
 * Top-bar Control Room badge. The pill is a compact live read on the LLM scheduler —
 * a quiet chip when idle, an animated accent chip with the in-flight count when work
 * is moving. Hover/focus reveals a mini Control Room: lane occupancy meters, queue
 * depth & model-swap tally, per-gate model residency, and the live in-flight calls —
 * with an "Open →" jump to the full Control Room page. Keeps every behaviour of the
 * former LLM-activity badge while surfacing the scheduler the page visualises.
 */
export function ControlRoomBadge({ onOpen }: { onOpen?: () => void }) {
  const active = useLLMActivity()
  const { endpoints } = useEndpointHealth()
  const { data: snap, reload } = useApi<SchedulerSnapshot>('/api/llm/scheduler')

  const count = active.length
  const queued = active.filter(c => c.status === 'queued').length
  const running = count - queued
  const queueDepth = snap?.queueDepth ?? 0
  const busy = count > 0 || queueDepth > 0
  const gates = (snap?.gates ?? []).filter(g => g.active > 0 || g.residentModel)

  // Rolling count of reload-forcing model swaps seen since mount (matches the page).
  const [swaps, setSwaps] = useState(0)
  useWebSocket((event) => {
    if (event === 'llm_model_swap') setSwaps(s => s + 1)
  })

  // Poll the authoritative scheduler snapshot. Tighter cadence while busy so lane
  // meters track live work; relaxed when idle to stay light.
  useEffect(() => {
    const ms = busy ? 2000 : 6000
    const id = setInterval(reload, ms)
    return () => clearInterval(id)
  }, [reload, busy])

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

  const stateLabel = busy ? (running === 0 ? 'Queued' : 'Thinking') : 'Idle'

  return (
    <div className="group relative">
      <button
        type="button"
        aria-label="LLM Control Room"
        aria-live="polite"
        onClick={onOpen}
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
          busy ? 'text-accent bg-accent/10 border-accent/20' : 'text-muted bg-surface-elevated border-border hover:text-foreground',
        )}
      >
        <ControlRoomIcon className="h-3.5 w-3.5 shrink-0" />
        <span>Control Room</span>
        <span className="text-muted/60">·</span>
        {busy ? (
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
          </span>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
        )}
        <span className="font-medium">{stateLabel}</span>
        {count > 1 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-accent/20 text-accent text-[10px] leading-none tabular-nums">
            {queued > 0 && running > 0 ? `${running}+${queued}` : count}
          </span>
        )}
      </button>

      {/* Hover / focus detail card — a mini Control Room */}
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
            <div className="flex items-center gap-1.5">
              <ControlRoomIcon className="h-3.5 w-3.5 text-accent" />
              <span className="text-xs font-semibold text-foreground">Control Room</span>
            </div>
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

          {/* Scheduler — lane meters + queue/swap tallies */}
          <div className="space-y-2 border-b border-border px-3 py-2.5">
            <LaneMeter name="Analyse" occ={snap?.lanes.analyse} />
            <LaneMeter name="Parallel" occ={snap?.lanes.parallel} />
            <div className="flex items-center gap-1.5 pt-0.5">
              <Chip label="queue" value={queueDepth} tone={queueDepth > 0 ? 'warn' : 'muted'} />
              <Chip label="swaps" value={swaps} tone={swaps > 0 ? 'sell' : 'muted'} />
              <Chip label="gates" value={gates.length} tone="muted" />
            </div>
          </div>

          {/* Model residency per gate */}
          {gates.length > 0 && (
            <ul className="border-b border-border">
              {gates.slice(0, 4).map(g => (
                <li key={g.key} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: modelColor(g.residentModel ?? '') }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-foreground">{g.residentModel ?? '—'}</p>
                    <p className="truncate text-[10px] text-muted">{shortGate(g.key)}</p>
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted">
                    <span className="font-semibold text-foreground">{g.active}</span> live
                    {g.streak > 1 && <span className="ml-1.5 opacity-80">·{g.streak}×</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Live in-flight calls */}
          <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Activity</span>
            {busy && (
              <span className="text-[10px] text-muted tabular-nums">
                {running} running{queued > 0 ? ` · ${queued} queued` : ''}
              </span>
            )}
          </div>
          {!busy ? (
            <p className="px-3 pb-3 text-xs text-muted">Scheduler idle — no LLM calls in flight.</p>
          ) : (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto pb-1">
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

function Chip({ label, value, tone }: { label: string; value: number; tone: 'muted' | 'warn' | 'sell' }) {
  const style =
    tone === 'warn' ? 'text-warn bg-warn/10 border-warn/20'
    : tone === 'sell' ? 'text-sell bg-sell/10 border-sell/20'
    : 'text-muted bg-surface-elevated border-border'
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium', style)}>
      <span className="tabular-nums font-semibold">{value}</span>
      <span className="opacity-70">{label}</span>
    </span>
  )
}

function ControlRoomIcon({ className }: { className?: string }) {
  // Sliders / mixing-desk glyph — the "control room" metaphor.
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h8M16 6h4M4 12h4M12 12h8M4 18h10M18 18h2" />
      <circle cx="14" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  )
}
