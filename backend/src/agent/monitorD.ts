// Type D — the agentic position monitor.
//
// Selected via `monitor_model === 'd'`, it runs on the SAME monitor cron as the classic
// ensemble (a/b/alternate/ab/abc) — the scheduler's dispatchMonitorRun routes the tick
// here when D is the chosen mode, so the two are mutually exclusive by construction.
//
// Where the classic monitor asks one model for a single-shot JSON verdict, Type D runs a
// native tool-calling loop per open position: the model reads candles, position history
// and sentiment through the shared agent tool belt, reasons across up to MAX_TOOL_ROUNDS
// rounds, then commits to one verdict — Hold, Adjust, Reduce or Close.
//
// It reuses the classic engine's position set + per-cycle params and, crucially, the SAME
// post-decision safety net (finalizeReview): confidence gates, REDUCE/ADJUST downgrades,
// OCO half-leg seeding, adjust cooldown, persistence, and the same close/reduce/adjust bus
// events index.ts acts on. Type D never executes a trade itself.
//
// Every coin's review is also persisted to `monitor_d_runs` (verdict + the full transcript)
// so the Agent Monitor page survives a reload and can show a per-run decision table and a
// per-coin transcript. Old runs are pruned to `monitor_d_retain_runs`.
import OpenAI from 'openai'
import { scheduleChat } from '../core/llmScheduler.js'
import { resolveLLM } from '../config/llm.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { getSettings, nowSql, monitorDRuns } from '../db/index.js'
import {
  getMonitorEntries, filterReviewableEntries, buildCycleParams, placeholderEnsemble,
  buildReviewContext, parseReview, finalizeReview,
} from '../monitor/index.js'
import type { MonitorEntry, RawReview } from '../monitor/index.js'
import type { PositionContext } from '../monitor/prompts.js'
import type { MonitorDRun, MonitorDRunFrame } from '../types.js'
import { getToolSchemas, runTool, isReadOnlyTool, MONITOR_D_TOOL_NAMES } from './tools.js'

// Safety valve mirroring the chat agent: how many model↔tool round-trips one position's
// review may take before we stop and commit to HOLD.
const MAX_TOOL_ROUNDS = 6

let running = false
export function isRunningD(): boolean { return running }

type StoredToolCalls = OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
type Tone = MonitorDRunFrame['tone']

// Per-tool presentation, shared by the live feed and the persisted transcript so both
// render identically. Keep in sync with the frontend's expectations (it just renders).
const TOOL_FEED: Record<string, { icon: string; verb: string }> = {
  get_candle_data:       { icon: '💾', verb: 'Reading candle data' },
  get_position_history:  { icon: '📊', verb: 'Pulling P&L history' },
  get_coin_sentiment:    { icon: '📰', verb: 'Checking news sentiment' },
  get_market:            { icon: '📈', verb: 'Reading live indicators' },
  list_position_reviews: { icon: '🗂️', verb: 'Reviewing prior verdicts' },
  list_recent_trades:    { icon: '🧾', verb: 'Scanning recent trades' },
  list_recent_signals:   { icon: '🔔', verb: 'Scanning recent signals' },
  list_open_positions:   { icon: '📂', verb: 'Listing open positions' },
}

// Records the transcript for one coin's review while streaming each frame live. The
// server owns presentation (icon/text/tone) so a reloaded transcript matches the live one.
class Recorder {
  readonly frames: MonitorDRunFrame[] = []
  readonly startedAt = Date.now()
  constructor(private cycleId: string, private coin: string) {}

  push(type: string, icon: string, text: string, tone: Tone, extra: Record<string, unknown> = {}): void {
    const frame: MonitorDRunFrame = { type, icon, text, tone, at: Date.now() }
    this.frames.push(frame)
    // `source: 'monitor_d'` lets the page tell these apart from the chat agent's frames.
    broadcast('agent_step', { source: 'monitor_d', cycle_id: this.cycleId, coin: this.coin, ...frame, ...extra })
  }
}

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

