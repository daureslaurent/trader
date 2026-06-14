import { useEffect, useState, useRef, useCallback, useMemo, Fragment } from 'react'
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

/* ============================================================
   Real-time pipeline stage tracker
   ============================================================ */

function tsOf(iso: string) {
  return new Date(iso.includes('T') ? iso : iso + 'Z').getTime()
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

type PhaseStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'

interface PhaseDef {
  key: string
  label: string
  start: string
  end: string[]
  icon: (cls: string) => React.ReactNode
}

const PHASES: PhaseDef[] = [
  { key: 'research', label: 'Research', start: 'research_started',   end: ['research_completed'],   icon: SearchIcon },
  { key: 'extract',  label: 'Extract',  start: 'extraction_started', end: ['extraction_completed'], icon: DocIcon },
  { key: 'select',   label: 'Select',   start: 'selection_started',  end: ['selection_completed'],  icon: FilterIcon },
  { key: 'analyze',  label: 'Analyze',  start: 'analysis_started',   end: ['signal_generated'],     icon: SparkIcon },
  { key: 'trade',    label: 'Trade',    start: 'signal_generated',   end: ['trade_executed', 'trade_skipped'], icon: BoltIcon },
]

interface PhaseState {
  def: PhaseDef
  status: PhaseStatus
  startAt?: number
  endAt?: number
}

function computePhases(cycle: Cycle): PhaseState[] {
  const stageTime = new Map<string, number>()
  for (const e of cycle.events) {
    if (!stageTime.has(e.stage)) stageTime.set(e.stage, tsOf(e.created_at))
  }
  const tradeSkipped = stageTime.has('trade_skipped')

  const phases: PhaseState[] = PHASES.map(def => {
    const startAt = stageTime.get(def.start)
    let endAt: number | undefined
    for (const e of def.end) {
      const t = stageTime.get(e)
      if (t != null) { endAt = t; break }
    }
    let status: PhaseStatus
    if (endAt != null) status = def.key === 'trade' && tradeSkipped ? 'skipped' : 'done'
    else if (startAt != null) status = 'active'
    else status = 'pending'
    // A HOLD ends at signal_generated and never trades — don't spin the Trade node forever.
    if (def.key === 'trade' && status === 'active' && cycle.finalAction === 'HOLD') status = 'skipped'
    return { def, status, startAt, endAt }
  })

  // Surface terminal failures / cancellation on the first unfinished phase.
  if (cycle.error || cycle.cancelled) {
    const target = phases.find(p => p.status === 'active') ?? phases.find(p => p.status === 'pending')
    if (target) target.status = 'error'
  }

  return phases
}

function StageNode({ phase, now }: { phase: PhaseState; now: number }) {
  const { status, def } = phase
  const dur =
    phase.startAt != null && phase.endAt != null ? phase.endAt - phase.startAt :
    status === 'active' && phase.startAt != null ? now - phase.startAt :
    null

  const ring =
    status === 'done'    ? 'bg-buy/15 text-buy ring-buy/30' :
    status === 'active'  ? 'bg-accent/15 text-accent ring-accent/40' :
    status === 'error'   ? 'bg-sell/15 text-sell ring-sell/30' :
    status === 'skipped' ? 'bg-surface-elevated text-muted ring-border' :
                           'bg-surface-elevated text-muted/50 ring-border'

  return (
    <div className="flex flex-col items-center gap-1.5 min-w-0">
      <div className="relative">
        {status === 'active' && (
          <span className="absolute -inset-1.5 rounded-2xl bg-accent/30 blur-md animate-glow-pulse" aria-hidden />
        )}
        <div className={cn(
          'relative w-11 h-11 rounded-2xl ring-1 flex items-center justify-center transition-colors duration-300',
          ring,
        )}>
          {status === 'done' ? <CheckIcon className="w-5 h-5" />
            : status === 'error' ? <XIcon className="w-5 h-5" />
            : status === 'skipped' ? <DashIcon className="w-5 h-5" />
            : def.icon(cn('w-5 h-5', status === 'active' && 'animate-pulse'))}
        </div>
      </div>
      <span className={cn(
        'text-[11px] font-semibold tracking-tight transition-colors',
        status === 'pending' ? 'text-muted/60' : status === 'active' ? 'text-accent' : 'text-foreground',
      )}>
        {def.label}
      </span>
      <span className="text-[10px] font-mono text-muted/70 h-3 leading-3 tabular-nums">
        {dur != null ? fmtElapsed(dur) : ''}
      </span>
    </div>
  )
}

function FlowConnector({ from, to }: { from: PhaseState; to: PhaseState }) {
  const filled = from.status === 'done' || from.status === 'skipped'
  const flowing = filled && to.status === 'active'
  return (
    <div className="flex-1 h-11 flex items-center min-w-[16px] -mx-1">
      <div className="relative w-full h-1 rounded-full bg-border/60 overflow-hidden">
        {flowing ? (
          <div
            className="absolute inset-0 rounded-full animate-flow-line"
            style={{
              backgroundImage: 'linear-gradient(90deg, rgb(var(--accent-rgb)/0.15) 0%, rgb(var(--accent-rgb)) 50%, rgb(var(--accent-rgb)/0.15) 100%)',
              backgroundSize: '200% 100%',
            }}
          />
        ) : (
          <div className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-all duration-500',
            filled ? 'w-full bg-gradient-to-r from-buy/70 to-accent/70' : 'w-0',
          )} />
        )}
      </div>
    </div>
  )
}

