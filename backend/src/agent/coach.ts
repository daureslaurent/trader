// Coach Agent — the agentic, system-wide process-audit engine.
//
// Where the other agents each make ONE kind of decision (analyst → BUY/SELL, monitor →
// SL/TP/close, entry → fill timing), the Coach steps back and audits HOW WELL they're
// deciding over time. One global tool-calling pass per cycle reads the system's track
// record — entry fill/miss rates, closed-position outcomes, recent signals/reviews — with
// a strictly READ-ONLY tool belt, then writes corrections back into the channels the other
// agents read so they self-correct on their next run.
//
// Like the Entry Agent, it has NO action tools: the corrections ride on the agent's final
// JSON verdict and the ENGINE applies them (applyCoachVerdict). Two write channels:
//   - per-coin  → agent_signal_memory.notes  (read by Agent Signal AND the Entry Agent)
//   - global    → coach_memory log           (injected into the Monitor + Analyst prompts)
// `recommendations` are advisory settings ideas for the human — surfaced on the page, never
// applied (no settings mutation; that's a deliberate guardrail).
//
// Guardrail against overfitting a small trade sample: the pass no-ops below
// `coach_min_trades` closed positions, runs infrequently (daily cron), and is prompted to
// flag tentative patterns rather than confidently "fix" off noise. Each pass persists to
// `coach_runs` (verdict + transcript) and streams live frames to the Coach Agent page as
// `agent_step` events (source 'coach').
import OpenAI from 'openai'
import { scheduleChat, runInSession } from '../core/llmScheduler.js'
import { resolveLLM } from '../config/llm.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { isOffline } from '../core/offlineMode.js'
import { getSettings, nowSql, coachRuns, positions } from '../db/index.js'
import type { CoachRun, CoachFinding, CoachCorrection, SignalRunFrame } from '../types.js'
import { isReadOnlyTool, upsertSignalMemory, appendCoachMemory, getCoachMemory } from './tools.js'
import { getAgentToolSchemas, getAgentToolPrompt, runAgentTool } from './registry.js'

const AGENT_ID = 'coach'

// Safety valve: how many model↔tool round-trips one audit may take before we stop. Higher
// than the per-coin agents — the Coach surveys the whole system, so it calls more tools.
const MAX_TOOL_ROUNDS = 10

let running = false
export function isRunningCoach(): boolean { return running }

type StoredToolCalls = OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
type Tone = SignalRunFrame['tone']

// The single in-flight audit, kept in memory so the Coach Agent page can rehydrate a
// running pass after a reload (live frames aren't persisted until the run lands).
export interface ActiveCoachReview {
  cycle_id: string
  status: 'reviewing' | 'done' | 'error'
  frames: SignalRunFrame[]
  peak_context_tokens: number
  started_at_ms: number
}
let activeReview: ActiveCoachReview | null = null
export function getActiveCoachReview(): ActiveCoachReview | null { return activeReview }

// Per-tool presentation, shared by the live feed and the persisted transcript. Keep in sync
// with the frontend's expectations (it just renders icon + text).
const TOOL_FEED: Record<string, { icon: string; verb: string }> = {
  get_entry_performance:   { icon: '🎯', verb: 'Auditing entry fills' },
  get_closed_positions:    { icon: '📉', verb: 'Reviewing closed trades' },
  recall_coach_memory:     { icon: '🧠', verb: 'Recalling past lessons' },
  get_portfolio:           { icon: '💼', verb: 'Reading portfolio' },
  list_open_positions:     { icon: '📂', verb: 'Reading open positions' },
  list_recent_trades:      { icon: '🧾', verb: 'Reading recent trades' },
  list_recent_signals:     { icon: '🔔', verb: 'Reviewing analyst signals' },
  list_position_reviews:   { icon: '🗂️', verb: 'Reviewing monitor calls' },
  get_portfolio_summary:   { icon: '📰', verb: 'Reading portfolio summary' },
  get_position_history:    { icon: '📜', verb: 'Reading coin history' },
  recall_signal_memory:    { icon: '🧩', verb: 'Reading signal memory' },
  get_coin_signal_history: { icon: '🗃️', verb: 'Reviewing prior verdicts' },
  get_market:              { icon: '📈', verb: 'Reading live indicators' },
  get_trading_settings:    { icon: '⚙️', verb: 'Reading trading config' },
}

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

