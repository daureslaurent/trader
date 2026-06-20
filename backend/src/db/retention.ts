import { pipelineEvents, debugLogs } from './repositories.js'
import { getSettings } from './settings.js'
import { logger } from '../core/logger.js'
import { Repository } from './repository.js'
import { Row } from './repositories.js'

// Build a `'YYYY-MM-DD HH:MM:SS'` cutoff `days` in the past — matches the string
// format `created_at` is stored in, so a `$lt` string compare works (see
// llm-retention.ts for the same construction).
function cutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

async function pruneByAge(repo: Repository<Row>, days: number, label: string): Promise<void> {
  if (!days || days <= 0) return
  const deleted = await repo.deleteMany({ created_at: { $lt: cutoff(days) } })
  if (deleted > 0) logger.info('Data retention: pruned old rows', { collection: label, deleted, retain_days: days })
}

// Age-based pruning for the high-volume, non-LLM collections (LLM calls have
// their own archiving path in llm-retention.ts). 0 days = keep forever.
export async function runDataRetention(): Promise<void> {
  const { pipeline_events_retain_days, debug_logs_retain_days } = getSettings()
  await pruneByAge(pipelineEvents, pipeline_events_retain_days, 'pipeline_events')
  await pruneByAge(debugLogs, debug_logs_retain_days, 'debug_logs')
}
