import { getDB } from './connection.js'
import { getSettings } from './settings.js'
import { logger } from '../core/logger.js'
import { scheduleSave } from './connection.js'

export function runLLMRetention(): void {
  const { llm_retain_days } = getSettings()
  if (!llm_retain_days || llm_retain_days <= 0) return

  const cutoff = new Date(Date.now() - llm_retain_days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)

  const db = getDB('cache')

  const aggResult = db.exec(`
    SELECT module, model, base_url,
      COUNT(*) AS call_count,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
      SUM(COALESCE(duration_ms, 0)) AS total_duration_ms,
      SUM(COALESCE(prompt_tokens, 0)) AS total_prompt_tokens,
      SUM(COALESCE(completion_tokens, 0)) AS total_completion_tokens,
      SUM(COALESCE(thinking_tokens, 0)) AS total_thinking_tokens
    FROM llm_calls
    WHERE created_at < '${cutoff}'
    GROUP BY module, model, base_url
  `)

  if (!aggResult[0]) return

  const { columns, values } = aggResult[0]
  let archived = 0

  for (const row of values) {
    const r = Object.fromEntries(columns.map((c, i) => [c, row[i]])) as Record<string, number | string>
    db.run(
      `INSERT INTO llm_stats_snapshots
         (module, model, base_url, call_count, error_count, total_duration_ms, total_prompt_tokens, total_completion_tokens, total_thinking_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(module, model, base_url) DO UPDATE SET
         call_count              = call_count + excluded.call_count,
         error_count             = error_count + excluded.error_count,
         total_duration_ms       = total_duration_ms + excluded.total_duration_ms,
         total_prompt_tokens     = total_prompt_tokens + excluded.total_prompt_tokens,
         total_completion_tokens = total_completion_tokens + excluded.total_completion_tokens,
         total_thinking_tokens   = total_thinking_tokens + excluded.total_thinking_tokens`,
      [r.module, r.model, r.base_url, r.call_count, r.error_count, r.total_duration_ms, r.total_prompt_tokens, r.total_completion_tokens, r.total_thinking_tokens],
    )
    archived += r.call_count as number
  }

  db.run(`DELETE FROM llm_calls WHERE created_at < '${cutoff}'`)
  scheduleSave()

  logger.info('LLM retention: archived old calls', { archived, retain_days: llm_retain_days, cutoff })
}
