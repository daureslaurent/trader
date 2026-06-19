import { Router, Request, Response } from 'express'
import { llmCalls, llmStatsSnapshots, getSettings } from '../../db/index.js'
import { getRunningLLMCalls } from '../../core/llm.js'
import { getSchedulerState } from '../../core/llmScheduler.js'
import { getEndpointHealth, runEndpointHealthCheck } from '../../core/endpointHealth.js'
import { config } from '../../config/index.js'

export const router = Router()

// Cached health of every LLM catalog endpoint, maintained by the background
// monitor (core/endpointHealth) and pushed live over the `endpoint_health` WS
// event. The frontend badge reads this snapshot — it never drives the probing.
// On a cold start (cache still empty) we await the first check so the response is
// never blank.
router.get('/llm/endpoints/health', async (_req: Request, res: Response) => {
  try {
    const cached = getEndpointHealth()
    res.json(cached.length ? cached : await runEndpointHealthCheck())
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Force an immediate re-probe (the badge's manual "re-check" affordance). The
// fresh snapshot is also broadcast to every client via `endpoint_health`.
router.post('/llm/endpoints/health/check', async (_req: Request, res: Response) => {
  try {
    res.json(await runEndpointHealthCheck())
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

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
    entryAgent: { baseURL: config.entryAgent.baseURL, model: config.entryAgent.model, maxTokens: config.entryAgent.maxTokens },
    agent: { baseURL: config.agent.baseURL, model: config.agent.model, maxTokens: config.agent.maxTokens },
    monitorD: { baseURL: config.monitorD.baseURL, model: config.monitorD.model, maxTokens: config.monitorD.maxTokens },
    agentSignal: { baseURL: config.agentSignal.baseURL, model: config.agentSignal.model, maxTokens: config.agentSignal.maxTokens },
    webSearch: { baseURL: config.webSearch.baseURL, model: config.webSearch.model, maxTokens: config.webSearch.maxTokens },
  })
})

router.get('/llm-calls/running', (_req: Request, res: Response) => {
  res.json(getRunningLLMCalls())
})

// Live snapshot of the LLM scheduler: lane occupancy, per-gate residency, and the
// pending queue. The Control Room uses this for its initial paint, then stays in
// sync via the `llm_job_*` / `llm_model_swap` WS events.
router.get('/llm/scheduler', (_req: Request, res: Response) => {
  res.json(getSchedulerState())
})

router.get('/llm-calls', async (req: Request, res: Response) => {
  try {
    const defaultLimit = getSettings().llm_debug_fetch_limit || 200
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || String(defaultLimit), 10), 1), 2000)
    const module = req.query.module as string | undefined
    const coin = req.query.coin as string | undefined

    const filter: Record<string, unknown> = {}
    if (module) filter.module = module
    if (coin) filter.coin = coin

    res.json(await llmCalls.find(filter, {
      sort: { created_at: -1 }, limit,
      projection: { _id: 0, id: 1, module: 1, model: 1, base_url: 1, response: 1, reasoning_content: 1, error: 1, error_code: 1, error_status: 1, stream_dirty: 1, tool_calls: 1, prompt_tokens: 1, completion_tokens: 1, thinking_tokens: 1, duration_ms: 1, queue_ms: 1, coin: 1, cycle_id: 1, created_at: 1 },
    }))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/llm-calls/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
    const call = await llmCalls.findById(id)
    if (!call) return res.status(404).json({ error: 'Not found' })
    res.json(call)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/llm-calls', async (_req: Request, res: Response) => {
  try {
    await llmCalls.deleteMany({})
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/llm-stats-snapshots', async (_req: Request, res: Response) => {
  try {
    const rows = await llmStatsSnapshots.find({}, {
      projection: { _id: 0, module: 1, model: 1, base_url: 1, call_count: 1, error_count: 1, total_duration_ms: 1, total_prompt_tokens: 1, total_completion_tokens: 1, total_thinking_tokens: 1 },
    })
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
