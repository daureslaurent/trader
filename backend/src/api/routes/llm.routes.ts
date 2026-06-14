import { Router, Request, Response } from 'express'
import { queryAll, queryOne, runSQL, getSettings } from '../../db/index.js'
import { getRunningLLMCalls } from '../../core/llm.js'
import { config } from '../../config/index.js'

export const router = Router()

// Env-var fallback endpoint/model/max-tokens for each module whose LLM is overridable
// from Settings. The UI shows these as placeholders so a blank field reads as "default".
router.get('/llm/defaults', (_req: Request, res: Response) => {
  res.json({
    analyst: { baseURL: config.analyst.baseURL, model: config.analyst.model, maxTokens: config.analyst.maxTokens },
    extractor: { baseURL: config.extractor.baseURL, model: config.extractor.model, maxTokens: config.extractor.maxTokens },
    discoverer: { baseURL: config.discoverer.baseURL, model: config.discoverer.model, maxTokens: config.discoverer.maxTokens },
    discovererExtractor: { baseURL: config.discovererExtractor.baseURL, model: config.discovererExtractor.model, maxTokens: config.discovererExtractor.maxTokens },
    monitorA: { baseURL: config.monitor.baseURL, model: config.monitor.model, maxTokens: config.monitor.maxTokens },
    monitorB: { baseURL: config.monitor.baseURLB, model: config.monitor.modelB, maxTokens: config.monitor.maxTokens },
    summary: { baseURL: config.summary.baseURL, model: config.summary.model, maxTokens: config.summary.maxTokens },
    agent: { baseURL: config.agent.baseURL, model: config.agent.model, maxTokens: config.agent.maxTokens },
  })
})

router.get('/llm-calls/running', (_req: Request, res: Response) => {
  res.json(getRunningLLMCalls())
})

router.get('/llm-calls', (req: Request, res: Response) => {
  try {
    const defaultLimit = getSettings().llm_debug_fetch_limit || 200
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || String(defaultLimit), 10), 1), 2000)
    const module = req.query.module as string | undefined
    const coin = req.query.coin as string | undefined

    let sql = 'SELECT id, module, model, base_url, response, reasoning_content, error, prompt_tokens, completion_tokens, thinking_tokens, duration_ms, queue_ms, coin, cycle_id, created_at FROM llm_calls'
    const params: (string | number)[] = []
    const conditions: string[] = []

    if (module) { conditions.push('module = ?'); params.push(module) }
    if (coin) { conditions.push('coin = ?'); params.push(coin) }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    res.json(queryAll(sql, params))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/llm-calls/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
    const call = queryOne('SELECT * FROM llm_calls WHERE id = ?', [id])
    if (!call) return res.status(404).json({ error: 'Not found' })
    res.json(call)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/llm-calls', (_req: Request, res: Response) => {
  try {
    runSQL('DELETE FROM llm_calls')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/llm-stats-snapshots', (_req: Request, res: Response) => {
  try {
    const rows = queryAll('SELECT module, model, base_url, call_count, error_count, total_duration_ms, total_prompt_tokens, total_completion_tokens, total_thinking_tokens FROM llm_stats_snapshots')
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
