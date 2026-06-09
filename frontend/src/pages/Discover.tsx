import { useEffect, useState, useCallback } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { cn } from '../lib/utils'
import { DiscoveryResult, DiscoveryMarketData } from '../types'
import { useWebSocket } from '../hooks/useWebSocket'

interface DiscoverResponse {
  running: boolean
  discoveries: DiscoveryResult[]
}

interface DiscoverSettings {
  watchlist: string[]
  discover_cron: string
  discover_min_score: number
  discover_top_n: number
  discover_auto_add: boolean
  discover_min_volume_usd: number
}

const CRON_PRESETS = [
  { label: '6am daily', value: '0 6 * * *' },
  { label: '12hr',      value: '0 */12 * * *' },
  { label: '6hr',       value: '0 */6 * * *' },
  { label: 'Daily',     value: '0 0 * * *' },
  { label: 'Weekly',    value: '0 6 * * 1' },
]

const STATUS_STYLES: Record<DiscoveryResult['status'], string> = {
  pending:    'bg-warn/10 text-warn border border-warn/20',
  approved:   'bg-buy/10 text-buy border border-buy/20',
  rejected:   'bg-sell/10 text-sell border border-sell/20',
  auto_added: 'bg-accent/10 text-accent border border-accent/20',
}

const STATUS_LABELS: Record<DiscoveryResult['status'], string> = {
  pending:    'Pending',
  approved:   'Added',
  rejected:   'Rejected',
  auto_added: 'Auto-added',
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color = score >= 0.7 ? 'bg-buy' : score >= 0.5 ? 'bg-warn' : 'bg-sell'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('text-xs font-semibold tabular-nums w-8 text-right', score >= 0.7 ? 'text-buy' : score >= 0.5 ? 'text-warn' : 'text-sell')}>
        {pct}%
      </span>
    </div>
  )
}

function TrendBadge({ trend }: { trend: string }) {
  const styles: Record<string, string> = {
    uptrend:   'text-buy',
    downtrend: 'text-sell',
    ranging:   'text-muted',
  }
  const arrows: Record<string, string> = { uptrend: '↑', downtrend: '↓', ranging: '↔' }
  return (
    <span className={cn('text-xs font-medium', styles[trend] ?? 'text-muted')}>
      {arrows[trend] ?? ''} {trend}
    </span>
  )
}

