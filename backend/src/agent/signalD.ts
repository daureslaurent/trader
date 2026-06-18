// Agent Signal — the agentic, single-coin entry engine.
//
// Selected via `signal_model === 'agent'`, it replaces the classic research pipeline
// (researcher → extractor → analyst) as the BUY/HOLD signal source for watchlist coins.
// The scheduler's dispatchPipelineRun routes the pipeline tick here when 'agent' is chosen,
// so the two engines are mutually exclusive by construction (mirrors monitor_model 'd').
//
// Where the classic pipeline runs a fixed chain, Agent Signal runs ONE agent per watchlist
// coin: a native tool-calling loop that reads candles, live indicators, news sentiment and
// its OWN long-term memory through the shared agent tool belt, reasons across up to
// MAX_TOOL_ROUNDS rounds, then commits to a single verdict — BUY or HOLD — plus a thesis,
// conviction %, key levels, SL/TP and (for a BUY) its own entry-timing band.
//
// Coins are processed STRICTLY SEQUENTIALLY: a coin's whole loop completes before the next
// coin starts, and every LLM call runs on the serialized `analyse` lane, so no other coin's
// agent calls interleave with the one in flight. On BUY the verdict flows through the
// unchanged BUY gauntlet and is staged on the Entry Desk with the agent's own band; the
// engine never executes a trade itself except via the shared handleTradeSignal path.
//
// Every coin's review is persisted to `agent_signal_runs` (verdict + full transcript) and the
// per-coin memory to `agent_signal_memory`, so the Agent Signal page survives a reload and the
// next review has continuity. Old runs are pruned to `agent_signal_retain_runs`.
import OpenAI from 'openai'
import { scheduleChat } from '../core/llmScheduler.js'
import { resolveLLM } from '../config/llm.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { getSettings, nowSql, agentSignalRuns, decisions } from '../db/index.js'
import { fetchMarketData } from '../trader/index.js'
import { getPortfolioState, getMarketContext, getOpenEntries, classifyRegime } from '../portfolio/index.js'
import { prepareBuyOrder, deferToEntryDesk, logPipelineEvent } from '../pipeline/index.js'
import { handleTradeSignal } from '../execution/index.js'
import * as entry from '../entry/index.js'
import { isTradeable } from '../core/tradeable.js'
import type { EntryBand } from '../entry/index.js'
import type { MarketContext, MarketData, Signal, SignalRun, SignalRunFrame } from '../types.js'
import { isReadOnlyTool, upsertSignalMemory } from './tools.js'
import { getAgentToolSchemas, getAgentToolPrompt, runAgentTool } from './registry.js'

// This module IS the "agentSignal" agent in the registry — its tool grants live under that id
// (read-only reads + its read-write memory tool; configurable in Settings → Agent → Agentic Tools).
const AGENT_ID = 'agentSignal'

// Safety valve: how many model↔tool round-trips one coin's review may take before we stop
// and commit to HOLD.
const MAX_TOOL_ROUNDS = 6

let running = false
export function isRunningSignal(): boolean { return running }

type StoredToolCalls = OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
type Tone = SignalRunFrame['tone']

// In-progress reviews for the CURRENT cycle, kept in memory so the Agent Signal page can
// rehydrate a running cycle after a reload (live frames aren't persisted until the verdict
// lands). Keyed by coin; cleared at the start of each cycle, and an entry is removed once
// its run is persisted (the saved run supersedes the live one).
export interface ActiveSignalReview {
  coin: string
  cycle_id: string
  status: 'reviewing' | 'done' | 'error'
  frames: SignalRunFrame[]
  peak_context_tokens: number
  started_at_ms: number
}
const activeReviews = new Map<string, ActiveSignalReview>()
export function getActiveSignalReviews(): ActiveSignalReview[] {
  return [...activeReviews.values()].sort((a, b) => b.started_at_ms - a.started_at_ms)
}

