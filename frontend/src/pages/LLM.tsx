import { useEffect, useState, useRef, useCallback, Fragment } from 'react'
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
  cancelled?: boolean
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
  trade_executed: 'Trade executed',
  trade_skipped: 'Trade skipped',
  pipeline_error: 'Error',
  pipeline_timeout: 'Timed out',
  pipeline_failed: 'Failed',
  pipeline_cancelled: 'Cancelled',
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
  trade_executed: 'border-l-buy',
  trade_skipped: 'border-l-muted',
  pipeline_error: 'border-l-sell',
  pipeline_timeout: 'border-l-sell',
  pipeline_failed: 'border-l-sell',
  pipeline_cancelled: 'border-l-muted',
}

const TERMINAL_STAGES = new Set(['signal_generated', 'trade_executed', 'trade_skipped', 'pipeline_error', 'pipeline_timeout', 'pipeline_failed', 'pipeline_cancelled'])

function isDiscoveryEvent(pe: PipelineEvent): boolean {
  return pe.stage.startsWith('discovery_')
}

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

  if (event.stage === 'pipeline_cancelled') {
    return wrapper(<p className="text-sm text-muted">Pipeline was cancelled by user.</p>)
  }

  if (event.stage === 'research_completed') {
    const headlines = (data.headlines as string[]) || []
    return wrapper(
      <div className="space-y-1.5">
        <p className="text-xs text-muted">{(data.articles as unknown[])?.length || 0} articles scraped</p>
        <ul className="space-y-1">
          {headlines.slice(0, 10).map((h, i) => (
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
    const skipped = (data.skipped_articles as any[]) || []
    const cachedCount = articles.filter((a: any) => a.from_cache).length
    const skipReasonLabel: Record<string, string> = {
      captcha: 'CAPTCHA',
      cloudflare: 'CLOUDFLARE',
      irrelevant: 'IRRELEVANT',
    }
    return wrapper(
      <div className="space-y-2">
        <p className="text-xs text-muted">
          {articles.length} relevant articles · sentiment: {String(data.aggregated_sentiment || '—')}
          {cachedCount > 0 && <span className="ml-2 text-accent/70">{cachedCount} from cache</span>}
          {skipped.length > 0 && <span className="ml-2 text-sell/70">{skipped.length} skipped</span>}
        </p>
        {articles.slice(0, 10).map((article: any, i: number) => (
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
        {skipped.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t border-border/40">
            {skipped.map((article: any, i: number) => (
              <div key={i} className="space-y-0.5">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Badge variant="sell" className="text-[10px] px-1.5 py-0.5 font-mono shrink-0">
                    {skipReasonLabel[article.skip_reason] ?? article.skip_reason ?? 'SKIPPED'}
                  </Badge>
                  {article.from_cache && (
                    <Badge variant="neutral" className="text-[10px] px-1.5 py-0.5 font-mono shrink-0">CACHED</Badge>
                  )}
                  <span className="truncate opacity-60">{article.title || article.url}</span>
                </div>
                {article.summary && (
                  <p className="text-[11px] text-muted/50 pl-1 leading-snug">{article.summary}</p>
                )}
              </div>
            ))}
          </div>
        )}
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

  if (event.stage === 'trade_executed') {
    const action = String(data.action || '')
    const price = Number(data.price || 0)
    const qty = Number(data.quantity || 0)
    const sl = data.stop_loss != null ? Number(data.stop_loss) : null
    const tp = data.take_profit != null ? Number(data.take_profit) : null
    const isPending = Boolean(data.pending_approval)
    const slSource = String(data.sl_source || 'atr')
    const tradeError = typeof data.error === 'string' && data.error ? data.error : null
    const coin = String(data.symbol || event.coin || '').replace('/USDC', '')
    return wrapper(
      <div className="bg-surface-elevated rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          {actionBadge(action)}
          <span className="font-semibold text-foreground">{coin}</span>
          <span className="text-sm text-muted font-mono">@ ${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</span>
          <div className="flex items-center gap-2 ml-auto">
            {isPending && <Badge variant="warning" className="text-[10px]">Pending approval</Badge>}
            {tradeError && <Badge variant="sell" className="text-[10px]">Failed</Badge>}
            <span className="text-xs text-muted">qty {qty.toFixed(6)}</span>
          </div>
        </div>
        {action === 'BUY' && sl != null && tp != null && (
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-sell/10 rounded-lg p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <p className="text-[10px] font-medium text-sell/70 uppercase tracking-wide">Stop Loss</p>
                {slSource === 'llm' && <span className="text-[9px] bg-accent/20 text-accent px-1 rounded">AI</span>}
              </div>
              <p className="text-sm font-mono font-semibold text-sell">${sl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</p>
              <p className="text-[10px] text-muted mt-0.5">{price > 0 ? `−${((price - sl) / price * 100).toFixed(1)}%` : ''}</p>
            </div>
            <div className="bg-buy/10 rounded-lg p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <p className="text-[10px] font-medium text-buy/70 uppercase tracking-wide">Take Profit</p>
                {slSource === 'llm' && <span className="text-[9px] bg-accent/20 text-accent px-1 rounded">AI</span>}
              </div>
              <p className="text-sm font-mono font-semibold text-buy">${tp.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</p>
              <p className="text-[10px] text-muted mt-0.5">{price > 0 ? `+${((tp - price) / price * 100).toFixed(1)}%` : ''}</p>
            </div>
          </div>
        )}
        {tradeError && (
          <div className="border border-sell/30 bg-sell/5 rounded-lg px-3 py-2">
            <p className="text-[11px] text-sell/80 font-mono break-all">{tradeError}</p>
          </div>
        )}
      </div>
    )
  }

  if (event.stage === 'trade_skipped') {
    return wrapper(
      <p className="text-sm text-muted">{String(data.reason || 'No reason provided')}</p>
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
    const isCancelled = event.stage === 'pipeline_cancelled'
    if (existing) {
      existing.events.push(event)
      if (isTerminal) existing.completed = true
      if (event.stage === 'signal_generated') {
        existing.finalAction = data.action as string
        existing.finalConfidence = data.confidence as number
      }
      if (event.stage === 'trade_executed') {
        existing.finalAction = data.action as string
      }
      if (isError) existing.error = data.error as string
      if (isCancelled) existing.cancelled = true
    } else {
      map.set(event.cycle_id, {
        cycle_id: event.cycle_id,
        coin: event.coin,
        events: [event],
        startTime: event.created_at,
        completed: isTerminal,
        finalAction: event.stage === 'signal_generated' || event.stage === 'trade_executed' ? data.action as string : undefined,
        finalConfidence: event.stage === 'signal_generated' ? data.confidence as number : undefined,
        error: isError ? data.error as string : undefined,
        cancelled: isCancelled,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    new Date(b.startTime.includes('T') ? b.startTime : b.startTime + 'Z').getTime() -
    new Date(a.startTime.includes('T') ? a.startTime : a.startTime + 'Z').getTime()
  )
}

interface SimulateModalProps {
  onClose: () => void
  onSimulated: (cycleId: string) => void
}

function SimulateModal({ onClose, onSimulated }: SimulateModalProps) {
  const [coin, setCoin] = useState('')
  const [action, setAction] = useState<'BUY' | 'SELL'>('BUY')
  const [confidence, setConfidence] = useState(0.8)
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!coin.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/pipeline/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin: coin.trim(), action, confidence, reason: reason.trim() }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error || 'Failed'); return }
      onSimulated(json.cycle_id)
      onClose()
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Simulate Pipeline Signal</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Coin */}
          <div>
            <label className="text-xs text-muted block mb-1.5">Coin</label>
            <input
              type="text"
              value={coin}
              onChange={e => { setCoin(e.target.value.toUpperCase()); setError(null) }}
              placeholder="BTC"
              autoFocus
              className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border rounded-xl text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent/50 font-mono"
            />
          </div>

          {/* Action */}
          <div>
            <label className="text-xs text-muted block mb-1.5">Action</label>
            <div className="flex gap-2">
              {(['BUY', 'SELL'] as const).map(a => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAction(a)}
                  className={cn(
                    'flex-1 py-2 rounded-xl text-sm font-semibold transition-colors',
                    action === a
                      ? a === 'BUY' ? 'bg-buy text-white' : 'bg-sell text-white'
                      : 'bg-surface-elevated text-muted hover:text-foreground border border-border',
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* Confidence */}
          <div>
            <label className="text-xs text-muted block mb-1.5">
              Confidence — <span className="text-foreground font-medium">{Math.round(confidence * 100)}%</span>
            </label>
            <input
              type="range"
              min={0} max={1} step={0.05}
              value={confidence}
              onChange={e => setConfidence(parseFloat(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-muted mt-0.5">
              <span>0%</span><span>100%</span>
            </div>
          </div>

          {/* Reason */}
          <div>
            <label className="text-xs text-muted block mb-1.5">Reason <span className="text-muted/60">(optional)</span></label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Manual test signal"
              className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border rounded-xl text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          </div>

          {error && <p className="text-xs text-sell">{error}</p>}

          <button
            type="submit"
            disabled={loading || !coin.trim()}
            className={cn(
              'w-full py-2.5 rounded-xl text-sm font-semibold transition-colors',
              loading || !coin.trim()
                ? 'bg-surface-elevated text-muted cursor-not-allowed'
                : action === 'BUY' ? 'bg-buy text-white hover:bg-buy/80' : 'bg-sell text-white hover:bg-sell/80',
            )}
          >
            {loading
              ? <span className="inline-flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Sending…</span>
              : `Simulate ${action}`
            }
          </button>
        </form>
      </div>
    </div>
  )
}

export default function LLM() {
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [coinInput, setCoinInput] = useState('')
  const [running, setRunning] = useState(false)
  const [runningAll, setRunningAll] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<Set<string>>(new Set())
  const [rerunning, setRerunning] = useState<Set<string>>(new Set())
  const [showSimulate, setShowSimulate] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pendingCycleRef = useRef<string | null>(null)

  useEffect(() => {
    fetch('/api/pipeline-events?limit=200')
      .then(r => r.json())
      .then((events: PipelineEvent[]) => {
        const grouped = groupEvents(events.filter(e => !isDiscoveryEvent(e)))
        setCycles(grouped)
        if (grouped.length > 0) setSelectedId(grouped[0].cycle_id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleRunAll = useCallback(async () => {
    setRunningAll(true)
    setRunError(null)
    try {
      const res = await fetch('/api/pipeline/run-all', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) setRunError(json.error || 'Failed to start pipeline')
    } catch {
      setRunError('Network error')
    } finally {
      setRunningAll(false)
    }
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

  const handleCancel = useCallback(async (cycleId: string) => {
    setCancelling(prev => new Set(prev).add(cycleId))
    try {
      await fetch(`/api/pipeline/cancel/${encodeURIComponent(cycleId)}`, { method: 'POST' })
    } finally {
      setCancelling(prev => { const s = new Set(prev); s.delete(cycleId); return s })
    }
  }, [])

  const handleRerun = useCallback(async (cycleId: string) => {
    setRerunning(prev => new Set(prev).add(cycleId))
    try {
      const res = await fetch('/api/pipeline/rerun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cycle_id: cycleId }),
      })
      const json = await res.json()
      if (res.ok) {
        pendingCycleRef.current = json.cycle_id
        setSelectedId(json.cycle_id)
      }
    } finally {
      setRerunning(prev => { const s = new Set(prev); s.delete(cycleId); return s })
    }
  }, [])

  useWebSocket((event, data) => {
    if (event === 'pipeline_event') {
      const pe = data as PipelineEvent
      if (isDiscoveryEvent(pe)) return
      const isTerminal = TERMINAL_STAGES.has(pe.stage)
      const isError = pe.stage === 'pipeline_error' || pe.stage === 'pipeline_timeout' || pe.stage === 'pipeline_failed'
      const isCancelled = pe.stage === 'pipeline_cancelled'
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
            finalAction: pe.stage === 'signal_generated' || pe.stage === 'trade_executed' ? pData.action as string : existing.finalAction,
            finalConfidence: pe.stage === 'signal_generated' ? pData.confidence as number : existing.finalConfidence,
            error: isError ? pData.error as string : existing.error,
            cancelled: isCancelled || existing.cancelled,
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
          finalAction: pe.stage === 'signal_generated' || pe.stage === 'trade_executed' ? pData.action as string : undefined,
          finalConfidence: pe.stage === 'signal_generated' ? pData.confidence as number : undefined,
          error: isError ? pData.error as string : undefined,
          cancelled: isCancelled,
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

  function handleSimulated(cycleId: string) {
    pendingCycleRef.current = cycleId
    setSelectedId(cycleId)
  }

  return (
    <Fragment>
    {showSimulate && (
      <SimulateModal
        onClose={() => setShowSimulate(false)}
        onSimulated={handleSimulated}
      />
    )}
    <div className="flex gap-4 h-[calc(100vh-9rem)] animate-fade-in">
      {/* Sidebar */}
      <div className="w-52 shrink-0 bg-surface-card border border-border rounded-2xl flex flex-col overflow-hidden neon-border">
        <div className="px-3 py-3 border-b border-border shrink-0 space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider">Run Pipeline</p>
            <div className="flex items-center gap-1">
              <button
                onClick={handleRunAll}
                disabled={runningAll}
                title="Run full watchlist pipeline (same as cron)"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-accent/80 hover:text-accent hover:bg-accent/10 transition-colors border border-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {runningAll
                  ? <span className="w-2.5 h-2.5 border border-accent border-t-transparent rounded-full animate-spin inline-block" />
                  : <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                    </svg>
                }
                All
              </button>
              <button
                onClick={() => setShowSimulate(true)}
                title="Simulate a BUY / SELL signal"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-muted hover:text-foreground hover:bg-surface-elevated transition-colors border border-border"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
                Sim
              </button>
            </div>
          </div>
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
            const inProgress = !cycle.completed && !cycle.error && !cycle.cancelled
            return (
              <button
                key={cycle.cycle_id}
                onClick={() => setSelectedId(cycle.cycle_id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 rounded-xl transition-colors duration-100',
                  isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                  inProgress && 'ring-1 ring-accent/20',
                )}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-medium">{cycle.coin.replace('/USDC', '')}</span>
                  {cycle.finalAction && actionBadge(cycle.finalAction)}
                  {cycle.error && <Badge variant="sell" className="text-[10px] px-1.5">ERR</Badge>}
                  {cycle.cancelled && <Badge variant="neutral" className="text-[10px] px-1.5">STOP</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted/70">{formatTime(cycle.startTime)}</span>
                  {cycle.finalConfidence !== undefined && (
                    <span className="text-xs text-muted/70">{Math.round(cycle.finalConfidence * 100)}%</span>
                  )}
                  {inProgress && (
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
              {selected.cancelled && <Badge variant="neutral">Cancelled</Badge>}
              {!selected.completed && <Badge variant="accent" dot>Processing</Badge>}
              <span className="text-xs text-muted font-mono ml-auto">{formatTime(selected.startTime)}</span>
              {!selected.completed && !selected.cancelled && (
                <button
                  onClick={() => handleCancel(selected.cycle_id)}
                  disabled={cancelling.has(selected.cycle_id)}
                  title="Cancel pipeline"
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                    cancelling.has(selected.cycle_id)
                      ? 'bg-surface-elevated text-muted cursor-not-allowed'
                      : 'bg-sell/10 text-sell hover:bg-sell/20',
                  )}
                >
                  {cancelling.has(selected.cycle_id) ? (
                    <span className="w-3 h-3 border border-sell border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  Cancel
                </button>
              )}
              {selected.completed && (
                <button
                  onClick={() => handleRerun(selected.cycle_id)}
                  disabled={rerunning.has(selected.cycle_id)}
                  title="Rerun pipeline for this coin"
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                    rerunning.has(selected.cycle_id)
                      ? 'bg-surface-elevated text-muted cursor-not-allowed'
                      : 'bg-accent/10 text-accent hover:bg-accent/20',
                  )}
                >
                  {rerunning.has(selected.cycle_id) ? (
                    <span className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                    </svg>
                  )}
                  Rerun
                </button>
              )}
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
    </Fragment>
  )
}
