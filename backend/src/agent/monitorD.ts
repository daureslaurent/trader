// Type D — the agentic position monitor.
//
// Where the classic monitor (monitor/service.ts) asks one model for a single-shot JSON
// verdict, Type D runs a *native tool-calling loop* per open position: the model reads
// candles, position history and sentiment through the shared agent tool belt, reasons
// across up to MAX_TOOL_ROUNDS rounds, and then commits to one verdict — Hold, Adjust,
// Close or Reduce.
//
// It deliberately reuses two things from the classic engine so the two strategies stay
// behaviourally consistent and can't diverge on safety:
//   1. the SAME position set + per-cycle params (getMonitorEntries / buildCycleParams), and
//   2. the SAME post-decision safety net (finalizeReview): confidence gates, REDUCE/ADJUST
//      downgrades, OCO half-leg seeding, adjust cooldown, persistence, and the very same
//      monitor_close_requested / monitor_reduce_requested / position_adjustment_proposed
//      bus events that index.ts already acts on.
//
// Type D never executes a trade itself — exactly like the classic monitor, it only
// proposes; the event handlers in index.ts remain the single execution choke point.
import OpenAI from 'openai'
import { scheduleChat } from '../core/llmScheduler.js'
import { resolveLLM } from '../config/llm.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { getSettings } from '../db/index.js'
import {
  getMonitorEntries, filterReviewableEntries, buildCycleParams, placeholderEnsemble,
  buildReviewContext, parseReview, finalizeReview,
} from '../monitor/index.js'
import type { MonitorEntry, RawReview } from '../monitor/index.js'
import type { PositionContext } from '../monitor/prompts.js'
import { getToolSchemas, runTool, isReadOnlyTool, MONITOR_D_TOOL_NAMES } from './tools.js'

// Mirrors the chat agent's safety valve: how many model↔tool round-trips a single
// position's review may take before we stop and commit to HOLD. Generous enough for a
// candles → history → sentiment chain, bounded so a runaway loop can't stall the cycle.
const MAX_TOOL_ROUNDS = 6

let running = false
export function isRunningD(): boolean { return running }

type StoredToolCalls = OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]

// Stream one progress frame to the AgentMonitor page. `source: 'monitor_d'` lets the
// frontend tell Type D frames apart from the chat agent's (which key on conversation_id).
function step(cycleId: string, coin: string, payload: Record<string, unknown>): void {
  broadcast('agent_step', { source: 'monitor_d', cycle_id: cycleId, coin, ...payload })
}

// The system prompt: defines Type D's job, the decision contract, and the strict JSON
// it must end on. The percentage convention matches the classic monitor + finalizeReview
// (SL/TP are % relative to the CURRENT price; the engine converts to absolute levels).
const SYSTEM_PROMPT = `You are "Type D", an autonomous risk manager reviewing ONE open crypto position at a time.

Your job: decide whether to HOLD, ADJUST (move stop-loss / take-profit), REDUCE (trim the position) or CLOSE it now.

Method — gather evidence with your tools BEFORE deciding:
- get_candle_data: read recent price structure, momentum and volatility (try the position's horizon timeframe).
- get_position_history: see realized P&L, fees and how this coin has been managed.
- get_coin_sentiment: weigh recent news / narrative risk against the chart.
- get_market / list_position_reviews / list_recent_signals: live indicators and prior verdicts for extra context.
Call the tools you actually need; don't pad. You have at most ${MAX_TOOL_ROUNDS} tool rounds.

Decision guidance:
- HOLD when the thesis is intact and risk is already well-placed.
- ADJUST to trail a stop into profit or re-target — never loosen a stop just to avoid being stopped out.
- REDUCE to de-risk a winner or a thesis that is weakening but not broken (give reduce_to_pct = the % of the position to KEEP, 1-99).
- CLOSE when the thesis is invalidated, momentum has clearly rolled over, or risk now outweighs reward.
- Be decisive but conservative: protecting capital beats churn. Each ADJUST costs an exchange OCO replace.

When — and only when — you are done gathering evidence, reply with ONE JSON object and NOTHING else:
{
  "action": "HOLD" | "ADJUST" | "REDUCE" | "CLOSE",
  "confidence": 0.0-1.0,
  "reasoning": "one or two sentences citing the concrete evidence",
  "new_stop_loss_pct": number | null,   // % relative to CURRENT price, e.g. -3 = stop 3% below; null = leave unchanged
  "new_take_profit_pct": number | null, // % relative to CURRENT price, e.g. 8 = target 8% above; null = leave unchanged
  "reduce_to_pct": number | null,       // only for REDUCE: % of the position to KEEP (1-99)
  "notes": string | null                // optional <=500 char memo to your future self about this coin
}`

