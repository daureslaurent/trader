// Type D — the agentic position monitor.
//
// Selected via `monitor_model === 'd'`, it runs on the SAME monitor cron as the classic
// ensemble (a/b/alternate/ab/abc) — the scheduler's dispatchMonitorRun routes the tick
// here when D is the chosen mode, so the two are mutually exclusive by construction.
//
// Where the classic monitor asks one model for a single-shot JSON verdict, Type D runs a
// native tool-calling loop per open position: the model reads candles, position history
// and sentiment through the shared agent tool belt, reasons across up to MAX_TOOL_ROUNDS
// rounds, then commits to one verdict — Hold, Adjust or Close.
//
// It reuses the classic engine's position set + per-cycle params and, crucially, the SAME
// post-decision safety net (finalizeReview): confidence gates, ADJUST downgrades,
// OCO half-leg seeding, adjust cooldown, persistence, and the same close/adjust bus
// events index.ts acts on. Type D never executes a trade itself.
//
// Every coin's review is also persisted to `monitor_d_runs` (verdict + the full transcript)
// so the Agent Monitor page survives a reload and can show a per-run decision table and a
// per-coin transcript. Old runs are pruned to `monitor_d_retain_runs`.
import OpenAI from 'openai'
import { scheduleChat, runInSession } from '../core/llmScheduler.js'
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
import type { MonitorDRun, MonitorDRunFrame, PositionReview, ReviewRiskFields } from '../types.js'
import { isReadOnlyTool } from './tools.js'
import { getAgentToolSchemas, getAgentToolPrompt, runAgentTool } from './registry.js'

// This module IS the "monitorD" agent in the registry — its tool grants live under that id
// (read-only by default; configurable in Settings → Agent → Agentic Tools).
const AGENT_ID = 'monitorD'

// Safety valve mirroring the chat agent: how many model↔tool round-trips one position's
// review may take before we stop and commit to HOLD.
const MAX_TOOL_ROUNDS = 6

let running = false
export function isRunningD(): boolean { return running }

type StoredToolCalls = OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
type Tone = MonitorDRunFrame['tone']

// In-progress reviews for the CURRENT cycle, kept in memory so the Agent Monitor page can
// rehydrate a running cycle after a reload (live frames aren't persisted until the verdict
// lands). Keyed by coin; cleared at the start of each cycle, and an entry is removed once
// its run is persisted to monitor_d_runs (the saved run supersedes the live one).
export interface ActiveReview {
  coin: string
  cycle_id: string
  status: 'reviewing' | 'done' | 'error'
  frames: MonitorDRunFrame[]
  /** Running peak single-request context (prompt+completion) seen so far this review. */
  peak_context_tokens: number
  started_at_ms: number
}
const activeReviews = new Map<string, ActiveReview>()
export function getActiveReviews(): ActiveReview[] {
  return [...activeReviews.values()].sort((a, b) => b.started_at_ms - a.started_at_ms)
}

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

// Caps a tool result before it rides on a frame's `detail` (persisted to monitor_d_runs and
// broadcast live) — long arrays (e.g. candle bars) are trimmed to their first/last few entries
// so the hover/pin popover stays useful without bloating storage.
const DETAIL_ARRAY_CAP = 8
function truncateForDetail(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length <= DETAIL_ARRAY_CAP) return value.map(truncateForDetail)
    const head = value.slice(0, DETAIL_ARRAY_CAP - 3).map(truncateForDetail)
    const tail = value.slice(-2).map(truncateForDetail)
    return [...head, `… ${value.length - DETAIL_ARRAY_CAP + 1} more …`, ...tail]
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateForDetail(v)]))
  }
  return value
}

// Records the transcript for one coin's review while streaming each frame live. The
// server owns presentation (icon/text/tone) so a reloaded transcript matches the live one.
// It also maintains the shared `activeReviews` entry so an in-flight review is recoverable.
class Recorder {
  private entry: ActiveReview
  // Token accounting across the run's LLM calls (peak = largest single request).
  promptTokens = 0
  completionTokens = 0
  peakContext = 0
  constructor(private cycleId: string, private coin: string) {
    this.entry = { coin, cycle_id: cycleId, status: 'reviewing', frames: [], peak_context_tokens: 0, started_at_ms: Date.now() }
    activeReviews.set(coin, this.entry)
  }
  get frames(): MonitorDRunFrame[] { return this.entry.frames }
  get startedAt(): number { return this.entry.started_at_ms }