function StageTracker({ cycle, now }: { cycle: Cycle; now: number }) {
  const phases = computePhases(cycle)
  return (
    <div className="flex items-start px-1 py-1">
      {phases.map((p, i) => (
        <Fragment key={p.def.key}>
          <StageNode phase={p} now={now} />
          {i < phases.length - 1 && <FlowConnector from={p} to={phases[i + 1]} />}
        </Fragment>
      ))}
    </div>
  )
}

/** Compact mini stage dots for the cycle list rail. */
function MiniStages({ cycle }: { cycle: Cycle }) {
  const phases = computePhases(cycle)
  return (
    <div className="flex items-center gap-1">
      {phases.map(p => (
        <span
          key={p.def.key}
          title={p.def.label}
          className={cn(
            'h-1.5 flex-1 rounded-full transition-colors duration-300',
            p.status === 'done' ? 'bg-buy/70' :
            p.status === 'active' ? 'bg-accent animate-pulse' :
            p.status === 'error' ? 'bg-sell/70' :
            p.status === 'skipped' ? 'bg-muted/40' :
            'bg-border',
          )}
        />
      ))}
    </div>
  )
}

/* ============================================================
   Stats strip
   ============================================================ */

function MetricChip({ label, value, tone, dot }: {
  label: string
  value: React.ReactNode
  tone?: 'accent' | 'buy' | 'sell' | 'warn' | 'muted'
  dot?: boolean
}) {
  const toneCls =
    tone === 'buy'  ? 'text-buy' :
    tone === 'sell' ? 'text-sell' :
    tone === 'warn' ? 'text-warn' :
    tone === 'accent' ? 'text-accent' : 'text-foreground'
  return (
    <div className="flex flex-col gap-0.5 px-3.5 py-2 rounded-xl bg-surface-elevated/60 border border-border min-w-[84px]">
      <span className="text-[10px] font-semibold text-muted uppercase tracking-wider flex items-center gap-1">
        {dot && <span className={cn('w-1.5 h-1.5 rounded-full bg-current animate-pulse', toneCls)} />}
        {label}
      </span>
      <span className={cn('text-lg font-bold tabular-nums leading-none tracking-tight', toneCls)}>{value}</span>
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
  const [now, setNow] = useState(Date.now())
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

  const liveCount = useMemo(
    () => cycles.filter(c => !c.completed && !c.error && !c.cancelled).length,
    [cycles],
  )

  // Tick the clock only while something is running, to drive live stage timers.
  useEffect(() => {
    if (liveCount === 0) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [liveCount])

  const stats = useMemo(() => {
    let buy = 0, sell = 0, hold = 0, confSum = 0, confN = 0
    for (const c of cycles) {
      if (c.finalAction === 'BUY') buy++
      else if (c.finalAction === 'SELL') sell++
      else if (c.finalAction === 'HOLD') hold++
      if (c.finalConfidence != null) { confSum += c.finalConfidence; confN++ }
    }
    return { buy, sell, hold, avgConf: confN > 0 ? Math.round((confSum / confN) * 100) : null }
  }, [cycles])

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
    <div className="flex flex-col gap-4 h-[calc(100vh-7rem)] animate-fade-in">

      {/* Toolbar: live stats + run controls */}
      <div className="relative overflow-hidden bg-surface-card border border-border rounded-2xl neon-border shadow-soft px-4 py-3 shrink-0">
        {liveCount > 0 && (
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <MetricChip label="Cycles" value={cycles.length} tone="muted" />
            <MetricChip label="Live" value={liveCount} tone={liveCount > 0 ? 'accent' : 'muted'} dot={liveCount > 0} />
            <MetricChip label="Buy" value={stats.buy} tone="buy" />
            <MetricChip label="Sell" value={stats.sell} tone="sell" />
            <MetricChip label="Hold" value={stats.hold} tone="warn" />
            <MetricChip label="Avg conf" value={stats.avgConf != null ? `${stats.avgConf}%` : '—'} tone="accent" />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={coinInput}
                onChange={e => { setCoinInput(e.target.value.toUpperCase()); setRunError(null) }}
                onKeyDown={e => e.key === 'Enter' && !running && handleRun()}
                placeholder="Run coin…"
                className="w-28 px-3 py-1.5 text-sm bg-surface-elevated border border-border rounded-xl text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent/50 font-mono"
              />
              <button
                onClick={handleRun}
                disabled={running || !coinInput.trim()}
                className={cn(
                  'shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all active:scale-[0.98]',
                  running || !coinInput.trim()
                    ? 'bg-surface-elevated text-muted cursor-not-allowed'
                    : 'bg-gradient-to-r from-accent to-accent2 text-surface-base hover:brightness-110 hover:shadow-glow',
                )}
              >
                {running
                  ? <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  : 'Run'
                }
              </button>
            </div>
            <span className="w-px h-6 bg-border" />
            <button
              onClick={handleRunAll}
              disabled={runningAll}
              title="Run full watchlist pipeline (same as cron)"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-accent bg-accent/10 border border-accent/20 hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {runningAll
                ? <span className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin inline-block" />
                : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                  </svg>
              }
              Run all
            </button>
            <button
              onClick={() => setShowSimulate(true)}
              title="Simulate a BUY / SELL signal"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-muted hover:text-foreground bg-surface-elevated border border-border hover:border-accent/20 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
              </svg>
              Simulate
            </button>
          </div>
        </div>
        {runError && <p className="text-[11px] text-sell mt-2">{runError}</p>}
      </div>

      {/* Main: cycle rail + detail */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* Cycle rail */}
        <div className="w-60 shrink-0 bg-surface-card border border-border rounded-2xl flex flex-col overflow-hidden neon-border shadow-soft">
          <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider">Cycles</p>
            <span className="text-[11px] text-muted/70 tabular-nums">{cycles.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
            {loading && (
              <div className="flex items-center justify-center h-16">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {!loading && cycles.length === 0 && (
              <p className="text-xs text-muted text-center px-3 py-6">No cycles yet. Run the pipeline or wait for the bot.</p>
            )}
            {cycles.map(cycle => {
              const isActive = selectedId === cycle.cycle_id
              const inProgress = !cycle.completed && !cycle.error && !cycle.cancelled
              return (
                <button
                  key={cycle.cycle_id}
                  onClick={() => setSelectedId(cycle.cycle_id)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-xl border transition-all duration-100',
                    isActive
                      ? 'bg-accent/10 border-accent/30'
                      : 'border-transparent hover:bg-surface-elevated hover:border-border',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={cn('text-sm font-semibold', isActive ? 'text-accent' : 'text-foreground')}>
                      {cycle.coin.replace('/USDC', '')}
                    </span>
                    {inProgress && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
                    <div className="ml-auto flex items-center gap-1.5">
                      {cycle.finalAction && actionBadge(cycle.finalAction)}
                      {cycle.error && <Badge variant="sell" className="text-[10px] px-1.5">ERR</Badge>}
                      {cycle.cancelled && <Badge variant="neutral" className="text-[10px] px-1.5">STOP</Badge>}
                    </div>
                  </div>
                  <MiniStages cycle={cycle} />
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[11px] font-mono text-muted/70">{formatTime(cycle.startTime)}</span>
                    {cycle.finalConfidence !== undefined && (
                      <span className="text-[11px] text-muted/70 tabular-nums ml-auto">{Math.round(cycle.finalConfidence * 100)}%</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 bg-surface-card border border-border rounded-2xl flex flex-col overflow-hidden neon-border shadow-soft min-w-0">
          {!selected ? (
            <div className="flex items-center justify-center h-full text-sm text-muted">
              {loading ? 'Loading…' : 'Select a pipeline cycle'}
            </div>
          ) : (
            <Fragment>
              {/* Header */}
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
                <CoinAvatar coin={selected.coin} />
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-foreground leading-none">{selected.coin.replace('/USDC', '')}</h2>
                  <span className="text-[11px] text-muted font-mono">{formatTime(selected.startTime)}</span>
                </div>
                <div className="flex items-center gap-2 ml-2">
                  {selected.finalAction && actionBadge(selected.finalAction)}
                  {selected.error && <Badge variant="sell">Error</Badge>}
                  {selected.cancelled && <Badge variant="neutral">Cancelled</Badge>}
                  {!selected.completed && !selected.error && !selected.cancelled && <Badge variant="accent" dot>Processing</Badge>}
                </div>
                <div className="ml-auto">
                  {!selected.completed && !selected.cancelled && (
                    <button
                      onClick={() => handleCancel(selected.cycle_id)}
                      disabled={cancelling.has(selected.cycle_id)}
                      title="Cancel pipeline"
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors',
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
                        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors',
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
              </div>

              {/* Live stage tracker */}
              <div className="px-5 py-4 border-b border-border shrink-0 bg-surface-elevated/30">
                <StageTracker cycle={selected} now={now} />
              </div>

              {/* Event stream */}
              <div className="flex-1 overflow-y-auto p-5">
                <div className="space-y-3">
                  {[...selected.events]
                    .sort((a, b) =>
                      new Date(a.created_at.includes('T') ? a.created_at : a.created_at + 'Z').getTime() -
                      new Date(b.created_at.includes('T') ? b.created_at : b.created_at + 'Z').getTime()
                    )
                    .map(event => <StageMessage key={event.id} event={event} />)
                  }
                </div>

                {!selected.completed && !selected.error && !selected.cancelled && (
                  <div className="flex items-center gap-2 text-sm text-accent mt-4">
                    <span className="w-2 h-2 bg-accent rounded-full animate-pulse" />
                    Waiting for next event…
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </Fragment>
          )}
        </div>
      </div>
    </div>
    </Fragment>
  )
}

/* ============================================================
   Icons
   ============================================================ */

function CoinAvatar({ coin }: { coin: string }) {
  return (
    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent/20 to-accent2/10 ring-1 ring-accent/15 flex items-center justify-center shrink-0">
      <span className="text-xs font-bold text-accent">{coin.replace('/USDC', '').slice(0, 3)}</span>
    </div>
  )
}

function SearchIcon(cls: string) {
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  )
}

function DocIcon(cls: string) {
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  )
}

function FilterIcon(cls: string) {
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
    </svg>
  )
}

function SparkIcon(cls: string) {
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
    </svg>
  )
}

function BoltIcon(cls: string) {
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  )
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function DashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
    </svg>
  )
}