// Runs the tool-calling loop for one coin and returns the parsed verdict, recording each
// step. Falls back to a safe HOLD on any failure (no JSON, exhausted rounds, tool error).
async function runAgenticReview(coin: string, ctx: PositionContext, cycleId: string, rec: Recorder): Promise<RawReview> {
  const active = resolveLLM('agent') // the agent endpoint is the tool-calling-capable one
  const tools = getToolSchemas(MONITOR_D_TOOL_NAMES)

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserBriefing(ctx) },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rec.push('thinking', '🤖', 'Reasoning about the position…', 'muted', { round })

    const resp = await scheduleChat({
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
      if (content) rec.push('assistant_note', '💬', content, 'muted')

      for (const tc of toolCalls) {
        if (!tc.function?.name) continue
        const name = tc.function.name
        let args: Record<string, unknown> = {}
        try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} } catch { /* bad JSON → empty args */ }

        const meta = TOOL_FEED[name] ?? { icon: '🔧', verb: name }
        rec.push('tool_call', meta.icon, `${meta.verb}…`, 'muted', { tool: name, read_only: isReadOnlyTool(name) })

        const result = await runTool(name, args)
        const res = result as Record<string, unknown> | undefined
        // Compact, consistent result line (full blobs are never persisted).
        if (name === 'get_candle_data' && res && typeof res.count === 'number') {
          rec.push('tool_result', '💾', `Candle data ready (${res.count} bars, cache-first)`, 'muted', { tool: name })
        } else if (name === 'get_coin_sentiment' && res?.stub) {
          rec.push('tool_result', '📰', 'Sentiment proxy returned (live crawl not wired)', 'warn', { tool: name })
        } else if (res?.error) {
          rec.push('tool_result', '⚠️', `${meta.verb} → ${String(res.error)}`, 'warn', { tool: name })
        } else {
          rec.push('tool_result', '✓', `${meta.verb} complete`, 'muted', { tool: name })
        }

        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id })
      }
      continue
    }

    // No tool calls → the model is committing. Try to read its JSON verdict.
    try {
      return parseReview(content)
    } catch {
      // Answered in prose instead of JSON — nudge once and spend another round.
      messages.push({ role: 'assistant', content: content || null })
      messages.push({ role: 'user', content: 'Respond now with ONLY the JSON verdict object specified — no prose, no code fences.' })
    }
  }

  logger.warn('Type D exhausted rounds without a JSON verdict — defaulting to HOLD', { coin, cycleId })
  return { action: 'HOLD', confidence: 0, reasoning: '[Type D could not reach a conclusive verdict within the round budget]' }
}

// Reviews one position end-to-end: build the shared JIT context, run the agentic loop,
// route the verdict through the classic safety net (finalizeReview), then persist the run
// (verdict + transcript) and broadcast it so the page's table/detail update live.
async function reviewPositionD(coin: string, entry: MonitorEntry, cycleId: string, p: ReturnType<typeof buildCycleParams>): Promise<void> {
  const rec = new Recorder(cycleId, coin)
  rec.push('coin_started', '🔍', `Reviewing ${coin}…`, 'accent')

  const { ctx, history, effectiveUseHorizon } = await buildReviewContext(coin, entry, p)
  const verdict = await runAgenticReview(coin, ctx, cycleId, rec)

  const model = `type-d:${resolveLLM('agent').model}`
  const review = await finalizeReview({
    ctx, raw: verdict, history, effectiveUseHorizon, modelName: model, cycleId, disagreement: null,
  }, p)

  const action = review?.action ?? verdict.action
  const confidence = review?.confidence ?? verdict.confidence
  const reasoning = review?.reasoning ?? verdict.reasoning
  const discarded = review == null

  const tone: Tone = action === 'CLOSE' ? 'sell' : action === 'REDUCE' ? 'warn' : action === 'ADJUST' ? 'accent' : 'buy'
  const icon = action === 'HOLD' ? '✋' : action === 'CLOSE' ? '🚪' : action === 'REDUCE' ? '✂️' : '🎯'
  rec.push('decision', icon, `Decision: ${action} (${Math.round(confidence * 100)}%)`, tone, { action, confidence, reasoning, discarded })

  // Persist the run (verdict + full transcript) and broadcast the saved record. The
  // repository allocates the integer id on insert; we echo it back in the broadcast.
  const runDoc: Omit<MonitorDRun, 'id'> = {
    cycle_id: cycleId, coin, action, confidence, reasoning, discarded,
    model, frames: rec.frames, started_at_ms: rec.startedAt, created_at: nowSql(),
  }
  const id = Number(await monitorDRuns.insert(runDoc))
  broadcast('monitor_d_run_saved', { id, ...runDoc } satisfies MonitorDRun)
}

