// Entry Agent — the agentic, per-coin entry-position engine.
//
// Selected via `entry_model === 'agent'`, it replaces the static/Entry-Planner band logic
// for deferred BUYs on the Entry Desk. Where the static engine sets a fixed band once,
// the Entry Agent runs ONE tool-calling agent per active entry intent that reads live
// market structure, the original BUY thesis and the Agent Signal memory, then DRIVES the
// deferred BUY through its action tools — re-anchoring the entry band (set_entry_band),
// firing now (fire_entry_now), or abandoning it (cancel_entry).
//
// It is a LIVING manager: a routing output node (`module_entry_agent`) re-fires it on a
// tick / price-move, and each pass re-evaluates every active intent and adapts. The fast
// static evaluate() loop in entry/service.ts stays as a safety net between passes
// (falling-knife / chase-cap / TTL still fire/cancel urgently). On any error the existing
// band is left untouched, so a bad pass can never degrade a good window.
//
// Coins are processed STRICTLY SEQUENTIALLY on the serialized `analyse` lane, so no two
// coins' agent calls interleave. Each pass is persisted to `entry_agent_runs` (verdict +
// full transcript) and the live frames stream to the Entry Agent page as `agent_step`
// events (source 'entry_agent'). Old runs are pruned to `entry_agent_retain_runs`.
import OpenAI from 'openai'
import { scheduleChat, runInSession } from '../core/llmScheduler.js'
import { resolveLLM } from '../config/llm.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { getSettings, nowSql, entryAgentRuns } from '../db/index.js'
import * as priceCache from '../market/index.js'
import { getMarketContext, classifyRegime } from '../portfolio/index.js'
import * as entry from '../entry/index.js'
import type { EntryIntent } from '../entry/index.js'
import type { MarketContext, EntryAgentRun, SignalRunFrame } from '../types.js'
import { isReadOnlyTool } from './tools.js'
import { getAgentToolSchemas, getAgentToolPrompt, runAgentTool } from './registry.js'

// This module IS the "entryAgent" agent in the registry — its tool grants live under that id
// (read-only reads + its three entry action tools; configurable in Settings → Agent → Agentic Tools).
const AGENT_ID = 'entryAgent'

// Safety valve: how many model↔tool round-trips one intent's pass may take before we stop.
const MAX_TOOL_ROUNDS = 6

let running = false
export function isRunningEntry(): boolean { return running }

// Coins currently under review, so the registration-triggered single-coin pass and the
// periodic routing pass can't double-review the same coin concurrently.
const inFlight = new Set<string>()

type StoredToolCalls = OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
type Tone = SignalRunFrame['tone']
type EntryAction = EntryAgentRun['action']

// In-progress reviews for the current pass, kept in memory so the Entry Agent page can
// rehydrate a running pass after a reload (live frames aren't persisted until the run lands).
export interface ActiveEntryReview {
  coin: string
  cycle_id: string
  status: 'reviewing' | 'done' | 'error'
  frames: SignalRunFrame[]
  peak_context_tokens: number
  started_at_ms: number
}
const activeReviews = new Map<string, ActiveEntryReview>()
export function getActiveEntryReviews(): ActiveEntryReview[] {
  return [...activeReviews.values()].sort((a, b) => b.started_at_ms - a.started_at_ms)
}

// Per-tool presentation, shared by the live feed and the persisted transcript so both render
// identically. Keep in sync with the frontend's expectations (it just renders).
const TOOL_FEED: Record<string, { icon: string; verb: string }> = {
  get_entry_intent:        { icon: '🎯', verb: 'Reading entry intent' },
  get_market:              { icon: '📈', verb: 'Reading live indicators' },
  get_candle_data:         { icon: '💾', verb: 'Reading candle data' },
  get_coin_sentiment:      { icon: '📰', verb: 'Checking news sentiment' },
  recall_signal_memory:    { icon: '🧠', verb: 'Recalling signal thesis' },
  get_coin_signal_history: { icon: '🗂️', verb: 'Reviewing prior verdicts' },
  list_recent_signals:     { icon: '🔔', verb: 'Scanning recent signals' },
  list_entry_events:       { icon: '📜', verb: 'Reading entry history' },
  set_entry_band:          { icon: '🎚️', verb: 'Setting entry band' },
  fire_entry_now:          { icon: '🚀', verb: 'Firing entry now' },
  cancel_entry:            { icon: '🚫', verb: 'Cancelling entry' },
}

