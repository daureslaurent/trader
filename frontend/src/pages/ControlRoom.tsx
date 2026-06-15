import { useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { useApi } from '../hooks/useApi'
import { Card, CardHeader } from '../components/ui/Card'
import { cn } from '../lib/utils'

// ── Types mirroring the backend scheduler's WS payloads + snapshot ──────────────
interface EndpointTimeline {
  url: string
  host: string
  residentModel: string | null
  active: number
  events: { model: string; coin: string | null; agoMs: number }[]
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
  const legendModels = Array.from(new Set(endpoints.flatMap(e => e.events.map(ev => ev.model)).filter(Boolean))).sort()

  return (
    <div className="space-y-6">
      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Queue depth" value={snap?.queueDepth ?? 0} tone={snap?.queueDepth ? 'warn' : 'muted'} />
        <Stat label="In flight" value={inFlight} tone={inFlight ? 'accent' : 'muted'} />
        <Stat label="Swaps seen" value={swapTotal} tone={swapTotal ? 'sell' : 'muted'} />
        <Stat label="Retention" value={`${retainHours}h`} tone="muted" />
      </div>

      {/* Per-endpoint model timeline — one bar per URL, color = model, red break = swap */}
      <Card>
        <CardHeader
          title="Endpoint model timeline"
          subtitle={`One bar per endpoint URL over the last ${retainHours}h. Contiguous color = a batched same-model run; a red break = a reload-forcing model swap on that URL.`}
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
          <div className="space-y-3">
            {endpoints.map(ep => (
              <EndpointRow key={ep.url} ep={ep} now={now} windowMs={retainMs} />
            ))}
            {/* Time axis */}
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted/70 pl-[160px] pt-1">
              <span>−{retainHours}h</span>
              <span>now</span>
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

// ── Endpoint timeline row ───────────────────────────────────────────────────────
interface Band { model: string; widthPct: number; start: number; end: number; count: number; coins: string[] }

// Collapse a URL's dispatch points into contiguous same-model bands across the window.
// A band runs from the model's first dispatch until the next different model's first
// dispatch (the swap moment), the last extending to now. Idle time before the first
// dispatch becomes a leading gap so every bar shares one time axis.
function buildBands(events: { model: string; coin: string | null; agoMs: number }[], now: number, windowMs: number): { leadPct: number; bands: Band[] } {
  const windowStart = now - windowMs
  if (!events.length) return { leadPct: 100, bands: [] }
  const segs: { model: string; start: number; end: number; count: number; coins: Set<string> }[] = []
  for (const e of events) {
    const at = now - e.agoMs
    const last = segs[segs.length - 1]
    if (last && last.model === e.model) {
      last.count++
      if (e.coin) last.coins.add(e.coin.replace('/USDC', ''))
    } else {
      segs.push({ model: e.model, start: at, end: now, count: 1, coins: new Set(e.coin ? [e.coin.replace('/USDC', '')] : []) })
    }
  }
  for (let i = 0; i < segs.length; i++) segs[i].end = i < segs.length - 1 ? segs[i + 1].start : now

  const firstStart = Math.max(segs[0].start, windowStart)
  const leadPct = Math.max(0, ((firstStart - windowStart) / windowMs) * 100)
  const bands: Band[] = segs.map(s => {
    const start = Math.max(s.start, windowStart)
    return { model: s.model, start, end: s.end, count: s.count, coins: [...s.coins], widthPct: Math.max(0, ((s.end - start) / windowMs) * 100) }
  })
  return { leadPct, bands }
}

function EndpointRow({ ep, now, windowMs }: { ep: EndpointTimeline; now: number; windowMs: number }) {
  const { leadPct, bands } = buildBands(ep.events, now, windowMs)
  return (
    <div className="flex items-center gap-3">
      {/* Label column (fixed width keeps every bar's time axis aligned) */}
      <div className="w-[148px] shrink-0 min-w-0">
        <p className="text-xs font-medium text-foreground truncate" title={ep.url}>{ep.host}</p>
        <p className="text-[10px] text-muted truncate flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: modelColor(ep.residentModel ?? '') }} />
          <span className="truncate">{ep.residentModel ?? 'idle'}</span>
          {ep.active > 0 && <span className="text-accent shrink-0">· {ep.active} live</span>}
        </p>
      </div>
      {/* Bar */}
      <div className="flex-1 flex h-8 rounded-lg overflow-hidden border border-border bg-surface-elevated/40">
        {leadPct > 0.5 && <div style={{ width: `${leadPct}%` }} className="shrink-0" />}
        {bands.map((b, i) => (
          <div
            key={i}
            className={cn('shrink-0 min-w-[2px] relative transition-[width]', i > 0 && 'border-l-2 border-sell')}
            style={{ width: `${b.widthPct}%`, background: modelColor(b.model) }}
            title={`${b.model}\n${b.count} dispatch${b.count === 1 ? '' : 'es'}${b.coins.length ? `\n${b.coins.join(', ')}` : ''}\n${new Date(b.start).toLocaleTimeString()} – ${new Date(b.end).toLocaleTimeString()}`}
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
