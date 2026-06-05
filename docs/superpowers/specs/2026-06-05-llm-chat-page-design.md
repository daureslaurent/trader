# LLM Chat Page — Design Spec

## Goal
Add an LLM page to the frontend showing the full pipeline (research → extraction → analysis → decision) in a real-time chat-like interface, with both live streaming and historical data.

## Data Model

### New DB table: `pipeline_events`
```sql
CREATE TABLE pipeline_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coin       TEXT NOT NULL,
  cycle_id   TEXT NOT NULL,
  stage      TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `cycle_id`: UUID generated at start of each coin's pipeline run, groups all stages together
- `stage`: one of `research_started`, `research_completed`, `extraction_started`, `extraction_completed`, `analysis_started`, `signal_generated`, `pipeline_error`
- `data`: JSON payload specific to stage

### New shared type
```typescript
type PipelineStage =
  | 'research_started' | 'research_completed'
  | 'extraction_started' | 'extraction_completed'
  | 'analysis_started'
  | 'signal_generated'
  | 'pipeline_error'

interface PipelineEvent {
  id: number
  coin: string
  cycle_id: string
  stage: PipelineStage
  data: Record<string, unknown>
  created_at: string
}
```

## Backend Changes

### 1. index.ts pipeline instrumentation
At each stage of the trading loop, call a `logPipelineEvent(stage, data)` helper that:
- INSERTs a row into `pipeline_events`
- Calls `broadcast('pipeline_event', { ...row })` to WebSocket clients

Instrumentation points:

| Location | Stage | data payload |
|----------|-------|-------------|
| Before `researchCoin(s)` | `research_started` | `{ symbol }` |
| After `researchCoin(s)` | `research_completed` | `{ symbol, headlines, articles, sentiment, summary }` |
| Before `extractResearch(r)` | `extraction_started` | `{ symbol, articleCount }` |
| After `extractResearch(r)` | `extraction_completed` | `{ symbol, articles, aggregated_sentiment, top_headlines }` |
| Before `analyzeSignal(m, e)` | `analysis_started` | `{ symbol, price, change24h, volume }` |
| After `analyzeSignal(m, e)` | `signal_generated` | `{ symbol, action, reason, confidence }` |
| catch block | `pipeline_error` | `{ symbol, error }` |

### 2. New helper: `logPipelineEvent(stage, data)`
- Generates `cycle_id` from a shared variable per coin cycle
- Inserts into DB, returns the row
- Calls `broadcast()` with the full event

### 3. New REST endpoint: `GET /api/pipeline-events`
Query params: `?limit=50&coin=BTC/USDT&cycle_id=...`
Returns events ordered by `created_at DESC`, filterable by coin and cycle_id.

## Frontend Changes

### New file: `frontend/src/pages/LLM.tsx`
Default-exported component. Registered in `App.tsx` as tab `"LLM"`.

### Layout: two-panel
**Left sidebar:** scrollable list of pipeline cycles. Each entry shows `coin + time + final_action`. The current live cycle (no `signal_generated` yet) is pinned at top with a pulsing indicator. Click a cycle to view.

**Right main area:** chat view. Stages render as chat messages in chronological order:

| Stage | Rendering |
|-------|-----------|
| `research_started` | "🔍 Researching {coin}..." with spinner |
| `research_completed` | Headline list with sentiment badges, article count |
| `extraction_started` | "🧠 Extracting intelligence from {n} articles..." with spinner |
| `extraction_completed` | Per-article cards: relevance, sentiment, summary, key_points |
| `analysis_started` | "📊 Analyzing {coin}..." with market data card (price, 24h) |
| `signal_generated` | Final signal: action badge, confidence bar, reason text |
| `pipeline_error` | ❌ Red error box with message |

### Data flow
- On mount: `GET /api/pipeline-events?limit=200` loads history
- Group events by `cycle_id`, sort by `created_at`
- `useWebSocket` listens for `pipeline_event` → append/replace in cycles
- Auto-scroll to latest event in the active (live) cycle

### Styling
- Dark theme matching existing app (`bg-gray-900`, `text-green-400`, etc.)
- Chat bubbles: subtle left border per stage type (blue for research, purple for extraction, green for analysis, yellow for signal)
- Code-like formatting for LLM responses (monospace, green text on dark bg)
