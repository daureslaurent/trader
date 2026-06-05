# LLM Chat Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LLM page with real-time + historical pipeline visualization in a chat-like interface.

**Architecture:** New `pipeline_events` DB table records each stage (research → extraction → analysis → signal) per coin cycle. The backend trading loop broadcasts events via WebSocket at each stage. The frontend LLM page displays grouped cycles in a two-panel chat layout.

**Tech Stack:** SQLite (sql.js), Express, WebSocket (ws), React, Tailwind

---

### Task 1: Add pipeline_events table and types

**Files:**
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/types.ts`

- [ ] **Step 1: Add pipeline_events CREATE TABLE to schema.ts**

In `backend/src/db/schema.ts`, add before the settings INSERT:

```typescript
CREATE TABLE IF NOT EXISTS pipeline_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coin       TEXT NOT NULL,
  cycle_id   TEXT NOT NULL,
  stage      TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_cycle ON pipeline_events(cycle_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_created ON pipeline_events(created_at DESC);
```

- [ ] **Step 2: Add PipelineEvent types to types.ts**

Append after `ApprovalRequest` in `backend/src/types.ts`:

```typescript
export type PipelineStage =
  | 'research_started'
  | 'research_completed'
  | 'extraction_started'
  | 'extraction_completed'
  | 'analysis_started'
  | 'signal_generated'
  | 'pipeline_error'

export interface PipelineEvent {
  id: number
  coin: string
  cycle_id: string
  stage: PipelineStage
  data: string
  created_at: string
}
```

- [ ] **Step 3: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/db/schema.ts backend/src/types.ts && git commit -m "feat: add pipeline_events table and types"
```

---

### Task 2: Add pipeline events API endpoint

**Files:**
- Modify: `backend/src/api/routes.ts`

- [ ] **Step 1: Add GET /api/pipeline-events route**

Add after the `/chart` route in `backend/src/api/routes.ts`:

```typescript
router.get('/pipeline-events', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500)
  const coin = req.query.coin as string | undefined
  const cycleId = req.query.cycle_id as string | undefined

  let sql = 'SELECT * FROM pipeline_events'
  const params: (string | number)[] = []
  const conditions: string[] = []

  if (coin) {
    conditions.push('coin = ?')
    params.push(coin)
  }
  if (cycleId) {
    conditions.push('cycle_id = ?')
    params.push(cycleId)
  }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const events = queryAll(sql, params)
  res.json(events)
})
```

- [ ] **Step 2: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/api/routes.ts && git commit -m "feat: add GET /api/pipeline-events endpoint"
```

---

### Task 3: Instrument trading loop with pipeline events

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add broadcast import**

Add `import { broadcast } from './api/ws.js'` to the imports at the top of `backend/src/index.ts`.

- [ ] **Step 2: Add logPipelineEvent helper and cycle counter**

Add after imports:

```typescript
import { PipelineStage } from './types.js'

let cycleCounter = 0

function logPipelineEvent(
  stage: PipelineStage,
  coin: string,
  cycleId: string,
  data: Record<string, unknown>
): void {
  const payload = JSON.stringify(data)
  runSQL(
    'INSERT INTO pipeline_events (coin, cycle_id, stage, data) VALUES (?, ?, ?, ?)',
    [coin, cycleId, stage, payload]
  )
  const row = queryOne(
    'SELECT * FROM pipeline_events WHERE id = (SELECT last_insert_rowid())'
  )
  if (row) broadcast('pipeline_event', row)
}
```

- [ ] **Step 3: Instrument the loop body**

In `backend/src/index.ts`, replace the loop body inside `for (const data of marketData)`:

```typescript
for (const data of marketData) {
    const cycleId = `${Date.now().toString(36)}-${(++cycleCounter).toString(36)}`
    try {
      logPipelineEvent('research_started', data.symbol, cycleId, { symbol: data.symbol })
      const rawResearch = await researchCoin(data.symbol)
      logPipelineEvent('research_completed', data.symbol, cycleId, {
        symbol: data.symbol,
        headlines: rawResearch.headlines,
        articles: rawResearch.articles,
        sentiment: rawResearch.sentiment,
        summary: rawResearch.summary,
      })

      logPipelineEvent('extraction_started', data.symbol, cycleId, { symbol: data.symbol, articleCount: rawResearch.articles.length })
      const extractedResearch = await extractResearch(rawResearch)
      logPipelineEvent('extraction_completed', data.symbol, cycleId, {
        symbol: data.symbol,
        articles: extractedResearch.articles,
        aggregated_sentiment: extractedResearch.aggregated_sentiment,
        top_headlines: extractedResearch.top_headlines,
      })

      const portfolioPercent = balance[data.symbol.replace('/USDT', '')]
        ? ((balance[data.symbol.replace('/USDT', '')].total * data.price) / (Object.values(balance).reduce((s, b) => s + b.total * data.price, 0.01))) * 100
        : 0

      logPipelineEvent('analysis_started', data.symbol, cycleId, {
        symbol: data.symbol,
        price: data.price,
        change24h: data.change24h,
        volume: data.volume,
      })

      const signal = await analyzeSignal(
        data.symbol,
        data.price,
        data.change24h,
        data.volume,
        extractedResearch,
        portfolioPercent,
      )

      logPipelineEvent('signal_generated', data.symbol, cycleId, {
        symbol: data.symbol,
        action: signal.action,
        quantity: signal.quantity,
        reason: signal.reason,
        confidence: signal.confidence,
      })

      runSQL(
        'INSERT INTO decisions (coin, action, reason, confidence, context) VALUES (?, ?, ?, ?, ?)',
        [data.symbol, signal.action, signal.reason, signal.confidence, JSON.stringify({ price: data.price, extractedResearch })]
      )

      if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
        logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
        continue
      }

      await handleTradeSignal(signal, data.price)
    } catch (err) {
      logPipelineEvent('pipeline_error', data.symbol, cycleId, {
        symbol: data.symbol,
        error: (err as Error).message,
      })
      logger.error('Error in trading loop', { coin: data.symbol, error: (err as Error).message })
    }
  }
