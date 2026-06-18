import { Repository } from './repository.js'

// A permissive row shape mirroring the old queryAll() return type. Call sites
// still cast individual fields (`row.coin as string`) exactly as they did with
// SQLite, which keeps the SQL→Mongo conversion mechanical.
export type Row = Record<string, any> & { _id?: number | string; id?: number | string }

// ── Trading (the durable, transactional state) ──────────────────────────────
export const trades             = new Repository<Row>('trades')
export const decisions          = new Repository<Row>('decisions')
export const positions          = new Repository<Row>('positions')
export const portfolioEntries   = new Repository<Row>('portfolio_entries')
export const portfolioSnapshots = new Repository<Row>('portfolio_snapshots')
export const positionReviews    = new Repository<Row>('position_reviews')
export const monitorDRuns       = new Repository<Row>('monitor_d_runs')
export const agentSignalRuns    = new Repository<Row>('agent_signal_runs')
export const positionAdjustments = new Repository<Row>('position_adjustments')
export const slTpHistory        = new Repository<Row>('sl_tp_history')
export const portfolioSummaries = new Repository<Row>('portfolio_summaries')
export const agentConversations = new Repository<Row>('agent_conversations')
export const agentMessages      = new Repository<Row>('agent_messages')

// Natural string-key collections (no auto-increment).
export const monitorNotes       = new Repository<Row>('monitor_notes', false)        // _id = coin
export const agentSignalMemory  = new Repository<Row>('agent_signal_memory', false)  // _id = coin
export const entryIntents       = new Repository<Row>('entry_intents', false)        // _id = intent id
export const entryEvents        = new Repository<Row>('entry_events', false)          // _id = event id
export const settings           = new Repository<Row>('settings', false)             // _id = key

// ── Pipeline ────────────────────────────────────────────────────────────────
export const pipelineEvents     = new Repository<Row>('pipeline_events')

// ── Cache (regenerable) ─────────────────────────────────────────────────────
export const extractionCache    = new Repository<Row>('extraction_cache', false)    // _id = url
export const ohlcvCache         = new Repository<Row>('ohlcv_cache', false)          // _id = cache_key
export const coinDiscoveries    = new Repository<Row>('coin_discoveries')
export const llmCalls           = new Repository<Row>('llm_calls')
export const llmStatsSnapshots  = new Repository<Row>('llm_stats_snapshots')

// Records captured by `debug` processor nodes in the routing graph (what flowed
// through them). Append-only, pruned by count — see routing/debugLog.
export const debugLogs          = new Repository<Row>('debug_logs')

// Durable LLM scheduler jobs (natural string key = job id). Only jobs flagged
// `durable` persist here; rows are deleted on completion. On startup, rows still
// `queued` are resumed via the builder registry — `running` rows were in flight at
// crash and are dropped (the producing cycle re-drives them).
export const llmJobs            = new Repository<Row>('llm_jobs', false)            // _id = job id

// Lookup by collection name (used by the migration tool and index setup).
export const ALL_REPOS: Record<string, Repository<Row>> = {
  trades, decisions, positions, portfolio_entries: portfolioEntries,
  portfolio_snapshots: portfolioSnapshots, position_reviews: positionReviews,
  monitor_d_runs: monitorDRuns, agent_signal_runs: agentSignalRuns,
  position_adjustments: positionAdjustments, sl_tp_history: slTpHistory,
  portfolio_summaries: portfolioSummaries, agent_conversations: agentConversations,
  agent_messages: agentMessages, monitor_notes: monitorNotes,
  agent_signal_memory: agentSignalMemory,
  entry_intents: entryIntents, entry_events: entryEvents, settings,
  pipeline_events: pipelineEvents, extraction_cache: extractionCache,
  ohlcv_cache: ohlcvCache, coin_discoveries: coinDiscoveries,
  llm_calls: llmCalls, llm_stats_snapshots: llmStatsSnapshots,
  debug_logs: debugLogs,
  llm_jobs: llmJobs,
}
