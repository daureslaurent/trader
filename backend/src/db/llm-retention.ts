import { llmCalls, llmStatsSnapshots } from './repositories.js'
import { getSettings } from './settings.js'
import { logger } from '../core/logger.js'

// Archive llm_calls older than the retention window into rolled-up
// llm_stats_snapshots (so historical totals survive), then delete the raw rows.
export async function runLLMRetention(): Promise<void> {
  const { llm_retain_days } = getSettings()
  if (!llm_retain_days || llm_retain_days <= 0) return

  const cutoff = new Date(Date.now() - llm_retain_days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)

  const groups = await llmCalls.aggregate<{
    _id: { module: string; model: string; base_url: string }
    call_count: number
    error_count: number
    total_duration_ms: number
    total_prompt_tokens: number
    total_completion_tokens: number
    total_thinking_tokens: number
  }>([
    { $match: { created_at: { $lt: cutoff } } },
    {
      $group: {
        _id: { module: '$module', model: '$model', base_url: '$base_url' },
        call_count: { $sum: 1 },
        error_count: { $sum: { $cond: [{ $ne: ['$error', null] }, 1, 0] } },
        total_duration_ms: { $sum: { $ifNull: ['$duration_ms', 0] } },
        total_prompt_tokens: { $sum: { $ifNull: ['$prompt_tokens', 0] } },
        total_completion_tokens: { $sum: { $ifNull: ['$completion_tokens', 0] } },
        total_thinking_tokens: { $sum: { $ifNull: ['$thinking_tokens', 0] } },
      },
    },
  ])

  if (groups.length === 0) return

  let archived = 0
  for (const g of groups) {
    const { module, model, base_url } = g._id
    await llmStatsSnapshots.col().updateOne(
      { module, model: model ?? '', base_url: base_url ?? '' },
      {
        $inc: {
          call_count: g.call_count,
          error_count: g.error_count,
          total_duration_ms: g.total_duration_ms,
          total_prompt_tokens: g.total_prompt_tokens,
          total_completion_tokens: g.total_completion_tokens,
          total_thinking_tokens: g.total_thinking_tokens,
        },
      },
      { upsert: true },
    )
    archived += g.call_count
  }

  await llmCalls.deleteMany({ created_at: { $lt: cutoff } })

  logger.info('LLM retention: archived old calls', { archived, retain_days: llm_retain_days, cutoff })
}