// Caps a tool result before it rides on a frame's `detail` (persisted + broadcast) — long
// arrays are trimmed to their first/last few entries so the popover stays useful without bloat.
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

// Records the transcript for one intent's pass while streaming each frame live.
class Recorder {
  private entry: ActiveEntryReview
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
    // `source: 'entry_agent'` lets the page tell these apart from the chat agent / Agent Signal / monitor D.
    broadcast('agent_step', { source: 'entry_agent', cycle_id: this.cycleId, coin: this.coin, ...frame, ...extra })
  }

  release(): void { activeReviews.delete(this.coin) }
  fail(error: string): void {
    this.entry.status = 'error'
    this.push('error', '❌', `Error: ${error}`, 'sell', { error })
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

interface EntryVerdict {
  action: EntryAction
  confidence: number
  reasoning: string
  notes: string | null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

// Parse the agent's final summary JSON. The side effects already happened via the action
// tools; this is the explanation + the action label for the run record. Throws when no
// valid object is present so the loop can nudge once more.
function parseEntryVerdict(content: string): EntryVerdict {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON found in Entry Agent response')
    parsed = JSON.parse(match[0])
  }
  const c = ((parsed as Record<string, unknown>)?.verdict ?? parsed) as Record<string, unknown>
  if (typeof c !== 'object' || c === null) throw new Error('Invalid verdict in Entry Agent response')
  const action = String(c.action ?? '').toUpperCase()
  const valid: EntryAction[] = ['ADJUST', 'FIRE', 'CANCEL', 'WAIT']
  return {
    action: (valid.includes(action as EntryAction) ? action : 'WAIT') as EntryAction,
    confidence: num(c.confidence) ?? 0,
    reasoning: typeof c.reasoning === 'string' ? c.reasoning.trim() : '',
    notes: typeof c.notes === 'string' && c.notes.trim() ? c.notes.trim() : null,
  }
}

// ── prompt ─────────────────────────────────────────────────────────────────────

// The "Method" section lists exactly the tools getAgentToolPrompt resolves for this agent
// (filtered to whatever's granted) — never hardcode a tool name here, or it can drift.
function buildSystemPrompt(coin: string, toolPrompt: string): string {
  return `You are "Entry Agent", an autonomous execution trader managing the ENTRY for a single deferred BUY — ${coin}.

A BUY for ${coin} has already been decided and is staged on the Entry Desk: instead of buying at market, the engine waits for a good price inside an entry band (a pullback target to buy at, an invalidate level that abandons on a breakdown, a chase cap that abandons if price runs away, and a TTL). Your job each pass is to read the live setup and DRIVE this entry to the best outcome.

Method — gather evidence with your tools BEFORE acting:
${toolPrompt}
ALWAYS start by calling get_entry_intent (your current band + the BUY thesis) and recall_signal_memory (the analyst's thesis/levels) so you adapt the existing window instead of starting blind. Read price structure (candles) and momentum/volatility before moving levels. You have at most ${MAX_TOOL_ROUNDS} tool rounds; call only the tools you need.

Decide and ACT via your action tools (the side effect IS the decision):
- set_entry_band — re-anchor the band to a smarter window: deeper pullback in high volatility / weak momentum; a shallow pullback (or fire now) in a strong uptrend you shouldn't wait on; tighten the invalidate when structure is fragile; extend the TTL when the setup needs more time. Levels are % relative to the LIVE price; invalidate_pct MUST be greater than pullback_pct.
- fire_entry_now — buy immediately when the entry is good right now and waiting risks missing it.
- cancel_entry — abandon when the thesis is broken or the risk/reward has decayed. Protecting capital beats forcing a bad entry.
- Do nothing (WAIT) when the current band is already well-placed — leave it for the watch loop.

When — and only when — you are done, reply with ONE JSON object and NOTHING else:
{
  "action": "ADJUST" | "FIRE" | "CANCEL" | "WAIT",   // what you did this pass
  "confidence": 0.0-1.0,                              // how sure you are in this action
  "reasoning": "1-3 sentences citing concrete evidence for what you did",
  "notes": string | null                             // optional short memo
}`
}

function buildUserBriefing(coin: string, intent: EntryIntent, price: number, ctx: MarketContext): string {
  const f = (n: number | null | undefined, d = 2) => (n == null ? 'n/a' : n.toFixed(d))
  const regime = classifyRegime(ctx)
  const minsLeft = Math.max(0, (intent.expiresAt - Date.now()) / 60000)
  return [
    `Entry under management: ${coin}`,
    `Live price: ${f(price, 6)}   24h: ${f(ctx.change24h)}%   7d: ${f(ctx.perf7d)}%`,
    `Indicators — RSI14: ${f(ctx.rsi14, 1)}, trend: ${ctx.trend}, volatility: ${ctx.volatility}, ATR14: ${f(ctx.atr14, 6)}`,
    `Regime: ${regime.summary}`,
    '',
    `Current entry band (source: ${intent.bandSource}):`,
    `  buy target ${f(intent.targetPrice, 6)} · invalidate ${f(intent.invalidatePrice, 6)} · chase cap ${f(intent.chaseCapPrice, 6)} · TTL ${minsLeft.toFixed(1)}m left`,
    `  BUY thesis: ${intent.signal.reason || 'n/a'}`,
    '',
    'Investigate with get_entry_intent + recall_signal_memory first, then act via your action tools and return the JSON summary.',
  ].join('\n')
}

// ── tool loop ──────────────────────────────────────────────────────────────────

// Runs the tool-calling loop for one intent and returns the parsed verdict, recording each
// step and tracking which action tools fired (so the run records the TRUE action, not just
// the model's claim). Stops early once the intent is consumed (fired/cancelled).
async function runAgenticEntry(coin: string, intent: EntryIntent, price: number, ctx: MarketContext, cycleId: string, rec: Recorder): Promise<EntryVerdict> {
  const tools = getAgentToolSchemas(AGENT_ID)
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(coin, getAgentToolPrompt(AGENT_ID)) },
    { role: 'user', content: buildUserBriefing(coin, intent, price, ctx) },
  ]

  const observed = { fired: false, cancelled: false, adjusted: false }
  const deriveAction = (): EntryAction =>
    observed.fired ? 'FIRE' : observed.cancelled ? 'CANCEL' : observed.adjusted ? 'ADJUST' : 'WAIT'

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rec.push('thinking', '🤔', `Thinking… (round ${round + 1})`, 'muted', { round })

    const resp = await scheduleChat({
      // `analyse` lane is serialized (limit 1): with the sequential intent loop this guarantees
      // no other coin's agent calls interleave with the one in flight.
      module: 'entryAgent', lane: 'analyse', priority: 1, coin, cycleId,
      route: () => resolveLLM('entryAgent'),
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
        const ok = res?.ok === true
        const resultDetail = { tool: name, result: truncateForDetail(result) }

        // Track real side effects so the run records the true action.
        if (ok && name === 'set_entry_band') observed.adjusted = true
        if (ok && name === 'fire_entry_now') observed.fired = true
        if (ok && name === 'cancel_entry') observed.cancelled = true

        if (res?.error) {
          rec.push('tool_result', '⚠️', `${meta.verb} → ${String(res.error)}`, 'warn', { tool: name }, resultDetail)
        } else {
          const tone: Tone = name === 'fire_entry_now' && ok ? 'buy' : name === 'cancel_entry' && ok ? 'warn' : 'muted'
          rec.push('tool_result', '✓', `${meta.verb} complete`, tone, { tool: name }, resultDetail)
        }

        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id })
      }

      // The intent was consumed (fired/cancelled) — nothing left to manage; synthesize a verdict.
      if (observed.fired || observed.cancelled) {
        return { action: deriveAction(), confidence: 0.7, reasoning: content || '', notes: null }
      }
      continue
    }

    // No tool calls → the model is committing. Read its JSON summary for reasoning/confidence,
    // but the recorded action is ALWAYS what actually happened via the tools (a claimed FIRE
    // with no fire_entry_now call did nothing → WAIT), so the run never overstates.
    try {
      const v = parseEntryVerdict(content)
      return { ...v, action: deriveAction() }
    } catch {
      messages.push({ role: 'assistant', content: content || null })
      messages.push({ role: 'user', content: 'Respond now with ONLY the JSON summary object specified — no prose, no code fences.' })
    }
  }

  logger.warn('Entry Agent exhausted rounds without a JSON verdict', { coin, cycleId })
  return { action: deriveAction(), confidence: 0, reasoning: '', notes: '[Entry Agent could not reach a conclusive summary within the round budget]' }
}

