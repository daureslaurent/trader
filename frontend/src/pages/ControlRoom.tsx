import { useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { useApi } from '../hooks/useApi'
import { Card, CardHeader } from '../components/ui/Card'
import { cn } from '../lib/utils'

// ── Types mirroring the backend scheduler's WS payloads + snapshot ──────────────
interface SchedulerSnapshot {
  lanes: { analyse: { active: number; limit: number }; parallel: { active: number; limit: number } }
  queueDepth: number
  gates: { key: string; active: number; residentModel: string | null; streak: number }[]
  waiting: { id: string; module: string; lane: string; coin: string | null; priority: number; waitedMs: number }[]
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

interface SwapMarker { gateKey: string; from: string; to: string; at: number }

// Deterministic color per model id, so the same model keeps its hue across the
// swimlanes and the batch ribbon — that visual continuity is what makes a model
// swap pop out.
const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444', '#84cc16']
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

const MAX_FEED = 80
const MAX_RIBBON = 60

export default function ControlRoom() {
  const { data: snap, reload } = useApi<SchedulerSnapshot>('/api/llm/scheduler')
  const [jobs, setJobs] = useState<Record<string, JobView>>({})
  const [feed, setFeed] = useState<{ id: string; text: string; kind: JobState | 'swap'; at: number }[]>([])
  const [ribbon, setRibbon] = useState<{ model: string; coin: string | null; at: number }[]>([])
  const [swaps, setSwaps] = useState<SwapMarker[]>([])
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  // Poll the authoritative snapshot for lane/gate occupancy; live job flow comes
  // from the WS events below.
  useEffect(() => {
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [reload])

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
      if (d.state === 'running' && d.model) {
        setRibbon(r => [...r.slice(-(MAX_RIBBON - 1)), { model: d.model!, coin: d.coin ?? null, at: Date.now() }])
      }
      if (d.state === 'done' || d.state === 'error') {
        pushFeed(setFeed, { id: d.id, text: `${d.module}${d.coin ? ` · ${d.coin.replace('/USDC', '')}` : ''} ${d.state}${d.error ? `: ${d.error}` : ''}`, kind: d.state, at: Date.now() })
        // Let the chip linger briefly, then drop terminal jobs so the lanes stay legible.
        const id = d.id
        setTimeout(() => setJobs(j => { const n = { ...j }; delete n[id]; return n }), 4000)
      }
    } else if (event === 'llm_model_swap') {
      const d = data as { gate_key: string; from_model: string; to_model: string }
      setSwaps(s => [...s.slice(-19), { gateKey: d.gate_key, from: d.from_model, to: d.to_model, at: Date.now() }])
      pushFeed(setFeed, { id: `${d.gate_key}-${Date.now()}`, text: `model swap on ${shortGate(d.gate_key)}: ${d.from_model} → ${d.to_model}`, kind: 'swap', at: Date.now() })
    }
  }, [])

  useWebSocket(onMessage)

  const jobList = Object.values(jobs).sort((a, b) => b.updatedAt - a.updatedAt)
  const analyseJobs = jobList.filter(j => j.lane === 'analyse')
  const parallelJobs = jobList.filter(j => j.lane === 'parallel')
  const swapCount = swaps.length

  return (
    <div className="space-y-6">
      {/* Endpoint / gate cards */}
      <div>
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted mb-3">Endpoints — model residency &amp; concurrency</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {(snap?.gates ?? []).length === 0 && (
            <Card className="text-sm text-muted">No active inference gates. Idle.</Card>
          )}
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

      {/* Model-batch ribbon + swap counter */}
      <Card>
        <CardHeader
          title="Model-batch ribbon"
          subtitle="Contiguous same-model bands = batched runs. Red ticks = a reload-forcing model swap."
          action={<div className="text-right"><p className="text-lg font-bold text-foreground tabular-nums">{swapCount}</p><p className="text-[10px] text-muted uppercase tracking-wide">swaps seen</p></div>}
        />
        {ribbon.length === 0 ? (
          <p className="text-sm text-muted">No dispatches yet — trigger the pipeline or a monitor run.</p>
        ) : (
          <div className="flex items-stretch h-10 rounded-lg overflow-hidden border border-border">
            {ribbon.map((seg, i) => {
              const swapped = i > 0 && ribbon[i - 1].model !== seg.model
              return (
                <div
                  key={`${seg.at}-${i}`}
                  className={cn('flex-1 min-w-[3px] relative', swapped && 'border-l-2 border-sell')}
                  style={{ background: modelColor(seg.model) }}
                  title={`${seg.model}${seg.coin ? ` · ${seg.coin}` : ''}`}
                />
              )
            })}
          </div>
        )}
      </Card>

      {/* Live feed */}
      <Card noPad>
        <div className="px-5 pt-5">
          <CardHeader title="Live scheduler feed" subtitle={`Queue depth ${snap?.queueDepth ?? 0}`} />
        </div>
        <div className="max-h-72 overflow-y-auto px-5 pb-4 space-y-1">
          {feed.length === 0 && <p className="text-sm text-muted">Waiting for activity…</p>}
          {feed.map(f => (
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