function DiscoveryCard({
  discovery,
  onApprove,
  onReject,
  onDelete,
}: {
  discovery: DiscoveryResult
  onApprove: (id: number) => void
  onReject: (id: number) => void
  onDelete: (id: number) => void
}) {
  const market: DiscoveryMarketData | null = (() => {
    try { return JSON.parse(discovery.market_data) } catch { return null }
  })()

  const coin = discovery.coin.replace('/USDC', '')
  const isPending = discovery.status === 'pending'

  return (
    <Card className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-surface-elevated flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-foreground">{coin.slice(0, 3)}</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{coin}</p>
            <p className="text-xs text-muted">{discovery.coin}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={cn('text-xs px-2 py-0.5 rounded-lg font-medium', STATUS_STYLES[discovery.status])}>
            {STATUS_LABELS[discovery.status]}
          </span>
        </div>
      </div>

      {/* Score */}
      <div>
        <p className="text-xs text-muted mb-1">Discovery score</p>
        <ScoreBar score={discovery.score} />
      </div>

      {/* Market snapshot */}
      {market && (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-surface-elevated rounded-xl p-2.5 text-center">
            <p className="text-xs text-muted">RSI-14</p>
            <p className={cn('text-sm font-semibold', market.rsi14 > 70 ? 'text-sell' : market.rsi14 < 30 ? 'text-buy' : 'text-foreground')}>
              {market.rsi14.toFixed(0)}
            </p>
          </div>
          <div className="bg-surface-elevated rounded-xl p-2.5 text-center">
            <p className="text-xs text-muted">Trend</p>
            <TrendBadge trend={market.trend} />
          </div>
          <div className="bg-surface-elevated rounded-xl p-2.5 text-center">
            <p className="text-xs text-muted">24h</p>
            <p className={cn('text-sm font-semibold', market.change24h >= 0 ? 'text-buy' : 'text-sell')}>
              {market.change24h >= 0 ? '+' : ''}{market.change24h.toFixed(2)}%
            </p>
          </div>
          <div className="bg-surface-elevated rounded-xl p-2.5 text-center">
            <p className="text-xs text-muted">Price</p>
            <p className="text-sm font-semibold text-foreground">${market.price < 0.01 ? market.price.toExponential(2) : market.price.toFixed(4)}</p>
          </div>
          <div className="bg-surface-elevated rounded-xl p-2.5 text-center">
            <p className="text-xs text-muted">Volume</p>
            <p className="text-sm font-semibold text-foreground">${(market.volume / 1_000_000).toFixed(1)}M</p>
          </div>
          <div className="bg-surface-elevated rounded-xl p-2.5 text-center">
            <p className="text-xs text-muted">7d perf</p>
            <p className={cn('text-sm font-semibold', market.perf7d >= 0 ? 'text-buy' : 'text-sell')}>
              {market.perf7d >= 0 ? '+' : ''}{market.perf7d.toFixed(1)}%
            </p>
          </div>
        </div>
      )}

      {/* Reasoning */}
      <p className="text-xs text-muted leading-relaxed bg-surface-elevated rounded-xl px-3 py-2">
        {discovery.reasoning}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {isPending && (
          <>
            <Button variant="success" size="sm" onClick={() => onApprove(discovery.id)} className="flex-1">
              Add to watchlist
            </Button>
            <Button variant="danger" size="sm" onClick={() => onReject(discovery.id)} className="flex-1">
              Reject
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => onDelete(discovery.id)}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
        </Button>
        <p className="text-xs text-muted ml-auto">{new Date(discovery.created_at).toLocaleDateString()}</p>
      </div>
    </Card>
  )
}

// ── Pipeline run panel ────────────────────────────────────────────────────────

interface LogEntry {
  id: number
  stage: string
  coin: string
  data: Record<string, unknown>
  ts: string
}

interface CoinState {
  coin: string
  stage: string
  articlesFetched?: number
  articlesExtracted?: number
  sentiment?: string
  score?: number
  error?: string
  ts: string
}

interface RunMeta {
  startTs: string
  topN?: number
  candidates?: number
  excluded?: number
  evaluated?: number
  discovered?: number
  autoAdded?: number
  done: boolean
}

function derivePipelineState(entries: LogEntry[]): { run: RunMeta | null; coins: CoinState[] } {
  let run: RunMeta | null = null
  const map = new Map<string, CoinState>()

  for (const e of entries) {
    if (e.stage === 'discovery_started') {
      run = { startTs: e.ts, topN: e.data.top_n as number | undefined, done: false }
      continue
    }
    if (e.stage === 'discovery_candidates_found') {
      if (run) { run.candidates = e.data.candidates as number; run.excluded = e.data.excluded as number }
      continue
    }
    if (e.stage === 'discovery_completed') {
      if (run) { run.evaluated = e.data.evaluated as number; run.discovered = e.data.discovered as number; run.autoAdded = e.data.auto_added as number; run.done = true }
      continue
    }
    if (!e.coin || e.coin === 'DISCOVERY' || e.coin === 'SYSTEM') continue

    const prev = map.get(e.coin) ?? { coin: e.coin, stage: 'evaluating', ts: e.ts }
    switch (e.stage) {
      case 'discovery_evaluating':  map.set(e.coin, { ...prev, stage: 'evaluating',  ts: e.ts }); break
      case 'discovery_researching': map.set(e.coin, { ...prev, stage: 'researching', ts: e.ts }); break
      case 'discovery_researched':  map.set(e.coin, { ...prev, stage: 'researched',  articlesFetched: e.data.articleCount as number, ts: e.ts }); break
      case 'discovery_extracting':  map.set(e.coin, { ...prev, stage: 'extracting',  ts: e.ts }); break
      case 'discovery_extracted':   map.set(e.coin, { ...prev, stage: 'extracted',   articlesExtracted: e.data.articleCount as number, sentiment: e.data.aggregated_sentiment as string, ts: e.ts }); break
      case 'discovery_scored':      map.set(e.coin, { ...prev, stage: 'scored',      score: e.data.score as number, ts: e.ts }); break
      case 'discovery_error':       map.set(e.coin, { ...prev, stage: 'error',       error: e.data.error as string, ts: e.ts }); break
    }
  }

  return { run, coins: Array.from(map.values()) }
}

const STAGE_CHIP: Record<string, { label: string; cls: string; pulse?: boolean }> = {
  evaluating:  { label: 'Eval',       cls: 'text-warn bg-warn/10',              pulse: true  },
  researching: { label: 'Searching',  cls: 'text-blue-400 bg-blue-400/10',      pulse: true  },
  researched:  { label: 'Searched',   cls: 'text-blue-400 bg-blue-400/10'                    },
  extracting:  { label: 'Extracting', cls: 'text-violet-400 bg-violet-400/10',  pulse: true  },
  extracted:   { label: 'Extracted',  cls: 'text-violet-400 bg-violet-400/10'                },
  scored:      { label: 'Scored',     cls: 'text-buy bg-buy/10'                              },
  error:       { label: 'Error',      cls: 'text-sell bg-sell/10'                            },
}

function fmt(ts: string): string {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return ts }
}

