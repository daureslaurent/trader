import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { ToolDetailPopover, type ToolDetail } from '../components/ui/ToolDetailPopover'
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
type Severity = 'info' | 'low' | 'medium' | 'high'
type FindingAgent = 'analyst' | 'signal' | 'entry' | 'monitor' | 'portfolio'

interface Frame { type: string; icon: string; text: string; tone: Tone; at: number; detail?: ToolDetail }
interface CoachFinding { agent: FindingAgent; observation: string; severity: Severity }
interface CoachCorrection { target: 'signal' | 'global'; coin: string | null; note: string }

interface CoachRun {
  id: number
  cycle_id: string
  assessment: string
  findings: CoachFinding[]
  corrections: CoachCorrection[]
  recommendations: string[]
  confidence: number
  model: string
  frames: Frame[]
  prompt_tokens: number
  completion_tokens: number
  peak_context_tokens: number
  started_at_ms: number
  created_at: string
}

// The single in-flight audit (frames stream in before the run is persisted).
interface ActiveReview { cycle_id: string; status: 'reviewing' | 'done' | 'error'; frames: Frame[]; peak_context_tokens: number; started_at_ms: number }
interface LiveReview { cycle_id: string; status: ActiveReview['status']; frames: Frame[]; peakContext: number; startedAt: number }

interface RunsResponse { running: boolean; runs: CoachRun[]; live: ActiveReview[] }
interface AgentStep extends Partial<Frame> { source?: string; cycle_id?: string; type: string }

function fmtTok(n: number): string {
  if (!n) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const TONE_CLASS: Record<Tone, string> = {
  accent: 'text-accent', buy: 'text-buy', sell: 'text-sell', warn: 'text-warn', muted: 'text-foreground/80',
}

const AGENT_LABEL: Record<FindingAgent, string> = {
  analyst: 'Analyst', signal: 'Agent Signal', entry: 'Entry Agent', monitor: 'Monitor', portfolio: 'Portfolio',
}
const SEVERITY_VARIANT: Record<Severity, 'failed' | 'warning' | 'accent' | 'neutral'> = {
  high: 'failed', medium: 'warning', low: 'accent', info: 'neutral',
}

const isThinking = (f: Frame) => f.type === 'thinking' && f.icon === '🧠'

function ThinkingLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return (
    <div className="my-1 rounded-lg border-l-2 border-accent/50 bg-accent/5">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left" title={open ? 'Collapse' : 'Expand'}>
        <svg className={cn('w-3 h-3 shrink-0 text-accent/70 transition-transform', open && 'rotate-90')} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        <span className="text-[10px] uppercase tracking-wide text-accent/80 shrink-0">🧠 thinking</span>
        {!open && <span className="truncate italic text-foreground/60">{oneLine}</span>}
      </button>
      {open && <p className="whitespace-pre-wrap italic text-foreground/70 px-3 pb-2 pl-8">{text}</p>}
    </div>
  )
}

function Transcript({ frames }: { frames: Frame[] }) {
  if (!frames.length) return <p className="text-muted font-mono text-xs">No transcript.</p>
  return (
    <div className="font-mono text-xs leading-relaxed space-y-0.5">
      {frames.map((f, i) => {
        if (isThinking(f)) return <ThinkingLine key={i} text={f.text} />
        const hasDetail = (f.type === 'tool_call' || f.type === 'tool_result') && f.detail
        const textEl = <span className={cn(TONE_CLASS[f.tone] ?? 'text-foreground/80')}>{f.text}</span>
        return (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="select-none">{f.icon}</span>
            {hasDetail
              ? <ToolDetailPopover detail={f.detail!} kind={f.type === 'tool_call' ? 'call' : 'result'}>{textEl}</ToolDetailPopover>
              : textEl}
          </div>
        )
      })}
    </div>
  )
}

type Selection = { kind: 'run'; id: number } | { kind: 'live'; cycle: string } | null