// Per-tool presentation, shared by the live feed and the persisted transcript so both
// render identically. Keep in sync with the frontend's expectations (it just renders).
const TOOL_FEED: Record<string, { icon: string; verb: string }> = {
  get_candle_data:        { icon: '💾', verb: 'Reading candle data' },
  get_market:             { icon: '📈', verb: 'Reading live indicators' },
  get_coin_sentiment:     { icon: '📰', verb: 'Checking news sentiment' },
  get_position_history:   { icon: '📊', verb: 'Pulling P&L history' },
  list_recent_signals:    { icon: '🔔', verb: 'Scanning recent signals' },
  recall_signal_memory:   { icon: '🧠', verb: 'Recalling coin memory' },
  remember_signal:        { icon: '📝', verb: 'Updating coin memory' },
  get_coin_signal_history: { icon: '🗂️', verb: 'Reviewing prior verdicts' },
}

// Caps a tool result before it rides on a frame's `detail` (persisted + broadcast) — long
// arrays (e.g. candle bars) are trimmed to their first/last few entries so the hover/pin
// popover stays useful without bloating storage.
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

// Records the transcript for one coin's review while streaming each frame live. The server
// owns presentation (icon/text/tone) so a reloaded transcript matches the live one. Also
// maintains the shared `activeReviews` entry so an in-flight review is recoverable.
class Recorder {
  private entry: ActiveSignalReview
  promptTokens = 0
  completionTokens = 0
  peakContext = 0
  constructor(private cycleId: string, private coin: string) {
    this.entry = { coin, cycle_id: cycleId, status: 'reviewing', frames: [], peak_context_tokens: 0, started_at_ms: Date.now() }
    activeReviews.set(coin, this.entry)
  }
  get frames(): SignalRunFrame[] { return this.entry.frames }
  get startedAt(): number { return this.entry.started_at_ms }

  addUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): void {
    if (!usage) return
    const p = usage.prompt_tokens ?? 0
    const c = usage.completion_tokens ?? 0
    this.promptTokens += p
    this.completionTokens += c
    this.peakContext = Math.max(this.peakContext, usage.total_tokens ?? p + c)
    this.entry.peak_context_tokens = this.peakContext
  }

  push(type: string, icon: string, text: string, tone: Tone, extra: Record<string, unknown> = {}, detail?: SignalRunFrame['detail']): void {
    const frame: SignalRunFrame = { type, icon, text, tone, at: Date.now(), ...(detail ? { detail } : {}) }
    this.entry.frames.push(frame)
    if (type === 'error') this.entry.status = 'error'
    else if (type === 'decision') this.entry.status = 'done'
    // `source: 'agent_signal'` lets the page tell these apart from the chat agent / monitor D.
    broadcast('agent_step', { source: 'agent_signal', cycle_id: this.cycleId, coin: this.coin, ...frame, ...extra })
  }

  release(): void { activeReviews.delete(this.coin) }
  fail(error: string): void {
    this.entry.status = 'error'
    this.push('error', '❌', `Error: ${error}`, 'sell', { error })
  }
}

// ── verdict ────────────────────────────────────────────────────────────────

interface SignalVerdict {
  action: 'BUY' | 'HOLD'
  confidence: number
  thesis: string
  conviction: number          // 0–100
  support: number | null
  resistance: number | null
  stop_loss_pct: number | null
  take_profit_pct: number | null
  entry: { pullbackPct: number; invalidatePct: number; chaseCapPct: number; ttlMinutes: number } | null
  notes: string | null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

// Parse the agent's final JSON verdict. Throws when no valid BUY/HOLD object is present so
// the loop can nudge once more; the caller defaults to HOLD if rounds run out.
function parseSignalVerdict(content: string): SignalVerdict {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON found in Agent Signal response')
    parsed = JSON.parse(match[0])
  }
  const obj = (parsed as Record<string, unknown>)?.verdict ?? parsed
  const c = obj as Record<string, unknown>
  if (typeof c !== 'object' || c === null || !['BUY', 'HOLD'].includes(c.action as string)) {
    throw new Error('Invalid verdict in Agent Signal response')
  }
  const e = c.entry as Record<string, unknown> | undefined
  const eb = e && typeof e === 'object'
    ? {
        pullbackPct: num(e.pullback_pct),
        invalidatePct: num(e.invalidate_pct),
        chaseCapPct: num(e.chase_cap_pct),
        ttlMinutes: num(e.ttl_minutes),
      }
    : null
  const entryBand = eb && eb.pullbackPct != null && eb.invalidatePct != null && eb.chaseCapPct != null && eb.ttlMinutes != null
    ? eb as { pullbackPct: number; invalidatePct: number; chaseCapPct: number; ttlMinutes: number }
    : null