function PipelineLog({ entries, active }: { entries: LogEntry[]; active: boolean }) {
  const { run, coins } = derivePipelineState(entries)

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', active ? 'bg-accent animate-pulse' : 'bg-muted')} />
          <span className="text-xs font-semibold text-foreground">Discovery run</span>
        </div>
        {run && <span className="text-[11px] text-muted font-mono">{fmt(run.startTs)}</span>}
      </div>

      {!run ? (
        <p className="text-xs text-muted text-center py-4">
          {active ? 'Waiting for events…' : 'Run the pipeline to see activity.'}
        </p>
      ) : (
        <div className="space-y-2">
          {/* Run meta */}
          {run.candidates != null && (
            <p className="text-[11px] text-muted">
              {run.candidates} candidates · {run.excluded ?? 0} skipped
              {run.topN != null && <span className="ml-1">· top {run.topN}</span>}
            </p>
          )}

          {/* Per-coin cards */}
          {coins.length > 0 && (
            <div className="space-y-1.5">
              {coins.map(c => {
                const chip = STAGE_CHIP[c.stage] ?? { label: c.stage, cls: 'text-muted bg-muted/10' }
                const symbol = c.coin.replace('/USDC', '')
                const pct = c.score != null ? Math.round(c.score * 100) : null
                const scoreColor = pct == null ? '' : pct >= 70 ? 'text-buy' : pct >= 50 ? 'text-warn' : 'text-sell'
                const barColor  = pct == null ? '' : pct >= 70 ? 'bg-buy'   : pct >= 50 ? 'bg-warn'   : 'bg-sell'
                const arts = c.articlesExtracted ?? c.articlesFetched

                return (
                  <div key={c.coin} className="bg-surface-elevated rounded-xl px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold font-mono text-foreground">{symbol}</span>
                      <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-md', chip.cls, chip.pulse && 'animate-pulse')}>
                        {chip.label}
                      </span>
                    </div>

                    {pct != null && (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1 bg-surface rounded-full overflow-hidden">
                          <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${pct}%` }} />
                        </div>
                        <span className={cn('text-[11px] font-semibold tabular-nums w-7 text-right', scoreColor)}>{pct}%</span>
                      </div>
                    )}

                    {c.stage === 'error' && c.error && (
                      <p className="text-[10px] text-sell leading-snug line-clamp-2">{c.error}</p>
                    )}

                    <div className="flex items-center gap-1.5 text-[10px] text-muted">
                      {arts != null && <span>{arts} art.</span>}
                      {c.sentiment && <span className="text-muted/60">· {c.sentiment}</span>}
                      <span className="ml-auto font-mono opacity-60">{fmt(c.ts)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Done summary */}
          {run.done && (
            <div className="pt-1.5 border-t border-border/40 flex items-center gap-1.5 text-[11px] text-muted">
              <span className="text-buy font-bold">✓</span>
              <span>{run.evaluated ?? 0} evaluated · {run.discovered ?? 0} scored · {run.autoAdded ?? 0} auto-added</span>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export default function Discover() {
  const [data, setData] = useState<DiscoverResponse | null>(null)
  const [settings, setSettings] = useState<DiscoverSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected' | 'auto_added'>('all')
  const [logs, setLogs] = useState<LogEntry[]>([])

  // Load recent discovery pipeline events on mount
  useEffect(() => {
    fetch('/api/pipeline-events?stage=discovery_&limit=200')
      .then(r => r.json())
      .then((rows: { id: number; stage: string; coin: string; data: string; created_at: string }[]) => {
        const parsed = rows
          .reverse()
          .map(r => ({
            id: r.id,
            stage: r.stage,
            coin: r.coin,
            data: (() => { try { return JSON.parse(r.data) } catch { return {} } })(),
            ts: r.created_at,
          }))
        setLogs(parsed)
      })
      .catch(() => {})
  }, [])

  // Live WebSocket updates
  useWebSocket(useCallback((event: string, raw: unknown) => {
    if (event === 'coin_discovered') {
      const d = raw as DiscoveryResult
      setData(prev => {
        if (!prev) return prev
        const alreadyExists = prev.discoveries.some(x => x.id === d.id)
        if (alreadyExists) return prev
        return { ...prev, discoveries: [d, ...prev.discoveries] }
      })
      return
    }
    if (event !== 'pipeline_event') return
    const e = raw as { id: number; coin: string; stage: string; data: string; created_at: string }
    if (!e.stage.startsWith('discovery_')) return
    const data = (() => { try { return JSON.parse(e.data) } catch { return {} } })()
    const entry: LogEntry = { id: e.id, stage: e.stage, coin: e.coin, data, ts: e.created_at }
    if (e.stage === 'discovery_started') {
      setLogs([entry])
    } else {
      setLogs(prev => [...prev, entry])
    }
  }, []))

  const load = useCallback(async () => {
    try {
      const [discoverRes, settingsRes] = await Promise.all([
        fetch('/api/discover'),
        fetch('/api/settings'),
      ])
      const discoverData: DiscoverResponse = await discoverRes.json()
      const settingsData = await settingsRes.json()
      setData(discoverData)
      setSettings({
        watchlist: settingsData.watchlist ?? [],
        discover_cron: settingsData.discover_cron ?? '0 6 * * *',
        discover_min_score: settingsData.discover_min_score ?? 0.65,
        discover_top_n: settingsData.discover_top_n ?? 30,
        discover_auto_add: settingsData.discover_auto_add ?? false,
        discover_min_volume_usd: settingsData.discover_min_volume_usd ?? 5000000,
      })
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Poll while pipeline is running
  useEffect(() => {
    if (!data?.running) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [data?.running, load])

  async function handleRunNow() {
    setRunning(true)
    try {
      await fetch('/api/discover/run', { method: 'POST' })
      setTimeout(() => { load(); setRunning(false) }, 1500)
    } catch {
      setRunning(false)
    }
  }

  async function handleApprove(id: number) {
    await fetch(`/api/discover/approve/${id}`, { method: 'POST' })
    load()
  }

  async function handleReject(id: number) {
    await fetch(`/api/discover/reject/${id}`, { method: 'POST' })
    load()
  }

  async function handleDelete(id: number) {
    await fetch(`/api/discover/${id}`, { method: 'DELETE' })
    load()
  }

  async function saveSettings() {
    if (!settings) return
    setSavingSettings(true)
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discover_cron: settings.discover_cron,
          discover_min_score: String(settings.discover_min_score),
          discover_top_n: String(settings.discover_top_n),
          discover_auto_add: String(settings.discover_auto_add),
          discover_min_volume_usd: String(settings.discover_min_volume_usd),
        }),
      })
    } finally {
      setSavingSettings(false)
    }
  }

  const isActive = data?.running || running

  const discoveries = data?.discoveries ?? []
  const filtered = (filter === 'all' ? discoveries : discoveries.filter(d => d.status === filter))
    .slice().sort((a, b) => b.score - a.score)

  const pendingCount = discoveries.filter(d => d.status === 'pending').length
  const approvedCount = discoveries.filter(d => d.status === 'approved').length
  const autoCount = discoveries.filter(d => d.status === 'auto_added').length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-sm">
        Loading...
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Status + Run */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn(
            'flex items-center gap-1.5 text-sm font-medium',
            isActive ? 'text-accent' : 'text-muted',
          )}>
            <span className={cn('w-2 h-2 rounded-full', isActive ? 'bg-accent animate-pulse' : 'bg-muted')} />
            {isActive ? 'Running discovery...' : 'Idle'}
          </div>
          <span className="text-xs text-muted">
            {settings?.discover_cron && `Scheduled: ${settings.discover_cron}`}
          </span>
        </div>
        <Button variant="primary" size="sm" loading={isActive} onClick={handleRunNow}>
          Run discovery now
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="text-center">
          <p className="text-2xl font-bold text-warn">{pendingCount}</p>
          <p className="text-xs text-muted mt-1">Pending review</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold text-buy">{approvedCount + autoCount}</p>
          <p className="text-xs text-muted mt-1">Added to watchlist</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold text-foreground">{discoveries.length}</p>
          <p className="text-xs text-muted mt-1">Total discovered</p>
        </Card>
      </div>

      <div className="grid grid-cols-[1fr_280px] gap-6 items-start">
        {/* Results */}
        <div className="space-y-4">
          {/* Filter tabs */}
          <div className="flex gap-1.5">
            {(['all', 'pending', 'approved', 'auto_added', 'rejected'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                  filter === f
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                )}
              >
                {f === 'all' ? 'All' : f === 'auto_added' ? 'Auto-added' : f.charAt(0).toUpperCase() + f.slice(1)}
                {f === 'pending' && pendingCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-warn/15 text-warn text-xs">{pendingCount}</span>
                )}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <Card>
              <div className="text-center py-8">
                <p className="text-muted text-sm">
                  {discoveries.length === 0
                    ? 'No discoveries yet. Run the pipeline to find new coins.'
                    : 'No results for this filter.'}
                </p>
                {discoveries.length === 0 && (
                  <Button variant="primary" size="sm" className="mt-4" loading={isActive} onClick={handleRunNow}>
                    Run now
                  </Button>
                )}
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filtered.map(d => (
                <DiscoveryCard
                  key={d.id}
                  discovery={d}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>

        {/* Settings + Activity panel */}
        <div className="space-y-4 sticky top-4">
          {/* Watchlist */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-foreground">Current Watchlist</span>
              {settings && (
                <span className="text-xs text-muted">{settings.watchlist.length} coin{settings.watchlist.length !== 1 ? 's' : ''}</span>
              )}
            </div>
            {!settings || settings.watchlist.length === 0 ? (
              <p className="text-xs text-muted">No coins in watchlist — discovery will not skip any.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {settings.watchlist.map(coin => (
                  <span
                    key={coin}
                    className="px-2 py-0.5 rounded-md bg-accent/10 text-accent text-xs font-medium font-mono"
                  >
                    {coin.replace('/USDC', '')}
                  </span>
                ))}
              </div>
            )}
          </Card>

          <PipelineLog entries={logs} active={isActive} />
          <Card>
            <CardHeader title="Discovery settings" />
            {settings && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-muted block mb-1.5">Cron schedule</label>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {CRON_PRESETS.map(p => (
                      <button
                        key={p.value}
                        onClick={() => setSettings(s => s ? { ...s, discover_cron: p.value } : s)}
                        className={cn(
                          'px-2 py-1 text-xs rounded-lg border transition-all',
                          settings.discover_cron === p.value
                            ? 'border-accent text-accent bg-accent/10'
                            : 'border-border text-muted hover:text-foreground',
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={settings.discover_cron}
                    onChange={e => setSettings(s => s ? { ...s, discover_cron: e.target.value } : s)}
                    placeholder="0 6 * * *"
                    className="font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="text-xs text-muted block mb-1.5">
                    Evaluate top N pairs
                  </label>
                  <Input
                    type="number"
                    min={5}
                    max={100}
                    value={settings.discover_top_n}
                    onChange={e => setSettings(s => s ? { ...s, discover_top_n: parseInt(e.target.value, 10) || 30 } : s)}
                  />
                </div>

                <div>
                  <label className="text-xs text-muted block mb-1.5">
                    Min volume (USD 24h)
                  </label>
                  <Input
                    type="number"
                    min={100000}
                    step={500000}
                    value={settings.discover_min_volume_usd}
                    onChange={e => setSettings(s => s ? { ...s, discover_min_volume_usd: parseFloat(e.target.value) || 5000000 } : s)}
                  />
                </div>

                <div>
                  <label className="text-xs text-muted block mb-1.5">
                    Min score to auto-add ({Math.round(settings.discover_min_score * 100)}%)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.discover_min_score}
                    onChange={e => setSettings(s => s ? { ...s, discover_min_score: parseFloat(e.target.value) } : s)}
                    className="w-full accent-accent"
                  />
                  <div className="flex justify-between text-xs text-muted mt-0.5">
                    <span>0%</span><span>100%</span>
                  </div>
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Auto-add to watchlist</p>
                    <p className="text-xs text-muted">Coins above min score are added automatically</p>
                  </div>
                  <button
                    onClick={() => setSettings(s => s ? { ...s, discover_auto_add: !s.discover_auto_add } : s)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 transition-colors',
                      settings.discover_auto_add ? 'bg-accent border-accent' : 'bg-surface-elevated border-border',
                    )}
                  >
                    <span className={cn(
                      'pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform mt-[1px]',
                      settings.discover_auto_add ? 'translate-x-4' : 'translate-x-0.5',
                    )} />
                  </button>
                </div>

                <Button variant="primary" size="sm" className="w-full" loading={savingSettings} onClick={saveSettings}>
                  Save settings
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
