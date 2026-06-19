import OpenAI from 'openai'
import { llmCalls, getSettings, nowSql } from '../db/index.js'
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
  /** True when this call streams its tokens — the UI shows a live token view and
   *  expects `llm_call_chunk` events for this temp_id rather than a "waiting" spinner. */
  stream?: boolean
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

/**
 * The physical concurrency gate a call to this endpoint+model would run under, or
 * null for unlimited parallelism. Exposed so the LLM scheduler can mirror the same
 * limit when admitting jobs — when the scheduler never admits more than `limit`
 * concurrent calls per gate key, `runChat`'s own `runLimited` becomes a no-op
 * pass-through and the scheduler's priority/affinity ordering is authoritative.
 *
 * The gate KEY is the unit of model contention: a serialized one-server endpoint is
 * keyed by base URL alone, so multiple models pointed at it share one gate and a
 * model swap is real — that is exactly where model-affinity batching pays off. A
 * capped-parallel endpoint is keyed by base URL + model, so each model has its own
 * lane and affinity is a no-op (the single-fixed-model deployment case).
 */
export function endpointGate(baseURL: string, model: string): { key: string; limit: number } | null {
  return resolveGate(baseURL, model)
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

// Transient transport failures: the socket dropped before a clean response was received
// (server closed keep-alive mid-body, reset, network/DNS blip). Re-issuing the same prompt
// at the same endpoint is safe and usually succeeds — distinct from API/4xx errors, which
// reflect a real rejection and must NOT be retried. The undici cause message is folded in
// because OpenAI's fetch wrapper often nests the real reason there ("Premature close").
const TRANSIENT_RE = /premature close|econnreset|socket hang ?up|terminated|fetch failed|und_err|epipe|enotfound|eai_again|network|connection (?:closed|reset|aborted)|timeout|timed out/i
function isTransientTransportError(err: unknown): boolean {
  const cause = (err as { cause?: { message?: string; code?: string } } | undefined)?.cause
  const msg = `${err instanceof Error ? err.message : String(err)} ${cause?.message ?? ''} ${cause?.code ?? ''}`
  return TRANSIENT_RE.test(msg)
}

/**
 * Structured diagnostics extracted from a thrown LLM error. "Premature close" and
 * friends arrive wrapped by the OpenAI SDK (an `APIConnectionError`) around an
 * undici fetch error whose *real* reason lives in a nested `.cause` chain — the
 * surface `.message` alone ("Premature close") tells you nothing about whether the
 * server reset the socket, hit a keep-alive timeout, or died mid-body. This walks
 * the whole error+cause chain to surface the deepest transport `code`
 * (ECONNRESET / UND_ERR_SOCKET / ETIMEDOUT …) and any HTTP `status`, and builds a
 * multi-line description that records every link in the chain.
 */
interface LLMErrorInfo {
  /** Human-readable, multi-line: every error/cause link with its name, code, message. */
  message: string
  /** Deepest transport/error code found in the chain (e.g. ECONNRESET, UND_ERR_SOCKET). */
  code: string | null
  /** HTTP status from an OpenAI APIError, if the failure was an API response (not transport). */
  status: number | null
}

function describeLLMError(err: unknown): LLMErrorInfo {
  if (!(err instanceof Error) && typeof err !== 'object') {
    return { message: String(err), code: null, status: null }
  }
  const lines: string[] = []
  let code: string | null = null
  let status: number | null = null
  let node: unknown = err
  const seen = new Set<unknown>()
  let depth = 0
  // Cap the walk so a self-referential cause chain can't loop forever.
  while (node && typeof node === 'object' && !seen.has(node) && depth < 8) {
    seen.add(node)
    const e = node as { name?: string; message?: string; code?: string; status?: number; cause?: unknown }
    const name = e.name ?? (node instanceof Error ? 'Error' : 'Object')
    const parts = [`${name}: ${e.message ?? String(node)}`]
    if (e.code) { parts.push(`code=${e.code}`); code = String(e.code) }
    if (typeof e.status === 'number') { parts.push(`status=${e.status}`); if (status === null) status = e.status }
    lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`)
    node = e.cause
    depth++
  }
  return { message: lines.join('\n'), code, status }
}

// Bounded same-endpoint retries for transient transport errors. 0 disables (failover only).
const _envRetries = Number(process.env.LLM_TRANSPORT_RETRIES)
const TRANSPORT_RETRIES = Number.isFinite(_envRetries) && _envRetries >= 0 ? _envRetries : 2

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// runChat + a bounded same-endpoint retry on transient transport errors. Each attempt is
// its own runChat (so it logs its own `llm_calls` row and the retries stay visible). A
// non-transient error throws immediately so llmChat's fallback logic can take over.
async function runChatWithRetry(
  target: LLMTarget,
  params: OpenAI.ChatCompletionCreateParams,
  meta: LLMCallMeta,
): Promise<OpenAI.ChatCompletion> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt++) {
    try {
      return await runChat(target, params, meta)
    } catch (err) {
      lastErr = err
      if (attempt < TRANSPORT_RETRIES && isTransientTransportError(err)) {
        const backoffMs = 400 * 2 ** attempt
        logger.warn('LLM transient transport error — retrying same endpoint', {
          module: meta.module,
          coin: meta.coin ?? null,
          target: `${target.model} @ ${target.baseURL}`,
          attempt: attempt + 1,
          retries: TRANSPORT_RETRIES,
          backoffMs,
          error: err instanceof Error ? err.message : String(err),
        })
        await sleep(backoffMs)
        continue
      }
      throw err
    }
  }
  throw lastErr
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
      return await runChatWithRetry(target, attemptParams, meta)
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

/** Per-module streaming flag (default ON). Keyed by the base module name so call
 *  variants (e.g. `extractor-challenge`) follow their base module's setting. An
 *  unmapped/absent key streams by default; only an explicit `false` disables it. */
function streamEnabled(module: string): boolean {
  const base = module.split('-')[0]
  const val = (getSettings() as unknown as Record<string, unknown>)[`llm_stream_${base}`]
  return val !== false
}

// In-progress accumulation of a streamed completion.
interface StreamAcc {
  content: string
  reasoning: string
  tools: { id?: string; type?: string; function: { name?: string; arguments: string } }[]
}

/**
 * Run a chat completion in streaming mode and reconstruct the equivalent
 * non-streaming `ChatCompletion`. Tokens are accumulated as they arrive and
 * broadcast (throttled, keyed by `tempId`) as `llm_call_chunk` events for the live
 * LLM Debug view. The returned object is shaped exactly like a normal completion
 * (content / reasoning_content / tool_calls / usage / finish_reason), so callers
 * are unaffected — only the transport changes. A mid-stream error propagates to the
 * caller, so the existing transient-retry / failover paths still apply unchanged.
 */
async function runStreaming(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParams,
  tempId: string,
): Promise<OpenAI.ChatCompletion> {
  const streamParams = { ...params, stream: true, stream_options: { include_usage: true } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (await (client.chat.completions.create as any)(streamParams)) as AsyncIterable<OpenAI.ChatCompletionChunk>

  const acc: StreamAcc = { content: '', reasoning: '', tools: [] }
  let finishReason: string | null = null
  let usage: OpenAI.CompletionUsage | undefined
  let respId = `chatcmpl-${tempId}`
  let created = Math.floor(Date.now() / 1000)
  let model = params.model

  // Throttle WS chunk broadcasts: coalesce deltas and flush at most every ~50ms,
  // so a fast token stream produces ≤~20 messages/sec rather than one per token.
  // No timers — a final forced flush guarantees the tail is delivered.
  let pendingContent = ''
  let pendingReasoning = ''
  let toolsDirty = false
  let lastFlush = 0
  const flush = (force: boolean): void => {
    const now = Date.now()
    if (!force && now - lastFlush < 50) return
    if (!pendingContent && !pendingReasoning && !toolsDirty) return
    broadcast('llm_call_chunk', {
      temp_id: tempId,
      ...(pendingContent ? { content: pendingContent } : {}),
      ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
      ...(toolsDirty ? { tools: acc.tools.map((t, i) => ({ index: i, name: t.function.name ?? '', args: t.function.arguments })) } : {}),
    })
    pendingContent = ''
    pendingReasoning = ''
    toolsDirty = false
    lastFlush = now
  }

  let streamThrew: unknown = null
  try {
    for await (const chunk of stream) {
      if (chunk.id) respId = chunk.id
      if (chunk.created) created = chunk.created
      if (chunk.model) model = chunk.model
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      if (!choice) continue // usage-only final chunk carries no choices
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta as (OpenAI.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string }) | undefined
      if (!delta) continue
      if (delta.content) { acc.content += delta.content; pendingContent += delta.content }
      if (delta.reasoning_content) { acc.reasoning += delta.reasoning_content; pendingReasoning += delta.reasoning_content }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0
          let slot = acc.tools[i]
          if (!slot) { slot = acc.tools[i] = { type: 'function', function: { name: undefined, arguments: '' } } }
          if (tc.id) slot.id = tc.id
          if (tc.type) slot.type = tc.type
          if (tc.function?.name) slot.function.name = tc.function.name
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
        }
        toolsDirty = true
      }
      flush(false)
    }
  } catch (err) {
    streamThrew = err
  }
  flush(true)

  const tools = acc.tools.filter(Boolean)

  // Local llama.cpp servers frequently tear down the SSE socket uncleanly *after*
  // the model has already finished a turn — especially tool-call turns (the trailing
  // usage chunk path is the common offender) — which surfaces as
  // ERR_STREAM_PREMATURE_CLOSE even though the whole response was already received.
  // If we have a terminal signal (an explicit finish_reason, or fully-formed tool
  // calls with parseable arguments), the result is complete, so trust what we
  // accumulated. Otherwise the stream was genuinely cut mid-generation: rethrow and
  // let the transient-retry / failover paths take over.
  if (streamThrew) {
    const parseable = (s: string): boolean => {
      const t = s.trim()
      if (!t) return false
      try { JSON.parse(t); return true } catch { /* fall through to embedded-slice */ }
      // Tolerate surrounding prose/fences: parse the outermost {...} or [...] slice.
      const obj = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)
      if (obj.length > 1) { try { JSON.parse(obj); return true } catch { /* not it */ } }
      const arr = t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)
      if (arr.length > 1) { try { JSON.parse(arr); return true } catch { /* not it */ } }
      return false
    }
    // A turn is "complete" — and a dirty socket close is therefore harmless — if the
    // model gave us a terminal signal (finish_reason), fully-formed tool calls, or a
    // content body that parses as complete JSON (the structured modules' final answer
    // streamed whole, the server just dropped the terminating chunk). A truncated
    // mid-generation stream satisfies none of these → rethrow for retry/failover.
    const toolsComplete = tools.length > 0 && tools.every(t => !!t.function.name && parseable(t.function.arguments))
    const contentComplete = parseable(acc.content)
    if (!finishReason && !toolsComplete && !contentComplete) throw streamThrew
    logger.warn('LLM stream closed uncleanly after completion — using accumulated result', {
      error: streamThrew instanceof Error ? streamThrew.message : String(streamThrew),
      finish_reason: finishReason,
      tool_calls: tools.length,
      content_chars: acc.content.length,
    })
    if (!finishReason) finishReason = tools.length ? 'tool_calls' : 'stop'
  }

  // Reassemble the message exactly as a non-streaming response would carry it:
  // content null when empty (so the empty-content/tool-call detection downstream is
  // unchanged), reasoning_content only when present, tool_calls only when requested.
  const message: Record<string, unknown> = { role: 'assistant', content: acc.content ? acc.content : null }
  if (acc.reasoning) message.reasoning_content = acc.reasoning
  if (tools.length) {
    message.tool_calls = tools.map(t => ({
      id: t.id ?? '',
      type: t.type ?? 'function',
      function: { name: t.function.name ?? '', arguments: t.function.arguments },
    }))
  }

  return {
    id: respId,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      finish_reason: (finishReason ?? 'stop') as OpenAI.ChatCompletion.Choice['finish_reason'],
      message: message as unknown as OpenAI.ChatCompletionMessage,
      logprobs: null,
    }],
    usage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as OpenAI.ChatCompletion
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
  const willStream = streamEnabled(meta.module)

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
    stream: willStream,
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
    let errInfo: LLMErrorInfo | null = null

    try {
      if (willStream) {
        resp = await runStreaming(client, params, tempId)
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resp = (await (client.chat.completions.create as any)(params)) as OpenAI.ChatCompletion
      }
      return resp
    } catch (err) {
      // Capture the full error+cause chain (transport code, HTTP status) — the
      // surface message ("Premature close") loses the real reason otherwise.
      errInfo = describeLLMError(err)
      errMsg = errInfo.message
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
        const insertedId = await llmCalls.insert({
          module: meta.module,
          model: params.model,
          base_url: baseUrl,
          system_prompt: systemPrompt,
          user_prompt: userPrompt,
          response: responseText,
          reasoning_content: reasoningContent,
          error: effectiveError,
          // Structured failure diagnostics, queryable for triage (e.g. group the
          // "Premature close" floods by error_code to see ECONNRESET vs timeout).
          error_code: errInfo?.code ?? null,
          error_status: errInfo?.status ?? null,
          // Requested generation cap — long max_tokens correlates with mid-body drops.
          max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens : null,
          prompt_tokens: resp?.usage?.prompt_tokens ?? null,
          completion_tokens: resp?.usage?.completion_tokens ?? null,
          thinking_tokens: thinkingTokens,
          duration_ms: durationMs,
          queue_ms: queueMs,
          coin: meta.coin ?? null,
          cycle_id: meta.cycle_id ?? null,
          tool_calls: toolCallsJson,
          created_at: nowSql(),
        })

        broadcast('llm_call', {
          id: Number(insertedId),
          temp_id: tempId,
          module: meta.module,
          model: params.model,
          base_url: baseUrl,
          response: responseText,
          reasoning_content: reasoningContent,
          tool_calls: toolCallsJson,
          error: effectiveError,
          error_code: errInfo?.code ?? null,
          error_status: errInfo?.status ?? null,
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