  return {
    action: c.action as 'BUY' | 'HOLD',
    confidence: num(c.confidence) ?? 0,
    thesis: typeof c.thesis === 'string' ? c.thesis.trim() : '',
    conviction: Math.max(0, Math.min(100, num(c.conviction) ?? 0)),
    support: num(c.support),
    resistance: num(c.resistance),
    stop_loss_pct: num(c.stop_loss_pct),
    take_profit_pct: num(c.take_profit_pct),
    entry: entryBand,
    notes: typeof c.notes === 'string' && c.notes.trim() ? c.notes.trim() : null,
  }
}

// Materialize the agent's chosen band into an EntryBand. Returns undefined (→ deferToEntryDesk
// falls back to the static settings band) when the levels are missing or nonsensical. Trust the
// model (per the entry-planner design): only reject values that would produce an invalid band.
function bandFromVerdict(v: SignalVerdict): EntryBand | undefined {
  const e = v.entry
  if (!e) return undefined
  if (e.pullbackPct < 0) return undefined
  if (e.invalidatePct <= e.pullbackPct) return undefined
  if (e.chaseCapPct <= 0 || e.ttlMinutes <= 0) return undefined
  return {
    pullbackPct: e.pullbackPct,
    invalidatePct: e.invalidatePct,
    chaseCapPct: e.chaseCapPct,
    ttlMinutes: e.ttlMinutes,
    source: 'agent',
    reason: v.thesis ? v.thesis.slice(0, 200) : 'Agent Signal entry band',
  }
}

// ── prompt ───────────────────────────────────────────────────────────────────

// The "Method" section lists exactly the tools `getAgentToolPrompt` resolves for this agent
// (filtered to whatever's granted under Settings → Agent → Agentic Tools) — never hardcode a
// tool name/blurb here, or it can drift from the catalog and describe a disabled tool.
function buildSystemPrompt(coin: string, toolPrompt: string): string {
  return `You are "Agent Signal", an autonomous crypto analyst evaluating ONE coin — ${coin} — for a NEW entry.

Your job: decide whether to BUY ${coin} now or HOLD off, and maintain a long-term thesis for it.

Method — gather evidence with your tools BEFORE deciding:
${toolPrompt}
Start by recalling your memory for this coin so you build on your past read instead of starting from scratch. Call the tools you actually need; don't pad. You have at most ${MAX_TOOL_ROUNDS} tool rounds.

Decision guidance:
- BUY only when the setup is genuinely attractive: a coherent thesis, supportive price structure/momentum, and acceptable news risk. A BUY is staged on the Entry Desk (it is not filled at market immediately), so propose an entry band that waits for a sensible price.
- HOLD when the thesis is weak, broken, fully priced in, or the risk/reward is poor. HOLD is the safe default — protecting capital beats forcing trades.
- Update your memory (remember_signal) with your current thesis, conviction and key levels before committing, so your next review has continuity.

When — and only when — you are done gathering evidence, reply with ONE JSON object and NOTHING else:
{
  "action": "BUY" | "HOLD",
  "confidence": 0.0-1.0,              // how sure you are in this action
  "conviction": 0-100,               // percentage conviction in the thesis
  "thesis": "1-3 sentence strategy/thesis for this coin",
  "support": number | null,          // key support price level
  "resistance": number | null,       // key resistance price level
  "stop_loss_pct": number | null,    // % below entry for the stop, e.g. 4 = 4% below; null = size from ATR
  "take_profit_pct": number | null,  // % above entry for the target, e.g. 10 = 10% above; null = size from ATR
  "entry": {                          // your entry-timing band (only meaningful for BUY); null = use defaults
    "pullback_pct": number,          // buy target as % BELOW current price (0 = buy now)
    "invalidate_pct": number,        // cancel if price drops this % below current (must be > pullback_pct)
    "chase_cap_pct": number,         // cancel if price runs this % above current
    "ttl_minutes": number            // how long the intent stays live
  } | null,
  "notes": string | null             // optional <=500 char memo appended to your memory log
}`
}