// ── per-intent pass ──────────────────────────────────────────────────────────────

// Reviews one active intent end-to-end: build live context, run the agentic loop (which acts
// via tools), then persist the run (verdict + transcript) and broadcast it. Guards against a
// concurrent pass on the same coin and against the intent vanishing mid-pass.
async function reviewIntent(coin: string, cycleId: string): Promise<void> {
  if (inFlight.has(coin)) return
  if (!entry.hasActiveIntent(coin)) return
  inFlight.add(coin)
  const rec = new Recorder(cycleId, coin)
  try {
    rec.push('coin_started', '🔍', `Managing entry for ${coin}…`, 'accent')

    const intent = entry.getActiveIntents().find(i => i.coin === coin)
    if (!intent) { rec.fail('Entry intent vanished before the pass started'); await persistRun(coin, cycleId, rec, waitVerdict()); return }

    const price = priceCache.getPrice(coin)?.price
    if (!price || !(price > 0)) {
      rec.fail(`No live price for ${coin} yet`)
      await persistRun(coin, cycleId, rec, waitVerdict('No live price available'))
      return
    }
    const ctx = await getMarketContext(coin, price)

    // Run the whole tool-calling loop as one session so it holds the entryAgent endpoint
    // across all its rounds + nested tool LLM calls — no other module swaps the model mid-pass.
    const verdict = await runInSession(
      { route: () => resolveLLM('entryAgent') },
      () => runAgenticEntry(coin, intent, price, ctx, cycleId, rec),
    )

    const tone: Tone = verdict.action === 'FIRE' ? 'buy' : verdict.action === 'CANCEL' ? 'warn' : verdict.action === 'ADJUST' ? 'accent' : 'muted'
    const icon = verdict.action === 'FIRE' ? '🚀' : verdict.action === 'CANCEL' ? '🚫' : verdict.action === 'ADJUST' ? '🎚️' : '✋'
    rec.push('decision', icon, `Decision: ${verdict.action}`, tone, { action: verdict.action, confidence: verdict.confidence, reasoning: verdict.reasoning })

    await persistRun(coin, cycleId, rec, verdict)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Entry Agent intent pass failed', { coin, cycleId, error })
    rec.fail(error)
    await persistRun(coin, cycleId, rec, waitVerdict(error))
  } finally {
    inFlight.delete(coin)
  }
}

