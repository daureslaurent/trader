import { useEffect, useState, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'

interface PipelineEvent {
  id: number
  coin: string
  cycle_id: string
  stage: string
  data: string
  created_at: string
}

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
  return new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function parseData(event: PipelineEvent) {
  try { return JSON.parse(event.data) } catch { return {} }
}

const stageColors: Record<string, string> = {
  research_started: 'border-l-blue-500',
  research_completed: 'border-l-blue-500',
  extraction_started: 'border-l-purple-500',
  extraction_completed: 'border-l-purple-500',
  analysis_started: 'border-l-green-500',
  signal_generated: 'border-l-yellow-500',
  pipeline_error: 'border-l-red-500',
}

const stageIcons: Record<string, string> = {
  research_started: '\u{1F50D}',
  research_completed: '\u{1F4F0}',
  extraction_started: '\u{1F9E0}',
  extraction_completed: '\u{1F4CA}',
  analysis_started: '\u{1F4C8}',
  signal_generated: '\u{1F4A1}',
  pipeline_error: '\u274C',
}

function StageMessage({ event }: { event: PipelineEvent }) {
  const data = parseData(event)
  const isStarted = event.stage.endsWith('_started')
  const isError = event.stage === 'pipeline_error'

  if (isStarted || isError) {
    return (
      <div className={`border-l-4 ${stageColors[event.stage]} pl-3 py-1 mb-2`}>
        <div className="flex items-center gap-2 text-sm">
          <span>{stageIcons[event.stage]}</span>
          <span className={isError ? 'text-red-400' : 'text-gray-400'}>
            {event.stage === 'research_started' && `Researching ${data.symbol}...`}
            {event.stage === 'extraction_started' && `Extracting intelligence from ${data.articleCount} articles...`}
            {event.stage === 'analysis_started' && `Analyzing ${data.symbol} signal...`}
            {isError && `${data.symbol}: ${data.error}`}
          </span>
          <span className="text-xs text-gray-600 ml-auto">{formatTime(event.created_at)}</span>
        </div>
      </div>
    )
  }

  if (event.stage === 'research_completed') {
    const headlines = (data.headlines as string[]) || []
    return (
      <div className={`border-l-4 ${stageColors[event.stage]} pl-3 py-2 mb-3`}>
        <div className="flex items-center gap-2 mb-2">
          <span>{stageIcons[event.stage]}</span>
          <span className="text-xs text-gray-400">{formatTime(event.created_at)}</span>
        </div>
        <div className="text-xs text-gray-400 mb-1">Found {data.articles?.length || 0} articles</div>
        <div className="space-y-1">
          {headlines.slice(0, 5).map((h: string, i: number) => (
            <div key={i} className="text-sm text-gray-200 flex items-center gap-2">
              <span className="text-gray-500">&bull;</span>
              <span>{h}</span>
            </div>
          ))}
        </div>
        {data.sentiment && (
          <div className="mt-2">
            <span className={`text-xs px-2 py-0.5 rounded ${
              data.sentiment === 'positive' ? 'bg-green-900/50 text-green-400' :
              data.sentiment === 'negative' ? 'bg-red-900/50 text-red-400' :
              'bg-gray-700 text-gray-300'
            }`}>{data.sentiment as string}</span>
          </div>
        )}
      </div>
    )
  }

  if (event.stage === 'extraction_completed') {
    const articles: any[] = (data.articles as any[]) || []
    return (
      <div className={`border-l-4 ${stageColors[event.stage]} pl-3 py-2 mb-3`}>
        <div className="flex items-center gap-2 mb-2">
          <span>{stageIcons[event.stage]}</span>
          <span className="text-xs text-gray-400">{formatTime(event.created_at)}</span>
        </div>
        <div className="space-y-2">
          {articles.filter((a) => a.relevance_score >= 0.3).map((article: any, i: number) => (
            <div key={i} className="bg-gray-800 rounded p-2 text-sm">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  article.sentiment === 'positive' ? 'bg-green-900/50 text-green-400' :
                  article.sentiment === 'negative' ? 'bg-red-900/50 text-red-400' :
                  'bg-gray-700 text-gray-300'
                }`}>{article.sentiment}</span>
                <span className="text-xs text-gray-500">{(article.relevance_score * 100).toFixed(0)}% relevant</span>
              </div>
              <div className="font-medium text-gray-200 mb-1">{article.title}</div>
              <div className="text-xs text-gray-400 mb-1">{article.summary}</div>
              {article.key_points && article.key_points.length > 0 && (
                <div className="space-y-0.5">
                  {article.key_points.slice(0, 3).map((kp: string, j: number) => (
                    <div key={j} className="flex items-start gap-1 text-xs text-gray-500">
                      <span>&rarr;</span>
                      <span>{kp}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (event.stage === 'signal_generated') {
    return (
      <div className={`border-l-4 ${stageColors[event.stage]} pl-3 py-2 mb-3`}>
        <div className="flex items-center gap-2 mb-2">
          <span>{stageIcons[event.stage]}</span>
          <span className="text-xs text-gray-400">{formatTime(event.created_at)}</span>
        </div>
        <div className="bg-gray-800 rounded p-3">
          <div className="flex items-center gap-3 mb-2">
            <span className={`text-lg font-bold ${
              data.action === 'BUY' ? 'text-green-400' :
              data.action === 'SELL' ? 'text-red-400' :
              'text-yellow-400'
            }`}>{data.action as string}</span>
            <span className="text-gray-200 font-medium">{data.symbol as string}</span>
            <div className="flex items-center gap-1 ml-auto">
              <div className="bg-gray-700 h-2 w-20 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${(data.confidence as number || 0) >= 0.7 ? 'bg-green-500' : (data.confidence as number || 0) >= 0.4 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${((data.confidence as number || 0) * 100).toFixed(0)}%` }}
                />
              </div>
              <span className="text-xs text-gray-400">{((data.confidence as number || 0) * 100).toFixed(0)}%</span>
            </div>
          </div>
          {data.reason && (
            <div className="text-sm text-gray-300 bg-gray-900 rounded p-2 font-mono leading-relaxed">
              {data.reason as string}
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}

export default function LLM() {
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/pipeline-events?limit=200')
      .then(r => r.json())
      .then((events: PipelineEvent[]) => {
        const grouped = groupEvents(events)
        setCycles(grouped)
        if (grouped.length > 0 && !selectedCycleId) {
          setSelectedCycleId(grouped[0].cycle_id)
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useWebSocket((msg) => {
    if (msg.type === 'pipeline_event') {
      const event = msg.data as PipelineEvent
      setCycles(prev => {
        const existing = prev.find(c => c.cycle_id === event.cycle_id)
        if (existing) {
          const alreadyHas = existing.events.some(e => e.id === event.id)
          if (alreadyHas) return prev
          const updated = {
            ...existing,
            events: [...existing.events, event].sort(
              (a, b) => new Date(a.created_at + 'Z').getTime() - new Date(b.created_at + 'Z').getTime()
            ),
            completed: event.stage === 'signal_generated' || event.stage === 'pipeline_error',
            finalAction: event.stage === 'signal_generated' ? parseData(event).action as string : existing.finalAction,
            finalConfidence: event.stage === 'signal_generated' ? parseData(event).confidence as number : existing.finalConfidence,
            error: event.stage === 'pipeline_error' ? parseData(event).error as string : existing.error,
          }
          return [updated, ...prev.filter(c => c.cycle_id !== event.cycle_id)]
        } else {
          const newCycle: Cycle = {
            cycle_id: event.cycle_id,
            coin: event.coin,
            events: [event],
            startTime: event.created_at,
            completed: event.stage === 'signal_generated' || event.stage === 'pipeline_error',
            finalAction: event.stage === 'signal_generated' ? parseData(event).action as string : undefined,
            finalConfidence: event.stage === 'signal_generated' ? parseData(event).confidence as number : undefined,
            error: event.stage === 'pipeline_error' ? parseData(event).error as string : undefined,
          }
          return [newCycle, ...prev]
        }
      })
    }
  })

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycleId) {
      setSelectedCycleId(cycles[0].cycle_id)
    }
  }, [cycles, selectedCycleId])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [cycles, selectedCycleId])

  const selectedCycle = cycles.find(c => c.cycle_id === selectedCycleId)

  return (
    <div className="flex gap-4 h-[calc(100vh-8rem)]">
      <div className="w-56 shrink-0 bg-gray-900 rounded-lg overflow-y-auto">
        <div className="p-2 text-xs text-gray-500 font-semibold uppercase tracking-wider border-b border-gray-800">
          Pipeline Cycles
        </div>
        <div className="p-1 space-y-0.5">
          {cycles.map(cycle => (
            <button
              key={cycle.cycle_id}
              onClick={() => setSelectedCycleId(cycle.cycle_id)}
              className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                selectedCycleId === cycle.cycle_id
                  ? 'bg-green-600/20 text-green-400'
                  : 'hover:bg-gray-800 text-gray-300'
              } ${!cycle.completed ? 'animate-pulse' : ''}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{cycle.coin.replace('/USDT', '')}</span>
                {cycle.finalAction && (
                  <span className={`text-xs font-medium ${
                    cycle.finalAction === 'BUY' ? 'text-green-400' :
                    cycle.finalAction === 'SELL' ? 'text-red-400' : 'text-yellow-400'
                  }`}>{cycle.finalAction}</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-gray-500">{formatTime(cycle.startTime)}</span>
                {cycle.finalConfidence !== undefined && (
                  <span className="text-xs text-gray-500">{(cycle.finalConfidence * 100).toFixed(0)}%</span>
                )}
                {!cycle.completed && <span className="text-xs text-green-400">&bull;</span>}
                {cycle.error && <span className="text-xs text-red-400">error</span>}
              </div>
            </button>
          ))}
          {!loading && cycles.length === 0 && (
            <p className="text-gray-500 text-sm p-3">No pipeline events yet. Wait for the trading loop to run.</p>
          )}
          {loading && <p className="text-gray-500 text-sm p-3">Loading...</p>}
        </div>
      </div>

      <div className="flex-1 bg-gray-900 rounded-lg overflow-y-auto p-4">
        {selectedCycle ? (
          <div>
            <div className="mb-4 pb-3 border-b border-gray-800">
              <h2 className="text-lg font-semibold text-green-400">{selectedCycle.coin.replace('/USDT', '')}</h2>
              <span className="text-xs text-gray-500">{formatTime(selectedCycle.startTime)}</span>
            </div>
            <div className="space-y-1">
              {selectedCycle.events
                .sort((a, b) => new Date(a.created_at + 'Z').getTime() - new Date(b.created_at + 'Z').getTime())
                .map((event) => (
                  <StageMessage key={event.id} event={event} />
                ))}
            </div>
            {!selectedCycle.completed && (
              <div className="flex items-center gap-2 text-sm text-green-400 mt-4">
                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span>Processing...</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            {loading ? 'Loading...' : 'Select a pipeline cycle from the left'}
          </div>
        )}
      </div>
    </div>
  )
}

function groupEvents(events: PipelineEvent[]): Cycle[] {
  const map = new Map<string, Cycle>()
  for (const event of events) {
    const existing = map.get(event.cycle_id)
    const data = parseData(event)
    if (existing) {
      existing.events.push(event)
      if (event.stage === 'signal_generated') {
        existing.completed = true
        existing.finalAction = data.action as string
        existing.finalConfidence = data.confidence as number
      }
      if (event.stage === 'pipeline_error') {
        existing.completed = true
        existing.error = data.error as string
      }
    } else {
      map.set(event.cycle_id, {
        cycle_id: event.cycle_id,
        coin: event.coin,
        events: [event],
        startTime: event.created_at,
        completed: event.stage === 'signal_generated' || event.stage === 'pipeline_error',
        finalAction: event.stage === 'signal_generated' ? data.action as string : undefined,
        finalConfidence: event.stage === 'signal_generated' ? data.confidence as number : undefined,
        error: event.stage === 'pipeline_error' ? data.error as string : undefined,
      })
    }
  }
  const sorted = Array.from(map.values())
  sorted.sort((a, b) => new Date(b.startTime + 'Z').getTime() - new Date(a.startTime + 'Z').getTime())
  return sorted
}