// A compact briefing of the position under review, handed to the model as the opening
// user turn. The same ctx snapshot is reused by finalizeReview, so the prompt and the
// engine logic agree on one market view (mirrors the classic monitor's JIT discipline).
function buildUserBriefing(ctx: PositionContext): string {
  const f = (n: number | null, d = 2) => (n == null ? 'n/a' : n.toFixed(d))
  return [
    `Position under review: ${ctx.coin}`,
    `Quantity: ${ctx.quantity}   Entry: ${f(ctx.entryPrice, 6)}   Current: ${f(ctx.currentPrice, 6)}`,
    `Unrealized P&L: ${f(ctx.pnlUsd)} USD (${f(ctx.pnlPct)}%)`,
    `Stop-loss: ${ctx.stopLoss == null ? 'none' : f(ctx.stopLoss, 6)}   Take-profit: ${ctx.takeProfit == null ? 'none' : f(ctx.takeProfit, 6)}`,
    `Distance to SL: ${f(ctx.distanceToSlPct)}%   Distance to TP: ${f(ctx.distanceToTpPct)}%`,
    `Age: ${f(ctx.ageHours, 1)}h   Horizon: ${ctx.horizon}`,
    `Indicators — RSI14: ${f(ctx.rsi14, 1)}, trend: ${ctx.trend}, volatility: ${ctx.volatility}, 24h: ${f(ctx.change24h)}%, 7d: ${f(ctx.perf7d)}%`,
    '',
    'Investigate with your tools, then return your verdict as the single JSON object specified.',
  ].join('\n')
}

// Runs the tool-calling loop for one coin and returns the parsed verdict. Falls back to a
// safe HOLD on any failure (no JSON, exhausted rounds, model/tool error) — Type D must
// never crash a position's review into an unintended action.
async function runAgenticReview(coin: string, ctx: PositionContext, cycleId: string): Promise<RawReview> {
  const active = resolveLLM('agent') // the agent endpoint is the tool-calling-capable one
  const tools = getToolSchemas(MONITOR_D_TOOL_NAMES)

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserBriefing(ctx) },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    step(cycleId, coin, { type: 'thinking', round })

    const resp = await scheduleChat({
      // Parallel lane like the classic monitor, with a small priority bump so live
      // position reviews jump ahead of background batches contending for the endpoint.
      module: 'agent', lane: 'parallel', priority: 1, coin, cycleId,
      route: () => active,
      build: async (route) => ({
        model: route.model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: route.maxTokens,
      }),
    })

    const choice = resp.choices[0]?.message
    const toolCalls = (choice?.tool_calls ?? []) as StoredToolCalls
    const content = choice?.content ?? ''

    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })
      if (content) step(cycleId, coin, { type: 'assistant_note', content })

      for (const tc of toolCalls) {
        if (!tc.function?.name) continue
        const name = tc.function.name
        let args: Record<string, unknown> = {}
        try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} } catch { /* bad JSON → empty args */ }

        step(cycleId, coin, { type: 'tool_call', tool: name, args, read_only: isReadOnlyTool(name) })
        const result = await runTool(name, args)
        const resultStr = JSON.stringify(result)
        messages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id })
        step(cycleId, coin, { type: 'tool_result', tool: name, result })
      }
      continue
    }

    // No tool calls → the model is committing. Try to read its JSON verdict.
    try {
      const verdict = parseReview(content)
      step(cycleId, coin, { type: 'assistant', content })
      return verdict
    } catch {
      // It answered in prose instead of JSON. Nudge once and spend another round.
      messages.push({ role: 'assistant', content: content || null })
      messages.push({ role: 'user', content: 'Respond now with ONLY the JSON verdict object specified — no prose, no code fences.' })
    }
  }

  logger.warn('Type D exhausted rounds without a JSON verdict — defaulting to HOLD', { coin, cycleId })
  step(cycleId, coin, { type: 'assistant', content: 'No conclusive verdict — defaulting to HOLD.' })
  return { action: 'HOLD', confidence: 0, reasoning: '[Type D could not reach a conclusive verdict within the round budget]' }
}

