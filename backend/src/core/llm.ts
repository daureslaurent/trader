import OpenAI from 'openai'
import { runSQL, getSettings } from '../db/index.js'
import { broadcast } from '../api/ws.js'
import { logger } from './logger.js'

export interface LLMCallMeta {
  module: string
  coin?: string | null
  cycle_id?: string | null
  base_url?: string
}

export interface RunningLLMCall {
  temp_id: string
  module: string
  model: string
  base_url: string
  coin: string | null
  cycle_id: string | null
  created_at: string
  /** 'queued' = waiting for the per-URL slot; 'running' = request in flight. */
  status: 'queued' | 'running'
  /**
   * When the request actually went in flight. Equals `created_at` when the call
   * never queued; `null` while still waiting in line. Lets the UI separate queue
   * wait (created_at → running_at) from inference latency (running_at → done).
   */
  running_at: string | null
}

const _runningCalls = new Map<string, RunningLLMCall>()

export function getRunningLLMCalls(): RunningLLMCall[] {
  return Array.from(_runningCalls.values())
}

// Per-key concurrency gating via counting semaphores. Local LLM servers
// (Ollama / llama.cpp) typically process one request at a time; firing concurrent
// requests at the same endpoint just adds queueing latency and memory pressure. So
// by default a given base URL is capped at one in-flight call (a gate with limit
// 1), while calls to *different* URLs run in parallel. A catalog endpoint flagged
// `parallel` lifts that cap, or — when it sets a `maxParallel` limit — runs under a
// gate keyed by endpoint (base URL + model) at that limit. `llm_allow_parallel_same_url`
// lifts the global limit-1 default for every URL (per-endpoint limits still apply).
interface Gate {
  /** Permits currently held (in-flight calls). */
  active: number
  /** Resolvers for calls waiting for a permit, FIFO. */
  queue: (() => void)[]
}
const _gates = new Map<string, Gate>()

/** True when a gate is at capacity, so a new call would have to wait in line. */
function gateAtCapacity(key: string, limit: number): boolean {
  const g = _gates.get(key)
  return !!g && g.active >= limit
}

// Run `task` under a counting semaphore keyed by `key` with the given `limit`. A
// freed permit is handed directly to the next waiter (the active count is never
// dropped mid-handoff), so capacity is respected without races. A prior failure
// never breaks the gate for later callers; idle gates are dropped to free memory.
async function runLimited<T>(key: string, limit: number, task: () => Promise<T>): Promise<T> {
  let g = _gates.get(key)
  if (!g) { g = { active: 0, queue: [] }; _gates.set(key, g) }
  if (g.active >= limit) {
    await new Promise<void>(resolve => g!.queue.push(resolve))
    // Inherited a permit handed over by the releasing call; `active` already counts us.
  } else {
    g.active++
  }
  try {
    return await task()
  } finally {
    const next = g.queue.shift()
    if (next) {
      next() // hand our permit to the next waiter; active stays the same
    } else {
      g.active--
      if (g.active <= 0 && g.queue.length === 0) _gates.delete(key)
    }
  }
}

/** The catalog entry matching this base URL + model, if any (first match). */
function findCatalogEndpoint(baseURL: string, model: string) {
  return getSettings().llm_endpoints.find(e => e.baseURL.trim() === baseURL && e.model.trim() === model)
}

/**
 * The concurrency gate for a call, or null for unlimited parallelism:
 *   • serialized (limit 1, keyed by base URL) — default for a one-at-a-time server
 *   • parallel + a per-endpoint max — keyed by endpoint at that limit
 *   • parallel + no max — null (no gate)
 */
function resolveGate(baseURL: string, model: string): { key: string; limit: number } | null {
  const ep = findCatalogEndpoint(baseURL, model)
  const parallel = getSettings().llm_allow_parallel_same_url || ep?.parallel === true
  if (!parallel) return { key: baseURL, limit: 1 }
  const max = ep?.maxParallel ?? 0
  return max > 0 ? { key: `${baseURL}::${model}`, limit: max } : null
}

// OpenAI clients are cheap to reuse but shouldn't be rebuilt on every call. We
// memoize one per base URL so that runtime endpoint switches (via per-module
// settings) take effect immediately while still reusing connections.
const _clients = new Map<string, OpenAI>()

export function getClient(baseURL: string): OpenAI {
  let client = _clients.get(baseURL)
  if (!client) {
    client = new OpenAI({ baseURL, apiKey: 'ollama' })
    _clients.set(baseURL, client)
  }
  return client
}

/** Result of a lightweight reachability probe against an endpoint's base URL. */
export interface EndpointPing {
  ok: boolean
  /** Round-trip time of the probe in ms. */
  latencyMs: number
  /** Model ids advertised by the server's `/models` (empty if unreachable or none). */
  models: string[]
  /** Failure reason when `ok` is false. */
  error?: string
}

