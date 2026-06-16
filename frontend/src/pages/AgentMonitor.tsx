import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import { cn } from '../lib/utils'

// Compact "Ns/Nm ago" from an epoch-ms timestamp (the WS frames carry ms, not the
// SQL date strings lib/utils.timeAgo expects).
function agoMs(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// ── strategy model ─────────────────────────────────────────────────────────────
// The three mutually-exclusive monitor engines, as the user thinks of them. They map
// onto two backend settings (monitor_strategy + monitor_model), so picking one always
// deselects the others — the mutual exclusion is structural, not enforced by hand.
type Strategy = 'A' | 'B' | 'D'

interface MonitorSettings {
  monitor_strategy: 'classic' | 'agentic_d'
  monitor_model: 'a' | 'b' | 'alternate' | 'ab' | 'abc'
}

function activeStrategy(s: MonitorSettings | null): Strategy {
  if (!s) return 'A'
  if (s.monitor_strategy === 'agentic_d') return 'D'
  return s.monitor_model === 'b' ? 'B' : 'A'
}

// The settings patch each toggle position writes.
const STRATEGY_PATCH: Record<Strategy, Partial<MonitorSettings>> = {
  A: { monitor_strategy: 'classic', monitor_model: 'a' },
  B: { monitor_strategy: 'classic', monitor_model: 'b' },
  D: { monitor_strategy: 'agentic_d' },
}

const STRATEGY_META: Record<Strategy, { label: string; blurb: string }> = {
  A: { label: 'Monitor A', blurb: 'Classic single-shot · slot A' },
  B: { label: 'Monitor B', blurb: 'Classic single-shot · slot B' },
  D: { label: 'Type D', blurb: 'Agentic tool-calling monitor' },
}

// ── live-feed model ────────────────────────────────────────────────────────────
type FrameType =
  | 'coin_started' | 'thinking' | 'tool_call' | 'tool_result'
  | 'assistant_note' | 'assistant' | 'decision' | 'error'

interface AgentStep {
  source?: string
  cycle_id?: string
  coin?: string
  type: FrameType
  tool?: string
  args?: Record<string, unknown>
  result?: unknown
  read_only?: boolean
  content?: string
  action?: string
  confidence?: number
  reasoning?: string
  discarded?: boolean
  error?: string
  round?: number
}

interface LogLine {
  id: number
  coin: string
  icon: string
  text: string
  tone: 'muted' | 'accent' | 'buy' | 'sell' | 'warn'
  at: number
}

interface Decision {
  action: string
  confidence: number
  reasoning: string
  discarded: boolean
  at: number
}

interface CoinReview {
  coin: string
  status: 'reviewing' | 'done' | 'error'
  decision?: Decision
  error?: string
  startedAt: number
}

// Per-tool presentation for the terminal feed.
const TOOL_FEED: Record<string, { icon: string; verb: string }> = {
  get_candle_data:      { icon: '💾', verb: 'Reading candle data' },
  get_position_history: { icon: '📊', verb: 'Pulling P&L history' },
  get_coin_sentiment:   { icon: '📰', verb: 'Checking news sentiment' },
  get_market:           { icon: '📈', verb: 'Reading live indicators' },
  list_position_reviews:{ icon: '🗂️', verb: 'Reviewing prior verdicts' },
  list_recent_trades:   { icon: '🧾', verb: 'Scanning recent trades' },
  list_recent_signals:  { icon: '🔔', verb: 'Scanning recent signals' },
  list_open_positions:  { icon: '📂', verb: 'Listing open positions' },
}

const ACTION_VARIANT: Record<string, 'buy' | 'sell' | 'warning' | 'accent' | 'neutral'> = {
  HOLD: 'neutral', CLOSE: 'sell', REDUCE: 'warning', ADJUST: 'accent',
}

let lineSeq = 0

export default function AgentMonitor() {
  const settings = useApi<MonitorSettings>('/api/settings')
  const [strategy, setStrategy] = useState<Strategy>('A')
  const [saving, setSaving] = useState(false)

  // Keep the toggle in sync once settings load (and after a save round-trips).
  useEffect(() => {
    if (settings.data) setStrategy(activeStrategy(settings.data))
  }, [settings.data])

  const [reviews, setReviews] = useState<Record<string, CoinReview>>({})
  const [feed, setFeed] = useState<LogLine[]>([])
  const [activeCoin, setActiveCoin] = useState<string | null>(null)
  const [cycleRunning, setCycleRunning] = useState(false)
  const feedEndRef = useRef<HTMLDivElement>(null)

  const pushLine = useCallback((coin: string, icon: string, text: string, tone: LogLine['tone']) => {
    setFeed(f => [...f.slice(-199), { id: ++lineSeq, coin, icon, text, tone, at: Date.now() }])
  }, [])

  // Auto-scroll the terminal to the newest line.
  useEffect(() => { feedEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [feed])

  const onWs = useCallback((event: string, data: unknown) => {
    if (event === 'monitor_started') {
      const d = data as { strategy?: string }
      if (d.strategy === 'agentic_d') {
        setCycleRunning(true)
        setReviews({})
        setActiveCoin(null)
        setFeed([])
      }
      return
    }
    if (event === 'monitor_completed' || event === 'monitor_error') {
      const d = data as { strategy?: string }
      if (d.strategy === 'agentic_d') setCycleRunning(false)
      return
    }
    if (event !== 'agent_step') return

    const s = data as AgentStep
    if (s.source !== 'monitor_d' || !s.coin) return
    const coin = s.coin

    switch (s.type) {
      case 'coin_started':
        setActiveCoin(coin)
        setReviews(r => ({ ...r, [coin]: { coin, status: 'reviewing', startedAt: Date.now() } }))
        pushLine(coin, '🔍', `Reviewing ${coin}…`, 'accent')
        break
      case 'thinking':
        setActiveCoin(coin)
        pushLine(coin, '🤖', 'Reasoning about the position…', 'muted')
        break
      case 'tool_call': {
        const meta = TOOL_FEED[s.tool ?? ''] ?? { icon: '🔧', verb: s.tool ?? 'tool' }
        pushLine(coin, meta.icon, `${meta.verb}…`, 'muted')
        break
      }
      case 'tool_result': {
        const meta = TOOL_FEED[s.tool ?? ''] ?? { icon: '✓', verb: s.tool ?? 'tool' }
        const res = s.result as Record<string, unknown> | undefined
        // Surface the cache-first candle backfill explicitly when present.
        if (s.tool === 'get_candle_data' && res && typeof res.count === 'number') {
          pushLine(coin, '💾', `Candle data ready (${res.count} bars, cache-first)`, 'muted')
        } else if (s.tool === 'get_coin_sentiment' && res?.stub) {
          pushLine(coin, '📰', 'Sentiment proxy returned (live crawl not wired)', 'warn')
        } else if (res?.error) {
          pushLine(coin, '⚠️', `${meta.verb} → ${String(res.error)}`, 'warn')
        } else {
          pushLine(coin, '✓', `${meta.verb} complete`, 'muted')
        }
        break
      }
      case 'assistant_note':
        if (s.content) pushLine(coin, '💬', s.content, 'muted')
        break
      case 'decision': {
        const action = s.action ?? 'HOLD'
        const dec: Decision = {
          action,
          confidence: s.confidence ?? 0,
          reasoning: s.reasoning ?? '',
          discarded: !!s.discarded,
          at: Date.now(),
        }
        setReviews(r => ({ ...r, [coin]: { ...(r[coin] ?? { coin, startedAt: Date.now() }), coin, status: 'done', decision: dec } }))
        const tone: LogLine['tone'] = action === 'CLOSE' ? 'sell' : action === 'REDUCE' ? 'warn' : action === 'ADJUST' ? 'accent' : 'buy'
        pushLine(coin, action === 'HOLD' ? '✋' : action === 'CLOSE' ? '🚪' : action === 'REDUCE' ? '✂️' : '🎯',
          `Decision: ${action} (${Math.round(dec.confidence * 100)}%)`, tone)
        if (activeCoin === coin) setActiveCoin(null)
        break
      }
      case 'error':
        setReviews(r => ({ ...r, [coin]: { ...(r[coin] ?? { coin, startedAt: Date.now() }), coin, status: 'error', error: s.error } }))
        pushLine(coin, '❌', `Error: ${s.error ?? 'unknown'}`, 'sell')
        break
    }
  }, [pushLine, activeCoin])

  const { connected } = useWebSocket(onWs)

  async function selectStrategy(next: Strategy) {
    if (next === strategy || saving) return
    const prev = strategy
    setStrategy(next)        // optimistic
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(STRATEGY_PATCH[next]),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      await settings.reload()
    } catch {
      setStrategy(prev)      // roll back on failure
    } finally {
      setSaving(false)
    }
  }

  async function runNow() {
    setCycleRunning(true)
    try {
      const res = await fetch('/api/monitor/run', { method: 'POST' })
      if (!res.ok) setCycleRunning(false)
    } catch {
      setCycleRunning(false)
    }
  }

  const reviewList = Object.values(reviews).sort((a, b) => b.startedAt - a.startedAt)
  const isTypeD = strategy === 'D'

  return (
    <div className="space-y-6">
      {/* ── Strategy toggle + status ─────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Agent Monitor"
          subtitle="Type D — the agentic position monitor: one tool-calling review per open position"
          action={
            <div className="flex items-center gap-2">
              <Badge variant={connected ? 'executed' : 'failed'} dot>{connected ? 'Live' : 'Offline'}</Badge>
              {cycleRunning && <Badge variant="accent" dot>Reviewing</Badge>}
            </div>
          }
        />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {/* Segmented, mutually-exclusive engine selector. */}
          <div className="inline-flex rounded-xl border border-border bg-surface-elevated/40 p-1">
            {(['A', 'B', 'D'] as Strategy[]).map(opt => {
              const on = strategy === opt
              return (
                <button
                  key={opt}
                  onClick={() => selectStrategy(opt)}
                  disabled={saving}
                  className={cn(
                    'relative px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 disabled:opacity-60',
                    on
                      ? (opt === 'D' ? 'bg-accent text-surface-base shadow-soft' : 'bg-surface-card text-foreground shadow-soft')
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  <span className="flex items-center gap-2">
                    {opt === 'D' && <span className={cn('w-1.5 h-1.5 rounded-full', on ? 'bg-surface-base' : 'bg-accent', cycleRunning && on && 'animate-pulse')} />}
                    {STRATEGY_META[opt].label}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-3">
            <p className="text-xs text-muted">{STRATEGY_META[strategy].blurb}</p>
            <Button variant="primary" size="sm" onClick={runNow} disabled={!isTypeD || cycleRunning} loading={cycleRunning}>
              {isTypeD ? 'Run Type D now' : 'Select Type D to run'}
            </Button>
          </div>
        </div>

        {!isTypeD && (
          <p className="mt-3 text-xs text-warn">
            Type D is inactive — the classic monitor ({STRATEGY_META[strategy].label}) drives the monitor cron. Switch to Type D to hand position reviews to the agent.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* ── Live terminal feed ─────────────────────────────────────────────── */}
        <Card className="lg:col-span-3" noPad>
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <span className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-sell/70" />
                <span className="w-3 h-3 rounded-full bg-warn/70" />
                <span className="w-3 h-3 rounded-full bg-buy/70" />
              </span>
              <span className="ml-2 font-mono text-xs text-muted">type-d://monitor/live</span>
            </div>
            {activeCoin && <Badge variant="accent" dot>{activeCoin}</Badge>}
          </div>

          <div className="h-[28rem] overflow-y-auto px-5 py-4 font-mono text-xs leading-relaxed">
            {feed.length === 0 ? (
              <p className="text-muted">
                {isTypeD
                  ? cycleRunning ? 'Waiting for the agent to begin…' : 'Idle. Run Type D to stream a live review.'
                  : 'Type D is not the active monitor.'}
              </p>
            ) : (
              feed.map(line => (
                <div key={line.id} className="flex items-start gap-2 py-0.5 animate-fade-in">
                  <span className="select-none">{line.icon}</span>
                  <span className="shrink-0 text-muted/60">{line.coin}</span>
                  <span className={cn(
                    line.tone === 'accent' && 'text-accent',
                    line.tone === 'buy' && 'text-buy',
                    line.tone === 'sell' && 'text-sell',
                    line.tone === 'warn' && 'text-warn',
                    line.tone === 'muted' && 'text-foreground/80',
                  )}>{line.text}</span>
                </div>
              ))
            )}
            <div ref={feedEndRef} />
          </div>
        </Card>

        {/* ── Decision cards ─────────────────────────────────────────────────── */}
        <div className="space-y-4 lg:col-span-2">
          <CardHeader title="Verdicts" subtitle={`${reviewList.length} position${reviewList.length === 1 ? '' : 's'} this cycle`} className="mb-0" />
          {reviewList.length === 0 && (
            <Card><p className="text-sm text-muted">No reviews yet. The agent's verdicts will appear here as each position is evaluated.</p></Card>
          )}
          {reviewList.map(rv => (
            <Card
              key={rv.coin}
              className={cn(
                'border-l-4 transition-all duration-300',
                rv.status === 'reviewing' && 'border-l-accent animate-pulse',
                rv.status === 'error' && 'border-l-sell',
                rv.status === 'done' && (
                  rv.decision?.action === 'CLOSE' ? 'border-l-sell'
                  : rv.decision?.action === 'REDUCE' ? 'border-l-warn'
                  : rv.decision?.action === 'ADJUST' ? 'border-l-accent'
                  : 'border-l-buy'
                ),
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">{rv.coin}</span>
                  {rv.status === 'reviewing' && <Badge variant="accent" dot>reviewing…</Badge>}
                  {rv.status === 'done' && rv.decision && (
                    <Badge variant={ACTION_VARIANT[rv.decision.action] ?? 'neutral'}>{rv.decision.action}</Badge>
                  )}
                  {rv.status === 'error' && <Badge variant="failed">error</Badge>}
                </div>
                {rv.status === 'done' && rv.decision && (
                  <span className="text-xs font-mono text-muted">{Math.round(rv.decision.confidence * 100)}% conf</span>
                )}
              </div>

              {rv.status === 'done' && rv.decision && (
                <p className="mt-2 text-xs text-foreground/80 leading-relaxed">{rv.decision.reasoning}</p>
              )}
              {rv.status === 'done' && rv.decision?.discarded && (
                <p className="mt-1 text-xs text-warn">Position closed during analysis — verdict not applied.</p>
              )}
              {rv.status === 'error' && <p className="mt-2 text-xs text-sell">{rv.error}</p>}
              <p className="mt-2 text-[10px] uppercase tracking-wide text-muted/60">{agoMs(rv.startedAt)}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
