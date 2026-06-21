// Entry Agent — the agentic, per-coin entry-position engine.
//
// Selected via `entry_model === 'agent'`, it replaces the static/Entry-Planner band logic
// for deferred BUYs on the Entry Desk. Where the static engine sets a fixed band once,
// the Entry Agent runs ONE tool-calling agent per active entry intent that reads live
// market structure, the original BUY thesis and the Agent Signal memory, then DECIDES how
// to drive the deferred BUY.
//
// The agent has NO action tools — its tool belt is strictly read-only. The decision (ADJUST
// the band / FIRE now / CANCEL / WAIT) is carried in the agent's final JSON verdict, and the
// ENGINE executes it here (applyEntryVerdict). This guarantees the displayed verdict and the
// real side effect can never diverge: a "CANCEL" verdict cancels, a "WAIT" does nothing.
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
import { isOffline } from '../core/offlineMode.js'
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

// The band levels an ADJUST verdict carries (percentages relative to the LIVE price at apply
// time). Every field optional — an omitted level keeps its current value when applied.
interface VerdictBand {
  pullbackPct?: number
  invalidatePct?: number
  chaseCapPct?: number
  ttlMinutes?: number
}

interface EntryVerdict {
  action: EntryAction
  confidence: number
  reasoning: string
  notes: string | null
  /** Populated only for ADJUST — the levels the engine should apply to the band. */
  band: VerdictBand
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

// Parse the agent's final verdict JSON. The agent has NO action tools, so this verdict IS the
// decision — the engine executes it (applyEntryVerdict). For an ADJUST it also carries the band
// levels to set. Throws when no valid object is present so the loop can nudge once more.
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
  // null → undefined so an omitted level isn't applied (applyAgentBand treats null as "keep").
  const opt = (v: unknown) => num(v) ?? undefined
  return {
    action: (valid.includes(action as EntryAction) ? action : 'WAIT') as EntryAction,
    confidence: num(c.confidence) ?? 0,
    reasoning: typeof c.reasoning === 'string' ? c.reasoning.trim() : '',
    notes: typeof c.notes === 'string' && c.notes.trim() ? c.notes.trim() : null,
    band: {
      pullbackPct: opt(c.pullback_pct),
      invalidatePct: opt(c.invalidate_pct),
      chaseCapPct: opt(c.chase_cap_pct),
      ttlMinutes: opt(c.ttl_minutes),
    },
  }
}

// ── prompt ─────────────────────────────────────────────────────────────────────

// The "Method" section lists exactly the tools getAgentToolPrompt resolves for this agent
// (filtered to whatever's granted) — never hardcode a tool name here, or it can drift.
function buildSystemPrompt(coin: string, toolPrompt: string): string {
  const maxPullback = getSettings().entry_max_pullback_pct
  const depthRule = maxPullback > 0
    ? `Entry-depth discipline — getting filled matters more than shaving the last fraction of a percent. The buy target may sit AT MOST ${maxPullback}% below the live price (deeper requests are clamped to this), but you should usually choose far less. A target a few percent down looks great on paper and then never triggers: the price drifts up, the TTL lapses, and you miss the whole move — this is the single most common way this desk loses a good BUY. Reserve a deeper pullback for a genuinely ranging / oversold tape where a dip is likely. When the setup is up-momentum, breaking out, or pressing resistance, do NOT wait for a dip that probably won't come: set a shallow pullback (≈0–0.5%) or FIRE now. A small, certain fill beats a perfect entry you never get.`
    : `Entry-depth discipline — getting filled matters more than shaving the last fraction of a percent. A buy target a few percent below market looks great on paper and then never triggers: the price drifts up, the TTL lapses, and you miss the whole move — this is the single most common way this desk loses a good BUY. Reserve a deeper pullback for a genuinely ranging / oversold tape where a dip is likely. When the setup is up-momentum, breaking out, or pressing resistance, do NOT wait for a dip that probably won't come: set a shallow pullback (≈0–0.5%) or FIRE now. A small, certain fill beats a perfect entry you never get.`
  return `You are "Entry Agent", an autonomous execution trader managing the ENTRY for a single deferred BUY — ${coin}.

A BUY for ${coin} has already been decided and is staged on the Entry Desk: instead of buying at market, the engine waits for a good price inside an entry band (a pullback target to buy at, an invalidate level that abandons on a breakdown, a chase cap that abandons if price runs away, and a TTL). Your job each pass is to read the live setup and decide how to DRIVE this entry to the best outcome — then get out of the way.

${depthRule}

Method — gather evidence with your READ-ONLY tools BEFORE deciding:
${toolPrompt}
ALWAYS start by calling get_entry_intent (your current band, age, and full band history) and recall_signal_memory (the analyst's thesis/levels) so you adapt the existing window instead of starting blind. Read price structure (candles) and momentum/volatility before choosing levels. You have at most ${MAX_TOOL_ROUNDS} tool rounds; call only the tools you need.

You have NO action tools — you decide by returning ONE action in your final JSON, and the engine executes it. Default to doing NOTHING; act only when the evidence clearly calls for it:
- WAIT (do nothing) — the right answer on most passes. If the band is already well-placed and nothing material has changed since the last pass, leave it untouched for the watch loop. A no-op tweak is churn, not management.
- ADJUST — re-shape the band ONLY when the setup has genuinely changed: a deeper pullback as volatility rises / momentum weakens; a shallower pullback in a strengthening uptrend you shouldn't wait on; a tighter invalidate when structure turns fragile. Put the new levels in the JSON below — EVERY level field is optional, so include ONLY the ones you are changing and the rest stay as they are. Any percentage is relative to the LIVE price; the band must stay ordered (invalidate below the target, chase cap above it).
- FIRE — buy immediately when the entry is good right now and waiting risks missing it.
- CANCEL — abandon when the thesis is broken, the risk/reward has decayed, OR the entry has been waiting a long time across several refreshes and simply isn't triggering. Protecting capital and freeing the slot beats babysitting a stale entry.

TTL discipline — the TTL is a TIME-BOX, not a renewable lease, and refreshing it for no new reason is the single most common failure here. Do NOT extend the TTL (via ttl_minutes on an ADJUST) just to "keep the window open"; that quietly defeats its purpose. Extend it ONLY for a specific, newly-observed reason that justifies more patience, and never repeatedly. If a setup already carries several TTL-only refreshes and still hasn't triggered, do not refresh it again — CANCEL and release the capital, or WAIT and let it expire on its own.

When — and only when — you are done, reply with ONE JSON object and NOTHING else:
{
  "action": "ADJUST" | "FIRE" | "CANCEL" | "WAIT",   // the engine executes exactly this
  "confidence": 0.0-1.0,                              // how sure you are in this action
  "reasoning": "1-3 sentences citing concrete evidence for your decision",
  "notes": string | null,                            // optional short memo
  // Include these ONLY for "ADJUST" — every field optional; omit a level to leave it unchanged:
  "pullback_pct": number,    // buy target as % BELOW the live price (0 = buy at market)
  "invalidate_pct": number,  // cancel-on-breakdown as % below the live price (ends up below the target)
  "chase_cap_pct": number,   // cancel-on-runaway as % above the live price
  "ttl_minutes": number      // new time-box in minutes from now
}`
}