// Keeps only the most recent `monitor_d_retain_runs` records (by id), pruning the rest.
async function pruneRuns(): Promise<void> {
  const keep = Math.max(10, getSettings().monitor_d_retain_runs || 200)
  const cutoffRow = (await monitorDRuns.find({}, { sort: { id: -1 }, skip: keep, limit: 1, projection: { id: 1 } }))[0] as { id: number } | undefined
  if (cutoffRow) await monitorDRuns.deleteMany({ id: { $lte: cutoffRow.id } })
}

// Cycle entrypoint. Routed here by dispatchMonitorRun only when monitor_model === 'd'; the
// guard below is belt-and-braces enforcement of that single-engine-per-tick rule.
export async function runMonitorD(cycleId: string): Promise<void> {
  const s = getSettings()
  if (s.monitor_model !== 'd') {
    logger.info('Type D skipped — monitor_model is not "d"', { cycleId, mode: s.monitor_model })
    return
  }
  if (running) {
    logger.warn('Type D already running, skipping', { cycleId })
    return
  }
  running = true
  const sequential = s.monitor_d_sequential
  logger.info('Type D agentic monitor started', { cycleId, sequential })
  broadcast('monitor_started', { cycle_id: cycleId, strategy: 'agentic_d' })

  try {
    const entries = await filterReviewableEntries(await getMonitorEntries())
    if (entries.length === 0) {
      logger.info('Type D: no open positions to review', { cycleId })
      broadcast('monitor_completed', { cycle_id: cycleId, reviews: [], message: 'No open positions', strategy: 'agentic_d' })
      return
    }

    const p = buildCycleParams(s, placeholderEnsemble())

    const reviewOne = async (entry: MonitorEntry): Promise<void> => {
      try {
        await reviewPositionD(entry.coin, entry, cycleId, p)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.error('Type D coin review failed', { coin: entry.coin, cycleId, error })
        broadcast('agent_step', { source: 'monitor_d', cycle_id: cycleId, coin: entry.coin, type: 'error', icon: '❌', text: `Error: ${error}`, tone: 'sell', error })
        broadcast('monitor_coin_error', { cycle_id: cycleId, coin: entry.coin, error, strategy: 'agentic_d' })
      }
    }

    if (sequential) {
      // One position at a time — keeps a single-lane local LLM from being flooded and the
      // live feed readable. Each coin's full review completes before the next begins.
      for (const entry of entries) await reviewOne(entry)
    } else {
      // Concurrent — only adds real parallelism when the agent endpoint allows it; the
      // per-endpoint LLM gate still serializes calls hitting a one-at-a-time server.
      await Promise.all(entries.map(reviewOne))
    }

    await pruneRuns()
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

// Recent persisted Type D runs (newest first), for the Agent Monitor page to rehydrate
// after a reload. Returns the verdict + full transcript per coin per cycle.
export async function getMonitorDRuns(limit = 100): Promise<MonitorDRun[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  return monitorDRuns.find({}, { sort: { id: -1 }, limit: capped, projection: { _id: 0 } }) as unknown as Promise<MonitorDRun[]>
}
