import { getDb } from './client.js'
import { logger } from '../core/logger.js'

// Mirror the indexes the SQLite schema declared, plus the UNIQUE constraints
// that became natural keys or compound unique indexes. createIndex is idempotent,
// so this runs safely on every startup.
export async function ensureIndexes(): Promise<void> {
  const db = getDb()

  await db.collection('counters').createIndex({ _id: 1 })

  // Trading
  await db.collection('trades').createIndexes([
    { key: { created_at: 1 }, name: 'idx_trades_created' },
    { key: { status: 1 }, name: 'idx_trades_status' },
    { key: { id: 1 }, name: 'idx_trades_id' },
  ])
  await db.collection('decisions').createIndex({ created_at: 1 }, { name: 'idx_decisions_created' })
  await db.collection('positions').createIndexes([
    { key: { status: 1 }, name: 'idx_positions_status' },
    { key: { id: 1 }, name: 'idx_positions_id' },
  ])
  await db.collection('portfolio_entries').createIndexes([
    { key: { status: 1 }, name: 'idx_portfolio_entries_status' },
    { key: { id: 1 }, name: 'idx_portfolio_entries_id' },
  ])
  await db.collection('portfolio_snapshots').createIndex({ created_at: 1 }, { name: 'idx_snapshots_created' })
  await db.collection('position_reviews').createIndexes([
    { key: { created_at: -1 }, name: 'idx_position_reviews_created' },
    { key: { coin: 1 }, name: 'idx_position_reviews_coin' },
  ])
  await db.collection('monitor_d_runs').createIndexes([
    { key: { id: -1 }, name: 'idx_monitor_d_runs_id' },
    { key: { cycle_id: 1 }, name: 'idx_monitor_d_runs_cycle' },
    { key: { coin: 1 }, name: 'idx_monitor_d_runs_coin' },
  ])
  await db.collection('agent_signal_runs').createIndexes([
    { key: { id: -1 }, name: 'idx_agent_signal_runs_id' },
    { key: { cycle_id: 1 }, name: 'idx_agent_signal_runs_cycle' },
    { key: { coin: 1 }, name: 'idx_agent_signal_runs_coin' },
  ])
  await db.collection('position_adjustments').createIndexes([
    { key: { status: 1 }, name: 'idx_position_adjustments_status' },
    { key: { coin: 1, created_at: 1 }, name: 'idx_position_adjustments_coin' },
  ])
  await db.collection('sl_tp_history').createIndex({ coin: 1, created_at: 1 }, { name: 'idx_sl_tp_history_coin' })
  await db.collection('portfolio_summaries').createIndex({ created_at: -1 }, { name: 'idx_portfolio_summaries_created' })
  await db.collection('agent_conversations').createIndex({ updated_at: -1 }, { name: 'idx_agent_conversations_updated' })
  await db.collection('agent_messages').createIndex({ conversation_id: 1, id: 1 }, { name: 'idx_agent_messages_conversation' })

  // entry_intents had UNIQUE(coin)
  await db.collection('entry_intents').createIndex({ coin: 1 }, { name: 'idx_entry_intents_coin', unique: true })
  await db.collection('entry_events').createIndex({ created_at: -1 }, { name: 'idx_entry_events_created' })

  // Pipeline
  await db.collection('pipeline_events').createIndexes([
    { key: { cycle_id: 1 }, name: 'idx_pipeline_cycle' },
    { key: { created_at: -1 }, name: 'idx_pipeline_created' },
  ])

  // Cache
  await db.collection('extraction_cache').createIndex({ coin: 1 }, { name: 'idx_extraction_cache_coin' })
  await db.collection('coin_discoveries').createIndexes([
    { key: { created_at: -1 }, name: 'idx_discoveries_created' },
    { key: { status: 1 }, name: 'idx_discoveries_status' },
  ])
  await db.collection('llm_calls').createIndexes([
    { key: { created_at: -1 }, name: 'idx_llm_calls_created' },
    { key: { module: 1 }, name: 'idx_llm_calls_module' },
  ])
  // llm_stats_snapshots had UNIQUE(module, model, base_url)
  await db.collection('llm_stats_snapshots').createIndex(
    { module: 1, model: 1, base_url: 1 },
    { name: 'idx_llm_stats_unique', unique: true },
  )

  // Routing debug processor capture log
  await db.collection('debug_logs').createIndexes([
    { key: { id: -1 }, name: 'idx_debug_logs_id' },
    { key: { created_at: -1 }, name: 'idx_debug_logs_created' },
  ])

  logger.info('MongoDB indexes ensured')
}