/**
 * Probes an OpenAI-compatible endpoint's health by listing its models — the
 * cheapest standard call that proves the server is reachable and responsive.
 * Retries are disabled and a short timeout is applied so a dead endpoint resolves
 * quickly rather than hanging the caller. Never throws: failures come back as
 * `{ ok: false, error }`.
 */
export async function pingEndpoint(baseURL: string, timeoutMs = 4000): Promise<EndpointPing> {
  const start = Date.now()
  try {
    const res = await getClient(baseURL).models.list({ timeout: timeoutMs, maxRetries: 0 })
    const models = (res.data ?? []).map(m => m.id).filter(Boolean)
    return { ok: true, latencyMs: Date.now() - start, models }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, models: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function extractText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p: unknown) => typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text')
      .map((p: unknown) => (p as { text: string }).text)
      .join('')
  }
  return String(content)
}

/**
 * A concrete endpoint+model the chat can run against. The primary is derived from
 * the `client`/`params` passed to `llmChat`; an optional `fallback` of this shape
 * is tried only if the primary call throws (connection refused, timeout, 5xx,
 * unknown model, …). `maxTokens` overrides the request's `max_tokens` for the
 * fallback attempt only — leave undefined to reuse the primary request's value.
 */
export interface LLMTarget {
  client: OpenAI
  model: string
  baseURL: string
  maxTokens?: number
}

function clientBaseURL(client: OpenAI): string {
  return (client as unknown as { baseURL: string }).baseURL ?? ''
}

/**
 * Run a chat completion with automatic failover. The primary target is the
 * `client` + `params.model` pair; if `fallback` is supplied and the primary call
 * *throws*, the same prompt is retried once against the fallback endpoint/model.
 *
 * Each attempt is recorded as its own `llm_calls` row (under its real base_url /
 * model), so a failover shows up as a failed primary row followed by a fallback
 * row — fully visible in the LLM activity views. An empty-but-non-throwing
 * response is NOT treated as a primary failure: that contract is unchanged and
 * left for each module's own parse/retry logic.
 */
