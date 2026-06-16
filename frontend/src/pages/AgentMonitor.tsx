import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import { cn } from '../lib/utils'

// Compact "Ns/Nm/Nh ago" from an epoch-ms timestamp.
function agoMs(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

type Tone = 'muted' | 'accent' | 'buy' | 'sell' | 'warn'

interface Frame { type: string; icon: string; text: string; tone: Tone; at: number }

interface MonitorDRun {
  id: number
  cycle_id: string
  coin: string
  action: string
  confidence: number
  reasoning: string
  discarded: boolean
  model: string
  frames: Frame[]
  started_at_ms: number
  created_at: string
}

// A coin currently mid-review (frames stream in before the run is persisted).
interface LiveReview { coin: string; frames: Frame[]; status: 'reviewing' | 'done' | 'error'; startedAt: number }

interface RunsResponse { running: boolean; mode: string; runs: MonitorDRun[] }

interface AgentStep extends Partial<Frame> {
  source?: string
  coin?: string
  type: string
  action?: string
  confidence?: number
  reasoning?: string
  discarded?: boolean
  error?: string
}

const ACTION_VARIANT: Record<string, 'buy' | 'sell' | 'warning' | 'accent' | 'neutral'> = {
  HOLD: 'neutral', CLOSE: 'sell', REDUCE: 'warning', ADJUST: 'accent',
}

const TONE_CLASS: Record<Tone, string> = {
  accent: 'text-accent', buy: 'text-buy', sell: 'text-sell', warn: 'text-warn', muted: 'text-foreground/80',
}

// ── transcript ──────────────────────────────────────────────────────────────
function Transcript({ frames }: { frames: Frame[] }) {
  if (!frames.length) return <p className="text-muted font-mono text-xs">No transcript.</p>
  return (
    <div className="font-mono text-xs leading-relaxed">
      {frames.map((f, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5">
          <span className="select-none">{f.icon}</span>
          <span className={cn(TONE_CLASS[f.tone] ?? 'text-foreground/80')}>{f.text}</span>
        </div>
      ))}
    </div>
  )
}

type Selection = { kind: 'run'; id: number } | { kind: 'live'; coin: string } | null

export default function AgentMonitor() {
  const initial = useApi<RunsResponse>('/api/monitor-d/runs?limit=200')

  const [runs, setRuns] = useState<MonitorDRun[]>([])
  const [live, setLive] = useState<Record<string, LiveReview>>({})
  const [mode, setMode] = useState<string>('a')
  const [running, setRunning] = useState(false)
  const [selected, setSelected] = useState<Selection>(null)

  // Hydrate from the API once (survives reloads).
  useEffect(() => {
    if (initial.data) {
      setRuns(initial.data.runs)
      setMode(initial.data.mode)
      setRunning(initial.data.running)
    }
  }, [initial.data])

  const onWs = useCallback((event: string, data: unknown) => {
    if (event === 'settings_updated') {
      const s = data as { monitor_model?: string }
      if (s.monitor_model) setMode(s.monitor_model)
      return
    }
    if (event === 'monitor_started') {
      if ((data as { strategy?: string }).strategy === 'agentic_d') { setRunning(true); setLive({}) }
      return
    }
    if (event === 'monitor_completed' || event === 'monitor_error') {
      if ((data as { strategy?: string }).strategy === 'agentic_d') setRunning(false)
      return
    }
    if (event === 'monitor_d_run_saved') {
      const run = data as MonitorDRun
      setRuns(prev => [run, ...prev.filter(r => r.id !== run.id)].slice(0, 300))
      setLive(prev => { const next = { ...prev }; delete next[run.coin]; return next }) // saved supersedes live
      return
    }
    if (event !== 'agent_step') return

    const s = data as AgentStep
    if (s.source !== 'monitor_d' || !s.coin || !s.type) return
    const coin = s.coin
    const frame: Frame = { type: s.type, icon: s.icon ?? '•', text: s.text ?? '', tone: (s.tone as Tone) ?? 'muted', at: s.at ?? Date.now() }

    setLive(prev => {
      const cur = prev[coin] ?? { coin, frames: [], status: 'reviewing' as const, startedAt: Date.now() }
      const status: LiveReview['status'] = s.type === 'error' ? 'error' : s.type === 'decision' ? 'done' : cur.status
      return { ...prev, [coin]: { ...cur, frames: [...cur.frames, frame], status } }
    })
  }, [])

  const { connected } = useWebSocket(onWs)

  async function runNow() {
    setRunning(true)
    try {
      const res = await fetch('/api/monitor/run', { method: 'POST' })
      if (!res.ok) setRunning(false)
    } catch { setRunning(false) }
  }

  const isActive = mode === 'd'
  const liveList = Object.values(live).sort((a, b) => b.startedAt - a.startedAt)

  // Group saved runs by cycle for the per-run decision table (newest cycle first).
  const cycles = useMemo(() => {
    const map = new Map<string, MonitorDRun[]>()
    for (const r of runs) {
      const arr = map.get(r.cycle_id) ?? []
      arr.push(r)
      map.set(r.cycle_id, arr)
    }
    return [...map.entries()]
      .map(([cycle_id, rs]) => ({ cycle_id, runs: rs, at: Math.max(...rs.map(r => r.started_at_ms)) }))
      .sort((a, b) => b.at - a.at)
  }, [runs])

  // Resolve the detail panel's selection to a verdict + frames.
  const detail = useMemo(() => {
    if (!selected) return null
    if (selected.kind === 'live') {
      const lv = live[selected.coin]
      return lv ? { coin: lv.coin, frames: lv.frames, verdict: null as MonitorDRun | null, status: lv.status } : null
    }
    const run = runs.find(r => r.id === selected.id)
    return run ? { coin: run.coin, frames: run.frames, verdict: run, status: 'done' as const } : null
  }, [selected, live, runs])

  return (
    <div className="space-y-6 animate-fade-in">
      {/* ── Status header ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Agent Monitor"
          subtitle="Type D — the agentic position monitor. Select it in Settings → Position Monitor (model “Agent D”)."
          action={
            <div className="flex items-center gap-2">
              <Badge variant={connected ? 'executed' : 'failed'} dot>{connected ? 'Live' : 'Offline'}</Badge>
              <Badge variant={isActive ? 'accent' : 'neutral'} dot={isActive}>{isActive ? 'Agent D active' : `Inactive (mode: ${mode.toUpperCase()})`}</Badge>
              {running && <Badge variant="accent" dot>Reviewing</Badge>}
            </div>
          }
        />
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted">
            {isActive
              ? 'Agent D drives the monitor cron. Each open position gets its own tool-calling review below.'
              : 'Agent D is not the selected monitor model — switch to “Agent D” in Settings to activate it.'}
          </p>
          <Button variant="primary" size="sm" onClick={runNow} disabled={!isActive || running} loading={running}>
            {isActive ? 'Run now' : 'Select Agent D first'}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* ── Left: live coins + decisions table ─────────────────────────── */}
        <div className="space-y-6 lg:col-span-3">
          {liveList.length > 0 && (
            <Card noPad>
              <div className="border-b border-border px-5 py-3">
                <span className="font-mono text-xs text-muted">type-d://reviewing-now</span>
              </div>
              <div className="divide-y divide-border">
                {liveList.map(lv => {
                  const last = lv.frames[lv.frames.length - 1]
                  const on = selected?.kind === 'live' && selected.coin === lv.coin
                  return (
                    <button
                      key={lv.coin}
                      onClick={() => setSelected({ kind: 'live', coin: lv.coin })}
                      className={cn('w-full flex items-center justify-between gap-3 px-5 py-3 text-left transition-colors', on ? 'bg-accent/10' : 'hover:bg-surface-elevated/40')}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', lv.status === 'error' ? 'bg-sell' : lv.status === 'done' ? 'bg-buy' : 'bg-accent animate-pulse')} />
                        <span className="font-semibold text-foreground shrink-0">{lv.coin}</span>
                        <span className="truncate font-mono text-xs text-muted">{last ? `${last.icon} ${last.text}` : '…'}</span>
                      </div>
                      <span className="text-[10px] text-muted/60 shrink-0">{lv.frames.length} steps</span>
                    </button>
                  )
                })}
              </div>
            </Card>
          )}

          {/* Decisions table, grouped by run (cycle) */}
          <Card noPad>
            <CardHeader title="Run history" subtitle={`${runs.length} reviews across ${cycles.length} runs`} className="px-5 pt-5 mb-0" />
            {initial.loading && <p className="px-5 py-4 text-sm text-muted">Loading…</p>}
            {!initial.loading && cycles.length === 0 && (
              <p className="px-5 py-6 text-sm text-muted">No runs yet. {isActive ? 'Run Agent D to populate this table.' : 'Activate Agent D in Settings.'}</p>
            )}
            {cycles.length > 0 && (
              <div className="max-h-[34rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-card">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted/70 border-b border-border">
                      <th className="px-5 py-2 font-medium">Coin</th>
                      <th className="px-3 py-2 font-medium">Decision</th>
                      <th className="px-3 py-2 font-medium text-right">Conf.</th>
                      <th className="px-3 py-2 font-medium">Reasoning</th>
                      <th className="px-5 py-2 font-medium text-right">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycles.map(cycle => (
                      <Fragment key={cycle.cycle_id}>
                        <tr className="bg-surface-elevated/30">
                          <td colSpan={5} className="px-5 py-1.5 text-[11px] font-mono text-muted/70">
                            run {cycle.cycle_id} · {agoMs(cycle.at)} · {cycle.runs.length} position{cycle.runs.length === 1 ? '' : 's'}
                          </td>
                        </tr>
                        {cycle.runs.map(r => {
                          const on = selected?.kind === 'run' && selected.id === r.id
                          return (
                            <tr
                              key={r.id}
                              onClick={() => setSelected({ kind: 'run', id: r.id })}
                              className={cn('cursor-pointer border-b border-border/50 transition-colors', on ? 'bg-accent/10' : 'hover:bg-surface-elevated/40')}
                            >
                              <td className="px-5 py-2 font-semibold text-foreground">{r.coin}</td>
                              <td className="px-3 py-2">
                                <Badge variant={ACTION_VARIANT[r.action] ?? 'neutral'}>{r.action}</Badge>
                                {r.discarded && <span className="ml-1 text-[10px] text-warn">discarded</span>}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-xs text-muted">{Math.round(r.confidence * 100)}%</td>
                              <td className="px-3 py-2 text-xs text-foreground/70 max-w-xs truncate" title={r.reasoning}>{r.reasoning}</td>
                              <td className="px-5 py-2 text-right text-[11px] text-muted/60 whitespace-nowrap">{agoMs(r.started_at_ms)}</td>
                            </tr>
                          )
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* ── Right: per-coin detail ─────────────────────────────────────── */}
        <div className="lg:col-span-2">
          <Card className="lg:sticky lg:top-4">
            {!detail ? (
              <div className="py-10 text-center">
                <p className="text-sm text-muted">Select a position to inspect its full agent transcript and verdict.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold text-foreground">{detail.coin}</span>
                    {detail.verdict
                      ? <Badge variant={ACTION_VARIANT[detail.verdict.action] ?? 'neutral'}>{detail.verdict.action}</Badge>
                      : <Badge variant="accent" dot>reviewing…</Badge>}
                  </div>
                  {detail.verdict && (
                    <span className="font-mono text-xs text-muted">{Math.round(detail.verdict.confidence * 100)}% conf</span>
                  )}
                </div>

                {detail.verdict && (
                  <div className="mb-3 rounded-xl border border-border bg-surface-elevated/40 p-3">
                    <p className="text-xs leading-relaxed text-foreground/90">{detail.verdict.reasoning}</p>
                    {detail.verdict.discarded && (
                      <p className="mt-2 text-xs text-warn">Position closed during analysis — verdict was not applied.</p>
                    )}
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-muted/60">
                      {detail.verdict.model} · {agoMs(detail.verdict.started_at_ms)}
                    </p>
                  </div>
                )}

                <p className="mb-2 text-[11px] uppercase tracking-wide text-muted/70">Agent transcript</p>
                <div className="max-h-[26rem] overflow-y-auto rounded-xl border border-border bg-surface-base/40 p-3">
                  <Transcript frames={detail.frames} />
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
