import { useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { useApi } from '../hooks/useApi'
import { Card, CardHeader } from '../components/ui/Card'
import { cn } from '../lib/utils'

// ── Types mirroring the backend scheduler's WS payloads + snapshot ──────────────
interface EndpointCall {
  model: string
  coin: string | null
  module: string
  startAgoMs: number   // ms since the call began
  durationMs: number   // wall-clock length (extended to now while running)
  state: 'running' | 'done' | 'error'
}

interface EndpointTimeline {
  url: string
  host: string
  residentModel: string | null
  active: number
  calls: EndpointCall[]
}

interface SchedulerSnapshot {
  lanes: { analyse: { active: number; limit: number }; parallel: { active: number; limit: number } }
  queueDepth: number
  retainHours: number
  gates: { key: string; active: number; residentModel: string | null; streak: number }[]
  waiting: { id: string; module: string; lane: string; coin: string | null; priority: number; waitedMs: number }[]
  // Recent-activity history the scheduler retains (~retainHours) so a reload rebuilds
  // instead of blanking. `agoMs` = ms elapsed since the event, reconstructed locally.
  active?: { id: string; module: string; lane: string; coin: string | null; model: string; state: 'dispatching' | 'running'; agoMs: number }[]
  feed?: { id: string; text: string; kind: JobState | 'swap'; agoMs: number }[]
  endpoints?: EndpointTimeline[]
  swapCount?: number
}

type JobState = 'queued' | 'dispatching' | 'running' | 'done' | 'error'

interface JobView {
  id: string
  module: string
  lane: 'analyse' | 'parallel'
  coin: string | null
  model: string
  state: JobState
  updatedAt: number
  error?: string
}

// Deterministic color per model id, so the same model keeps its hue across the
// endpoint timelines, the legend and the chips — that visual continuity is what makes
// a model swap (a color break in a bar) pop out.
const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444', '#84cc16', '#14b8a6', '#f97316']
function modelColor(model: string): string {
  if (!model) return 'rgb(var(--muted-rgb))'
  let h = 0
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

const STATE_STYLE: Record<JobState, string> = {
  queued:      'border-border text-muted',
  dispatching: 'border-warn/40 text-warn',
  running:     'border-accent/50 text-accent animate-pulse',
  done:        'border-buy/40 text-buy',
  error:       'border-sell/50 text-sell',
}

const MAX_FEED = 600

export default function ControlRoom() {
  const { data: snap, reload } = useApi<SchedulerSnapshot>('/api/llm/scheduler')
  const [jobs, setJobs] = useState<Record<string, JobView>>({})
  const [feed, setFeed] = useState<{ id: string; text: string; kind: JobState | 'swap'; at: number }[]>([])
  const [swapTotal, setSwapTotal] = useState(0)

  const retainHours = snap?.retainHours && snap.retainHours > 0 ? snap.retainHours : 3
  const retainMs = retainHours * 3_600_000
  const now = Date.now()

  // Poll the authoritative snapshot for lane/gate occupancy + the per-endpoint
  // timeline (rendered straight from it); live job flow comes from the WS events below.
  useEffect(() => {
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [reload])

  // Seed the live view (feed, in-flight chips, swap total) from the scheduler's history
  // exactly once, the first time a snapshot lands — this is what survives a page reload.
  // The endpoint timeline isn't seeded: it renders directly from the polled snapshot.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || !snap) return
    seededRef.current = true
    const t = Date.now()
    if (snap.active?.length) {
      setJobs(j => {
        const n = { ...j }
        for (const a of snap.active!) {
          if (n[a.id]) continue
          n[a.id] = { id: a.id, module: a.module, lane: a.lane === 'analyse' ? 'analyse' : 'parallel', coin: a.coin, model: a.model, state: a.state, updatedAt: t - a.agoMs }
        }
        return n
      })
    }
    if (snap.feed?.length) setFeed(f => f.length ? f : snap.feed!.map(x => ({ id: x.id, text: x.text, kind: x.kind, at: t - x.agoMs })))
    if (typeof snap.swapCount === 'number') setSwapTotal(snap.swapCount)
  }, [snap])

  const onMessage = useCallback((event: string, data: unknown) => {
    if (event === 'llm_job_enqueued') {
      const d = data as { id: string; module: string; lane: string; coin: string | null; model: string }
      setJobs(j => ({ ...j, [d.id]: { id: d.id, module: d.module, lane: d.lane === 'analyse' ? 'analyse' : 'parallel', coin: d.coin, model: d.model, state: 'queued', updatedAt: Date.now() } }))
      pushFeed(setFeed, { id: d.id, text: `${d.module}${d.coin ? ` · ${d.coin.replace('/USDC', '')}` : ''} queued`, kind: 'queued', at: Date.now() })
    } else if (event === 'llm_job_state') {
      const d = data as { id: string; module: string; lane: string; coin: string | null; model?: string; state: JobState; error?: string }
      setJobs(j => {
        const prev = j[d.id]
        const merged: JobView = {
          id: d.id,
          module: d.module ?? prev?.module ?? '?',
          lane: (d.lane === 'analyse' ? 'analyse' : 'parallel'),
          coin: d.coin ?? prev?.coin ?? null,
          model: d.model ?? prev?.model ?? '',
          state: d.state,
          updatedAt: Date.now(),
          error: d.error,
        }
        return { ...j, [d.id]: merged }
      })
      if (d.state === 'done' || d.state === 'error') {
        pushFeed(setFeed, { id: `${d.id}:${d.state}`, text: `${d.module}${d.coin ? ` · ${d.coin.replace('/USDC', '')}` : ''} ${d.state}${d.error ? `: ${d.error}` : ''}`, kind: d.state, at: Date.now() })
        // Let the chip linger briefly, then drop terminal jobs so the lanes stay legible.
        const id = d.id
        setTimeout(() => setJobs(j => { const n = { ...j }; delete n[id]; return n }), 4000)
      }
    } else if (event === 'llm_model_swap') {
      const d = data as { gate_key: string; from_model: string; to_model: string }
      setSwapTotal(n => n + 1)
      pushFeed(setFeed, { id: `${d.gate_key}-${Date.now()}`, text: `model swap on ${shortGate(d.gate_key)}: ${d.from_model} → ${d.to_model}`, kind: 'swap', at: Date.now() })
    }
  }, [])

  useWebSocket(onMessage)

  // Render lane chips from BOTH sources: live WS events (model + running/done) and the
  // polled snapshot's authoritative `waiting[]` queue, so already-enqueued jobs show
  // when the page is opened mid-cycle. WS state wins on conflict.
  const waitingExtra: JobView[] = (snap?.waiting ?? [])
    .filter(w => !jobs[w.id])
    .map(w => ({
      id: w.id, module: w.module, lane: w.lane === 'analyse' ? 'analyse' : 'parallel',
      coin: w.coin, model: '', state: 'queued', updatedAt: Date.now() - w.waitedMs,
    }))
  const jobList = [...Object.values(jobs), ...waitingExtra].sort((a, b) => b.updatedAt - a.updatedAt)
  const analyseJobs = jobList.filter(j => j.lane === 'analyse')
  const parallelJobs = jobList.filter(j => j.lane === 'parallel')

  const endpoints = snap?.endpoints ?? []
  const inFlight = jobList.filter(j => j.state === 'running' || j.state === 'dispatching').length
  const visibleFeed = feed.filter(f => now - f.at <= retainMs)

  // Models present across all endpoint timelines, for the shared legend.
  const legendModels = Array.from(new Set(endpoints.flatMap(e => e.calls.map(c => c.model)).filter(Boolean))).sort()

  return (
    <div className="space-y-6">
      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Queue depth" value={snap?.queueDepth ?? 0} tone={snap?.queueDepth ? 'warn' : 'muted'} />
        <Stat label="In flight" value={inFlight} tone={inFlight ? 'accent' : 'muted'} />
        <Stat label="Swaps seen" value={swapTotal} tone={swapTotal ? 'sell' : 'muted'} />
        <Stat label="Retention" value={`${retainHours}h`} tone="muted" />
      </div>

      {/* Per-endpoint Gantt timeline — one lane per URL, each call a duration segment colored by model */}
      <Card>
        <CardHeader
          title="Endpoint model timeline"
          subtitle={`One lane per endpoint over the last ${retainHours}h. Each block is one LLM call — width = how long it ran, color = the model. Overlapping calls stack, so a tall stack = high concurrency. Empty = idle.`}
          action={legendModels.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 max-w-md">
              {legendModels.map(m => (
                <span key={m} className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: modelColor(m) }} />
                  <span className="truncate max-w-[120px]">{m}</span>
                </span>
              ))}
            </div>
          )}
        />
        {endpoints.length === 0 ? (
          <p className="text-sm text-muted">No dispatches in the window yet — trigger the pipeline or a monitor run.</p>
        ) : (
          <div className="space-y-2">
            {endpoints.map(ep => (
              <EndpointRow key={ep.url} ep={ep} now={now} windowMs={retainMs} />
            ))}
            {/* Time axis — ticks aligned to the track (label column is 160px wide) */}
            <div className="relative h-4 pl-[160px] pt-1">
              <div className="relative h-full text-[10px] tabular-nums text-muted/70">
                {axisTicks(retainHours).map(t => (
                  <span
                    key={t.frac}
                    className="absolute top-0"
                    style={{ left: `${t.frac * 100}%`, transform: t.frac === 0 ? 'none' : t.frac === 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Lane swimlanes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LaneCard
          title="Analyse lane"
          subtitle="Sequential · limit 1 — only one analyst job runs at a time"
          occ={snap?.lanes.analyse}
          jobs={analyseJobs}
        />
        <LaneCard
          title="Parallel lane"
          subtitle="Monitor, summary, discovery & the rest — fanned out concurrently"
          occ={snap?.lanes.parallel}
          jobs={parallelJobs}
        />
      </div>

      {/* Gate concurrency cards */}
      {(snap?.gates ?? []).length > 0 && (
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted mb-3">Gates — concurrency &amp; batch streak</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {(snap?.gates ?? []).map(g => (
              <Card key={g.key}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted truncate">{shortGate(g.key)}</p>
                    <p className="text-sm font-semibold text-foreground truncate flex items-center gap-2 mt-0.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: modelColor(g.residentModel ?? '') }} />
                      {g.residentModel ?? '—'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-foreground tabular-nums">{g.active}</p>
                    <p className="text-[10px] text-muted uppercase tracking-wide">in flight</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
                  <span className="px-1.5 py-0.5 rounded bg-surface-elevated border border-border">batch streak {g.streak}</span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Live feed */}
      <Card noPad>
        <div className="px-5 pt-5">
          <CardHeader title="Live scheduler feed" subtitle={`Last ${retainHours}h · ${visibleFeed.length} events`} />
        </div>
        <div className="max-h-80 overflow-y-auto px-5 pb-4 space-y-1">
          {visibleFeed.length === 0 && <p className="text-sm text-muted">Waiting for activity…</p>}
          {visibleFeed.map(f => (
            <div key={f.id} className="flex items-center gap-2 text-xs">
              <span className="text-muted/60 tabular-nums w-16 shrink-0">{new Date(f.at).toLocaleTimeString()}</span>
              <span className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                f.kind === 'swap' ? 'bg-sell' : f.kind === 'error' ? 'bg-sell' : f.kind === 'done' ? 'bg-buy' : 'bg-accent',
              )} />
              <span className="text-foreground truncate">{f.text}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ── Endpoint Gantt timeline row ─────────────────────────────────────────────────
// Each call becomes one positioned segment: left = when it started, width = how long it
// ran, color = the model. Concurrent calls on the same endpoint can't share a row, so
// they're packed into stacked sub-lanes (greedy interval scheduling) — a tall stack
// reads as high concurrency. Idle time stays empty because nothing is drawn there.
interface Seg extends EndpointCall { leftPct: number; widthPct: number; lane: number; startMs: number; endMs: number }

function packLanes(calls: EndpointCall[], now: number, windowMs: number): { segs: Seg[]; laneCount: number } {
  const windowStart = now - windowMs
  const items = calls
    .map(c => {
      const startMs = now - c.startAgoMs
      return { ...c, startMs, endMs: startMs + Math.max(0, c.durationMs) }
    })
    .sort((a, b) => a.startMs - b.startMs)

  const laneEnds: number[] = [] // endMs of the last segment placed in each lane
  const segs: Seg[] = items.map(it => {
    // Assign to the first lane free at this call's start; else open a new lane.
    let lane = laneEnds.findIndex(end => end <= it.startMs)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.endMs) }
    else laneEnds[lane] = it.endMs

    const vStart = Math.max(it.startMs, windowStart)
    const vEnd = Math.max(it.endMs, vStart)
    return {
      ...it,
      lane,
      leftPct: ((vStart - windowStart) / windowMs) * 100,
      widthPct: ((vEnd - vStart) / windowMs) * 100,
    }
  })
  return { segs, laneCount: Math.max(1, laneEnds.length) }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

// Evenly spaced hour ticks across the window (0 = window start, 1 = now).
function axisTicks(hours: number): { frac: number; label: string }[] {
  const n = Math.max(1, Math.min(6, Math.round(hours)))
  return Array.from({ length: n + 1 }, (_, i) => {
    const frac = i / n
    const h = hours * (1 - frac)
    return { frac, label: i === n ? 'now' : `−${h % 1 === 0 ? h : h.toFixed(1)}h` }
  })
}

function EndpointRow({ ep, now, windowMs }: { ep: EndpointTimeline; now: number; windowMs: number }) {
  const { segs, laneCount } = packLanes(ep.calls, now, windowMs)
  const laneH = 100 / laneCount
  return (
    <div className="flex items-center gap-3">
      {/* Label column (fixed 148px + 12px gap = 160px, aligning every track + the axis) */}
      <div className="w-[148px] shrink-0 min-w-0">
        <p className="text-xs font-medium text-foreground truncate" title={ep.url}>{ep.host}</p>
        <p className="text-[10px] text-muted truncate flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: modelColor(ep.residentModel ?? '') }} />
          <span className="truncate">{ep.residentModel ?? 'idle'}</span>
          {ep.active > 0 && (
            <span className="text-accent shrink-0 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {ep.active} live
            </span>
          )}
        </p>
      </div>
      {/* Track — segments are absolutely positioned; empty space is genuinely empty */}
      <div className="relative flex-1 h-9 rounded-lg border border-border bg-surface-elevated/40 overflow-hidden">
        {/* Faint gridlines at each axis tick for time reference */}
        {axisTicks(windowMs / 3_600_000).slice(1, -1).map(t => (
          <div key={t.frac} className="absolute inset-y-0 w-px bg-border/40" style={{ left: `${t.frac * 100}%` }} />
        ))}
        {segs.map((s, i) => (
          <div
            key={i}
            className={cn(
              'absolute rounded-[3px] transition-[opacity,transform] hover:z-10 hover:brightness-110 hover:ring-1 hover:ring-white/40',
              s.state === 'running' && 'animate-pulse ring-1 ring-accent/60',
              s.state === 'error' && 'ring-1 ring-sell',
            )}
            style={{
              left: `${s.leftPct}%`,
              width: `${s.widthPct}%`,
              minWidth: '3px',
              top: `calc(${s.lane * laneH}% + 1px)`,
              height: `calc(${laneH}% - 2px)`,
              background: modelColor(s.model),
              opacity: s.state === 'error' ? 0.55 : 1,
            }}
            title={[
              s.model,
              `${s.module}${s.coin ? ` · ${s.coin.replace('/USDC', '')}` : ''}`,
              `${fmtDuration(s.durationMs)}${s.state === 'running' ? ' (running)' : s.state === 'error' ? ' (error)' : ''}`,
              `${new Date(s.startMs).toLocaleTimeString()} → ${s.state === 'running' ? 'now' : new Date(s.endMs).toLocaleTimeString()}`,
            ].join('\n')}
          />
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone: 'accent' | 'warn' | 'sell' | 'muted' }) {
  const toneClass = tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-warn' : tone === 'sell' ? 'text-sell' : 'text-foreground'
  return (
    <Card className="py-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className={cn('text-2xl font-bold tabular-nums mt-0.5', toneClass)}>{value}</p>
    </Card>
  )
}

function LaneCard({ title, subtitle, occ, jobs }: { title: string; subtitle: string; occ?: { active: number; limit: number }; jobs: JobView[] }) {
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        action={<span className="text-sm font-semibold text-foreground tabular-nums">{occ ? `${occ.active}/${occ.limit === Infinity ? '∞' : occ.limit}` : '–'}</span>}
      />
      {jobs.length === 0 ? (
        <p className="text-sm text-muted">Idle</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {jobs.map(j => (
            <div
              key={j.id}
              className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium bg-surface-elevated/60', STATE_STYLE[j.state])}
              title={`${j.module} · ${j.model} · ${j.state}${j.error ? ` · ${j.error}` : ''}`}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: modelColor(j.model) }} />
              {j.coin ? j.coin.replace('/USDC', '') : j.module}
              <span className="text-muted/70">· {j.state}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function pushFeed(
  set: React.Dispatch<React.SetStateAction<{ id: string; text: string; kind: JobState | 'swap'; at: number }[]>>,
  item: { id: string; text: string; kind: JobState | 'swap'; at: number },
) {
  set(f => [item, ...f].slice(0, MAX_FEED))
}

// Collapse a gate key (a base URL, optionally with ::model) to something readable.
function shortGate(key: string): string {
  const [url, model] = key.split('::')
  let host = url
  try { host = new URL(url).host } catch { /* keep raw */ }
  return model ? `${host} · ${model}` : host
}