// Reviews one position end-to-end: build the shared JIT context, run the agentic loop,
// then route the verdict through the classic safety net (finalizeReview) which persists
// the review and emits the close/reduce/adjust events index.ts acts on.
async function reviewPositionD(coin: string, entry: MonitorEntry, cycleId: string, p: ReturnType<typeof buildCycleParams>): Promise<void> {
  step(cycleId, coin, { type: 'coin_started' })

  // Same JIT context the classic monitor builds — we only need ctx/history/horizon flag;
  // the classic prompt strings it also returns are simply ignored here.
  const { ctx, history, effectiveUseHorizon } = await buildReviewContext(coin, entry, p)

  const verdict = await runAgenticReview(coin, ctx, cycleId)

  const review = await finalizeReview({
    ctx, raw: verdict, history, effectiveUseHorizon,
    modelName: `type-d:${resolveLLM('agent').model}`,
    cycleId, disagreement: null,
  }, p)

  step(cycleId, coin, {
    type: 'decision',
    action: review?.action ?? verdict.action,
    confidence: review?.confidence ?? verdict.confidence,
    reasoning: review?.reasoning ?? verdict.reasoning,
    // null review = the position closed mid-analysis (finalizeReview's race guard).
    discarded: review == null,
  })
}

// Cycle entrypoint. Mutually exclusive with the classic monitor: the scheduler routes the
// monitor cron here only when monitor_strategy === 'agentic_d'. The guard below is the
// belt-and-braces enforcement of that rule (and of the "A/B can't also be running" intent).
export async function runMonitorD(cycleId: string): Promise<void> {
  const s = getSettings()
  if (s.monitor_strategy !== 'agentic_d') {
    logger.info('Type D skipped — monitor_strategy is not agentic_d', { cycleId, strategy: s.monitor_strategy })
    return
  }
  if (running) {
    logger.warn('Type D already running, skipping', { cycleId })
    return
  }
  running = true
  logger.info('Type D agentic monitor started', { cycleId })
  broadcast('monitor_started', { cycle_id: cycleId, strategy: 'agentic_d' })

  try {
    const all = await getMonitorEntries()
    const entries = await filterReviewableEntries(all)
    if (entries.length === 0) {
      logger.info('Type D: no open positions to review', { cycleId })
      broadcast('monitor_completed', { cycle_id: cycleId, reviews: [], message: 'No open positions', strategy: 'agentic_d' })
      return
    }

    // Reuse the classic per-cycle params (confidence gates, horizon configs, cooldown…)
    // with a placeholder ensemble finalizeReview never reads.
    const p = buildCycleParams(s, placeholderEnsemble())

    // One independent agentic review per coin, concurrently. The LLM scheduler's
    // per-endpoint gate still serializes calls hitting the same one-at-a-time server,
    // so this only adds real parallelism when the agent endpoint allows it.
    await Promise.all(entries.map(async (entry) => {
      try {
        await reviewPositionD(entry.coin, entry, cycleId, p)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.error('Type D coin review failed', { coin: entry.coin, cycleId, error })
        step(cycleId, entry.coin, { type: 'error', error })
        broadcast('monitor_coin_error', { cycle_id: cycleId, coin: entry.coin, error, strategy: 'agentic_d' })
      }
    }))

    broadcast('monitor_completed', { cycle_id: cycleId, reviews: [], strategy: 'agentic_d' })
    logger.info('Type D agentic monitor completed', { cycleId, reviewed: entries.length })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Type D agentic monitor failed', { cycleId, error })
    broadcast('monitor_error', { cycle_id: cycleId, error, strategy: 'agentic_d' })
  } finally {
    running = false
  }
}