// Records the transcript for the audit while streaming each frame live.
class Recorder {
  private review: ActiveCoachReview
  promptTokens = 0
  completionTokens = 0
  peakContext = 0
  constructor(private cycleId: string) {
    this.review = { cycle_id: cycleId, status: 'reviewing', frames: [], peak_context_tokens: 0, started_at_ms: Date.now() }
    activeReview = this.review
  }
  get frames(): SignalRunFrame[] { return this.review.frames }
  get startedAt(): number { return this.review.started_at_ms }

  addUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): void {
    if (!usage) return
    const p = usage.prompt_tokens ?? 0
    const c = usage.completion_tokens ?? 0
    this.promptTokens += p
    this.completionTokens += c
    this.peakContext = Math.max(this.peakContext, usage.total_tokens ?? p + c)
    this.review.peak_context_tokens = this.peakContext
  }

  push(type: string, icon: string, text: string, tone: Tone, extra: Record<string, unknown> = {}, detail?: SignalRunFrame['detail']): void {
    const frame: SignalRunFrame = { type, icon, text, tone, at: Date.now(), ...(detail ? { detail } : {}) }
    this.review.frames.push(frame)
    if (type === 'error') this.review.status = 'error'
    else if (type === 'decision') this.review.status = 'done'
    broadcast('agent_step', { source: 'coach', cycle_id: this.cycleId, ...frame, ...extra })
  }

  release(): void { activeReview = null }
  fail(error: string): void {
    this.review.status = 'error'
    this.push('error', '❌', `Error: ${error}`, 'sell', { error })
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

interface CoachVerdict {
  assessment: string
  findings: CoachFinding[]
  corrections: CoachCorrection[]
  recommendations: string[]
  confidence: number
}

function emptyVerdict(assessment = ''): CoachVerdict {
  return { assessment, findings: [], corrections: [], recommendations: [], confidence: 0 }
}

const FINDING_AGENTS = new Set(['analyst', 'signal', 'entry', 'monitor', 'portfolio'])
const SEVERITIES = new Set(['info', 'low', 'medium', 'high'])

function normCoin(input: unknown): string | null {
  const raw = String(input ?? '').trim().toUpperCase()
  if (!raw) return null
  if (raw.includes('/')) return raw
  const base = raw.replace(/USDC$/, '').replace(/USDT$/, '')
  return base ? `${base}/USDC` : null
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

// Parse the agent's final verdict JSON. The agent has NO action tools, so this verdict IS the
// decision — the engine executes the corrections it carries. Throws when no valid object is
// present so the loop can nudge once more.
function parseCoachVerdict(content: string): CoachVerdict {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON found in Coach response')
    parsed = JSON.parse(match[0])
  }
  const c = ((parsed as Record<string, unknown>)?.verdict ?? parsed) as Record<string, unknown>
  if (typeof c !== 'object' || c === null) throw new Error('Invalid verdict in Coach response')

  const findings: CoachFinding[] = Array.isArray(c.findings)
    ? c.findings.slice(0, 12).map((f): CoachFinding | null => {
        const o = f as Record<string, unknown>
        const agent = String(o?.agent ?? '').trim().toLowerCase()
        const observation = typeof o?.observation === 'string' ? o.observation.trim() : ''
        const severity = String(o?.severity ?? 'info').trim().toLowerCase()
        if (!observation || !FINDING_AGENTS.has(agent)) return null
        return {
          agent: agent as CoachFinding['agent'],
          observation: observation.slice(0, 500),
          severity: (SEVERITIES.has(severity) ? severity : 'info') as CoachFinding['severity'],
        }
      }).filter((x): x is CoachFinding => x !== null)
    : []

  const corrections: CoachCorrection[] = Array.isArray(c.corrections)
    ? c.corrections.slice(0, 12).map((x): CoachCorrection | null => {
        const o = x as Record<string, unknown>
        const target = String(o?.target ?? '').trim().toLowerCase()
        const note = typeof o?.note === 'string' ? o.note.trim() : ''
        if (!note) return null
        if (target === 'signal') {
          const coin = normCoin(o?.coin)
          if (!coin) return null
          return { target: 'signal', coin, note: note.slice(0, 500) }
        }
        if (target === 'global') return { target: 'global', coin: null, note: note.slice(0, 500) }
        return null
      }).filter((x): x is CoachCorrection => x !== null)
    : []

  const recommendations: string[] = Array.isArray(c.recommendations)
    ? c.recommendations.map(r => (typeof r === 'string' ? r.trim() : String(r))).filter(s => s.length > 0).slice(0, 8).map(s => s.slice(0, 300))
    : []

  return {
    assessment: typeof c.assessment === 'string' ? c.assessment.trim() : '',
    findings,
    corrections,
    recommendations,
    confidence: Math.min(1, Math.max(0, num(c.confidence))),
  }
}

// ── prompt ─────────────────────────────────────────────────────────────────────

function buildSystemPrompt(toolPrompt: string, minTrades: number): string {
  return `You are "Coach", an autonomous trading-desk reviewer. You do NOT trade. Your job is to audit how the desk's other agents are DECIDING — and feed concrete corrections back so they improve.

The other agents you are reviewing:
- Analyst — produces BUY/SELL/HOLD signals with confidence + SL/TP from research.
- Agent Signal — per-coin entry conviction with long-term per-coin memory.
- Entry Agent — times each deferred BUY: sets a pullback/invalidate/chase band to fill a good price (or misses if the band is wrong).
- Monitor — manages open positions: adjusts SL/TP or closes.

Method — gather evidence with your READ-ONLY tools BEFORE concluding:
${toolPrompt}
ALWAYS start with recall_coach_memory (your past lessons — build on them, don't repeat them), then get_entry_performance and get_closed_positions to ground the audit in the actual track record. Drill into specific coins with get_position_history / recall_signal_memory / list_recent_signals as needed. You have at most ${MAX_TOOL_ROUNDS} tool rounds; call only what you need.

Discipline — this is a SMALL sample. Do not over-fit to a handful of trades or a single unlucky loss. Distinguish a systematic, repeated pattern (e.g. "entries consistently expire because targets sit too deep") from noise. State weak signals as tentative. A precise, well-evidenced correction beats a confident guess; if the evidence is thin, say so and record fewer corrections.

You have NO action tools — you produce corrections in your final JSON and the engine writes them into the agents' memory:
- A "signal" correction (with a coin) is appended to that coin's signal memory, read by BOTH the Agent Signal and Entry Agent next time they evaluate it. Use it for coin-specific guidance ("XRP entries keep expiring — target shallower pullbacks").
- A "global" correction is appended to the shared coach-memory log injected into the Monitor and Analyst prompts. Use it for cross-cutting, coin-agnostic lessons ("close winners are being given back — tighten trailing stops once +2%").
Write a correction as a direct, actionable instruction to the receiving agent, grounded in the evidence you cited. Only write corrections you'd stand behind; an empty corrections list is correct when nothing is clearly wrong.
- recommendations are advisory settings ideas for the human operator (e.g. "lower entry_max_pullback_pct to 0.8"). They are shown on the page but NOT applied — never assume a setting changed.

When — and only when — you are done, reply with ONE JSON object and NOTHING else:
{
  "assessment": "2-5 sentence narrative of how the agents are performing right now, citing concrete numbers",
  "confidence": 0.0-1.0,
  "findings": [ { "agent": "analyst"|"signal"|"entry"|"monitor"|"portfolio", "observation": "what you observed, with evidence", "severity": "info"|"low"|"medium"|"high" } ],
  "corrections": [ { "target": "signal"|"global", "coin": "SOL" | null, "note": "a direct instruction to the receiving agent" } ],
  "recommendations": [ "advisory settings idea for the human (not applied)" ]
}
(The desk currently has enough history to audit — at least ${minTrades} closed positions.)`
}

function buildUserBriefing(closedCount: number, openCount: number, lessonsCount: number): string {
  return [
    'System audit requested. Review the desk-wide track record and decide what (if anything) to correct.',
    `Scope right now: ${closedCount} closed positions, ${openCount} open positions, ${lessonsCount} prior coach lesson(s) on record.`,
    '',
    'Start with recall_coach_memory, then get_entry_performance and get_closed_positions. Investigate specific coins as the data warrants, then return the single JSON verdict specified.',
  ].join('\n')
}

// ── tool loop ──────────────────────────────────────────────────────────────────

async function runAgenticCoach(briefing: string, minTrades: number, cycleId: string, rec: Recorder): Promise<CoachVerdict> {
  // Defence-in-depth: even if a saved Agentic-Tools override re-enabled an action tool for
  // this agent, never expose it — the audit writes via the JSON verdict, not via tools.
  const tools = getAgentToolSchemas(AGENT_ID).filter(t => isReadOnlyTool(t.function.name))
  const toolPrompt = getAgentToolPrompt(AGENT_ID)
    .split('\n')
    .filter(line => { const m = /^- (\w+):/.exec(line); return !m || isReadOnlyTool(m[1]) })
    .join('\n')
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(toolPrompt, minTrades) },
    { role: 'user', content: briefing },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rec.push('thinking', '🤔', `Thinking… (round ${round + 1})`, 'muted', { round })

    const resp = await scheduleChat({
      module: 'coach', lane: 'parallel', priority: 1, cycleId,
      route: () => resolveLLM('coach'),
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

    // No tool calls → the model is committing its verdict. This JSON IS the audit result.
    try {
      return parseCoachVerdict(content)
    } catch {
      messages.push({ role: 'assistant', content: content || null })
      messages.push({ role: 'user', content: 'Respond now with ONLY the JSON verdict object specified — no prose, no code fences.' })
    }
  }

  logger.warn('Coach exhausted rounds without a JSON verdict', { cycleId })
  return emptyVerdict('[Coach could not reach a conclusive audit within the round budget]')
}

// Execute the agent's verdict — write each correction into the channel its target reads.
// Returns the corrections that ACTUALLY landed (so the displayed run never overstates).
async function applyCoachVerdict(v: CoachVerdict, cycleId: string, rec: Recorder): Promise<CoachCorrection[]> {
  const applied: CoachCorrection[] = []
  for (const c of v.corrections) {
    try {
      if (c.target === 'signal' && c.coin) {
        await upsertSignalMemory(c.coin, { note: `[Coach] ${c.note}` })
        rec.push('tool_result', '🧩', `Wrote signal-memory note → ${c.coin.replace('/USDC', '')}`, 'accent', { target: 'signal', coin: c.coin })
        applied.push(c)
      } else if (c.target === 'global') {
        await appendCoachMemory(c.note, cycleId)
        rec.push('tool_result', '🧠', 'Wrote global coach lesson (→ Monitor + Analyst)', 'accent', { target: 'global' })
        applied.push(c)
      }
    } catch (err) {
      rec.push('tool_result', '⚠️', `Failed to write a ${c.target} correction: ${(err as Error).message}`, 'warn', { target: c.target })
    }
  }
  return applied
}

// ── cycle entrypoint ─────────────────────────────────────────────────────────

async function persistRun(cycleId: string, rec: Recorder, v: CoachVerdict): Promise<void> {
  const model = `coach:${resolveLLM('coach').model}`
  const runDoc: Omit<CoachRun, 'id'> = {
    cycle_id: cycleId,
    assessment: v.assessment,
    findings: v.findings,
    corrections: v.corrections,
    recommendations: v.recommendations,
    confidence: v.confidence,
    model, frames: rec.frames,
    prompt_tokens: rec.promptTokens, completion_tokens: rec.completionTokens, peak_context_tokens: rec.peakContext,
    started_at_ms: rec.startedAt, created_at: nowSql(),
  }
  const id = Number(await coachRuns.insert(runDoc))
  broadcast('coach_run_saved', { id, ...runDoc } satisfies CoachRun)
  rec.release()
}

async function pruneRuns(): Promise<void> {
  const keep = Math.max(10, getSettings().coach_retain_runs || 100)
  const cutoffRow = (await coachRuns.find({}, { sort: { id: -1 }, skip: keep, limit: 1, projection: { id: 1 } }))[0] as { id: number } | undefined
  if (cutoffRow) await coachRuns.deleteMany({ id: { $lte: cutoffRow.id } })
}

// One global audit pass. Routed here by the routing output node `module_coach` (and the
// manual "Run audit now"). Guarded so passes can't overlap. Gated on a minimum closed-trade
// sample so it never generalizes from noise.
export async function runCoach(cycleId: string): Promise<void> {
  if (isOffline()) {
    logger.info('Coach skipped — offline mode (LLM disabled)', { cycleId })
    return
  }
  if (running) {
    logger.warn('Coach already running, skipping', { cycleId })
    return
  }
  running = true
  logger.info('Coach audit started', { cycleId })
  broadcast('coach_started', { cycle_id: cycleId })

  const rec = new Recorder(cycleId)
  try {
    rec.push('coin_started', '🔍', 'Auditing the trading desk…', 'accent')

    const minTrades = Math.max(0, getSettings().coach_min_trades || 0)
    const closedCount = await positions.count({ status: { $ne: 'OPEN' } })
    const openCount = await positions.count({ status: 'OPEN' })

    if (closedCount < minTrades) {
      const msg = `Insufficient sample: ${closedCount} closed position(s) < the ${minTrades} required to audit. Skipping to avoid generalizing from noise.`
      rec.push('decision', '✋', msg, 'muted', { action: 'SKIP' })
      logger.info('Coach skipped — insufficient sample', { cycleId, closedCount, minTrades })
      await persistRun(cycleId, rec, emptyVerdict(msg))
      broadcast('coach_completed', { cycle_id: cycleId, skipped: true, reason: 'insufficient_sample' })
      return
    }

    const lessonsCount = (await getCoachMemory()).length
    const briefing = buildUserBriefing(closedCount, openCount, lessonsCount)

    // Run the whole tool-calling loop in one session so it holds the coach endpoint across
    // all rounds + nested tool LLM calls — no other module swaps the model mid-pass.
    const verdict = await runInSession(
      { route: () => resolveLLM('coach') },
      () => runAgenticCoach(briefing, minTrades, cycleId, rec),
    )

    // The agent has no action tools — the engine writes its corrections here, and the run
    // records the corrections that ACTUALLY landed.
    verdict.corrections = await applyCoachVerdict(verdict, cycleId, rec)

    rec.push('decision', '📋', `Audit complete: ${verdict.findings.length} finding(s), ${verdict.corrections.length} correction(s) written`, 'accent', {
      findings: verdict.findings.length, corrections: verdict.corrections.length, confidence: verdict.confidence,
    })

    await persistRun(cycleId, rec, verdict)
    await pruneRuns()
    broadcast('coach_completed', { cycle_id: cycleId, findings: verdict.findings.length, corrections: verdict.corrections.length })
    logger.info('Coach audit completed', { cycleId, findings: verdict.findings.length, corrections: verdict.corrections.length })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Coach audit failed', { cycleId, error })
    rec.fail(error)
    await persistRun(cycleId, rec, emptyVerdict(`Audit failed: ${error}`))
    broadcast('coach_error', { cycle_id: cycleId, error })
  } finally {
    running = false
  }
}

// Recent persisted runs (newest first), for the Coach Agent page to rehydrate after a reload.
export async function getCoachRuns(limit = 50): Promise<CoachRun[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  return coachRuns.find({}, { sort: { id: -1 }, limit: capped, projection: { _id: 0 } }) as unknown as Promise<CoachRun[]>
}