  /** Fold one call's usage into the run totals. */
  addUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): void {
    if (!usage) return
    const p = usage.prompt_tokens ?? 0
    const c = usage.completion_tokens ?? 0
    this.promptTokens += p
    this.completionTokens += c
    this.peakContext = Math.max(this.peakContext, usage.total_tokens ?? p + c)
    this.entry.peak_context_tokens = this.peakContext
  }

  push(type: string, icon: string, text: string, tone: Tone, extra: Record<string, unknown> = {}, detail?: MonitorDRunFrame['detail']): void {
    const frame: MonitorDRunFrame = { type, icon, text, tone, at: Date.now(), ...(detail ? { detail } : {}) }
    this.entry.frames.push(frame)
    if (type === 'error') this.entry.status = 'error'
    else if (type === 'decision') this.entry.status = 'done'
    // `source: 'monitor_d'` lets the page tell these apart from the chat agent's frames.
    broadcast('agent_step', { source: 'monitor_d', cycle_id: this.cycleId, coin: this.coin, ...frame, ...extra })
  }

  /** Drop the in-memory entry once the review is durably persisted (or abandoned). */
  release(): void { activeReviews.delete(this.coin) }
  /** Mark the entry failed but keep it visible until the next cycle clears it. */
  fail(error: string): void {
    this.entry.status = 'error'
    this.push('error', '❌', `Error: ${error}`, 'sell', { error })
  }
}

// The "Method" section lists exactly the tools `getAgentToolPrompt` resolves for this agent
// (its catalog descriptions, filtered to whatever's granted under Settings → Agent →
// Agentic Tools) — never hardcode a tool name/blurb here, or it can drift from the catalog
// and describe a tool that's actually disabled.
function buildSystemPrompt(toolPrompt: string): string {
  return `You are "Type D", a SENIOR crypto portfolio risk manager reviewing ONE open long position at a time. You think in probabilities and asymmetry, not hope. Your mandate is to protect capital and let winners run — never to churn.

Your job: decide exactly one action — HOLD, ADJUST (move stop-loss / take-profit), or CLOSE it now.

Method — gather evidence with your tools BEFORE deciding:
${toolPrompt}
Call the tools you actually need; don't pad. You have at most ${MAX_TOOL_ROUNDS} tool rounds.
You can read ANY symbol's market/candles — pull BTC (and the position's own coin) to judge the backdrop, not just the headline numbers.

Reason like a desk PM, working these four lenses in order:

1. RISK/REWARD (R-multiple, from the CURRENT price — not from entry):
   - Downside = distance from current price to a sensible stop. Upside = distance to a realistic target.
   - Compute reward:risk as upside ÷ downside. Strong asymmetry (≥2:1) with an intact thesis argues HOLD.
   - A sub-1:1 reading is NOT by itself a reason to CLOSE. Once you have trailed the stop up under a
     winner and price is near its target, the room left to the TP is naturally smaller than the room
     down to the trailed stop, so R:R falls below 1 — this is the EXPECTED geometry of a successful
     trade nearing its target, not a sell signal and not "thesis weakening". On a thin R:R your levers
     are: extend the TP if the trend justifies more upside (ADJUST), let it ride to the existing target
     (HOLD), or — only if upside is genuinely exhausted AND momentum is rolling over — tighten the stop.
     Reserve CLOSE for lenses 2-4 (reversal / risk-off regime / broken thesis), never the R-multiple alone.

2. MARKET REGIME & BTC BETA:
   - Read BTC's trend/momentum (use get_market / get_candle_data on BTC). Risk-on or risk-off?
   - High-beta alts mostly track BTC. Discount alt "strength" that is merely the whole market drifting up, and respect alt weakness that BTC is masking. A long into a risk-off BTC tape carries extra tail risk.

3. VOLATILITY-ADJUSTED STOPS (ATR / structure — never a fixed % inside the noise):
   - Anchor any stop/target to realized volatility (ATR, recent range) and structure (swing highs/lows), so the stop sits OUTSIDE normal noise. A stop inside the noise band guarantees a fee-paying scratch exit.
   - While in profit the stop only ratchets UP — never loosen a winner. When BELOW break-even you MAY widen the stop back toward the volatility-justified distance to give the trade room, but never loosen merely to dodge a justified, imminent exit.

4. THESIS & MOMENTUM STRUCTURE:
   - Re-validate the original entry thesis. Is price still making higher highs / higher lows? Is momentum (RSI, trend) confirming or diverging / rolling over?
   - CLOSE when the thesis is invalidated or momentum has clearly broken down; HOLD when it is intact and risk is well-placed.

Discipline: the DEFAULT action is HOLD. Act only when something structural changed. Each ADJUST costs an exchange OCO cancel+replace, so skip cosmetic tweaks (<0.5% level moves). Be decisive but conservative — protecting capital beats churn.

CLOSE guard: never CLOSE a position that is in profit while its stop is NOT threatened (price comfortably above the SL) and the trend has NOT reversed — that is a HOLD, or trail the stop up with ADJUST to lock more in. A winning, trending position with a healthy SL buffer has no reason to exit. CLOSE is for a confirmed reversal with negative momentum, a risk-off regime turning against the position, an invalidated thesis, or a position deeply underwater with no recovery signal — never for trimming a healthy winner just because its remaining upside has narrowed.

When — and only when — you are done gathering evidence, reply with ONE JSON object and NOTHING else:
{
  "action": "HOLD" | "ADJUST" | "CLOSE",
  "confidence": 0.0-1.0,
  "reasoning": "one or two sentences citing the concrete evidence (numbers, levels, BTC backdrop)",
  "thesis_status": "intact" | "weakening" | "invalidated",   // your re-validation of the entry thesis
  "risk_reward": number,                // remaining reward:risk as an R-multiple from the CURRENT price (e.g. 2.5 = 2.5:1)
  "regime": "risk_on" | "risk_off" | "neutral",              // the BTC/market backdrop you read
  "new_stop_loss_pct": number | null,   // % relative to CURRENT price, e.g. -3 = stop 3% below; null = leave unchanged
  "new_take_profit_pct": number | null, // % relative to CURRENT price, e.g. 8 = target 8% above; null = leave unchanged
  "notes": string | null                // optional <=500 char memo to your future self about this coin
}`
}

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
    'Work the four lenses: compute reward:risk from HERE (distance-to-TP vs distance-to-SL), read the BTC backdrop, anchor any stop to volatility/structure, and re-validate the thesis. Then return your verdict as the single JSON object specified.',
  ].join('\n')
}