function buildUserBriefing(coin: string, md: MarketData, ctx: MarketContext): string {
  const f = (n: number | null | undefined, d = 2) => (n == null ? 'n/a' : n.toFixed(d))
  const regime = classifyRegime(ctx)
  return [
    `Coin under review: ${coin}`,
    `Price: ${f(ctx.price, 6)}   24h: ${f(md.change24h ?? ctx.change24h)}%   7d: ${f(ctx.perf7d)}%`,
    `Indicators — RSI14: ${f(ctx.rsi14, 1)}, trend: ${ctx.trend}, volatility: ${ctx.volatility}, ATR14: ${f(ctx.atr14, 6)}`,
    `Regime: ${regime.summary}`,
    '',
    'Investigate with your tools (recall your memory first), then return your verdict as the single JSON object specified.',
  ].join('\n')
}

// ── tool loop ──────────────────────────────────────────────────────────────

// Runs the tool-calling loop for one coin and returns the parsed verdict, recording each
// step. Falls back to a safe HOLD on any failure (no JSON, exhausted rounds).
async function runAgenticSignal(coin: string, md: MarketData, ctx: MarketContext, cycleId: string, rec: Recorder): Promise<SignalVerdict> {
  const tools = getAgentToolSchemas(AGENT_ID)
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(coin, getAgentToolPrompt(AGENT_ID)) },
    { role: 'user', content: buildUserBriefing(coin, md, ctx) },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rec.push('thinking', '🤔', `Thinking… (round ${round + 1})`, 'muted', { round })

    const resp = await scheduleChat({
      // `analyse` lane is serialized (limit 1): combined with the sequential coin loop this
      // guarantees no other coin's agent calls interleave with the one in flight.
      module: 'agentSignal', lane: 'analyse', priority: 1, coin, cycleId,
      route: () => resolveLLM('agentSignal'),
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
      return parseSignalVerdict(content)
    } catch {
      messages.push({ role: 'assistant', content: content || null })
      messages.push({ role: 'user', content: 'Respond now with ONLY the JSON verdict object specified — no prose, no code fences.' })
    }
  }

  logger.warn('Agent Signal exhausted rounds without a JSON verdict — defaulting to HOLD', { coin, cycleId })
  return {
    action: 'HOLD', confidence: 0, thesis: '', conviction: 0, support: null, resistance: null,
    stop_loss_pct: null, take_profit_pct: null, entry: null,
    notes: '[Agent Signal could not reach a conclusive verdict within the round budget]',
  }
}

// ── per-coin review ──────────────────────────────────────────────────────────

