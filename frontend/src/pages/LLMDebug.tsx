import { useEffect, useState, useCallback, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { LLMCall } from '../types'
import { cn } from '../lib/utils'

// ── Module metadata ──────────────────────────────────────────────────────────

const MODULE_META: Record<string, { label: string; color: string; bg: string }> = {
  extractor:  { label: 'Extractor',  color: 'text-violet-400', bg: 'bg-violet-500/15' },
  analyst:    { label: 'Analyst',    color: 'text-accent',     bg: 'bg-accent/15'     },
  discoverer: { label: 'Discoverer', color: 'text-buy',        bg: 'bg-buy/15'        },
  monitor:    { label: 'Monitor',    color: 'text-warn',       bg: 'bg-warn/15'       },
}

function moduleMeta(mod: string) {
  return MODULE_META[mod] ?? { label: mod, color: 'text-muted', bg: 'bg-surface-elevated' }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  const d = new Date(iso.includes('T') ? iso : iso + 'Z')
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(prompt: number | null, completion: number | null): string {
  const total = (prompt ?? 0) + (completion ?? 0)
  if (total === 0) return '—'
  return `${total.toLocaleString()} tk`
}

function tryFormatJSON(text: string): { formatted: string; isJSON: boolean } {
  if (!text) return { formatted: text, isJSON: false }
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { formatted: text, isJSON: false }
  try {
    const parsed = JSON.parse(trimmed)
    return { formatted: JSON.stringify(parsed, null, 2), isJSON: true }
  } catch {
    return { formatted: text, isJSON: false }
  }
}

// ── Module badge ─────────────────────────────────────────────────────────────

function ModuleBadge({ module }: { module: string }) {
  const m = moduleMeta(module)
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide', m.color, m.bg)}>
      {m.label}
    </span>
  )
}

// ── List item ────────────────────────────────────────────────────────────────

function CallListItem({ call, selected, onClick }: { call: LLMCall; selected: boolean; onClick: () => void }) {
  const isRunning = call.status === 'running'
  const hasError = !!call.error
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-xl transition-colors duration-100 space-y-1.5',
        selected ? 'bg-accent/10 text-accent ring-1 ring-accent/20' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <ModuleBadge module={call.module} />
        {isRunning && (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-warn bg-warn/10 px-1.5 py-0.5 rounded">
            <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
            RUN
          </span>
        )}
        {!isRunning && hasError && (
          <span className="text-[10px] font-semibold text-sell bg-sell/10 px-1.5 py-0.5 rounded">ERR</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-xs flex-wrap">
        {call.coin && (
          <span className={cn('font-mono font-medium', selected ? 'text-accent' : 'text-foreground')}>
            {call.coin.replace('/USDC', '')}
          </span>
        )}
        <span className="text-muted/60 font-mono">{formatTime(call.created_at)}</span>
      </div>
      {isRunning ? (
        <div className="flex items-center gap-1.5 text-[11px] text-warn/70">
          <span className="w-3 h-3 border border-warn border-t-transparent rounded-full animate-spin" />
          <span>waiting…</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[11px] text-muted/70">
          <span>{formatDuration(call.duration_ms)}</span>
          <span>·</span>
          <span>{formatTokens(call.prompt_tokens, call.completion_tokens)}</span>
        </div>
      )}
    </button>
  )
}

// ── Chat bubble ──────────────────────────────────────────────────────────────

function ChatBubble({
  role,
  content,
  label,
  defaultCollapsed = false,
  isError = false,
  isThinking = false,
}: {
  role: 'system' | 'user' | 'assistant'
  content: string
  label: string
  defaultCollapsed?: boolean
  isError?: boolean
  isThinking?: boolean
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const { formatted, isJSON } = tryFormatJSON(content)
  const isLong = content.length > 400

  const borderColor =
    isError ? 'border-sell/40' :
    isThinking ? 'border-violet-500/30' :
    role === 'system' ? 'border-border' :
    role === 'user' ? 'border-accent/30' :
    'border-buy/30'

  const labelColor =
    isError ? 'text-sell' :
    isThinking ? 'text-violet-400' :
    role === 'system' ? 'text-muted' :
    role === 'user' ? 'text-accent' :
    'text-buy'

  const displayContent = collapsed ? content.slice(0, 300) + (content.length > 300 ? '…' : '') : formatted

  return (
    <div className={cn('rounded-xl border bg-surface-elevated overflow-hidden', borderColor)}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50">
        <span className={cn('text-xs font-semibold uppercase tracking-widest', labelColor)}>{label}</span>
        {isLong && (
          <button
            onClick={() => setCollapsed(c => !c)}
            className="text-[11px] text-muted hover:text-foreground transition-colors"
          >
            {collapsed ? 'Expand' : 'Collapse'}
          </button>
        )}
      </div>
      <pre className={cn(
        'px-4 py-3 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed',
        isError ? 'text-sell' : 'text-foreground/90',
        isJSON && !isError ? 'text-xs' : '',
      )}>
        {displayContent}
      </pre>
    </div>
  )
}

// ── Running detail panel ──────────────────────────────────────────────────────

function RunningCallDetail({ call }: { call: LLMCall }) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(new Date(call.created_at.includes('T') ? call.created_at : call.created_at + 'Z').getTime())

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 250)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 px-6 py-4 border-b border-border space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <ModuleBadge module={call.module} />
          {call.coin && (
            <span className="text-sm font-mono font-semibold text-foreground">
              {call.coin.replace('/USDC', '')}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs font-semibold text-warn bg-warn/10 px-2 py-0.5 rounded-lg">
            <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
            RUNNING
          </span>
          <span className="text-xs text-muted font-mono ml-auto">{formatTime(call.created_at)}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="font-mono text-foreground/70">{call.model}</span>
          {call.base_url && (
            <>
              <span>@</span>
              <span className="font-mono text-muted/70 truncate max-w-[260px]" title={call.base_url}>{call.base_url}</span>
            </>
          )}
          <span>·</span>
          <span className="font-semibold text-warn">{formatDuration(elapsed)}</span>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-muted">
          <div className="w-8 h-8 border-2 border-warn border-t-transparent rounded-full animate-spin" />
          <p className="text-sm">Waiting for LLM response…</p>
        </div>
      </div>
    </div>
  )
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function CallDetail({ callId }: { callId: number }) {
  const [detail, setDetail] = useState<LLMCall | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setDetail(null)
    fetch(`/api/llm-calls/${callId}`)
      .then(r => r.json())
      .then((d: LLMCall) => { setDetail(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [callId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!detail) {
    return <div className="flex items-center justify-center h-full text-sm text-muted">Failed to load call details.</div>
  }

  const totalTokens = (detail.prompt_tokens ?? 0) + (detail.completion_tokens ?? 0)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <ModuleBadge module={detail.module} />
          {detail.coin && (
            <span className="text-sm font-mono font-semibold text-foreground">
              {detail.coin.replace('/USDC', '')}
            </span>
          )}
          {detail.error && (
            <span className="text-xs font-semibold text-sell bg-sell/10 px-2 py-0.5 rounded-lg">Error</span>
          )}
          <span className="text-xs text-muted font-mono ml-auto">{formatTime(detail.created_at)}</span>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted flex-wrap">
          <span className="font-mono text-foreground/70">{detail.model}</span>
          {detail.base_url && (
            <>
              <span>@</span>
              <span className="font-mono text-muted/70 truncate max-w-[260px]" title={detail.base_url}>
                {detail.base_url}
              </span>
            </>
          )}
          <span>·</span>
          <span className="font-semibold text-foreground">{formatDuration(detail.duration_ms)}</span>
          {totalTokens > 0 && (
            <>
              <span>·</span>
              <span>
                <span className="text-accent">↑</span> {(detail.prompt_tokens ?? 0).toLocaleString()}
                <span className="mx-1 text-muted/40">+</span>
                <span className="text-buy">↓</span> {(detail.completion_tokens ?? 0).toLocaleString()}
                {(detail.thinking_tokens ?? 0) > 0 && (
                  <span className="ml-1 text-violet-400">({(detail.thinking_tokens!).toLocaleString()} think)</span>
                )}
                <span className="ml-1 text-muted/60">= {totalTokens.toLocaleString()} tokens</span>
              </span>
            </>
          )}
          {detail.cycle_id && (
            <>
              <span>·</span>
              <span className="font-mono text-muted/60 text-[10px]">{detail.cycle_id}</span>
            </>
          )}
        </div>
      </div>

      {/* Chat bubbles */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {detail.system_prompt && (
          <ChatBubble
            role="system"
            content={detail.system_prompt}
            label="System"
            defaultCollapsed={detail.system_prompt.length > 400}
          />
        )}

        {detail.user_prompt && (
          <ChatBubble
            role="user"
            content={detail.user_prompt}
            label="User"
            defaultCollapsed={detail.user_prompt.length > 600}
          />
        )}

        {detail.reasoning_content && (
          <ChatBubble
            role="assistant"
            content={detail.reasoning_content}
            label={`Thinking${detail.thinking_tokens ? ` · ${detail.thinking_tokens.toLocaleString()} tokens` : ''}`}
            defaultCollapsed={true}
            isThinking
          />
        )}

        {detail.error ? (
          <ChatBubble
            role="assistant"
            content={detail.error}
            label="Error"
            isError
          />
        ) : detail.response ? (
          <ChatBubble
            role="assistant"
            content={detail.response}
            label={`Assistant · ${moduleMeta(detail.module).label}`}
          />
        ) : (
          <div className="rounded-xl border border-border bg-surface-elevated px-4 py-3 text-sm text-muted">
            No response recorded.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Filter chips ─────────────────────────────────────────────────────────────

const ALL_MODULES = ['extractor', 'analyst', 'discoverer', 'monitor'] as const

function FilterChips({
  active,
  onChange,
}: {
  active: string | null
  onChange: (m: string | null) => void
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={() => onChange(null)}
        className={cn(
          'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
          active === null ? 'bg-accent/15 text-accent' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
        )}
      >
        All
      </button>
      {ALL_MODULES.map(mod => {
        const m = moduleMeta(mod)
        const isActive = active === mod
        return (
          <button
            key={mod}
            onClick={() => onChange(isActive ? null : mod)}
            className={cn(
              'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
              isActive ? cn(m.color, m.bg) : 'text-muted hover:text-foreground hover:bg-surface-elevated',
            )}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

let _runningCounter = 0

export default function LLMDebug() {
  const [calls, setCalls] = useState<LLMCall[]>([])
  const callsRef = useRef<LLMCall[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [moduleFilter, setModuleFilter] = useState<string | null>(null)
  const [fetchLimit, setFetchLimit] = useState(200)
  const listEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: { llm_debug_fetch_limit?: number }) => {
        if (s.llm_debug_fetch_limit) setFetchLimit(s.llm_debug_fetch_limit)
      })
      .catch(() => {})
  }, [])

  const handleClear = useCallback(async () => {
    setClearing(true)
    try {
      await fetch('/api/llm-calls', { method: 'DELETE' })
      callsRef.current = []
      setCalls([])
      setSelectedId(null)
    } finally {
      setClearing(false)
    }
  }, [])

  const fetchCalls = useCallback((module?: string | null) => {
    const url = `/api/llm-calls?limit=${fetchLimit}${module ? `&module=${module}` : ''}`
    Promise.all([
      fetch(url).then(r => r.json()) as Promise<LLMCall[]>,
      fetch('/api/llm-calls/running').then(r => r.json()).catch(() => []) as Promise<LLMCall[]>,
    ])
      .then(([done, running]) => {
        const filteredRunning = module
          ? running.filter(c => c.module === module)
          : running
        const merged: LLMCall[] = [
          ...filteredRunning.map(c => ({ ...c, id: --_runningCounter, status: 'running' as const, response: null, reasoning_content: null, error: null, prompt_tokens: null, completion_tokens: null, thinking_tokens: null, duration_ms: 0 })),
          ...done,
        ]
        callsRef.current = merged
        setCalls(merged)
        if (merged.length > 0 && !selectedId) setSelectedId(merged[0].id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [selectedId, fetchLimit])

  useEffect(() => {
    fetchCalls(moduleFilter)
  }, [moduleFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  useWebSocket((event, data) => {
    if (event === 'llm_call_start') {
      const raw = data as Omit<LLMCall, 'id' | 'response' | 'error' | 'prompt_tokens' | 'completion_tokens' | 'duration_ms'> & { temp_id: string }
      if (moduleFilter && raw.module !== moduleFilter) return
      // Skip if we already have this running call (loaded via /api/llm-calls/running on mount)
      if (callsRef.current.some(c => c.temp_id === raw.temp_id)) return
      const tempNumId = --_runningCounter
      const runningCall: LLMCall = {
        id: tempNumId,
        temp_id: raw.temp_id,
        module: raw.module,
        model: raw.model,
        base_url: raw.base_url,
        coin: raw.coin,
        cycle_id: raw.cycle_id,
        created_at: raw.created_at,
        response: null,
        reasoning_content: null,
        error: null,
        prompt_tokens: null,
        completion_tokens: null,
        thinking_tokens: null,
        duration_ms: 0,
        status: 'running',
      }
      callsRef.current = [runningCall, ...callsRef.current]
      setCalls(callsRef.current)
      setSelectedId(prev => prev === null ? tempNumId : prev)
      return
    }

    if (event === 'llm_call') {
      const call = data as LLMCall & { temp_id?: string }
      if (moduleFilter && call.module !== moduleFilter) return
      let replacedTempId: number | null = null
      const next = (() => {
        const prev = callsRef.current
        if (call.temp_id) {
          const idx = prev.findIndex(c => c.temp_id === call.temp_id)
          if (idx !== -1) {
            replacedTempId = prev[idx].id
            const arr = [...prev]
            arr[idx] = { ...call, status: 'done' as const }
            return arr
          }
        }
        if (prev.find(c => c.id === call.id)) return prev
        return [{ ...call, status: 'done' as const }, ...prev]
      })()
      callsRef.current = next
      setCalls(next)
      // If the running entry was selected, switch selection to the real id
      if (replacedTempId !== null) {
        const rId = replacedTempId
        setSelectedId(prev => prev === rId ? call.id : prev)
      }
    }
  })

  const handleModuleChange = (mod: string | null) => {
    setModuleFilter(mod)
    setSelectedId(null)
    setLoading(true)
  }

  const visibleCalls = calls

  return (
    <div className="flex gap-4 h-[calc(100vh-9rem)] animate-fade-in">
      {/* Left panel */}
      <div className="w-56 shrink-0 bg-surface-card border border-border rounded-2xl flex flex-col overflow-hidden neon-border">
        {/* Filters */}
        <div className="px-3 py-3 border-b border-border shrink-0 space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider">Filter</p>
            <button
              onClick={handleClear}
              disabled={clearing || visibleCalls.length === 0}
              className="text-[11px] font-medium text-sell/70 hover:text-sell transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {clearing ? 'Clearing…' : 'Clear all'}
            </button>
          </div>
          <FilterChips active={moduleFilter} onChange={handleModuleChange} />
        </div>

        <div className="px-3 py-2 border-b border-border shrink-0 flex items-center justify-between">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider">Calls</p>
          <span className="text-[11px] text-muted/60">{visibleCalls.length}</span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {loading && (
            <div className="flex items-center justify-center h-16">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {!loading && visibleCalls.length === 0 && (
            <p className="text-xs text-muted text-center px-3 py-6">
              No LLM calls recorded yet.{'\n'}Run the pipeline to see calls here.
            </p>
          )}
          {visibleCalls.map(call => (
            <CallListItem
              key={call.id}
              call={call}
              selected={selectedId === call.id}
              onClick={() => setSelectedId(call.id)}
            />
          ))}
          <div ref={listEndRef} />
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 bg-surface-card border border-border rounded-2xl overflow-hidden neon-border">
        {selectedId === null ? (
          <div className="flex items-center justify-center h-full text-sm text-muted">
            {loading ? 'Loading…' : 'Select a call to inspect it'}
          </div>
        ) : (() => {
          const selectedCall = calls.find(c => c.id === selectedId)
          if (selectedCall?.status === 'running') {
            return <RunningCallDetail key={selectedId} call={selectedCall} />
          }
          return <CallDetail key={selectedId} callId={selectedId} />
        })()}
      </div>
    </div>
  )
}
