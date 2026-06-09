import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar,
} from 'recharts'
import { useWebSocket } from '../hooks/useWebSocket'
import { Card, CardHeader } from '../components/ui/Card'
import { Stat } from '../components/ui/Stat'
import { LLMCall } from '../types'
import { cn } from '../lib/utils'

const MODULE_COLORS: Record<string, string> = {
  'extractor':           '#8b5cf6',
  'extractor-challenge': '#c4b5fd',
  'analyst':             'rgb(var(--accent-rgb))',
  'monitor':             '#f59e0b',
  'discoverer':          '#22c55e',
}

const MODULE_LABELS: Record<string, string> = {
  'extractor':           'Extractor',
  'extractor-challenge': 'Ext. Challenge',
  'analyst':             'Analyst',
  'monitor':             'Monitor',
  'discoverer':          'Discoverer',
}

type TimeRange = 'all' | '1h' | '3h' | '10h' | '2d'

const TIME_RANGES: { key: TimeRange; label: string; ms: number | null }[] = [
  { key: 'all',  label: 'All',      ms: null },
  { key: '1h',   label: 'Last 1h',  ms: 1 * 60 * 60 * 1000 },
  { key: '3h',   label: 'Last 3h',  ms: 3 * 60 * 60 * 1000 },
  { key: '10h',  label: 'Last 10h', ms: 10 * 60 * 60 * 1000 },
  { key: '2d',   label: 'Last 2d',  ms: 2 * 24 * 60 * 60 * 1000 },
]

const FALLBACK_COLORS = [
  'rgb(var(--accent-rgb))', '#8b5cf6', '#f59e0b', '#22c55e',
  '#ec4899', '#3b82f6', '#14b8a6', '#f97316',
]

function modColor(mod: string, idx: number): string {
  return MODULE_COLORS[mod] ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length]
}

function modLabel(mod: string): string {
  return MODULE_LABELS[mod] ?? mod
}

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--surface-elevated)',
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  fontSize: '12px',
  color: 'var(--foreground)',
  padding: '8px 12px',
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

function hostFromUrl(url: string): string {
  if (!url) return 'default'
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return url
  }
}

function endpointLabel(url: string, mod: string): string {
  if (!url) return `default (${mod})`
  return hostFromUrl(url)
}

interface ScatterPoint {
  x: number
  y: number
  coin: string | null
}

interface ModuleStat {
  module: string
  label: string
  color: string
  count: number
  errors: number
  avg_duration: number
  avg_prompt: number
  avg_completion: number
  avg_thinking: number
  total_tokens: number
  total_thinking: number
}

interface LLMSnapshot {
  module: string
  model: string
  base_url: string
  call_count: number
  error_count: number
  total_duration_ms: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_thinking_tokens: number
}

function TimingTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ScatterPoint }> }) {
  if (!active || !payload?.length) return null
  const pt = payload[0].payload
  return (
    <div style={TOOLTIP_STYLE}>
      <p className="text-[11px] text-muted">{new Date(pt.x).toLocaleTimeString()}</p>
      <p className="font-semibold text-foreground mt-0.5">{fmtMs(pt.y)}</p>
      {pt.coin && <p className="text-xs text-muted mt-0.5">{pt.coin}</p>}
    </div>
  )
}

function EmptyChart() {
  return (
    <div className="flex items-center justify-center h-56 text-sm text-muted">
      No LLM calls recorded yet.
    </div>
  )
}