// Reviews one coin end-to-end: build live context, run the agentic loop, persist memory, and
// — on a BUY that clears the gauntlet — stage it on the Entry Desk (or fill immediately when
// entry-timing is off). Persists the run (verdict + transcript) and broadcasts it.
async function reviewCoin(coin: string, cycleId: string, rec: Recorder): Promise<void> {
  rec.push('coin_started', '🔍', `Reviewing ${coin}…`, 'accent')
  const settings = getSettings()

  const md = (await fetchMarketData([coin]))[0]
  if (!md || !(md.price > 0)) {
    rec.fail(`No Binance market data for ${coin} — is it a valid USDC pair?`)
    await persistRun(coin, cycleId, rec, {
      action: 'HOLD', confidence: 0, conviction: 0, thesis: '', reasoning: `No market data for ${coin}`,
      rejected: false, rejected_reason: null,
    })
    return
  }
  const ctx = await getMarketContext(coin, md.price)

  const verdict = await runAgenticSignal(coin, md, ctx, cycleId, rec)

  // Always persist memory (engine-authoritative) so continuity survives even if the model
  // never called remember_signal itself.
  await upsertSignalMemory(coin, {
    thesis: verdict.thesis || undefined,
    conviction: verdict.conviction,
    support: verdict.support,
    resistance: verdict.resistance,
    last_action: verdict.action,
    note: verdict.notes ?? undefined,
  })

  // Record a `decisions` row exactly like the classic analyst does, so the verdict shows as
  // a BUY/HOLD marker on the Trade candle chart (it reads /api/decisions/:coin). Markers are
  // placed by candle timestamp; the price/conviction ride on `context` for the tooltip.
  await decisions.insert({
    coin, action: verdict.action, reason: verdict.thesis || 'Agent Signal', confidence: verdict.confidence,
    context: JSON.stringify({ price: md.price, conviction: verdict.conviction, source: 'agent_signal' }),
    triggered_trade_id: null, created_at: nowSql(),
  })
  logPipelineEvent('signal_generated', coin, cycleId, {
    symbol: coin, action: verdict.action, reason: verdict.thesis, confidence: verdict.confidence,
  })

  let rejected = false
  let rejectedReason: string | null = null

  if (verdict.action === 'BUY') {
    if (verdict.confidence < settings.min_confidence) {
      rejected = true
      rejectedReason = `Confidence ${Math.round(verdict.confidence * 100)}% below threshold ${Math.round(settings.min_confidence * 100)}%`
      logPipelineEvent('trade_skipped', coin, cycleId, { reason: rejectedReason })
    } else {
      const signal: Signal = {
        coin, action: 'BUY', quantity: 0, reason: verdict.thesis || 'Agent Signal BUY', confidence: verdict.confidence,
        ...(verdict.stop_loss_pct != null ? { stop_loss_pct: verdict.stop_loss_pct } : {}),
        ...(verdict.take_profit_pct != null ? { take_profit_pct: verdict.take_profit_pct } : {}),
      }
      const portfolioState = await getPortfolioState([md], settings)
      const evaluation = await prepareBuyOrder({
        symbol: coin, price: md.price, atr14: ctx.atr14, signal, portfolioState, settings, checkActiveIntent: true,
      })
      if (!evaluation.ok) {
        rejected = true
        rejectedReason = evaluation.reason
        logPipelineEvent('trade_skipped', coin, cycleId, { reason: evaluation.reason })
      } else {
        const buySignal: Signal = { ...signal, quantity: evaluation.order.qty }
        if (settings.entry_timing_enabled) {
          // Stage on the Entry Desk with the agent's own band (falls back to the static band
          // inside deferToEntryDesk when the agent didn't supply a usable one).
          await deferToEntryDesk({ buySignal, analyzedPrice: md.price, marketCtx: ctx, settings, cycleId, band: bandFromVerdict(verdict) })
        } else {
          const { outcome, error } = await handleTradeSignal(buySignal, md.price, ctx.atr14, settings)
          logPipelineEvent('trade_executed', coin, cycleId, {
            action: 'BUY', price: md.price, quantity: evaluation.order.qty,
            stop_loss: evaluation.order.sl, take_profit: evaluation.order.tp,
            pending_approval: outcome === 'pending',
            sl_source: verdict.stop_loss_pct != null ? 'rule' : 'atr',
            error: outcome === 'failed' ? error : undefined,
          })
        }
      }
    }
  }

  const action = verdict.action
  const staged = action === 'BUY' && !rejected
  const tone: Tone = action === 'HOLD' ? 'muted' : staged ? 'buy' : 'warn'
  const icon = action === 'HOLD' ? '✋' : staged ? '🎯' : '🚫'
  const label = action === 'HOLD'
    ? `Decision: HOLD (conviction ${Math.round(verdict.conviction)}%)`
    : staged
      ? `Decision: BUY → Entry Desk (conviction ${Math.round(verdict.conviction)}%)`
      : `Decision: BUY not staged — ${rejectedReason}`
  rec.push('decision', icon, label, tone, { action, confidence: verdict.confidence, conviction: verdict.conviction, thesis: verdict.thesis, rejected, rejected_reason: rejectedReason })

  await persistRun(coin, cycleId, rec, {
    action, confidence: verdict.confidence, conviction: verdict.conviction,
    thesis: verdict.thesis, reasoning: verdict.thesis, rejected, rejected_reason: rejectedReason,
  })
}

// Persist one coin's run (verdict + full transcript) and broadcast the saved record. The
// repository allocates the integer id on insert; we echo it back in the broadcast.
async function persistRun(
  coin: string, cycleId: string, rec: Recorder,
  v: { action: 'BUY' | 'HOLD'; confidence: number; conviction: number; thesis: string; reasoning: string; rejected: boolean; rejected_reason: string | null },
): Promise<void> {
  const model = `agent-signal:${resolveLLM('agentSignal').model}`
  const runDoc: Omit<SignalRun, 'id'> = {
    cycle_id: cycleId, coin, action: v.action, confidence: v.confidence, conviction: v.conviction,
    thesis: v.thesis, reasoning: v.reasoning, rejected: v.rejected, rejected_reason: v.rejected_reason,
    model, frames: rec.frames,
    prompt_tokens: rec.promptTokens, completion_tokens: rec.completionTokens, peak_context_tokens: rec.peakContext,
    started_at_ms: rec.startedAt, created_at: nowSql(),
  }
  const id = Number(await agentSignalRuns.insert(runDoc))
  broadcast('signal_run_saved', { id, ...runDoc } satisfies SignalRun)
  rec.release()
}

