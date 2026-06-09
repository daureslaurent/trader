import OpenAI from 'openai'
import { runSQL } from '../db/index.js'
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
  status: 'running'
}

const _runningCalls = new Map<string, RunningLLMCall>()

export function getRunningLLMCalls(): RunningLLMCall[] {
  return Array.from(_runningCalls.values())
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
  const startMs = Date.now()
  const tempId = `tmp_${startMs}_${Math.random().toString(36).slice(2, 7)}`
  const baseUrl: string = meta.base_url ?? (client as unknown as { baseURL: string }).baseURL ?? ''

  const callStart: RunningLLMCall = {
    temp_id: tempId,
    module: meta.module,
    model: params.model,
    base_url: baseUrl,
    coin: meta.coin ?? null,
    cycle_id: meta.cycle_id ?? null,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    status: 'running',
  }
  _runningCalls.set(tempId, callStart)
  broadcast('llm_call_start', callStart)

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
