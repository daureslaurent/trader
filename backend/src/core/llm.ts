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
}

const _runningCalls = new Map<string, RunningLLMCall>()

export function getRunningLLMCalls(): RunningLLMCall[] {
  return Array.from(_runningCalls.values())
}

// Per-base-URL serialization. Local LLM servers (Ollama / llama.cpp) typically
// process one request at a time; firing concurrent requests at the same
// endpoint just adds queueing latency and memory pressure on the server. When
// `llm_allow_parallel_same_url` is off (the default) we chain calls to a given
// base URL so they run one-at-a-time, while calls to *different* URLs still run
// in parallel. The chain is the "waiting list": each new call awaits the tail.
const _urlChains = new Map<string, Promise<unknown>>()

/** True when a call to this base URL is already queued or in flight. */
function isUrlBusy(baseURL: string): boolean {
  return _urlChains.has(baseURL)
}

// Run `task` after any pending call to the same base URL, returning task's own
// result/error. A prior failure never breaks the chain for later callers, and
// the map entry is dropped once this call is the tail so idle URLs free memory.
function runSerialized<T>(baseURL: string, task: () => Promise<T>): Promise<T> {
  const prev = _urlChains.get(baseURL) ?? Promise.resolve()
  const next = prev.then(task, task)
  _urlChains.set(baseURL, next)
  void next.catch(() => {}).then(() => {
    if (_urlChains.get(baseURL) === next) _urlChains.delete(baseURL)
  })
  return next
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

export async function llmChat(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParams,
  meta: LLMCallMeta,
): Promise<OpenAI.ChatCompletion> {
  const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const baseUrl: string = meta.base_url ?? (client as unknown as { baseURL: string }).baseURL ?? ''

  // Serialize per URL unless the user has opted into parallel same-URL calls. A
  // call that arrives while its endpoint is busy starts "queued" and flips to
  // "running" once it reaches the front of the per-URL waiting list.
  const serialize = !getSettings().llm_allow_parallel_same_url

  const callStart: RunningLLMCall = {
    temp_id: tempId,
    module: meta.module,
    model: params.model,
    base_url: baseUrl,
    coin: meta.coin ?? null,
    cycle_id: meta.cycle_id ?? null,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    status: serialize && isUrlBusy(baseUrl) ? 'queued' : 'running',
  }
  _runningCalls.set(tempId, callStart)
  broadcast('llm_call_start', callStart)

  // The actual request. Duration is measured here (not at enqueue time) so a
  // queued call's reported latency excludes the time spent waiting in line.
  const exec = async (): Promise<OpenAI.ChatCompletion> => {
    if (callStart.status === 'queued') {
      callStart.status = 'running'
      broadcast('llm_call_status', { temp_id: tempId, status: 'running' })
    }
    const startMs = Date.now()
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
      // Method A: explicit field from newer llama.cpp. Method B: estimate from reasoning_content length (~4 chars/token).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const thinkingTokens: number | null =
        (resp?.usage as any)?.completion_tokens_details?.reasoning_tokens ??
        (reasoningContent ? Math.ceil(reasoningContent.length / 4) : null)

      // If the API returned without throwing but the content is empty, synthesize an
      // error so the call is flagged and the raw response is visible in the UI.
      let effectiveError = errMsg
      if (!effectiveError && resp && !responseText) {
        const finish = resp.choices[0]?.finish_reason ?? 'unknown'
        effectiveError = `Empty content (finish_reason: ${finish})\n\nRaw response:\n${JSON.stringify(resp, null, 2)}`
      }

      logger.debug('llmChat base_url', { module: meta.module, baseUrl, meta_base_url: meta.base_url, client_base_url: (client as unknown as { baseURL: string }).baseURL })

      _runningCalls.delete(tempId)

      try {
        const { lastInsertRowid } = runSQL(
          `INSERT INTO llm_calls
            (module, model, base_url, system_prompt, user_prompt, response, reasoning_content, error, prompt_tokens, completion_tokens, thinking_tokens, duration_ms, coin, cycle_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            meta.coin ?? null,
            meta.cycle_id ?? null,
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
          error: effectiveError,
          prompt_tokens: resp?.usage?.prompt_tokens ?? null,
          completion_tokens: resp?.usage?.completion_tokens ?? null,
          thinking_tokens: thinkingTokens,
          duration_ms: durationMs,
          coin: meta.coin ?? null,
          cycle_id: meta.cycle_id ?? null,
          created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      } catch (dbErr) {
        logger.warn('Failed to log LLM call', { module: meta.module, error: (dbErr as Error).message })
      }
    }
  }

  return serialize ? runSerialized(baseUrl, exec) : exec()
}