// Runs the tool-calling loop for one coin and returns the parsed verdict, recording each
// step. Falls back to a safe HOLD on any failure (no JSON, exhausted rounds, tool error).
async function runAgenticReview(coin: string, ctx: PositionContext, cycleId: string, rec: Recorder): Promise<RawReview> {
  const active = resolveLLM('monitorD') // dedicated, tool-calling-capable module (Settings → LLM Models)
  const tools = getAgentToolSchemas(AGENT_ID)

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(getAgentToolPrompt(AGENT_ID)) },
    { role: 'user', content: buildUserBriefing(ctx) },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rec.push('thinking', '🤔', `Thinking… (round ${round + 1})`, 'muted', { round })

    const resp = await scheduleChat({
      module: 'monitorD', lane: 'parallel', priority: 1, coin, cycleId,
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

    rec.addUsage(resp.usage)

    const choice = resp.choices[0]?.message
    // Surface the model's own chain-of-thought for this call when the endpoint returns it
    // (llama.cpp / reasoning models expose it as `reasoning_content`). Shown in the modal.
    const thinking = ((choice as unknown as { reasoning_content?: string | null })?.reasoning_content ?? '').trim()
    if (thinking) rec.push('thinking', '🧠', thinking, 'accent', { round, thinking: true })

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
        rec.push('tool_call', meta.icon, `${meta.verb}…`, 'muted', { tool: name, read_only: isReadOnlyTool(name) }, { tool: name, args })

        const result = await runAgentTool(AGENT_ID, name, args)
        const res = result as Record<string, unknown> | undefined
        const resultDetail = { tool: name, result: truncateForDetail(result) }
        // Compact, consistent result line (the summary stays short; the full payload rides on `detail`).
        if (name === 'get_candle_data' && res && typeof res.count === 'number') {
          rec.push('tool_result', '💾', `Candle data ready (${res.count} bars, cache-first)`, 'muted', { tool: name }, resultDetail)
        } else if (name === 'get_coin_sentiment' && res && typeof res.article_count === 'number') {
          rec.push('tool_result', '📰', `Sentiment: ${res.aggregated_sentiment ?? 'n/a'} (${res.article_count} article${res.article_count === 1 ? '' : 's'})`, 'muted', { tool: name }, resultDetail)
        } else if (res?.error) {
          rec.push('tool_result', '⚠️', `${meta.verb} → ${String(res.error)}`, 'warn', { tool: name }, resultDetail)
        } else {
          rec.push('tool_result', '✓', `${meta.verb} complete`, 'muted', { tool: name }, resultDetail)
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
async function reviewPositionD(coin: string, entry: MonitorEntry, cycleId: string, p: ReturnType<typeof buildCycleParams>, rec: Recorder): Promise<PositionReview | null> {
  rec.push('coin_started', '🔍', `Reviewing ${coin}…`, 'accent')

  const { ctx, effectiveUseHorizon } = await buildReviewContext(coin, entry, p)
  // One session per position: holds the monitorD endpoint across all rounds + nested tool
  // LLM calls so no other module swaps the model mid-review.
  const verdict = await runInSession(
    { route: () => resolveLLM('monitorD') },
    () => runAgenticReview(coin, ctx, cycleId, rec),
  )

  const model = `type-d:${resolveLLM('monitorD').model}`
  const review = await finalizeReview({
    ctx, raw: verdict, effectiveUseHorizon, modelName: model, cycleId, disagreement: null,
  }, p)

  const action = review?.action ?? verdict.action
  const confidence = review?.confidence ?? verdict.confidence
  const reasoning = review?.reasoning ?? verdict.reasoning
  const discarded = review == null
  // Structured risk metadata: prefer the persisted (parsed/coerced) review, fall back to the raw verdict.
  const riskFields: ReviewRiskFields = {
    thesis_status: review?.thesis_status ?? verdict.thesis_status ?? null,
    risk_reward: review?.risk_reward ?? verdict.risk_reward ?? null,
    regime: review?.regime ?? verdict.regime ?? null,
  }

  const tone: Tone = action === 'CLOSE' ? 'sell' : action === 'ADJUST' ? 'accent' : 'buy'
  const icon = action === 'HOLD' ? '✋' : action === 'CLOSE' ? '🚪' : '🎯'
  rec.push('decision', icon, `Decision: ${action} (${Math.round(confidence * 100)}%)`, tone, { action, confidence, reasoning, discarded, ...riskFields })

  // Persist the run (verdict + full transcript) and broadcast the saved record. The
  // repository allocates the integer id on insert; we echo it back in the broadcast.
  const runDoc: Omit<MonitorDRun, 'id'> = {
    cycle_id: cycleId, coin, action, confidence, reasoning, discarded, ...riskFields,
    model, frames: rec.frames,
    prompt_tokens: rec.promptTokens, completion_tokens: rec.completionTokens, peak_context_tokens: rec.peakContext,
    started_at_ms: rec.startedAt, created_at: nowSql(),
  }
  const id = Number(await monitorDRuns.insert(runDoc))
  broadcast('monitor_d_run_saved', { id, ...runDoc } satisfies MonitorDRun)
  rec.release() // the persisted run now supersedes the in-memory live entry

  // The shared position_reviews row finalizeReview persisted — returned so the cycle can
  // include it in monitor_completed (drives the Monitor & Portfolio pages, same as classic).
  return review
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
  activeReviews.clear() // fresh cycle — drop any leftover live entries from the previous one
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

    const reviewOne = async (entry: MonitorEntry): Promise<PositionReview | null> => {
      const rec = new Recorder(cycleId, entry.coin)
      try {
        return await reviewPositionD(entry.coin, entry, cycleId, p, rec)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.error('Type D coin review failed', { coin: entry.coin, cycleId, error })
        rec.fail(error) // records the error frame + flags the live entry, kept until next cycle
        broadcast('monitor_coin_error', { cycle_id: cycleId, coin: entry.coin, error, strategy: 'agentic_d' })
        return null
      }
    }

    let settled: (PositionReview | null)[]
    if (sequential) {
      // One position at a time — keeps a single-lane local LLM from being flooded and the
      // live feed readable. Each coin's full review completes before the next begins.
      settled = []
      for (const entry of entries) settled.push(await reviewOne(entry))
    } else {
      // Concurrent — only adds real parallelism when the agent endpoint allows it; the
      // per-endpoint LLM gate still serializes calls hitting a one-at-a-time server.
      settled = await Promise.all(entries.map(reviewOne))
    }
    const reviews = settled.filter((r): r is PositionReview => r !== null)

    await pruneRuns()
    // Same shape the classic monitor emits, so the Monitor & Portfolio pages refresh and
    // show Agent D's verdicts (they live in the shared position_reviews collection).
    broadcast('monitor_completed', { cycle_id: cycleId, reviews, strategy: 'agentic_d' })
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
