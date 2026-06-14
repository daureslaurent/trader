import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import { resolveLLM } from '../config/llm.js'
import { MarketContext, Signal, BotSettings } from '../types.js'
import { buildEntryPlannerPrompt } from './prompts.js'
import { EntryPlan, EntryBand } from './types.js'

interface PlanArgs {
  coin: string
  /** Decision-time price the band percentages are measured against. */
  price: number
  market: MarketContext
  signal: Signal
  settings: BotSettings
}

/**
 * Parse and validate the planner response. Every numeric field must be a finite
 * number > 0 (pullback may be 0), and invalidate must sit below the pullback
 * target. Anything off → null, so the caller falls back to the static settings.
 */
function parsePlan(content: string): EntryPlan | null {
  if (!content.trim()) return null
  let parsed: Record<string, unknown>
  try {
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    parsed = JSON.parse(stripped) as Record<string, unknown>
  } catch {
    return null
  }

  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    return Number.isFinite(n) ? n : null
  }

  const pullbackPct = num(parsed.pullback_pct)
  const invalidatePct = num(parsed.invalidate_pct)
  const chaseCapPct = num(parsed.chase_cap_pct)
  const ttlMinutes = num(parsed.ttl_minutes)

  // Trust the LLM (per the design): no clamping — only reject values that would
  // produce a nonsensical band (negative / zero where a positive is required, or
  // an invalidate at/above the buy target).
  if (pullbackPct == null || pullbackPct < 0) return null
  if (invalidatePct == null || invalidatePct <= pullbackPct) return null
  if (chaseCapPct == null || chaseCapPct <= 0) return null
  if (ttlMinutes == null || ttlMinutes <= 0) return null

  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim()
    : 'LLM-decided entry band'

  return { pullbackPct, invalidatePct, chaseCapPct, ttlMinutes, reason }
}

/**
 * Ask the Entry Planner LLM for a per-coin entry band. Returns the plan, or null
 * on any failure (endpoint down, parse error, invalid levels) so callers fall
 * back cleanly to the static `entry_*` settings.
 */
export async function planEntry(args: PlanArgs): Promise<EntryPlan | null> {
  const { coin, price, market, signal, settings } = args
  const { system, user } = buildEntryPlannerPrompt(coin, price, market, signal, settings)
  const llm = resolveLLM('entryPlanner')
  logger.info('Request LLM', { module: 'entryPlanner', coin, model: llm.model })

  const params: OpenAI.ChatCompletionCreateParams = {
    model: llm.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: llm.maxTokens,
    response_format: { type: 'json_object' },
  }

  try {
    const resp = await llmChat(llm.client, params, { module: 'entryPlanner', coin, base_url: llm.baseURL }, llm.fallback)
    const content = resp.choices[0]?.message?.content ?? ''
    const plan = parsePlan(content)
    if (!plan) {
      logger.warn('Entry planner returned unusable output, falling back to static band', { coin, raw: content.substring(0, 200) })
      return null
    }
    logger.info('Entry plan from LLM', { coin, ...plan })
    return plan
  } catch (err) {
    const e = err as { message?: string; status?: number }
    logger.warn('Entry planner LLM failed, falling back to static band', {
      coin, message: e.message, status: e.status, baseURL: llm.baseURL, model: llm.model,
    })
    return null
  }
}

/**
 * Resolve the entry band actually applied to an intent. A non-null plan wins
 * ('llm'); otherwise the static `entry_*` settings are used ('static'). This is
 * the single place the LLM-vs-static choice is materialized.
 */
export function resolveEntryBand(plan: EntryPlan | null, settings: BotSettings): EntryBand {
  if (plan) {
    return {
      pullbackPct: plan.pullbackPct,
      invalidatePct: plan.invalidatePct,
      chaseCapPct: plan.chaseCapPct,
      ttlMinutes: plan.ttlMinutes,
      source: 'llm',
      reason: plan.reason,
    }
  }
  return {
    pullbackPct: settings.entry_pullback_pct,
    invalidatePct: settings.entry_invalidate_pct,
    chaseCapPct: settings.entry_max_chase_pct,
    ttlMinutes: settings.entry_ttl_minutes,
    source: 'static',
  }
}
