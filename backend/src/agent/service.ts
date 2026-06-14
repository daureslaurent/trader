// The Agent chat orchestration: a native tool-calling loop. The user's message is
// persisted, then we run the model with the full tool belt; whenever it asks for
// tools we execute them, persist + stream each step, and feed the results back —
// repeating until the model returns a plain answer (or we hit the round cap).
//
// Every model call goes through `llmChat`, so each turn is recorded to `llm_calls`,
// serialized per endpoint, and fails over to the configured fallback like the rest
// of the app. Live progress is streamed to the frontend via `broadcast('agent_step')`.
import OpenAI from 'openai'
import { llmChat } from '../core/llm.js'
import type { LLMTarget } from '../core/llm.js'
import { resolveLLM } from '../config/llm.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { getSettings } from '../db/index.js'
import type { AgentMessage } from '../types.js'
import * as store from './store.js'
import { getToolSchemas, runTool, isReadOnlyTool } from './tools.js'
import { SYSTEM_PROMPT, TITLE_SYSTEM_PROMPT } from './prompts.js'

// Safety valve: how many model↔tool round-trips a single user turn may take before
// we stop and ask the user to narrow the question. Generous enough for multi-tool
// answers, small enough to bound latency/cost on a runaway loop.
const MAX_TOOL_ROUNDS = 6

// Auto-title cadence: regenerate the conversation title on the first turn and then
// every Nth user turn, so the title tracks where the chat goes without an LLM call
// every single turn. The title prompt itself only sees the last X messages (the
// `agent_title_context_messages` setting), keeping each refresh cheap.
const TITLE_REFRESH_EVERY_TURNS = 4

// One in-flight turn per conversation. A second concurrent send would interleave
// messages and confuse the transcript, so we reject it.
const inFlight = new Set<number>()

export function isGenerating(conversationId: number): boolean {
  return inFlight.has(conversationId)
}

export function getActiveAgentModel(): { model: string; baseURL: string; maxTokens: number; fallback?: LLMTarget } {
  const { model, baseURL, maxTokens, fallback } = resolveLLM('agent')
  return { model, baseURL, maxTokens, fallback }
}

type StoredToolCalls = OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]

// Replay persisted messages back into OpenAI chat format so the model sees the
// full conversation (including its own prior tool calls and the tool results).
function toOpenAIMessages(rows: AgentMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = []
  for (const r of rows) {
    if (r.role === 'assistant') {
      const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: 'assistant', content: r.content ?? '' }
      if (r.tool_calls) {
        try {
          const calls = JSON.parse(r.tool_calls) as StoredToolCalls
          if (calls.length) {
            msg.tool_calls = calls
            // Assistant messages that carry tool_calls may have null content.
            msg.content = r.content ?? null
          }
        } catch { /* fall through to plain assistant message */ }
      }
      out.push(msg)
    } else if (r.role === 'tool') {
      out.push({ role: 'tool', content: r.content ?? '', tool_call_id: r.tool_call_id ?? '' })
    } else {
      out.push({ role: 'user', content: r.content ?? '' })
    }
  }
  return out
}

function step(conversationId: number, payload: Record<string, unknown>): void {
  broadcast('agent_step', { conversation_id: conversationId, ...payload })
}

// Instant placeholder title from the first user message — shown in the rail until the
// LLM-generated title arrives (and as the fallback if title generation fails).
function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 60 ? t.slice(0, 57) + '…' : (t || 'New chat')
}