// How many times the band has already been re-anchored, and how many of those were
// TTL-only refreshes (same price levels, just a pushed-out expiry). Surfacing this in
// the briefing is what lets the agent recognize its own churn and stop perpetually
// extending a setup that isn't triggering.
function summarizeBandHistory(history: EntryIntent['bandHistory']): { adjustments: number; ttlOnly: number } {
  let ttlOnly = 0
  for (let i = 1; i < history.length; i++) {
    const a = history[i], b = history[i - 1]
    if (a.targetPrice === b.targetPrice && a.invalidatePrice === b.invalidatePrice && a.chaseCapPrice === b.chaseCapPrice) ttlOnly++
  }
  return { adjustments: Math.max(0, history.length - 1), ttlOnly }
}

function buildUserBriefing(coin: string, intent: EntryIntent, price: number, ctx: MarketContext): string {
  const f = (n: number | null | undefined, d = 2) => (n == null ? 'n/a' : n.toFixed(d))
  const regime = classifyRegime(ctx)
  const now = Date.now()
  const minsLeft = Math.max(0, (intent.expiresAt - now) / 60000)
  const ageMin = (now - intent.createdAt) / 60000
  const ageStr = ageMin >= 60 ? `${(ageMin / 60).toFixed(1)}h` : `${ageMin.toFixed(0)}m`
  const { adjustments, ttlOnly } = summarizeBandHistory(intent.bandHistory)
  // % the live price must still move to reach a band level (negative = level below live).
  const toPct = (lvl: number) => `${(((lvl - price) / price) * 100).toFixed(2)}%`
  return [
    `Entry under management: ${coin}`,
    `Live price: ${f(price, 6)}   24h: ${f(ctx.change24h)}%   7d: ${f(ctx.perf7d)}%   vol24h: ${f(ctx.volume, 0)}`,
    `Indicators — RSI14: ${f(ctx.rsi14, 1)}, trend: ${ctx.trend}, volatility: ${ctx.volatility}, ATR14: ${f(ctx.atr14, 6)}`,
    `Structure — SMA7 ${f(ctx.sma7, 6)} · SMA25 ${f(ctx.sma25, 6)} · SMA99 ${f(ctx.sma99, 6)}`,
    `Regime: ${regime.summary}`,
    '',
    `Current entry band (source: ${intent.bandSource}):`,
    `  buy target ${f(intent.targetPrice, 6)} (${toPct(intent.targetPrice)} from live) · invalidate ${f(intent.invalidatePrice, 6)} (${toPct(intent.invalidatePrice)}) · chase cap ${f(intent.chaseCapPrice, 6)} (${toPct(intent.chaseCapPrice)})`,
    `  BUY thesis: ${intent.signal.reason || 'n/a'}`,
    '',
    `Wait so far: ${ageStr} in management · TTL ${minsLeft.toFixed(0)}m left · band re-anchored ${adjustments}× (${ttlOnly} of them TTL-only refreshes).`,
    ttlOnly >= 2
      ? `You have already refreshed the TTL ${ttlOnly} times without this setup triggering. Do NOT refresh it again unless something materially changed; if the pullback simply isn't playing out, CANCEL and free the slot.`
      : '',
    '',
    'Investigate with get_entry_intent + recall_signal_memory first, then act via your action tools and return the JSON summary.',
  ].filter(Boolean).join('\n')
}