```

- [ ] **Step 4: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/index.ts && git commit -m "feat: instrument trading loop with pipeline events"
```

---

### Task 4: Create LLM page component

**Files:**
- Create: `frontend/src/pages/LLM.tsx`

- [ ] **Step 1: Create the LLM page**

Create `frontend/src/pages/LLM.tsx` with the following code:

```tsx
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
```

- [ ] **Step 2: Run frontend build**

```bash
cd /home/dauresl/cryptoBot/frontend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add frontend/src/pages/LLM.tsx && git commit -m "feat: create LLM chat page component"
```

---

### Task 5: Register LLM page in App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add import, type, tab, and conditional render**

In `frontend/src/App.tsx`:

```typescript
import LLM from './pages/LLM'

type Page = 'dashboard' | 'portfolio' | 'logs' | 'settings' | 'charts' | 'llm'

const tabs: { key: Page; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'logs', label: 'Logs' },
  { key: 'llm', label: 'LLM' },
  { key: 'charts', label: 'Charts' },
  { key: 'settings', label: 'Settings' },
]

// In the conditional renders:
{page === 'llm' && <LLM />}
```

- [ ] **Step 2: Run frontend build**

```bash
cd /home/dauresl/cryptoBot/frontend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add frontend/src/App.tsx && git commit -m "feat: register LLM page in navigation"
```

---

### Task 6: Verify everything compiles

- [ ] **Step 1: Run backend type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```

- [ ] **Step 2: Run frontend type check**

```bash
cd /home/dauresl/cryptoBot/frontend && npx tsc --noEmit
```

- [ ] **Step 3: If all pass, commit any final fixes**

```bash
cd /home/dauresl/cryptoBot && git add -A && git commit -m "chore: fix type issues after LLM page implementation"
```
