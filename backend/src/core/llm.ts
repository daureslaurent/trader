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

    const baseUrl: string = meta.base_url ?? (client as unknown as { baseURL: string }).baseURL ?? ''

    logger.debug('llmChat base_url', { module: meta.module, baseUrl, meta_base_url: meta.base_url, client_base_url: (client as unknown as { baseURL: string }).baseURL })

    try {
      const { lastInsertRowid } = runSQL(
        `INSERT INTO llm_calls
          (module, model, base_url, system_prompt, user_prompt, response, error, prompt_tokens, completion_tokens, duration_ms, coin, cycle_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.module,
          params.model,
          baseUrl,
          systemPrompt,
          userPrompt,
          responseText,
          errMsg,
          resp?.usage?.prompt_tokens ?? null,
          resp?.usage?.completion_tokens ?? null,
          durationMs,
          meta.coin ?? null,
          meta.cycle_id ?? null,
        ],
      )

      broadcast('llm_call', {
        id: Number(lastInsertRowid),
        module: meta.module,
        model: params.model,
        base_url: baseUrl,
        response: responseText,
        error: errMsg,
        prompt_tokens: resp?.usage?.prompt_tokens ?? null,
        completion_tokens: resp?.usage?.completion_tokens ?? null,
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