export default function CoachAgent() {
  const initial = useApi<RunsResponse>('/api/coach/runs?limit=100')

  const [runs, setRuns] = useState<CoachRun[]>([])
  const [live, setLive] = useState<Record<string, LiveReview>>({})
  const [running, setRunning] = useState(false)
  const [selected, setSelected] = useState<Selection>(null)

  useEffect(() => {
    if (initial.data) {
      setRuns(initial.data.runs)
      setRunning(initial.data.running)
      const seeded: Record<string, LiveReview> = {}
      for (const a of initial.data.live ?? []) {
        seeded[a.cycle_id] = { cycle_id: a.cycle_id, frames: a.frames, status: a.status, peakContext: a.peak_context_tokens, startedAt: a.started_at_ms }
      }
      setLive(prev => ({ ...seeded, ...prev }))
    }
  }, [initial.data])

  const onWs = useCallback((event: string, data: unknown) => {
    if (event === 'coach_started') { setRunning(true); return }
    if (event === 'coach_completed' || event === 'coach_error') { setRunning(false); return }
    if (event === 'coach_run_saved') {
      const run = data as CoachRun
      setRuns(prev => [run, ...prev.filter(r => r.id !== run.id)].slice(0, 200))
      setLive(prev => { const next = { ...prev }; delete next[run.cycle_id]; return next })
      return
    }
    if (event !== 'agent_step') return

    const s = data as AgentStep
    if (s.source !== 'coach' || !s.cycle_id || !s.type) return
    const cycle = s.cycle_id
    const frame: Frame = { type: s.type, icon: s.icon ?? '•', text: s.text ?? '', tone: (s.tone as Tone) ?? 'muted', at: s.at ?? Date.now(), detail: s.detail }
    setLive(prev => {
      const cur = prev[cycle] ?? { cycle_id: cycle, frames: [], status: 'reviewing' as const, peakContext: 0, startedAt: Date.now() }
      const status: LiveReview['status'] = s.type === 'error' ? 'error' : s.type === 'decision' ? 'done' : cur.status
      return { ...prev, [cycle]: { ...cur, frames: [...cur.frames, frame], status } }
    })
  }, [])

  const { connected } = useWebSocket(onWs)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function runNow() {
    setRunning(true)
    try {
      const res = await fetch('/api/coach/run', { method: 'POST' })
      if (!res.ok) setRunning(false)
    } catch { setRunning(false) }
  }

  const liveList = Object.values(live).sort((a, b) => b.startedAt - a.startedAt)

  // Auto-select the freshest thing to look at: a running audit, else the latest run.
  useEffect(() => {
    if (selected) return
    if (liveList.length > 0) setSelected({ kind: 'live', cycle: liveList[0].cycle_id })
    else if (runs.length > 0) setSelected({ kind: 'run', id: runs[0].id })
  }, [selected, liveList, runs])

  const detail = useMemo(() => {
    if (!selected) return null
    if (selected.kind === 'live') {
      const lv = live[selected.cycle]
      if (lv) return { frames: lv.frames, run: null as CoachRun | null, peak: lv.peakContext, status: lv.status }
      const saved = runs.find(r => r.cycle_id === selected.cycle)
      return saved ? { frames: saved.frames, run: saved, peak: saved.peak_context_tokens, status: 'done' as const } : null
    }
    const run = runs.find(r => r.id === selected.id)
    return run ? { frames: run.frames, run, peak: run.peak_context_tokens, status: 'done' as const } : null
  }, [selected, live, runs])

  const thinkingCount = detail ? detail.frames.filter(isThinking).length : 0

  return (
    <div className="space-y-6 animate-fade-in">
      {/* ── Status header ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Coach Agent"
          subtitle="The desk's process auditor — one agentic pass reviews how the other agents (Analyst, Agent Signal, Entry Agent, Monitor) are deciding, then writes corrections into their memory so they self-correct. Read-only on trading."
          action={
            <div className="flex items-center gap-2">
              <Badge variant={connected ? 'executed' : 'failed'} dot>{connected ? 'Live' : 'Offline'}</Badge>
              {running && <Badge variant="accent" dot>Auditing</Badge>}
            </div>
          }
        />
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted">
            Corrections land in two channels: <span className="text-foreground/80">per-coin</span> notes go to signal memory (read by Agent Signal &amp; the Entry Agent), and <span className="text-foreground/80">global</span> lessons are injected into the Monitor &amp; Analyst prompts. Settings ideas are advisory only — never auto-applied.
          </p>
          <Button variant="primary" size="sm" onClick={runNow} disabled={running} loading={running}>
            Run audit now
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* ── Left: live audit + run history ──────────────────────────────── */}
        <div className="space-y-6 lg:col-span-2">
          {liveList.length > 0 && (
            <Card noPad>
              <div className="border-b border-border px-5 py-3">
                <span className="font-mono text-xs text-muted">coach://auditing-now</span>
              </div>
              <div className="divide-y divide-border">
                {liveList.map(lv => {
                  const last = lv.frames[lv.frames.length - 1]
                  const on = selected?.kind === 'live' && selected.cycle === lv.cycle_id
                  return (
                    <button
                      key={lv.cycle_id}
                      onClick={() => setSelected({ kind: 'live', cycle: lv.cycle_id })}
                      className={cn('w-full flex items-center justify-between gap-3 px-5 py-3 text-left transition-colors', on ? 'bg-accent/10' : 'hover:bg-surface-elevated/40')}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', lv.status === 'error' ? 'bg-sell' : lv.status === 'done' ? 'bg-buy' : 'bg-accent animate-pulse')} />
                        <span className="truncate font-mono text-xs text-muted">{last ? `${last.icon} ${last.text}` : 'starting…'}</span>
                      </div>
                      <span className="text-[10px] text-muted/60 shrink-0">{lv.frames.length} steps{lv.peakContext ? ` · ${fmtTok(lv.peakContext)} tok` : ''}</span>
                    </button>
                  )
                })}
              </div>
            </Card>
          )}

          <Card noPad>
            <CardHeader title="Audit history" subtitle={`${runs.length} audit${runs.length === 1 ? '' : 's'}`} className="px-5 pt-5 mb-0" />
            {initial.loading && <p className="px-5 py-4 text-sm text-muted">Loading…</p>}
            {!initial.loading && runs.length === 0 && (
              <p className="px-5 py-6 text-sm text-muted">No audits yet. Run one now, or enable the Coach timer in Settings.</p>
            )}
            {runs.length > 0 && (
              <div className="max-h-[40rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-card">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted/70 border-b border-border">
                      <th className="px-5 py-2 font-medium text-right">Findings</th>
                      <th className="px-3 py-2 font-medium text-right">Corrections</th>
                      <th className="px-3 py-2 font-medium text-right" title="Peak single-request context (prompt + completion)">Ctx peak</th>
                      <th className="px-5 py-2 font-medium text-right">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map(r => {
                      const on = selected?.kind === 'run' && selected.id === r.id
                      const skipped = r.findings.length === 0 && r.corrections.length === 0
                      return (
                        <tr
                          key={r.id}
                          onClick={() => setSelected({ kind: 'run', id: r.id })}
                          className={cn('cursor-pointer border-b border-border/50 transition-colors', on ? 'bg-accent/10' : 'hover:bg-surface-elevated/40')}
                        >
                          <td className="px-5 py-2 text-right">
                            {skipped ? <span className="text-muted/50">—</span> : <Badge variant="neutral">{r.findings.length}</Badge>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {r.corrections.length > 0 ? <Badge variant="accent">{r.corrections.length}</Badge> : <span className="text-muted/50">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs text-muted" title={`${(r.peak_context_tokens ?? 0).toLocaleString()} tokens peak`}>{fmtTok(r.peak_context_tokens)}</td>
                          <td className="px-5 py-2 text-right text-[11px] text-muted/60 whitespace-nowrap">{agoMs(r.started_at_ms)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* ── Right: detail — assessment + findings + corrections + transcript ── */}
        <div className="lg:col-span-3">
          <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] flex flex-col" noPad>
            {!detail ? (
              <div className="p-6 py-12 text-center">
                <p className="text-sm text-muted">Select an audit (or run one) to read the assessment, the per-agent findings, the corrections written back, and the full transcript.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-4 shrink-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg font-bold text-foreground">Audit</span>
                    {detail.run
                      ? <Badge variant="neutral">{detail.run.findings.length} finding{detail.run.findings.length === 1 ? '' : 's'} · {detail.run.corrections.length} correction{detail.run.corrections.length === 1 ? '' : 's'}</Badge>
                      : <Badge variant="accent" dot>auditing…</Badge>}
                    {detail.run && <span className="font-mono text-xs text-muted">{Math.round(detail.run.confidence * 100)}% conf</span>}
                  </div>
                  <button onClick={() => setSelected(null)} className="text-muted hover:text-foreground transition-colors" aria-label="Close">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                <div className="overflow-y-auto px-5 py-4 space-y-4">
                  {detail.run && (
                    <>
                      {/* Assessment */}
                      <div className="rounded-xl border border-border bg-surface-elevated/40 p-4">
                        <p className="text-[11px] uppercase tracking-wide text-muted/70 mb-1.5">Assessment</p>
                        <p className="text-sm leading-relaxed text-foreground/90">{detail.run.assessment || '—'}</p>
                        <p className="mt-3 text-[10px] uppercase tracking-wide text-muted/60">{detail.run.model} · {agoMs(detail.run.started_at_ms)}</p>
                      </div>

                      {/* Findings */}
                      {detail.run.findings.length > 0 && (
                        <div>
                          <p className="mb-2 text-[11px] uppercase tracking-wide text-muted/70">Findings</p>
                          <div className="space-y-2">
                            {detail.run.findings.map((f, i) => (
                              <div key={i} className="rounded-xl border border-border bg-surface-base/40 p-3">
                                <div className="flex items-center gap-2 mb-1">
                                  <Badge variant="neutral">{AGENT_LABEL[f.agent] ?? f.agent}</Badge>
                                  <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
                                </div>
                                <p className="text-sm leading-relaxed text-foreground/85">{f.observation}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Corrections written */}
                      <div>
                        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted/70">
                          Corrections written {detail.run.corrections.length > 0 && <span className="text-accent/80">· {detail.run.corrections.length}</span>}
                        </p>
                        {detail.run.corrections.length === 0 ? (
                          <p className="text-xs text-muted">No corrections this audit — nothing was clearly wrong enough to act on.</p>
                        ) : (
                          <div className="space-y-2">
                            {detail.run.corrections.map((c, i) => (
                              <div key={i} className="rounded-xl border border-border bg-surface-base/40 p-3">
                                <div className="mb-1">
                                  {c.target === 'signal'
                                    ? <Badge variant="accent" title="Written to this coin's signal memory — read by Agent Signal & the Entry Agent">signal · {c.coin?.replace('/USDC', '')}</Badge>
                                    : <Badge variant="buy" title="Written to the global coach-memory log — injected into the Monitor & Analyst prompts">global → Monitor + Analyst</Badge>}
                                </div>
                                <p className="text-sm leading-relaxed text-foreground/85">{c.note}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Recommendations (advisory) */}
                      {detail.run.recommendations.length > 0 && (
                        <div className="rounded-xl border border-warn/30 bg-warn/5 p-4">
                          <p className="text-[11px] uppercase tracking-wide text-warn/80 mb-1.5">Recommendations for you (advisory — not applied)</p>
                          <ul className="space-y-1">
                            {detail.run.recommendations.map((r, i) => (
                              <li key={i} className="text-sm leading-relaxed text-foreground/85 flex gap-2"><span className="text-warn/70 select-none">›</span>{r}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                        <span className="text-muted/70">Context peak <span className="font-mono text-foreground/80">{detail.peak ? detail.peak.toLocaleString() : '—'} tok</span></span>
                        <span className="text-muted/70">Total <span className="font-mono text-foreground/80">{((detail.run.prompt_tokens ?? 0) + (detail.run.completion_tokens ?? 0)).toLocaleString()} tok</span></span>
                      </div>
                    </>
                  )}

                  <div>
                    <p className="mb-2 text-[11px] uppercase tracking-wide text-muted/70">
                      Agent transcript {thinkingCount > 0 && <span className="text-accent/80">· {thinkingCount} thinking step{thinkingCount === 1 ? '' : 's'}</span>}
                    </p>
                    <div className="rounded-xl border border-border bg-surface-base/40 p-3">
                      <Transcript frames={detail.frames} />
                    </div>
                  </div>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