export async function llmChat(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParams,
  meta: LLMCallMeta,
  fallback?: LLMTarget,
): Promise<OpenAI.ChatCompletion> {
  const primary: LLMTarget = {
    client,
    model: params.model,
    baseURL: meta.base_url ?? clientBaseURL(client),
  }
  const targets: LLMTarget[] = fallback ? [primary, fallback] : [primary]

  let lastErr: unknown
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    const isFallback = i > 0
    // Swap in the fallback's model (and optional max-tokens) for its attempt; the
    // primary attempt reuses the caller's params untouched.
    const attemptParams: OpenAI.ChatCompletionCreateParams = isFallback
      ? { ...params, model: target.model, ...(target.maxTokens ? { max_tokens: target.maxTokens } : {}) }
      : params
    try {
      return await runChat(target, attemptParams, meta)
    } catch (err) {
      lastErr = err
      if (!isFallback && fallback) {
        logger.warn('LLM primary failed — failing over to fallback', {
          module: meta.module,
          coin: meta.coin ?? null,
          primary: `${primary.model} @ ${primary.baseURL}`,
          fallback: `${fallback.model} @ ${fallback.baseURL}`,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      throw err
    }
  }
  throw lastErr
}

// Single attempt against one endpoint/model. Records the running call, serializes
// per base URL, performs the request and logs the result to `llm_calls`. Throws
// on transport/API errors so the caller (llmChat) can decide whether to fail over.
async function runChat(
  target: LLMTarget,
  params: OpenAI.ChatCompletionCreateParams,
  meta: LLMCallMeta,
): Promise<OpenAI.ChatCompletion> {
  const client = target.client
  const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const baseUrl: string = target.baseURL

  // Pick this call's concurrency gate (serialized, capped-parallel, or unlimited).
  // A call that arrives while its gate is at capacity starts "queued" and flips to
  // "running" once it reaches the front of the waiting list.
  const gate = resolveGate(baseUrl, params.model)

  const toTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
  const enqueuedMs = Date.now()
  const queued = !!gate && gateAtCapacity(gate.key, gate.limit)

  const callStart: RunningLLMCall = {
    temp_id: tempId,
    module: meta.module,
    model: params.model,
    base_url: baseUrl,
    coin: meta.coin ?? null,
    cycle_id: meta.cycle_id ?? null,
    created_at: toTs(enqueuedMs),
    status: queued ? 'queued' : 'running',
    running_at: queued ? null : toTs(enqueuedMs),
  }
  _runningCalls.set(tempId, callStart)
  broadcast('llm_call_start', callStart)

  // The actual request. Inference latency (`duration_ms`) is measured from here,
  // not from enqueue time, so it reflects only the LLM's own latency. Time spent
  // waiting in line is captured separately as `queue_ms` so neither is lost.
  const exec = async (): Promise<OpenAI.ChatCompletion> => {
    const startMs = Date.now()
    // Only calls that actually waited in line have a queue wait; a call that went
    // straight to flight reports 0 rather than a sub-ms scheduling artifact.
    const queueMs = callStart.status === 'queued' ? Math.max(0, startMs - enqueuedMs) : 0
    if (callStart.status === 'queued') {
      callStart.status = 'running'
      callStart.running_at = toTs(startMs)
      broadcast('llm_call_status', { temp_id: tempId, status: 'running', running_at: callStart.running_at })
    }
    let resp: OpenAI.ChatCompletion | null = null
    let errMsg: string | null = null

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resp = (await (client.chat.completions.create as any)(params)) as OpenAI.ChatCompletion
      return resp
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      const durationMs = Date.now() - startMs
      const systemMsg = params.messages.find(m => m.role === 'system')
      const userMsg = params.messages.find(m => m.role === 'user')
      const systemPrompt = extractText(systemMsg?.content)
      const userPrompt = extractText(userMsg?.content)
      const responseText = resp?.choices[0]?.message?.content ?? null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reasoningContent: string | null = (resp?.choices[0]?.message as any)?.reasoning_content ?? null
      // Tool/function calls the model requested this turn. A response that carries
      // tool_calls legitimately has empty `content` (the model is calling a tool, not
      // talking), so we record the calls and must NOT treat the empty content as an error.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolCallsArr = (resp?.choices[0]?.message as any)?.tool_calls
      const toolCallsJson: string | null =
        Array.isArray(toolCallsArr) && toolCallsArr.length ? JSON.stringify(toolCallsArr) : null
      // Method A: explicit field from newer llama.cpp. Method B: estimate from reasoning_content length (~4 chars/token).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const thinkingTokens: number | null =
        (resp?.usage as any)?.completion_tokens_details?.reasoning_tokens ??
        (reasoningContent ? Math.ceil(reasoningContent.length / 4) : null)

      // If the API returned without throwing but produced neither content nor a tool
      // call, synthesize an error so the call is flagged and the raw response is visible
      // in the UI. A tool-call turn (content empty, tool_calls present) is NOT an error.
      let effectiveError = errMsg
      if (!effectiveError && resp && !responseText && !toolCallsJson) {
        const finish = resp.choices[0]?.finish_reason ?? 'unknown'
        effectiveError = `Empty content (finish_reason: ${finish})\n\nRaw response:\n${JSON.stringify(resp, null, 2)}`
      }

      logger.debug('llmChat base_url', { module: meta.module, baseUrl, meta_base_url: meta.base_url, client_base_url: (client as unknown as { baseURL: string }).baseURL })

      _runningCalls.delete(tempId)

      try {
        const { lastInsertRowid } = runSQL(
          `INSERT INTO llm_calls
            (module, model, base_url, system_prompt, user_prompt, response, reasoning_content, error, prompt_tokens, completion_tokens, thinking_tokens, duration_ms, queue_ms, coin, cycle_id, tool_calls)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.module,
            params.model,
            baseUrl,
            systemPrompt,
            userPrompt,
            responseText,
            reasoningContent,
            effectiveError,
            resp?.usage?.prompt_tokens ?? null,
            resp?.usage?.completion_tokens ?? null,
            thinkingTokens,
            durationMs,
            queueMs,
            meta.coin ?? null,
            meta.cycle_id ?? null,
            toolCallsJson,
          ],
        )

        broadcast('llm_call', {
          id: Number(lastInsertRowid),
          temp_id: tempId,
          module: meta.module,
          model: params.model,
          base_url: baseUrl,
          response: responseText,
          reasoning_content: reasoningContent,
          tool_calls: toolCallsJson,
          error: effectiveError,
          prompt_tokens: resp?.usage?.prompt_tokens ?? null,
          completion_tokens: resp?.usage?.completion_tokens ?? null,
          thinking_tokens: thinkingTokens,
          duration_ms: durationMs,
          queue_ms: queueMs,
          coin: meta.coin ?? null,
          cycle_id: meta.cycle_id ?? null,
          created_at: callStart.created_at,
        })
      } catch (dbErr) {
        logger.warn('Failed to log LLM call', { module: meta.module, error: (dbErr as Error).message })
      }
    }
  }

  return gate ? runLimited(gate.key, gate.limit, exec) : exec()
}
