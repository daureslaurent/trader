import { useEffect, useState, useRef, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { PipelineEvent } from '../types'
import { Badge, actionBadge } from '../components/ui/Badge'
import { cn } from '../lib/utils'

interface Cycle {
  cycle_id: string
  coin: string
  events: PipelineEvent[]
  startTime: string
  finalAction?: string
  finalConfidence?: number
  completed: boolean
  error?: string
}

function formatTime(iso: string) {
  return new Date(iso.includes('T') ? iso : iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function parseData(event: PipelineEvent): Record<string, unknown> {
  try { return JSON.parse(event.data) } catch { return {} }
}

const STAGE_LABELS: Record<string, string> = {
  research_started: 'Research started',
  research_completed: 'Research complete',
  extraction_started: 'Extraction started',
  extraction_completed: 'Articles extracted',
  selection_started: 'Selecting articles',
  selection_completed: 'Articles selected',
  analysis_started: 'Analysis started',
  signal_generated: 'Signal generated',
  pipeline_error: 'Error',
  pipeline_timeout: 'Timed out',
  pipeline_failed: 'Failed',
}

const STAGE_COLORS: Record<string, string> = {
  research_started: 'border-l-blue-500/50',
  research_completed: 'border-l-blue-400',
  extraction_started: 'border-l-violet-500/50',
  extraction_completed: 'border-l-violet-400',
  selection_started: 'border-l-amber-500/50',
  selection_completed: 'border-l-amber-400',
  analysis_started: 'border-l-accent/50',
  signal_generated: 'border-l-accent',
  pipeline_error: 'border-l-sell',
  pipeline_timeout: 'border-l-sell',
  pipeline_failed: 'border-l-sell',
}

const TERMINAL_STAGES = new Set(['signal_generated', 'pipeline_error', 'pipeline_timeout', 'pipeline_failed'])

function SentimentPill({ s }: { s: string }) {
  const v = s === 'positive' ? 'buy' : s === 'negative' ? 'sell' : 'neutral'
  return <Badge variant={v as any}>{s}</Badge>
}

function StageMessage({ event }: { event: PipelineEvent }) {
  const data = parseData(event)
  const borderClass = STAGE_COLORS[event.stage] ?? 'border-l-border'
  const label = STAGE_LABELS[event.stage] ?? event.stage

  const wrapper = (children: React.ReactNode) => (
    <div className={cn('border-l-2 pl-3 py-2', borderClass)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-medium text-muted">{label}</span>
        <span className="text-xs text-muted/60 ml-auto font-mono">{formatTime(event.created_at)}</span>
      </div>
      {children}
    </div>
  )

  if (event.stage === 'research_started') {
    return wrapper(<p className="text-sm text-muted">Searching news for {String(data.symbol)}…</p>)
  }

  if (event.stage === 'extraction_started') {
    return wrapper(<p className="text-sm text-muted">Extracting {String(data.articleCount)} articles (1 LLM call each)…</p>)
  }

  if (event.stage === 'selection_started') {
    return wrapper(<p className="text-sm text-muted">Asking LLM to select pertinent articles from {String(data.articleCount)}…</p>)
  }

  if (event.stage === 'analysis_started') {
    return wrapper(
      <div className="flex items-center gap-3 text-sm text-muted">
        <span>Price: <strong className="text-foreground">${Number(data.price).toFixed(2)}</strong></span>
        <span>RSI: <strong className="text-foreground">{data.rsi14 ? Number(data.rsi14).toFixed(1) : '—'}</strong></span>
        <span>Trend: <strong className="text-foreground">{String(data.trend || '—')}</strong></span>
      </div>
    )
  }

  if (event.stage === 'pipeline_error' || event.stage === 'pipeline_timeout' || event.stage === 'pipeline_failed') {
    return wrapper(<p className="text-sm text-sell">{String(data.error || 'Unknown error')}</p>)
  }

  if (event.stage === 'research_completed') {
    const headlines = (data.headlines as string[]) || []
    return wrapper(
      <div className="space-y-1.5">
        <p className="text-xs text-muted">{(data.articles as unknown[])?.length || 0} articles scraped</p>
        <ul className="space-y-1">
          {headlines.slice(0, 5).map((h, i) => (
            <li key={i} className="text-sm text-foreground flex items-start gap-2">
              <span className="text-muted mt-0.5 shrink-0">›</span>
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (event.stage === 'extraction_completed') {
    const articles = (data.articles as any[]) || []
    const filtered = articles.filter(a => a.relevance_score >= 0.3)
    const cachedCount = filtered.filter((a: any) => a.from_cache).length
    return wrapper(
      <div className="space-y-2">
        <p className="text-xs text-muted">
          {filtered.length} relevant articles · sentiment: {String(data.aggregated_sentiment || '—')}
          {cachedCount > 0 && <span className="ml-2 text-accent/70">{cachedCount} from cache</span>}
        </p>
        {filtered.slice(0, 3).map((article: any, i: number) => (
          <div key={i} className="bg-surface-elevated rounded-xl p-3 text-sm space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <SentimentPill s={article.sentiment} />
              <span className="text-xs text-muted">{Math.round(article.relevance_score * 100)}% relevant</span>
              {article.preliminary_signal && actionBadge(article.preliminary_signal)}
              {article.from_cache && (
                <Badge variant="neutral" className="text-[10px] px-1.5 py-0.5 font-mono">CACHED</Badge>
              )}
            </div>
            <p className="font-medium text-foreground">{article.title}</p>
            {article.summary && <p className="text-xs text-muted leading-relaxed">{article.summary}</p>}
            {(article.key_points as string[] | undefined)?.slice(0, 3).map((kp: string, j: number) => (
              <p key={j} className="text-xs text-muted flex items-start gap-1.5">
                <span className="text-muted/60 shrink-0 mt-0.5">→</span>
                {kp}
              </p>
            ))}
          </div>
        ))}
      </div>
    )
  }

  if (event.stage === 'selection_completed') {
    const articles = (data.articles as any[]) || []
    const total = Number(data.totalCount ?? articles.length)
    return wrapper(
      <div className="space-y-1.5">
        <p className="text-xs text-muted">
          {articles.length} of {total} articles selected for analysis
        </p>
        {articles.map((a: any, i: number) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="text-muted/60 shrink-0">›</span>
            <SentimentPill s={a.sentiment} />
            {a.preliminary_signal && actionBadge(a.preliminary_signal)}
            {a.from_cache && <Badge variant="neutral" className="text-[10px] px-1.5 py-0.5 font-mono">CACHED</Badge>}
            <span className="text-foreground truncate">{a.title}</span>
          </div>
        ))}
      </div>
    )
  }

  if (event.stage === 'signal_generated') {
    const conf = Number(data.confidence || 0)
    const confPct = Math.round(conf * 100)
    return wrapper(
      <div className="bg-surface-elevated rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3">
          {actionBadge(String(data.action))}
          <span className="font-semibold text-foreground">{String(data.symbol || '').replace('/USDC', '')}</span>
          <div className="flex items-center gap-2 ml-auto">
            <div className="w-24 h-1.5 bg-surface-card rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  conf >= 0.7 ? 'bg-buy' : conf >= 0.4 ? 'bg-warn' : 'bg-sell',
                )}
                style={{ width: `${confPct}%` }}
              />
            </div>
            <span className="text-xs text-muted">{confPct}%</span>
          </div>
        </div>
        {typeof data.reason === 'string' && data.reason && (
          <p className="text-sm text-muted leading-relaxed border-l-2 border-border pl-3">
            {data.reason}
          </p>
        )}
      </div>
    )
  }

  return null
}

function groupEvents(events: PipelineEvent[]): Cycle[] {
  const map = new Map<string, Cycle>()
  for (const event of events) {
    const existing = map.get(event.cycle_id)
    const data = parseData(event)
    const isTerminal = TERMINAL_STAGES.has(event.stage)
    const isError = event.stage === 'pipeline_error' || event.stage === 'pipeline_timeout' || event.stage === 'pipeline_failed'
    if (existing) {
      existing.events.push(event)
      if (isTerminal) existing.completed = true
      if (event.stage === 'signal_generated') {
        existing.finalAction = data.action as string
        existing.finalConfidence = data.confidence as number
      }
      if (isError) existing.error = data.error as string
    } else {
      map.set(event.cycle_id, {
        cycle_id: event.cycle_id,
        coin: event.coin,
        events: [event],
        startTime: event.created_at,
        completed: isTerminal,
        finalAction: event.stage === 'signal_generated' ? data.action as string : undefined,
        finalConfidence: event.stage === 'signal_generated' ? data.confidence as number : undefined,
        error: isError ? data.error as string : undefined,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    new Date(b.startTime.includes('T') ? b.startTime : b.startTime + 'Z').getTime() -
    new Date(a.startTime.includes('T') ? a.startTime : a.startTime + 'Z').getTime()
  )
}

export default function LLM() {
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [coinInput, setCoinInput] = useState('')
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pendingCycleRef = useRef<string | null>(null)

  useEffect(() => {
    fetch('/api/pipeline-events?limit=200')
      .then(r => r.json())
      .then((events: PipelineEvent[]) => {
        const grouped = groupEvents(events)
        setCycles(grouped)
        if (grouped.length > 0) setSelectedId(grouped[0].cycle_id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleRun = useCallback(async () => {
    const coin = coinInput.trim()
    if (!coin) return
    setRunning(true)
    setRunError(null)
    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin }),
      })
      const json = await res.json()
      if (!res.ok) { setRunError(json.error || 'Failed to start pipeline'); return }
      pendingCycleRef.current = json.cycle_id
      setSelectedId(json.cycle_id)
      setCoinInput('')
    } catch {
      setRunError('Network error')
    } finally {
      setRunning(false)
    }
  }, [coinInput])

  useWebSocket((event, data) => {
    if (event === 'pipeline_event') {
      const pe = data as PipelineEvent
      const isTerminal = TERMINAL_STAGES.has(pe.stage)
      const isError = pe.stage === 'pipeline_error' || pe.stage === 'pipeline_timeout' || pe.stage === 'pipeline_failed'
      setCycles(prev => {
        const existing = prev.find(c => c.cycle_id === pe.cycle_id)
        const pData = parseData(pe)
        if (existing) {
          if (existing.events.some(e => e.id === pe.id)) return prev
          const updated: Cycle = {
            ...existing,
            events: [...existing.events, pe].sort((a, b) =>
              new Date(a.created_at.includes('T') ? a.created_at : a.created_at + 'Z').getTime() -
              new Date(b.created_at.includes('T') ? b.created_at : b.created_at + 'Z').getTime()
            ),
            completed: isTerminal || existing.completed,
            finalAction: pe.stage === 'signal_generated' ? pData.action as string : existing.finalAction,
            finalConfidence: pe.stage === 'signal_generated' ? pData.confidence as number : existing.finalConfidence,
            error: isError ? pData.error as string : existing.error,
          }
          return [updated, ...prev.filter(c => c.cycle_id !== pe.cycle_id)]
        }
        // Auto-select if this is the pending manual cycle
        if (pendingCycleRef.current === pe.cycle_id) {
          setSelectedId(pe.cycle_id)
        }
        const newCycle: Cycle = {
          cycle_id: pe.cycle_id,
          coin: pe.coin,
          events: [pe],
          startTime: pe.created_at,
          completed: isTerminal,
          finalAction: pe.stage === 'signal_generated' ? pData.action as string : undefined,
          finalConfidence: pe.stage === 'signal_generated' ? pData.confidence as number : undefined,
          error: isError ? pData.error as string : undefined,
        }
        return [newCycle, ...prev]
      })
    }
  })

  useEffect(() => {
    if (cycles.length > 0 && !selectedId) setSelectedId(cycles[0].cycle_id)
  }, [cycles, selectedId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [selectedId, cycles])

  const selected = cycles.find(c => c.cycle_id === selectedId)

  return (
    <div className="flex gap-4 h-[calc(100vh-9rem)] animate-fade-in">
      {/* Sidebar */}
      <div className="w-52 shrink-0 bg-surface-card border border-border rounded-2xl flex flex-col overflow-hidden neon-border">
        <div className="px-3 py-3 border-b border-border shrink-0 space-y-2">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider px-1">Run Pipeline</p>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={coinInput}
              onChange={e => { setCoinInput(e.target.value.toUpperCase()); setRunError(null) }}
              onKeyDown={e => e.key === 'Enter' && !running && handleRun()}
              placeholder="BTC"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-sm bg-surface-elevated border border-border rounded-lg text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
            <button
              onClick={handleRun}
              disabled={running || !coinInput.trim()}
              className={cn(
                'shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                running || !coinInput.trim()
                  ? 'bg-surface-elevated text-muted cursor-not-allowed'
                  : 'bg-accent text-white hover:bg-accent/80',
              )}
            >
              {running
                ? <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin inline-block" />
                : 'Run'
              }
            </button>
          </div>
          {runError && <p className="text-[11px] text-sell px-1">{runError}</p>}
        </div>
        <div className="px-3 py-2 border-b border-border shrink-0">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider">Cycles</p>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {loading && (
            <div className="flex items-center justify-center h-16">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {!loading && cycles.length === 0 && (
            <p className="text-xs text-muted text-center px-3 py-4">No cycles yet. Wait for the bot to run.</p>
          )}
          {cycles.map(cycle => {
            const isActive = selectedId === cycle.cycle_id
            return (
              <button
                key={cycle.cycle_id}
                onClick={() => setSelectedId(cycle.cycle_id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 rounded-xl transition-colors duration-100',
                  isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                  !cycle.completed && !cycle.error && 'ring-1 ring-accent/20',
                )}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-medium">{cycle.coin.replace('/USDC', '')}</span>
                  {cycle.finalAction && actionBadge(cycle.finalAction)}
                  {cycle.error && <Badge variant="sell" className="text-[10px] px-1.5">ERR</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted/70">{formatTime(cycle.startTime)}</span>
                  {cycle.finalConfidence !== undefined && (
                    <span className="text-xs text-muted/70">{Math.round(cycle.finalConfidence * 100)}%</span>
                  )}
                  {!cycle.completed && !cycle.error && (
                    <span className="w-1.5 h-1.5 rounded-full bg-buy animate-pulse ml-auto" />
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 bg-surface-card border border-border rounded-2xl overflow-y-auto p-5 neon-border">
        {!selected ? (
          <div className="flex items-center justify-center h-full text-sm text-muted">
            {loading ? 'Loading…' : 'Select a pipeline cycle'}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 pb-4 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">{selected.coin.replace('/USDC', '')}</h2>
              {selected.finalAction && actionBadge(selected.finalAction)}
              {selected.error && <Badge variant="sell">Error</Badge>}
              {!selected.completed && <Badge variant="accent" dot>Processing</Badge>}
              <span className="text-xs text-muted font-mono ml-auto">{formatTime(selected.startTime)}</span>
            </div>

            <div className="space-y-3">
              {[...selected.events]
                .sort((a, b) =>
                  new Date(a.created_at.includes('T') ? a.created_at : a.created_at + 'Z').getTime() -
                  new Date(b.created_at.includes('T') ? b.created_at : b.created_at + 'Z').getTime()
                )
                .map(event => <StageMessage key={event.id} event={event} />)
              }
            </div>

            {!selected.completed && (
              <div className="flex items-center gap-2 text-sm text-accent">
                <span className="w-2 h-2 bg-accent rounded-full animate-pulse" />
                Waiting for next event…
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  )
}
