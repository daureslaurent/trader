import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { ToolDetailPopover, type ToolDetail } from '../components/ui/ToolDetailPopover'
import { EntryBandChart } from '../components/EntryBandChart'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import type { EntryIntent } from '../types'
import { fmtUSD, cn } from '../lib/utils'

// Compact "Ns/Nm/Nh ago" from an epoch-ms timestamp.
function agoMs(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

type Tone = 'muted' | 'accent' | 'buy' | 'sell' | 'warn'
type EntryAction = 'ADJUST' | 'FIRE' | 'CANCEL' | 'WAIT'

interface Frame { type: string; icon: string; text: string; tone: Tone; at: number; detail?: ToolDetail }

interface EntryRun {
  id: number
  cycle_id: string
  coin: string
  action: EntryAction
  confidence: number
  reasoning: string
  model: string
  frames: Frame[]
  prompt_tokens: number
  completion_tokens: number
  peak_context_tokens: number
  started_at_ms: number
  created_at: string
}

// A coin currently mid-pass (frames stream in before the run is persisted).
interface LiveReview { coin: string; frames: Frame[]; status: 'reviewing' | 'done' | 'error'; peakContext: number; startedAt: number }
// The server's in-memory in-flight pass (so a running pass survives a page reload).
interface ActiveReview { coin: string; cycle_id: string; status: LiveReview['status']; frames: Frame[]; peak_context_tokens: number; started_at_ms: number }

function fmtTok(n: number): string {
  if (!n) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

interface RunsResponse { running: boolean; mode: string; runs: EntryRun[]; live: ActiveReview[] }
interface AgentStep extends Partial<Frame> { source?: string; coin?: string; type: string }

const TONE_CLASS: Record<Tone, string> = {
  accent: 'text-accent', buy: 'text-buy', sell: 'text-sell', warn: 'text-warn', muted: 'text-foreground/80',
}

// An entry-agent action → badge variant + label.
function actionVariant(a: EntryAction): 'buy' | 'warning' | 'accent' | 'neutral' {
  if (a === 'FIRE') return 'buy'
  if (a === 'CANCEL') return 'warning'
  if (a === 'ADJUST') return 'accent'
  return 'neutral'
}
const ACTION_LABEL: Record<EntryAction, string> = {
  FIRE: 'FIRE → bought', CANCEL: 'CANCEL', ADJUST: 'ADJUST band', WAIT: 'WAIT',
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

type Selection = { kind: 'run'; id: number } | { kind: 'live'; coin: string } | null

export default function EntryAgent() {
  const initial = useApi<RunsResponse>('/api/entry-agent/runs?limit=200')

  const [runs, setRuns] = useState<EntryRun[]>([])
  const [live, setLive] = useState<Record<string, LiveReview>>({})
  const [intents, setIntents] = useState<EntryIntent[]>([])
  const [mode, setMode] = useState<string>('static')
  const [running, setRunning] = useState(false)
  const [selected, setSelected] = useState<Selection>(null)

  useEffect(() => {
    if (initial.data) {
      setRuns(initial.data.runs)
      setMode(initial.data.mode)
      setRunning(initial.data.running)
      const seeded: Record<string, LiveReview> = {}
      for (const a of initial.data.live ?? []) {
        seeded[a.coin] = { coin: a.coin, frames: a.frames, status: a.status, peakContext: a.peak_context_tokens, startedAt: a.started_at_ms }
      }
      setLive(prev => ({ ...seeded, ...prev }))
    }
  }, [initial.data])

  // The live entry intents (for the band chart + countdown).
  useEffect(() => {
    fetch('/api/entry-intents').then(r => r.json()).then((d: EntryIntent[]) => {
      if (Array.isArray(d)) setIntents(d)
    }).catch(() => {})
  }, [])

  const onWs = useCallback((event: string, data: unknown) => {
    if (event === 'settings_updated') {
      const s = data as { entry_model?: string }
      if (s.entry_model) setMode(s.entry_model)
      return
    }
    if (event === 'entry_intent_update') {
      const d = data as { intents?: EntryIntent[] }
      if (Array.isArray(d.intents)) setIntents(d.intents)
      return
    }
    if (event === 'entry_agent_started') { setRunning(true); return }
    if (event === 'entry_agent_completed' || event === 'entry_agent_error') { setRunning(false); return }
    if (event === 'entry_agent_run_saved') {
      const run = data as EntryRun
      setRuns(prev => [run, ...prev.filter(r => r.id !== run.id)].slice(0, 300))
      setLive(prev => { const next = { ...prev }; delete next[run.coin]; return next })
      return
    }
    if (event !== 'agent_step') return

    const s = data as AgentStep
    if (s.source !== 'entry_agent' || !s.coin || !s.type) return
    const coin = s.coin
    const frame: Frame = { type: s.type, icon: s.icon ?? '•', text: s.text ?? '', tone: (s.tone as Tone) ?? 'muted', at: s.at ?? Date.now(), detail: s.detail }
    setLive(prev => {
      const cur = prev[coin] ?? { coin, frames: [], status: 'reviewing' as const, peakContext: 0, startedAt: Date.now() }
      const status: LiveReview['status'] = s.type === 'error' ? 'error' : s.type === 'decision' ? 'done' : cur.status
      return { ...prev, [coin]: { ...cur, frames: [...cur.frames, frame], status } }
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
      const res = await fetch('/api/entry-agent/run', { method: 'POST' })
      if (!res.ok) setRunning(false)
    } catch { setRunning(false) }
  }

  const isActive = mode === 'agent'
  const liveList = Object.values(live).sort((a, b) => b.startedAt - a.startedAt)

  const cycles = useMemo(() => {
    const map = new Map<string, EntryRun[]>()
    for (const r of runs) {
      const arr = map.get(r.cycle_id) ?? []
      arr.push(r)
      map.set(r.cycle_id, arr)
    }
    return [...map.entries()]
      .map(([cycle_id, rs]) => ({ cycle_id, runs: rs, at: Math.max(...rs.map(r => r.started_at_ms)) }))
      .sort((a, b) => b.at - a.at)
  }, [runs])

  const detail = useMemo(() => {
    if (!selected) return null
    if (selected.kind === 'live') {
      const lv = live[selected.coin]
      if (lv) return { coin: lv.coin, frames: lv.frames, verdict: null as EntryRun | null, peak: lv.peakContext }
      const saved = runs.find(r => r.coin === selected.coin)
      return saved ? { coin: saved.coin, frames: saved.frames, verdict: saved, peak: saved.peak_context_tokens } : null
    }
    const run = runs.find(r => r.id === selected.id)
    return run ? { coin: run.coin, frames: run.frames, verdict: run, peak: run.peak_context_tokens } : null
  }, [selected, live, runs])

  const detailIntent = useMemo(
    () => (detail ? intents.find(i => i.coin === detail.coin) ?? null : null),
    [detail, intents],
  )
  const thinkingCount = detail ? detail.frames.filter(isThinking).length : 0

  return (
    <div className="space-y-6 animate-fade-in">
      {/* ── Status header ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Entry Agent"
          subtitle="The agentic entry engine — one tool-calling agent per deferred BUY reasons about the best entry and drives the band / fires / cancels. Select it in Settings → Smart entry timing (Entry model “Entry Agent”)."
          action={
            <div className="flex items-center gap-2">
              <Badge variant={connected ? 'executed' : 'failed'} dot>{connected ? 'Live' : 'Offline'}</Badge>
              <Badge variant={isActive ? 'accent' : 'neutral'} dot={isActive}>{isActive ? 'Entry Agent active' : `Inactive (mode: ${mode})`}</Badge>
              {running && <Badge variant="accent" dot>Managing</Badge>}
            </div>
          }
        />
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted">
            {isActive
              ? 'Entry Agent drives every deferred BUY. Each active intent gets its own tool-calling agent that adapts the entry band, fires, or cancels as the market moves. The fast static gates stay as a safety net.'
              : 'Entry Agent is not the selected entry model — switch to “Entry Agent” in Settings to activate it. Deferred BUYs currently use the static band.'}
          </p>
          <Button variant="primary" size="sm" onClick={runNow} disabled={!isActive || running} loading={running}>
            {isActive ? 'Run pass now' : 'Select Entry Agent first'}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* ── Left: live coins + run history table ─────────────────────────── */}
        <div className="space-y-6 lg:col-span-2">
          {liveList.length > 0 && (
            <Card noPad>
              <div className="border-b border-border px-5 py-3">
                <span className="font-mono text-xs text-muted">entry-agent://managing-now</span>
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
                        <span className="font-semibold text-foreground shrink-0">{lv.coin.replace('/USDC', '')}</span>
                        <span className="truncate font-mono text-xs text-muted">{last ? `${last.icon} ${last.text}` : '…'}</span>
                      </div>
                      <span className="text-[10px] text-muted/60 shrink-0">{lv.frames.length} steps{lv.peakContext ? ` · ${fmtTok(lv.peakContext)} tok` : ''}</span>
                    </button>
                  )
                })}
              </div>
            </Card>
          )}

          <Card noPad>
            <CardHeader title="Pass history" subtitle={`${runs.length} passes across ${cycles.length} runs`} className="px-5 pt-5 mb-0" />
            {initial.loading && <p className="px-5 py-4 text-sm text-muted">Loading…</p>}
            {!initial.loading && cycles.length === 0 && (
              <p className="px-5 py-6 text-sm text-muted">No passes yet. {isActive ? 'A deferred BUY triggers the agent, or run a pass now.' : 'Activate Entry Agent in Settings.'}</p>
            )}
            {cycles.length > 0 && (
              <div className="max-h-[40rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-card">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted/70 border-b border-border">
                      <th className="px-5 py-2 font-medium">Coin</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                      <th className="px-3 py-2 font-medium text-right">Conf.</th>
                      <th className="px-3 py-2 font-medium text-right" title="Peak single-request context (prompt + completion)">Ctx peak</th>
                      <th className="px-5 py-2 font-medium text-right">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycles.map(cycle => (
                      <Fragment key={cycle.cycle_id}>
                        <tr className="bg-surface-elevated/30">
                          <td colSpan={5} className="px-5 py-1.5 text-[11px] font-mono text-muted/70">
                            run {cycle.cycle_id} · {agoMs(cycle.at)} · {cycle.runs.length} pass{cycle.runs.length === 1 ? '' : 'es'}
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
                              <td className="px-5 py-2 font-semibold text-foreground">{r.coin.replace('/USDC', '')}</td>
                              <td className="px-3 py-2"><Badge variant={actionVariant(r.action)}>{ACTION_LABEL[r.action]}</Badge></td>
                              <td className="px-3 py-2 text-right font-mono text-xs text-muted">{Math.round(r.confidence * 100)}%</td>
                              <td className="px-3 py-2 text-right font-mono text-xs text-muted" title={`${(r.peak_context_tokens ?? 0).toLocaleString()} tokens peak`}>{fmtTok(r.peak_context_tokens)}</td>
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

        {/* ── Right: detail — verdict + transcript + live band chart ── */}
        <div className="lg:col-span-3">
          <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] flex flex-col" noPad>
            {!detail ? (
              <div className="p-6 py-12 text-center">
                <p className="text-sm text-muted">Select a coin (row or live coin) to inspect what the Entry Agent did, the full transcript &amp; thinking, and the live entry band.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-4 shrink-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg font-bold text-foreground">{detail.coin.replace('/USDC', '')}</span>
                    {detail.verdict
                      ? <Badge variant={actionVariant(detail.verdict.action)}>{ACTION_LABEL[detail.verdict.action]}</Badge>
                      : <Badge variant="accent" dot>managing…</Badge>}
                    {detail.verdict && <span className="font-mono text-xs text-muted">{Math.round(detail.verdict.confidence * 100)}% conf</span>}
                  </div>
                  <button onClick={() => setSelected(null)} className="text-muted hover:text-foreground transition-colors" aria-label="Close">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                <div className="overflow-y-auto px-5 py-4 space-y-4">
                  {/* Live entry band for this coin (if still active). */}
                  {detailIntent && (
                    <div className="rounded-xl border border-border bg-surface-base/40 overflow-hidden">
                      <div className="flex items-center justify-between gap-2 px-4 pt-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted/70">Live entry band</p>
                        <div className="flex items-center gap-2">
                          {detailIntent.bandSource === 'agent' && <Badge variant="accent" title={detailIntent.planReason || 'Levels chosen by the Entry Agent'}>Agent levels</Badge>}
                          {detailIntent.bandSource === 'manual' && <Badge variant="warning">Manual levels</Badge>}
                          <span className="font-mono text-[11px] text-muted">buy ≤ {fmtUSD(detailIntent.targetPrice)}</span>
                        </div>
                      </div>
                      {detailIntent.bandSource === 'agent' && detailIntent.planReason && (
                        <p className="px-4 pt-1 text-xs text-muted leading-relaxed">{detailIntent.planReason}</p>
                      )}
                      <EntryBandChart intent={detailIntent} />
                    </div>
                  )}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                    <span className="text-muted/70">Context peak <span className="font-mono text-foreground/80">{detail.peak ? detail.peak.toLocaleString() : '—'} tok</span></span>
                    {detail.verdict && (
                      <span className="text-muted/70">Total <span className="font-mono text-foreground/80">{((detail.verdict.prompt_tokens ?? 0) + (detail.verdict.completion_tokens ?? 0)).toLocaleString()} tok</span></span>
                    )}
                  </div>

                  {detail.verdict && (
                    <div className="rounded-xl border border-border bg-surface-elevated/40 p-4">
                      <p className="text-[11px] uppercase tracking-wide text-muted/70 mb-1.5">Reasoning</p>
                      <p className="text-sm leading-relaxed text-foreground/90">{detail.verdict.reasoning || '—'}</p>
                      <p className="mt-3 text-[10px] uppercase tracking-wide text-muted/60">{detail.verdict.model} · {agoMs(detail.verdict.started_at_ms)}</p>
                    </div>
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