function waitVerdict(reasoning = ''): EntryVerdict {
  return { action: 'WAIT', confidence: 0, reasoning, notes: null }
}

// Persist one intent's pass (verdict + full transcript) and broadcast the saved record.
async function persistRun(coin: string, cycleId: string, rec: Recorder, v: EntryVerdict): Promise<void> {
  const model = `entry-agent:${resolveLLM('entryAgent').model}`
  const runDoc: Omit<EntryAgentRun, 'id'> = {
    cycle_id: cycleId, coin, action: v.action, confidence: v.confidence, reasoning: v.reasoning,
    model, frames: rec.frames,
    prompt_tokens: rec.promptTokens, completion_tokens: rec.completionTokens, peak_context_tokens: rec.peakContext,
    started_at_ms: rec.startedAt, created_at: nowSql(),
  }
  const id = Number(await entryAgentRuns.insert(runDoc))
  broadcast('entry_agent_run_saved', { id, ...runDoc } satisfies EntryAgentRun)
  rec.release()
}

// Keeps only the most recent `entry_agent_retain_runs` records (by id), pruning the rest.
async function pruneRuns(): Promise<void> {
  const keep = Math.max(10, getSettings().entry_agent_retain_runs || 200)
  const cutoffRow = (await entryAgentRuns.find({}, { sort: { id: -1 }, skip: keep, limit: 1, projection: { id: 1 } }))[0] as { id: number } | undefined
  if (cutoffRow) await entryAgentRuns.deleteMany({ id: { $lte: cutoffRow.id } })
}