// ── tool loop ──────────────────────────────────────────────────────────────────

// Runs the read-only tool-calling loop for one intent and returns the parsed verdict. The
// agent only GATHERS evidence here (no action tools); the decision rides on the final JSON
// verdict, which the caller hands to applyEntryVerdict to execute.
async function runAgenticEntry(coin: string, intent: EntryIntent, price: number, ctx: MarketContext, cycleId: string, rec: Recorder): Promise<EntryVerdict> {
  // Defence-in-depth: even if a saved Agentic-Tools override re-enabled an action tool for this
  // agent, never expose it — the entry is driven by the JSON verdict, not by tools.
  const tools = getAgentToolSchemas(AGENT_ID).filter(t => isReadOnlyTool(t.function.name))
  const toolPrompt = getAgentToolPrompt(AGENT_ID)
    .split('\n')
    .filter(line => { const m = /^- (\w+):/.exec(line); return !m || isReadOnlyTool(m[1]) })
    .join('\n')
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(coin, toolPrompt) },
    { role: 'user', content: buildUserBriefing(coin, intent, price, ctx) },
  ]

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
        const resultDetail = { tool: name, result: truncateForDetail(result) }

        if (res?.error) {
          rec.push('tool_result', '⚠️', `${meta.verb} → ${String(res.error)}`, 'warn', { tool: name }, resultDetail)
        } else {
          rec.push('tool_result', '✓', `${meta.verb} complete`, 'muted', { tool: name }, resultDetail)
        }

        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id })
      }
      continue
    }

    // No tool calls → the model is committing its verdict. This JSON IS the decision.
    try {
      return parseEntryVerdict(content)
    } catch {
      messages.push({ role: 'assistant', content: content || null })
      messages.push({ role: 'user', content: 'Respond now with ONLY the JSON verdict object specified — no prose, no code fences.' })
    }
  }

  logger.warn('Entry Agent exhausted rounds without a JSON verdict', { coin, cycleId })
  return { action: 'WAIT', confidence: 0, reasoning: '', notes: '[Entry Agent could not reach a conclusive verdict within the round budget]', band: {} }
}

// Execute the agent's verdict — the agent has no action tools, so the ENGINE drives the entry
// here. Returns the action that ACTUALLY took effect (downgraded to WAIT if the intent vanished
// mid-pass or the entry service rejected the change), so the recorded/displayed verdict never
// overstates what happened. Each effect is pushed as a frame for the live feed + transcript.
async function applyEntryVerdict(coin: string, v: EntryVerdict, rec: Recorder): Promise<EntryAction> {
  if (v.action === 'WAIT') return 'WAIT'

  // The static safety net (falling-knife / chase-cap / TTL) may have filled or cancelled the
  // intent between the LLM call finishing and now — don't act on a stale decision.
  if (!entry.hasActiveIntent(coin)) {
    rec.push('tool_result', '⚠️', `Entry for ${coin} is no longer active — ${v.action} skipped`, 'warn')
    return 'WAIT'
  }

  if (v.action === 'CANCEL') {
    entry.cancel(coin, 'agent')
    rec.push('tool_result', '🚫', 'Entry cancelled', 'warn', { tool: 'cancel_entry' })
    return 'CANCEL'
  }

  if (v.action === 'FIRE') {
    const res = entry.fireNow(coin)
    if (!res.ok) {
      rec.push('tool_result', '⚠️', `Fire failed: ${res.error ?? 'unknown error'}`, 'warn')
      return 'WAIT'
    }
    rec.push('tool_result', '🚀', 'Entry fired at market', 'buy', { tool: 'fire_entry_now' })
    return 'FIRE'
  }

  // ADJUST — re-anchor the band to the levels in the verdict (omitted levels stay as-is).
  const res = await entry.applyAgentBand(coin, { ...v.band, reason: v.reasoning })
  if (!res.ok) {
    rec.push('tool_result', '⚠️', `Band update failed: ${res.error ?? 'unknown error'}`, 'warn')
    return 'WAIT'
  }
  rec.push('tool_result', '🎚️', 'Entry band updated', 'accent', { tool: 'set_entry_band' })
  return 'ADJUST'
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

    // The agent has no action tools — the engine executes its JSON verdict here, and the run
    // records the action that ACTUALLY took effect (so the desk never shows a phantom CANCEL).
    verdict.action = await applyEntryVerdict(coin, verdict, rec)

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
  return { action: 'WAIT', confidence: 0, reasoning, notes: null, band: {} }
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
  if (s.entry_model !== 'agent' || isOffline()) {
    logger.info('Entry Agent skipped', { cycleId, mode: s.entry_model, offline: isOffline() })
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
  if (getSettings().entry_model !== 'agent' || isOffline()) return
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