export default function LLMStats() {
  const [calls, setCalls] = useState<LLMCall[]>([])
  const [snapshots, setSnapshots] = useState<LLMSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState<TimeRange>('all')

  useEffect(() => {
    Promise.all([
      fetch('/api/llm-calls?limit=500').then(r => r.json()).catch(() => [] as LLMCall[]),
      fetch('/api/llm-stats-snapshots').then(r => r.json()).catch(() => [] as LLMSnapshot[]),
    ]).then(([liveCalls, snaps]: [LLMCall[], LLMSnapshot[]]) => {
      setCalls(liveCalls)
      setSnapshots(snaps)
      setLoading(false)
    })
  }, [])

  useWebSocket(useCallback((event: string, data: unknown) => {
    if (event === 'llm_call') {
      const call = data as LLMCall
      setCalls(prev => {
        if (call.temp_id) {
          const idx = prev.findIndex(c => c.temp_id === call.temp_id)
          if (idx !== -1) {
            const next = [...prev]
            next[idx] = call
            return next
          }
        }
        return [call, ...prev].slice(0, 500)
      })
    }
  }, []))

  const doneCalls = useMemo(() => calls.filter(c => c.status !== 'running'), [calls])

  const hasHistorical = snapshots.length > 0
  const historicalCallCount = useMemo(() => snapshots.reduce((s, r) => s + r.call_count, 0), [snapshots])

  type AggBucket = { count: number; errors: number; totalDuration: number; totalPrompt: number; totalCompletion: number; totalThinking: number }

  const { moduleStats, sortedModules, totalCalls, avgDuration, totalTokens, totalThinking, errorCount, endpointStats, sortedEndpoints, modelStats, sortedModels } = useMemo(() => {
    const empty = { moduleStats: [] as ModuleStat[], sortedModules: [] as string[], totalCalls: 0, avgDuration: 0, totalTokens: 0, totalThinking: 0, errorCount: 0, endpointStats: [] as ModuleStat[], sortedEndpoints: [] as string[], modelStats: [] as ModuleStat[], sortedModels: [] as string[] }
    if (!doneCalls.length && !snapshots.length) return empty

    const modMap = new Map<string, AggBucket>()
    const epMap  = new Map<string, AggBucket>()
    const mdlMap = new Map<string, AggBucket>()

    function ensureBucket(map: Map<string, AggBucket>, key: string): AggBucket {
      let b = map.get(key)
      if (!b) { b = { count: 0, errors: 0, totalDuration: 0, totalPrompt: 0, totalCompletion: 0, totalThinking: 0 }; map.set(key, b) }
      return b
    }

    // Fold historical snapshots first
    for (const snap of snapshots) {
      const mb = ensureBucket(modMap, snap.module)
      mb.count += snap.call_count; mb.errors += snap.error_count
      mb.totalDuration += snap.total_duration_ms; mb.totalPrompt += snap.total_prompt_tokens
      mb.totalCompletion += snap.total_completion_tokens; mb.totalThinking += snap.total_thinking_tokens

      const epKey = snap.base_url || `module:${snap.module}`
      const eb = ensureBucket(epMap, epKey)
      eb.count += snap.call_count; eb.errors += snap.error_count
      eb.totalDuration += snap.total_duration_ms; eb.totalPrompt += snap.total_prompt_tokens
      eb.totalCompletion += snap.total_completion_tokens; eb.totalThinking += snap.total_thinking_tokens

      const mlb = ensureBucket(mdlMap, snap.model || snap.module)
      mlb.count += snap.call_count; mlb.errors += snap.error_count
      mlb.totalDuration += snap.total_duration_ms; mlb.totalPrompt += snap.total_prompt_tokens
      mlb.totalCompletion += snap.total_completion_tokens; mlb.totalThinking += snap.total_thinking_tokens
    }

    // Fold live calls
    for (const call of doneCalls) {
      const mb = ensureBucket(modMap, call.module)
      mb.count++; if (call.error) mb.errors++
      mb.totalDuration += call.duration_ms; mb.totalPrompt += call.prompt_tokens ?? 0
      mb.totalCompletion += call.completion_tokens ?? 0; mb.totalThinking += call.thinking_tokens ?? 0

      const epKey = call.base_url || `module:${call.module}`
      const eb = ensureBucket(epMap, epKey)
      eb.count++; if (call.error) eb.errors++
      eb.totalDuration += call.duration_ms; eb.totalPrompt += call.prompt_tokens ?? 0
      eb.totalCompletion += call.completion_tokens ?? 0; eb.totalThinking += call.thinking_tokens ?? 0

      const mlb = ensureBucket(mdlMap, call.model)
      mlb.count++; if (call.error) mlb.errors++
      mlb.totalDuration += call.duration_ms; mlb.totalPrompt += call.prompt_tokens ?? 0
      mlb.totalCompletion += call.completion_tokens ?? 0; mlb.totalThinking += call.thinking_tokens ?? 0
    }

    const bucketToStat = (key: string, b: AggBucket, label: string, color: string): ModuleStat => ({
      module: key, label, color,
      count: b.count, errors: b.errors,
      avg_duration: b.count > 0 ? b.totalDuration / b.count : 0,
      avg_prompt: b.count > 0 ? b.totalPrompt / b.count : 0,
      avg_completion: b.count > 0 ? b.totalCompletion / b.count : 0,
      avg_thinking: b.count > 0 ? b.totalThinking / b.count : 0,
      total_tokens: b.totalPrompt + b.totalCompletion,
      total_thinking: b.totalThinking,
    })

    const sortedModules = [...modMap.keys()].sort()
    const sortedEndpoints = [...epMap.keys()].sort()
    const sortedModels = [...mdlMap.keys()].sort()

    const moduleStats = sortedModules.map((mod, i) => bucketToStat(mod, modMap.get(mod)!, modLabel(mod), modColor(mod, i)))
    const endpointStats = sortedEndpoints.map((key, i) => {
      const isModuleFallback = key.startsWith('module:')
      const url = isModuleFallback ? '' : key
      const moduleName = isModuleFallback ? key.slice(7) : ''
      return bucketToStat(key, epMap.get(key)!, endpointLabel(url, moduleName), FALLBACK_COLORS[i % FALLBACK_COLORS.length])
    })
    const modelStats = sortedModels.map((model, i) => bucketToStat(model, mdlMap.get(model)!, model, FALLBACK_COLORS[i % FALLBACK_COLORS.length]))

    const totalCalls = moduleStats.reduce((s, m) => s + m.count, 0)
    const totalDurationAll = moduleStats.reduce((s, m) => s + m.avg_duration * m.count, 0)

    return {
      moduleStats, sortedModules,
      totalCalls,
      avgDuration: totalCalls > 0 ? totalDurationAll / totalCalls : 0,
      totalTokens: moduleStats.reduce((s, m) => s + m.total_tokens, 0),
      totalThinking: moduleStats.reduce((s, m) => s + m.total_thinking, 0),
      errorCount: moduleStats.reduce((s, m) => s + m.errors, 0),
      endpointStats, sortedEndpoints,
      modelStats, sortedModels,
    }
  }, [doneCalls, snapshots])

  const scatterByModule = useMemo(() => {
    const out = new Map<string, ScatterPoint[]>()
    for (const call of doneCalls) {
      const ts = new Date(call.created_at.includes('T') ? call.created_at : call.created_at + 'Z').getTime()
      const arr = out.get(call.module) ?? []
      arr.push({ x: ts, y: call.duration_ms, coin: call.coin })
      out.set(call.module, arr)
    }
    return out
  }, [calls])

  const filteredScatterByModule = useMemo(() => {
    const range = TIME_RANGES.find(r => r.key === timeRange)
    if (!range?.ms) return scatterByModule
    const cutoff = Date.now() - range.ms
    const out = new Map<string, ScatterPoint[]>()
    for (const [mod, points] of scatterByModule) {
      const filtered = points.filter(p => p.x >= cutoff)
      if (filtered.length) out.set(mod, filtered)
    }
    return out
  }, [scatterByModule, timeRange])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const isEmpty = totalCalls === 0
  const errorRate = totalCalls ? (errorCount / totalCalls) * 100 : 0

  const weightedAvgPrompt = totalCalls > 0
    ? Math.round(moduleStats.reduce((a, s) => a + s.avg_prompt * s.count, 0) / totalCalls)
    : 0
  const weightedAvgCompletion = totalCalls > 0
    ? Math.round(moduleStats.reduce((a, s) => a + s.avg_completion * s.count, 0) / totalCalls)
    : 0
  const weightedAvgThinking = totalCalls > 0
    ? Math.round(moduleStats.reduce((a, s) => a + s.avg_thinking * s.count, 0) / totalCalls)
    : 0
  const totalThinkPct = totalTokens > 0 ? (totalThinking / totalTokens) * 100 : 0

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Summary stats */}
      {hasHistorical && (
        <div className="flex items-center gap-2 text-xs text-muted bg-surface-elevated border border-border rounded-xl px-4 py-2.5">
          <svg className="w-4 h-4 text-accent shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
          </svg>
          <span>
            Includes <span className="font-semibold text-foreground">{historicalCallCount.toLocaleString()}</span> archived calls — raw records were deleted by the retention policy, but aggregate stats are preserved.
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="Total Calls"
          value={totalCalls.toLocaleString()}
          sub={`${sortedModules.length} module type${sortedModules.length !== 1 ? 's' : ''}`}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
          }
        />
        <Stat
          label="Avg Response"
          value={isEmpty ? '—' : fmtMs(avgDuration)}
          sub="per LLM call"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <Stat
          label="Total Tokens"
          value={isEmpty ? '—' : fmtTokens(totalTokens)}
          sub={totalThinking > 0 ? `${fmtTokens(totalThinking)} thinking` : 'prompt + completion'}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
          }
        />
        <Stat
          label="Error Rate"
          value={isEmpty ? '—' : `${errorRate.toFixed(1)}%`}
          sub={`${errorCount} failed call${errorCount !== 1 ? 's' : ''}`}
          trend={errorRate > 10 ? 'down' : errorRate > 0 ? 'neutral' : isEmpty ? 'neutral' : 'up'}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          }
        />
      </div>

      {/* Response time scatter chart */}
      <Card noPad>
        <div className="px-5 pt-5 pb-2 flex items-start justify-between gap-4">
          <CardHeader
            title="Response Time by Module"
            subtitle="Duration per LLM call over time — each point is one call"
          />
          <div className="flex items-center gap-1 shrink-0 mt-0.5">
            {TIME_RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setTimeRange(r.key)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded-md font-medium transition-colors whitespace-nowrap',
                  timeRange === r.key
                    ? 'bg-accent/20 text-accent'
                    : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {isEmpty ? <EmptyChart /> : (
          <div className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={320}>
              <ScatterChart margin={{ top: 10, right: 24, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={['auto', 'auto']}
                  scale="time"
                  tickFormatter={fmtTime}
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  name="Time"
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  tickFormatter={v => fmtMs(v as number)}
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  name="Duration"
                />
                <Tooltip content={<TimingTooltip />} cursor={{ strokeDasharray: '3 3', stroke: 'var(--border-color)' }} />
                <Legend
                  wrapperStyle={{ fontSize: '12px', color: 'var(--muted-fg)', paddingTop: '8px' }}
                  formatter={v => modLabel(v as string)}
                />
                {sortedModules.map((mod, i) => {
                  const data = filteredScatterByModule.get(mod)
                  if (!data?.length) return null
                  return (
                    <Scatter
                      key={mod}
                      name={mod}
                      data={data}
                      fill={modColor(mod, i)}
                      opacity={0.75}
                    />
                  )
                })}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Token usage bar chart */}
      <Card noPad>
        <div className="px-5 pt-5 pb-2">
          <CardHeader
            title="Token Size by Module"
            subtitle="Average prompt and completion tokens per call"
          />
        </div>
        {isEmpty ? <EmptyChart /> : (
          <div className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={moduleStats.map(s => ({
                  name: s.label,
                  Prompt: Math.round(s.avg_prompt),
                  Completion: Math.round(s.avg_completion),
                  ...(s.avg_thinking > 0 ? { Thinking: Math.round(s.avg_thinking) } : {}),
                }))}
                margin={{ top: 10, right: 24, bottom: 10, left: 0 }}
                barGap={4}
                barCategoryGap="30%"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis
                  dataKey="name"
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  tickFormatter={v => v >= 1000 ? `${Math.round((v as number) / 1000)}K` : `${v}`}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: 'var(--surface-elevated)', opacity: 0.4 }}
                  formatter={(v: number, name: string) => [`${v.toLocaleString()} tokens`, name]}
                />
                <Legend wrapperStyle={{ fontSize: '12px', color: 'var(--muted-fg)', paddingTop: '8px' }} />
                <Bar dataKey="Prompt" fill="rgb(var(--accent-rgb))" radius={[4, 4, 0, 0]} maxBarSize={52} />
                <Bar dataKey="Completion" fill="#8b5cf6" radius={[4, 4, 0, 0]} maxBarSize={52} />
                {moduleStats.some(s => s.avg_thinking > 0) && (
                  <Bar dataKey="Thinking" fill="#a78bfa" radius={[4, 4, 0, 0]} maxBarSize={52} />
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Module breakdown table */}
      <Card>
        <CardHeader
          title="Module Breakdown"
          subtitle="Classic stats per LLM call type"
        />
        {isEmpty ? (
          <p className="text-sm text-muted text-center py-8">No LLM calls recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['Module', 'Calls', 'Errors', 'Err %', 'Avg Time', 'Avg Prompt', 'Avg Completion', 'Avg Thinking', 'Think %', 'Total Tokens'].map(h => (
                    <th
                      key={h}
                      className={cn(
                        'pb-3 text-xs font-medium text-muted uppercase tracking-wider whitespace-nowrap',
                        h === 'Module' ? 'text-left pr-4' : 'text-right pl-4',
                        h === 'Avg Thinking' || h === 'Think %' ? 'text-violet-400/70' : '',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {moduleStats.map(s => {
                  const errPct = s.count > 0 ? (s.errors / s.count) * 100 : 0
                  const thinkPct = (s.avg_prompt + s.avg_completion) > 0 ? (s.avg_thinking / (s.avg_prompt + s.avg_completion)) * 100 : 0
                  return (
                    <tr key={s.module} className="hover:bg-surface-elevated/30 transition-colors">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                          <div className="min-w-0">
                            <span className="font-medium text-foreground">{s.label}</span>
                            {s.module !== s.label.toLowerCase().replace(/\s/g, '-') && (
                              <span className="ml-1.5 text-[11px] text-muted/50 font-mono">{s.module}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground tabular-nums">{s.count.toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono tabular-nums">
                        <span className={s.errors > 0 ? 'text-sell' : 'text-muted'}>{s.errors}</span>
                      </td>
                      <td className="py-3 text-right pl-4">
                        <span className={cn(
                          'inline-block text-xs px-1.5 py-0.5 rounded-md font-mono tabular-nums',
                          errPct > 10 ? 'bg-sell/10 text-sell' :
                          errPct > 0  ? 'bg-warn/10 text-warn' :
                                        'bg-buy/10 text-buy',
                        )}>
                          {errPct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground tabular-nums">{fmtMs(s.avg_duration)}</td>
                      <td className="py-3 text-right pl-4 font-mono text-muted tabular-nums">{Math.round(s.avg_prompt).toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono text-muted tabular-nums">{Math.round(s.avg_completion).toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono text-violet-400 tabular-nums">
                        {s.avg_thinking > 0 ? Math.round(s.avg_thinking).toLocaleString() : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-3 text-right pl-4 tabular-nums">
                        {thinkPct > 0 ? (
                          <span className="inline-block text-xs px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-400">
                            {thinkPct.toFixed(0)}%
                          </span>
                        ) : <span className="text-muted text-xs">—</span>}
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground font-medium tabular-nums">{s.total_tokens.toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className="pt-3 pr-4 font-semibold text-foreground">Total</td>
                  <td className="pt-3 text-right pl-4 font-mono font-semibold text-foreground tabular-nums">{totalCalls.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono tabular-nums">
                    <span className={errorCount > 0 ? 'text-sell' : 'text-muted'}>{errorCount}</span>
                  </td>
                  <td className="pt-3 text-right pl-4">
                    <span className={cn(
                      'inline-block text-xs px-1.5 py-0.5 rounded-md font-mono tabular-nums',
                      errorRate > 10 ? 'bg-sell/10 text-sell' :
                      errorRate > 0  ? 'bg-warn/10 text-warn' :
                                       'bg-buy/10 text-buy',
                    )}>
                      {errorRate.toFixed(1)}%
                    </span>
                  </td>
                  <td className="pt-3 text-right pl-4 font-mono text-foreground tabular-nums">{fmtMs(avgDuration)}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-muted tabular-nums">{weightedAvgPrompt.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-muted tabular-nums">{weightedAvgCompletion.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-violet-400 font-semibold tabular-nums">
                    {weightedAvgThinking > 0 ? weightedAvgThinking.toLocaleString() : <span className="text-muted">—</span>}
                  </td>
                  <td className="pt-3 text-right pl-4 tabular-nums">
                    {totalThinkPct > 0 ? (
                      <span className="inline-block text-xs px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-400">
                        {totalThinkPct.toFixed(0)}%
                      </span>
                    ) : <span className="text-muted text-xs">—</span>}
                  </td>
                  <td className="pt-3 text-right pl-4 font-mono font-semibold text-foreground tabular-nums">{totalTokens.toLocaleString()}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Endpoint breakdown table */}
      <Card>
        <CardHeader
          title="Endpoint Breakdown"
          subtitle="Stats per LLM endpoint URL"
        />
        {isEmpty ? (
          <p className="text-sm text-muted text-center py-8">No LLM calls recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['Endpoint', 'Calls', 'Errors', 'Err %', 'Avg Time', 'Avg Prompt', 'Avg Completion', 'Avg Thinking', 'Think %', 'Total Tokens'].map(h => (
                    <th
                      key={h}
                      className={cn(
                        'pb-3 text-xs font-medium text-muted uppercase tracking-wider whitespace-nowrap',
                        h === 'Endpoint' ? 'text-left pr-4' : 'text-right pl-4',
                        h === 'Avg Thinking' || h === 'Think %' ? 'text-violet-400/70' : '',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {endpointStats.map(s => {
                  const errPct = s.count > 0 ? (s.errors / s.count) * 100 : 0
                  const thinkPct = (s.avg_prompt + s.avg_completion) > 0 ? (s.avg_thinking / (s.avg_prompt + s.avg_completion)) * 100 : 0
                  return (
                    <tr key={s.module} className="hover:bg-surface-elevated/30 transition-colors">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                          <span className="font-medium text-foreground truncate max-w-[320px]" title={s.module.startsWith('module:') ? s.label : s.module}>{s.label}</span>
                        </div>
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground tabular-nums">{s.count.toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono tabular-nums">
                        <span className={s.errors > 0 ? 'text-sell' : 'text-muted'}>{s.errors}</span>
                      </td>
                      <td className="py-3 text-right pl-4">
                        <span className={cn(
                          'inline-block text-xs px-1.5 py-0.5 rounded-md font-mono tabular-nums',
                          errPct > 10 ? 'bg-sell/10 text-sell' :
                          errPct > 0  ? 'bg-warn/10 text-warn' :
                                        'bg-buy/10 text-buy',
                        )}>
                          {errPct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground tabular-nums">{fmtMs(s.avg_duration)}</td>
                      <td className="py-3 text-right pl-4 font-mono text-muted tabular-nums">{Math.round(s.avg_prompt).toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono text-muted tabular-nums">{Math.round(s.avg_completion).toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono text-violet-400 tabular-nums">
                        {s.avg_thinking > 0 ? Math.round(s.avg_thinking).toLocaleString() : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-3 text-right pl-4 tabular-nums">
                        {thinkPct > 0 ? (
                          <span className="inline-block text-xs px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-400">
                            {thinkPct.toFixed(0)}%
                          </span>
                        ) : <span className="text-muted text-xs">—</span>}
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground font-medium tabular-nums">{s.total_tokens.toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className="pt-3 pr-4 font-semibold text-foreground">Total</td>
                  <td className="pt-3 text-right pl-4 font-mono font-semibold text-foreground tabular-nums">{totalCalls.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono tabular-nums">
                    <span className={errorCount > 0 ? 'text-sell' : 'text-muted'}>{errorCount}</span>
                  </td>
                  <td className="pt-3 text-right pl-4">
                    <span className={cn(
                      'inline-block text-xs px-1.5 py-0.5 rounded-md font-mono tabular-nums',
                      errorRate > 10 ? 'bg-sell/10 text-sell' :
                      errorRate > 0  ? 'bg-warn/10 text-warn' :
                                       'bg-buy/10 text-buy',
                    )}>
                      {errorRate.toFixed(1)}%
                    </span>
                  </td>
                  <td className="pt-3 text-right pl-4 font-mono text-foreground tabular-nums">{fmtMs(avgDuration)}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-muted tabular-nums">{weightedAvgPrompt.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-muted tabular-nums">{weightedAvgCompletion.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-violet-400 font-semibold tabular-nums">
                    {weightedAvgThinking > 0 ? weightedAvgThinking.toLocaleString() : <span className="text-muted">—</span>}
                  </td>
                  <td className="pt-3 text-right pl-4 tabular-nums">
                    {totalThinkPct > 0 ? (
                      <span className="inline-block text-xs px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-400">
                        {totalThinkPct.toFixed(0)}%
                      </span>
                    ) : <span className="text-muted text-xs">—</span>}
                  </td>
                  <td className="pt-3 text-right pl-4 font-mono font-semibold text-foreground tabular-nums">{totalTokens.toLocaleString()}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Model breakdown table */}
      <Card>
        <CardHeader
          title="Model Breakdown"
          subtitle="Stats per LLM model"
        />
        {isEmpty ? (
          <p className="text-sm text-muted text-center py-8">No LLM calls recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['Model', 'Calls', 'Errors', 'Err %', 'Avg Time', 'Avg Prompt', 'Avg Completion', 'Avg Thinking', 'Think %', 'Total Tokens'].map(h => (
                    <th
                      key={h}
                      className={cn(
                        'pb-3 text-xs font-medium text-muted uppercase tracking-wider whitespace-nowrap',
                        h === 'Model' ? 'text-left pr-4' : 'text-right pl-4',
                        h === 'Avg Thinking' || h === 'Think %' ? 'text-violet-400/70' : '',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {modelStats.map(s => {
                  const errPct = s.count > 0 ? (s.errors / s.count) * 100 : 0
                  const thinkPct = (s.avg_prompt + s.avg_completion) > 0 ? (s.avg_thinking / (s.avg_prompt + s.avg_completion)) * 100 : 0
                  return (
                    <tr key={s.module} className="hover:bg-surface-elevated/30 transition-colors">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                          <span className="font-medium text-foreground">{s.label}</span>
                        </div>
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground tabular-nums">{s.count.toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono tabular-nums">
                        <span className={s.errors > 0 ? 'text-sell' : 'text-muted'}>{s.errors}</span>
                      </td>
                      <td className="py-3 text-right pl-4">
                        <span className={cn(
                          'inline-block text-xs px-1.5 py-0.5 rounded-md font-mono tabular-nums',
                          errPct > 10 ? 'bg-sell/10 text-sell' :
                          errPct > 0  ? 'bg-warn/10 text-warn' :
                                        'bg-buy/10 text-buy',
                        )}>
                          {errPct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground tabular-nums">{fmtMs(s.avg_duration)}</td>
                      <td className="py-3 text-right pl-4 font-mono text-muted tabular-nums">{Math.round(s.avg_prompt).toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono text-muted tabular-nums">{Math.round(s.avg_completion).toLocaleString()}</td>
                      <td className="py-3 text-right pl-4 font-mono text-violet-400 tabular-nums">
                        {s.avg_thinking > 0 ? Math.round(s.avg_thinking).toLocaleString() : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-3 text-right pl-4 tabular-nums">
                        {thinkPct > 0 ? (
                          <span className="inline-block text-xs px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-400">
                            {thinkPct.toFixed(0)}%
                          </span>
                        ) : <span className="text-muted text-xs">—</span>}
                      </td>
                      <td className="py-3 text-right pl-4 font-mono text-foreground font-medium tabular-nums">{s.total_tokens.toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className="pt-3 pr-4 font-semibold text-foreground">Total</td>
                  <td className="pt-3 text-right pl-4 font-mono font-semibold text-foreground tabular-nums">{totalCalls.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono tabular-nums">
                    <span className={errorCount > 0 ? 'text-sell' : 'text-muted'}>{errorCount}</span>
                  </td>
                  <td className="pt-3 text-right pl-4">
                    <span className={cn(
                      'inline-block text-xs px-1.5 py-0.5 rounded-md font-mono tabular-nums',
                      errorRate > 10 ? 'bg-sell/10 text-sell' :
                      errorRate > 0  ? 'bg-warn/10 text-warn' :
                                       'bg-buy/10 text-buy',
                    )}>
                      {errorRate.toFixed(1)}%
                    </span>
                  </td>
                  <td className="pt-3 text-right pl-4 font-mono text-foreground tabular-nums">{fmtMs(avgDuration)}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-muted tabular-nums">{weightedAvgPrompt.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-muted tabular-nums">{weightedAvgCompletion.toLocaleString()}</td>
                  <td className="pt-3 text-right pl-4 font-mono text-violet-400 font-semibold tabular-nums">
                    {weightedAvgThinking > 0 ? weightedAvgThinking.toLocaleString() : <span className="text-muted">—</span>}
                  </td>
                  <td className="pt-3 text-right pl-4 tabular-nums">
                    {totalThinkPct > 0 ? (
                      <span className="inline-block text-xs px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-400">
                        {totalThinkPct.toFixed(0)}%
                      </span>
                    ) : <span className="text-muted text-xs">—</span>}
                  </td>
                  <td className="pt-3 text-right pl-4 font-mono font-semibold text-foreground tabular-nums">{totalTokens.toLocaleString()}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