// Keeps only the most recent `agent_signal_retain_runs` records (by id), pruning the rest.
async function pruneRuns(): Promise<void> {
  const keep = Math.max(10, getSettings().agent_signal_retain_runs || 200)
  const cutoffRow = (await agentSignalRuns.find({}, { sort: { id: -1 }, skip: keep, limit: 1, projection: { id: 1 } }))[0] as { id: number } | undefined
  if (cutoffRow) await agentSignalRuns.deleteMany({ id: { $lte: cutoffRow.id } })
}

// Resolve the watchlist coins one agent each should review this cycle. Drops fiat; when
// `agent_signal_check_portfolio` is on, also drops held coins (the monitor owns them) and
// coins already on the Entry Desk. When off, every watchlist coin gets an agent.
async function resolveCoins(): Promise<string[]> {
  const s = getSettings()
  let coins = [...new Set(s.watchlist)].filter(isTradeable)
  if (s.agent_signal_check_portfolio) {
    const held = new Set(((await getOpenEntries()) as unknown as { coin: string }[]).map(e => e.coin))
    coins = coins.filter(c => !held.has(c) && !entry.hasActiveIntent(c))
  }
  return coins
}

// ── cycle entrypoints ──────────────────────────────────────────────────────

// Full watchlist cycle. Routed here by dispatchPipelineRun only when signal_model === 'agent';
// the guard below is belt-and-braces enforcement of that single-engine-per-tick rule.
export async function runAgentSignal(cycleId: string): Promise<void> {
  const s = getSettings()
  if (s.signal_model !== 'agent') {
    logger.info('Agent Signal skipped — signal_model is not "agent"', { cycleId, mode: s.signal_model })
    return
  }
  if (running) {
    logger.warn('Agent Signal already running, skipping', { cycleId })
    return
  }
  running = true
  activeReviews.clear()
  logger.info('Agent Signal engine started', { cycleId })
  broadcast('signal_started', { cycle_id: cycleId })

  try {
    const coins = await resolveCoins()
    if (coins.length === 0) {
      logger.info('Agent Signal: no eligible watchlist coins', { cycleId })
      broadcast('signal_completed', { cycle_id: cycleId, reviewed: 0, message: 'No eligible watchlist coins' })
      return
    }

    // STRICTLY SEQUENTIAL: one coin's whole loop completes before the next begins.
    let reviewed = 0
    for (const coin of coins) {
      const rec = new Recorder(cycleId, coin)
      try {
        await reviewCoin(coin, cycleId, rec)
        reviewed++
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.error('Agent Signal coin review failed', { coin, cycleId, error })
        rec.fail(error)
      }
    }

    await pruneRuns()
    broadcast('signal_completed', { cycle_id: cycleId, reviewed })
    logger.info('Agent Signal engine completed', { cycleId, reviewed })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Agent Signal engine failed', { cycleId, error })
    broadcast('signal_error', { cycle_id: cycleId, error })
  } finally {
    running = false
  }
}

// Single-coin run, for a manual "run this coin" trigger when signal_model === 'agent'.
// Independent of the full-cycle guard so a manual coin can run on demand.
export async function runAgentSignalCoin(coin: string, cycleId: string): Promise<void> {
  if (!isTradeable(coin)) {
    logger.info('Agent Signal single-coin skipped — fiat/stablecoin', { coin })
    return
  }
  logger.info('Agent Signal single-coin run started', { coin, cycleId })
  const rec = new Recorder(cycleId, coin)
  try {
    await reviewCoin(coin, cycleId, rec)
    await pruneRuns()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Agent Signal single-coin review failed', { coin, cycleId, error })
    rec.fail(error)
  }
}

// Recent persisted runs (newest first), for the Agent Signal page to rehydrate after a reload.
export async function getSignalRuns(limit = 100): Promise<SignalRun[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  return agentSignalRuns.find({}, { sort: { id: -1 }, limit: capped, projection: { _id: 0 } }) as unknown as Promise<SignalRun[]>
}