// ── cycle entrypoints ──────────────────────────────────────────────────────────

// Full pass over every active entry intent. Routed here by the routing output node
// `module_entry_agent` (and the manual "Run now"). Guarded so passes can't overlap.
export async function runEntryAgent(cycleId: string): Promise<void> {
  const s = getSettings()
  if (s.entry_model !== 'agent') {
    logger.info('Entry Agent skipped — entry_model is not "agent"', { cycleId, mode: s.entry_model })
    return
  }
  if (running) {
    logger.warn('Entry Agent already running, skipping', { cycleId })
    return
  }
  running = true
  logger.info('Entry Agent pass started', { cycleId })
  broadcast('entry_agent_started', { cycle_id: cycleId })

  try {
    const coins = entry.getActiveIntents().map(i => i.coin)
    if (coins.length === 0) {
      broadcast('entry_agent_completed', { cycle_id: cycleId, reviewed: 0, message: 'No active entry intents' })
      return
    }
    // STRICTLY SEQUENTIAL: one intent's whole loop completes before the next begins.
    let reviewed = 0
    for (const coin of coins) {
      // The intent may have filled/cancelled (static safety net) since the snapshot.
      if (!entry.hasActiveIntent(coin)) continue
      await reviewIntent(coin, cycleId)
      reviewed++
    }
    await pruneRuns()
    broadcast('entry_agent_completed', { cycle_id: cycleId, reviewed })
    logger.info('Entry Agent pass completed', { cycleId, reviewed })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Entry Agent pass failed', { cycleId, error })
    broadcast('entry_agent_error', { cycle_id: cycleId, error })
  } finally {
    running = false
  }
}

// Single-coin pass — for the immediate first pass on a freshly registered intent
// (entry_intent_registered) and the manual "run this coin" trigger. Independent of the
// full-cycle lock so it can run on demand; the per-coin inFlight guard prevents overlap.
export async function runEntryAgentCoin(coin: string, cycleId: string): Promise<void> {
  if (getSettings().entry_model !== 'agent') return
  if (!entry.hasActiveIntent(coin)) return
  logger.info('Entry Agent single-coin pass started', { coin, cycleId })
  try {
    await reviewIntent(coin, cycleId)
    await pruneRuns()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Entry Agent single-coin pass failed', { coin, cycleId, error })
  }
}

// Recent persisted runs (newest first), for the Entry Agent page to rehydrate after a reload.
export async function getEntryAgentRuns(limit = 100): Promise<EntryAgentRun[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  return entryAgentRuns.find({}, { sort: { id: -1 }, limit: capped, projection: { _id: 0 } }) as unknown as Promise<EntryAgentRun[]>
}