// Normalize a raw LLM title into a bare, single-line, punctuation-free string.
function cleanTitle(raw: string): string {
  let t = (raw ?? '').split('\n')[0].trim()
  t = t.replace(/^title\s*[:\-–]\s*/i, '')   // drop a "Title:" label
  t = t.replace(/^["'`*“”]+|["'`*“”]+$/g, '').trim() // strip wrapping quotes/markdown
  t = t.replace(/[.!?,;:]+$/g, '').trim()    // strip trailing punctuation
  t = t.replace(/\s+/g, ' ')
  if (t.length > 60) t = t.slice(0, 57).trimEnd() + '…'
  return t
}

// One title generation per conversation at a time (a fast follow-up turn shouldn't
// stack title calls).
const titleInFlight = new Set<number>()

// Auto-name a conversation with the agent model, summarizing only the last X
// (`agent_title_context_messages`) non-tool messages. Best-effort and fully
// detached from the chat turn: failures are logged and never surface to the user.
async function generateConversationTitle(conversationId: number): Promise<void> {
  if (titleInFlight.has(conversationId)) return
  titleInFlight.add(conversationId)
  try {
    const limit = Math.min(Math.max(getSettings().agent_title_context_messages || 6, 2), 40)
    const recent = (await store.getMessages(conversationId))
      .filter(m => m.role !== 'tool' && (m.content ?? '').trim())
      .slice(-limit)
    if (!recent.length) return

    const transcript = recent
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content ?? '').replace(/\s+/g, ' ').slice(0, 500)}`)
      .join('\n')

    const active = resolveLLM('agent')
    const resp = await llmChat(
      active.client,
      {
        model: active.model,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: `Conversation:\n${transcript}\n\nTitle:` },
        ],
        temperature: 0.3,
        // Use the model's configured max-tokens (same as the main agent calls). A tiny
        // cap breaks reasoning models (e.g. Gemma) that spend tokens on hidden
        // reasoning_content before emitting the title — they'd return empty content
        // (finish_reason: length). It's only a ceiling: a non-reasoning model stops
        // right after the short title, and cleanTitle() keeps just the first line.
        max_tokens: active.maxTokens,
      },
      { module: 'agent', cycle_id: `agent-${conversationId}-title`, base_url: active.baseURL },
      active.fallback,
    )

    const title = cleanTitle(resp.choices[0]?.message?.content ?? '')
    if (!title) return

    await store.renameConversation(conversationId, title)
    const u = resp.usage
    if (u) await store.addConversationTokens(conversationId, (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0))
    broadcast('agent_conversation_updated', { id: conversationId, title })
    logger.info('Agent conversation title generated', { conversationId, title })
  } catch (err) {
    logger.warn('Agent title generation failed', { conversationId, error: err instanceof Error ? err.message : String(err) })
  } finally {
    titleInFlight.delete(conversationId)
  }
}

export interface ChatTurnResult {
  /** All messages produced this turn (assistant tool-call messages, tool results,
   *  and the final assistant answer), in order. */
  produced: AgentMessage[]
}

export async function runChatTurn(conversationId: number, userText: string): Promise<ChatTurnResult> {
  const text = (userText ?? '').trim()
  if (!text) throw new Error('Message is empty')
  if (inFlight.has(conversationId)) throw new Error('A response is already being generated for this conversation')

  const convo = await store.getConversation(conversationId)
  if (!convo) throw new Error('Conversation not found')

  inFlight.add(conversationId)
  // Encode the conversation in the cycle id so agent calls are traceable in LLM Debug.
  const cycleId = `agent-${conversationId}-${Date.now().toString(36)}`
  const produced: AgentMessage[] = []

  // Token accounting for this turn. `turnTokens` sums every model call (a turn may make
  // several when it chains tools); `peakContext` is the largest single request, which is
  // what actually presses against the model's context window.
  let turnTokens = 0
  let peakContext = 0

  // Title auto-refresh bookkeeping (resolved in the finally once the turn succeeds).
  let succeeded = false
  let userTurns = 0

  try {
    const priorCount = (await store.getMessages(conversationId)).length

    const userMsg = await store.addMessage(conversationId, { role: 'user', content: text })
    await store.touchConversation(conversationId)
    step(conversationId, { type: 'user', message: userMsg })

    // Instant placeholder title from the first message so the rail isn't "New chat";
    // the LLM-generated title replaces it once this turn completes (see the finally).
    if (priorCount === 0 && convo.title === 'New chat') {
      await store.renameConversation(conversationId, titleFrom(text))
    }

    const active = resolveLLM('agent')
    const tools = getToolSchemas()
    const history = await store.getMessages(conversationId)
    userTurns = history.filter(m => m.role === 'user').length
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...toOpenAIMessages(history),
    ]

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      step(conversationId, { type: 'thinking' })

      const resp = await llmChat(
        active.client,
        {
          model: active.model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.4,
          max_tokens: active.maxTokens,
        },
        { module: 'agent', cycle_id: cycleId, base_url: active.baseURL },
        active.fallback,
      )

      const usage = resp.usage
      if (usage) {
        const p = usage.prompt_tokens ?? 0
        const c = usage.completion_tokens ?? 0
        turnTokens += p + c
        peakContext = Math.max(peakContext, usage.total_tokens ?? p + c)
      }

      const choice = resp.choices[0]?.message
      const toolCalls = (choice?.tool_calls ?? []) as StoredToolCalls
      const content = choice?.content ?? ''

      if (toolCalls.length > 0) {
        // Persist + echo the assistant's tool-call request, then execute each call.
        const assistantMsg = await store.addMessage(conversationId, {
          role: 'assistant',
          content: content || null,
          tool_calls: JSON.stringify(toolCalls),
        })
        produced.push(assistantMsg)
        messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })
        if (content) step(conversationId, { type: 'assistant_note', message: assistantMsg })

        for (const tc of toolCalls) {
          // Be lenient: some local servers omit `type` on tool calls. As long as a
          // function payload is present, treat it as a function call.
          if (!tc.function?.name) continue
          const name = tc.function.name
          let args: Record<string, unknown> = {}
          try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} } catch { /* bad JSON → empty args */ }

          step(conversationId, { type: 'tool_call', tool: name, args, read_only: isReadOnlyTool(name), tool_call_id: tc.id })
          const result = await runTool(name, args)
          const resultStr = JSON.stringify(result)
          const toolMsg = await store.addMessage(conversationId, {
            role: 'tool', content: resultStr, tool_call_id: tc.id, name,
          })
          produced.push(toolMsg)
          messages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id })
          step(conversationId, { type: 'tool_result', tool: name, tool_call_id: tc.id, result, message: toolMsg })
        }
        continue
      }

      // No tool calls → this is the final answer.
      const finalText = content.trim() || "I couldn't produce a response. Please try rephrasing."
      const finalMsg = await store.addMessage(conversationId, { role: 'assistant', content: finalText })
      produced.push(finalMsg)
      await store.touchConversation(conversationId)
      step(conversationId, { type: 'assistant', message: finalMsg })
      succeeded = true
      return { produced }
    }

    // Exhausted the round budget without a plain answer.
    const capMsg = await store.addMessage(conversationId, {
      role: 'assistant',
      content: 'I gathered a lot of data but hit the tool-call limit before wrapping up. Could you narrow the question a bit?',
    })
    produced.push(capMsg)
    step(conversationId, { type: 'assistant', message: capMsg })
    succeeded = true
    return { produced }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Agent chat turn failed', { conversationId, error: message })
    step(conversationId, { type: 'error', error: message })
    throw err
  } finally {
    // Persist token usage for the turn (even on error — those tokens were still spent).
    if (turnTokens > 0) {
      try { await store.recordConversationUsage(conversationId, turnTokens, peakContext) } catch { /* non-fatal */ }
    }
    // Auto-(re)name the conversation on the first turn and periodically as it grows.
    // Fire-and-forget so it never delays the reply the user is waiting on.
    if (succeeded && (userTurns === 1 || userTurns % TITLE_REFRESH_EVERY_TURNS === 0)) {
      void generateConversationTitle(conversationId)
    }
    inFlight.delete(conversationId)
  }
}
