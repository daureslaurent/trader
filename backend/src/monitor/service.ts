import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import type { LLMTarget } from '../core/llm.js'
import { scheduleChat } from '../core/llmScheduler.js'
import {
  getSettings, updateSetting, getRawSetting, nowSql,
  positionReviews, monitorNotes, positionAdjustments, positions as positionsRepo, portfolioEntries,
} from '../db/index.js'
import { getMarketContext } from '../portfolio/market.js'
import { validateSlTpAdjustment, minStopGapPct } from '../portfolio/risk.js'
import * as priceCache from '../market/index.js'
import { getOHLCV, isTimeframe } from '../market/index.js'
import { broadcast } from '../api/ws.js'
import { bus } from '../core/events.js'
import { PositionReview } from '../types.js'
import { buildMonitorPrompt, buildSynthesizerUser, fmtOffsetLabel, PositionContext, HorizonConfigs, MonitorNotes } from './prompts.js'
import { LLMError } from '../core/errors.js'
import { resolveLLM } from '../config/llm.js'

let running = false

interface MonitorSlot { slot: 'a' | 'b' | 'c'; model: string; baseURL: string; maxTokens: number; fallback?: LLMTarget }

// Resolves a monitor slot through the shared Settings-aware LLM resolver, so the
// model / endpoint / max-tokens overrides from the Settings page take effect.
function resolveSlot(slot: 'a' | 'b' | 'c'): MonitorSlot {
  const module = slot === 'b' ? 'monitorB' : slot === 'c' ? 'monitorC' : 'monitorA'
  const { model, baseURL, maxTokens, fallback } = resolveLLM(module)
  return { slot, model, baseURL, maxTokens, fallback }
}

// In 'alternate' mode the slot flips each cycle. `monitor_alternate_last` records
// the slot used by the previous cycle; the next slot is its opposite (default 'a').
function alternateNextSlot(): 'a' | 'b' {
  return getRawSetting('monitor_alternate_last') === 'a' ? 'b' : 'a'
}

// Resolves the monitor LLM slot the user selected in settings into its concrete
// model + endpoint. Exported so the API can surface the active model. This is a
// pure peek — in 'alternate' mode it returns the slot the NEXT cycle will use
// without advancing the rotation. For the ensemble modes ('ab'/'abc') it returns
// slot A as the representative model.
export function getActiveMonitorModel(): MonitorSlot {
  const mode = getSettings().monitor_model
  const slot = mode === 'alternate' ? alternateNextSlot() : (mode === 'b' ? 'b' : 'a')
  return resolveSlot(slot)
}

interface MonitorLLM {
  client: OpenAI
  model: string
  baseURL: string
  maxTokens: number
  fallback?: LLMTarget
  /** 'A' | 'B' | 'C' — for logs, the stored review's badge, and disagreement alerts. */
  label: string
}

// How the cycle's models are combined. 'single' runs one model (a / b / alternate);
// 'ab' runs both voters and keeps the higher-confidence verdict; 'abc' runs both
// voters and then has the synthesizer (C) write the final verdict from their output.
interface MonitorEnsemble {
  mode: 'single' | 'ab' | 'abc'
  voters: MonitorLLM[]
  synthesizer: MonitorLLM | null
}

// Wraps a resolved slot in a per-cycle OpenAI client + label.
function buildLLM(slot: MonitorSlot, label: string): MonitorLLM {
  return {
    client: new OpenAI({ baseURL: slot.baseURL, apiKey: 'ollama' }),
    model: slot.model,
    baseURL: slot.baseURL,
    maxTokens: slot.maxTokens,
    fallback: slot.fallback,
    label,
  }
}

// Builds the model set for a cycle about to run from the `monitor_model` setting,
// advancing the alternate rotation as a side effect so the next cycle flips.
async function buildEnsemble(): Promise<MonitorEnsemble> {
  const mode = getSettings().monitor_model
  if (mode === 'ab' || mode === 'abc') {
    const voters = [buildLLM(resolveSlot('a'), 'A'), buildLLM(resolveSlot('b'), 'B')]
    const synthesizer = mode === 'abc' ? buildLLM(resolveSlot('c'), 'C') : null
    return { mode, voters, synthesizer }
  }
  let slot: 'a' | 'b'
  if (mode === 'alternate') {
    slot = alternateNextSlot()
    await updateSetting('monitor_alternate_last', slot)
  } else {
    slot = mode === 'b' ? 'b' : 'a'
  }
  return { mode: 'single', voters: [buildLLM(resolveSlot(slot), slot.toUpperCase())], synthesizer: null }
}

// Action severity for tie-breaking the confidence-weighted A+B merge: when both
// models report the same confidence, the more capital-protective action wins.
const ACTION_SEVERITY: Record<string, number> = { CLOSE: 3, REDUCE: 2, ADJUST: 1, HOLD: 0 }

interface Opinion { llm: MonitorLLM; review: RawReview }

// A+B confidence-weighted merge: keep the higher-confidence verdict wholesale (so its
// SL/TP/reduce numbers stay coherent). Ties break toward the more protective action,
// then toward slot A for determinism.
function pickHigherConfidence(opinions: Opinion[]): Opinion {
  return [...opinions].sort((x, y) => {
    if (y.review.confidence !== x.review.confidence) return y.review.confidence - x.review.confidence
    const sev = (ACTION_SEVERITY[y.review.action] ?? 0) - (ACTION_SEVERITY[x.review.action] ?? 0)
    if (sev !== 0) return sev
    return x.llm.label.localeCompare(y.llm.label)
  })[0]
}

interface RawReview {
  action: 'HOLD' | 'CLOSE' | 'REDUCE' | 'ADJUST'
  confidence: number
  reasoning: string
  reduce_to_pct?: number | null
  // #2a: LLM returns percentages relative to current price — engine converts to abs prices
  new_stop_loss_pct?: number | null
  new_take_profit_pct?: number | null
  // Persistent per-coin memory: a non-empty string replaces the stored note, null keeps it
  notes?: string | null
}

// Hard cap on stored note size — the prompt asks for ≤500 chars, this guards
// against a runaway model flooding the prompt of every future review.
const MAX_NOTES_LENGTH = 1000

function parseReview(content: string): RawReview {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) throw new LLMError('No JSON found in monitor response')
    parsed = JSON.parse(match[0])
  }

  // Accept { "review": {...} } wrapper or bare object
  const obj: unknown = (parsed as Record<string, unknown>)?.review ?? parsed

  const candidate = obj as Record<string, unknown>
  if (
    typeof candidate !== 'object' || candidate === null ||
    !['HOLD', 'CLOSE', 'REDUCE', 'ADJUST'].includes(candidate.action as string) ||
    typeof candidate.confidence !== 'number' ||
    typeof candidate.reasoning !== 'string'
  ) throw new LLMError('Invalid review in monitor response')

  return candidate as unknown as RawReview
}

// Approximate review cadence from the monitor cron expression, for the prompt.
// Returns minutes between runs, or null when the pattern isn't a simple interval.
function cronIntervalMinutes(expr: string): number | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts
  if (dom !== '*' || mon !== '*' || dow !== '*') return null
  const everyMin = min.match(/^\*\/(\d+)$/)
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10)
  if (min === '*' && hour === '*') return 1
  const everyHour = hour.match(/^\*\/(\d+)$/)
  if (everyHour && /^\d+$/.test(min)) return parseInt(everyHour[1], 10) * 60
  if (/^\d+$/.test(min) && hour === '*') return 60
  return null
}

async function pruneMonitorHistory(maxCycles = 20): Promise<void> {
  // Keep the most recent `maxCycles` distinct cycles (by latest created_at), delete the rest.
  const recent = await positionReviews.aggregate<{ _id: string }>([
    { $group: { _id: '$cycle_id', latest: { $max: '$created_at' } } },
    { $sort: { latest: -1 } },
    { $limit: maxCycles },
  ])
  const keep = recent.map(r => r._id)
  await positionReviews.deleteMany({ cycle_id: { $nin: keep } })
}

// One OPEN portfolio entry, aggregated across multiple fills (see runMonitor).
interface MonitorEntry { coin: string; quantity: number; avg_buy_price: number; avg_date_ms: number }

// Per-cycle knobs resolved once from settings in runMonitor and shared by every
// coin's review. These are configuration, not market data, so they don't go stale.
interface CycleParams {
  ensemble: MonitorEnsemble
  adjustEnabled: boolean
  reduceEnabled: boolean
  trustLlm: boolean
  useHorizon: boolean
  utcOffsetHours: number
  horizonConfigs: HorizonConfigs
  historyTf: string
  historyCount: number
  minConfidence: number
  reviewIntervalMin: number | null
  breakevenPct: number
  feeRate: number
  adjustCooldownMin: number
}

// Everything a coin's review acts on: the fresh position context, the prompt built
// from it, the recent-review history (for anti-flip-flop), and the horizon-resolved
// guidance flag. Produced JIT by buildReviewContext, then reused by the merge/validate
// stage so the prompt and the post-LLM logic always see the SAME market snapshot.
interface ReviewContext {
  ctx: PositionContext
  system: string
  // Synthesizer (model C) system prompt — same shared body as `system` but with an
  // arbiter opener instead of the reviewer opener. Used only in 'abc' mode.
  synthSystem: string
  user: string
  history: PositionReview[]
  effectiveUseHorizon: boolean
}

// JIT context binding: gathers the live price, market indicators, fresh position
// SL/TP, candles, review history and notes for a coin, then builds its prompt — all
// at the moment the scheduler dispatches the call, never at cycle start. A monitor
// run can queue many coins behind a serialized endpoint; building here keeps the
// prompt's market/position values current rather than minutes-stale from the queue.
async function buildReviewContext(coin: string, entry: MonitorEntry, p: CycleParams): Promise<ReviewContext> {
  const snap = priceCache.getPrice(coin)
  const currentPrice = snap?.price ?? entry.avg_buy_price

  const tf = isTimeframe(p.historyTf) ? p.historyTf : '1h'
  const count = Math.max(1, Math.min(100, p.historyCount))

  const [marketCtx, position, history, storedNotes, candles] = await Promise.all([
    getMarketContext(coin, currentPrice),
    positionsRepo.findOne(
      { coin, status: 'OPEN' },
      { projection: { id: 1, stop_loss: 1, take_profit: 1, horizon: 1 } },
    ) as Promise<{ id: number; stop_loss: number | null; take_profit: number | null; horizon: string | null } | null>,
    positionReviews.find(
      { coin },
      { sort: { created_at: -1 }, limit: 3 },
    ) as unknown as Promise<PositionReview[]>,
    monitorNotes.findOne(
      { _id: coin },
      { projection: { notes: 1, updated_at: 1 } },
    ) as Promise<MonitorNotes | null>,
    getOHLCV(coin, tf, count).catch((err): Awaited<ReturnType<typeof getOHLCV>> => {
      logger.warn('Failed to fetch candle history for monitor prompt', { coin, tf, error: (err as Error).message })
      return []
    }),
  ])

  const pnlUsd = (currentPrice - entry.avg_buy_price) * entry.quantity
  const pnlPct = entry.avg_buy_price > 0
    ? ((currentPrice - entry.avg_buy_price) / entry.avg_buy_price) * 100
    : 0

  const stopLoss = position?.stop_loss ?? null
  const takeProfit = position?.take_profit ?? null
  const distanceToSlPct = stopLoss != null && currentPrice > 0
    ? ((currentPrice - stopLoss) / currentPrice) * 100
    : null
  const distanceToTpPct = takeProfit != null && currentPrice > 0
    ? ((takeProfit - currentPrice) / currentPrice) * 100
    : null

  // Weighted-average entry timestamp (epoch ms) from the runMonitor aggregation.
  const msFromJd = entry.avg_date_ms
  const ageHours = (Date.now() - msFromJd) / (1000 * 60 * 60)
  const entryDate = new Date(msFromJd + p.utcOffsetHours * 3600000)
    .toISOString().replace('T', ' ').slice(0, 19) + ' ' + fmtOffsetLabel(p.utcOffsetHours)

  const rawHorizon = position?.horizon ?? 'medium'
  const horizon = (['short', 'medium', 'long', 'disabled', 'llm'].includes(rawHorizon)
    ? rawHorizon : 'medium') as PositionContext['horizon']

  const ctx: PositionContext = {
    positionId: position?.id ?? null,
    coin,
    quantity: entry.quantity,
    entryPrice: entry.avg_buy_price,
    currentPrice,
    pnlUsd,
    pnlPct,
    stopLoss,
    takeProfit,
    distanceToSlPct,
    distanceToTpPct,
    entryDate,
    ageHours,
    horizon,
    rsi14: marketCtx.rsi14,
    trend: marketCtx.trend,
    volatility: marketCtx.volatility,
    atr14: marketCtx.atr14,
    sma7: marketCtx.sma7,
    sma25: marketCtx.sma25,
    change24h: marketCtx.change24h,
    perf7d: marketCtx.perf7d,
  }

  // 'llm' horizon: monitor runs, but horizon guidance is suppressed in the prompt.
  const effectiveUseHorizon = horizon === 'llm' ? false : p.useHorizon
  const { system, synthSystem, user } = buildMonitorPrompt(
    ctx, history, p.horizonConfigs, effectiveUseHorizon, p.utcOffsetHours,
    candles, tf, p.reviewIntervalMin, storedNotes, p.breakevenPct, p.reduceEnabled,
  )

  return { ctx, system, synthSystem, user, history, effectiveUseHorizon }
}

// Runs a single monitor model and returns its parsed verdict. The prompt is not
// passed in — `promptFor` is invoked inside the scheduler's build thunk so the
// request is materialized JIT at dispatch. Retries once on both LLM API/network
// errors and parse failures (#2d).
async function askModel(
  llm: MonitorLLM,
  promptFor: () => Promise<{ system: string; user: string }>,
  coin: string,
  cycleId: string,
): Promise<RawReview> {
  logger.info('Request LLM', { module: 'monitor', coin, slot: llm.label, model: llm.model })

  let raw: RawReview | null = null
  for (let attempt = 0; attempt <= 1; attempt++) {
    let resp: OpenAI.ChatCompletion
    try {
      // Routed through the scheduler's PARALLEL lane: monitor positions are reviewed
      // concurrently, while the per-endpoint gate still serializes calls hitting the
      // same one-at-a-time server. Voters with distinct endpoints run in true parallel.
      resp = await scheduleChat({
        // priority > 0: open-position reviews jump ahead of other parallel-lane
        // work (discovery, summary) when they contend for the same endpoint, so a
        // position is never reviewed late because a discovery scan got the gate first.
        module: 'monitor', lane: 'parallel', priority: 1, coin, cycleId,
        route: () => ({ client: llm.client, model: llm.model, baseURL: llm.baseURL, maxTokens: llm.maxTokens, fallback: llm.fallback }),
        // JIT: the prompt is generated here, at dispatch, against the current market +
        // position snapshot — a job that waited in the queue is never sent stale context.
        build: async (route) => {
          const { system, user } = await promptFor()
          return {
            model: route.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.2,
            max_tokens: route.maxTokens,
            response_format: { type: 'json_object' },
          }
        },
      })
    } catch (apiErr) {
      if (attempt === 0) {
        logger.warn('Monitor LLM API error, retrying', { coin, slot: llm.label, error: (apiErr as Error).message })
        continue
      }
      throw apiErr
    }

    const finish = resp.choices[0]?.finish_reason
    const content = resp.choices[0]?.message?.content ?? ''

    logger.info('Monitor LLM response', { coin, slot: llm.label, attempt, finish_reason: finish, length: content.length })

    if (!content.trim()) {
      if (attempt === 0) { logger.warn('Empty monitor response, retrying', { coin, slot: llm.label, finish_reason: finish }); continue }
      throw new LLMError(`Empty LLM response (finish_reason: ${finish ?? 'unknown'})`)
    }

    try {
      raw = parseReview(content)
    } catch (err) {
      if (attempt === 0) { logger.warn('Monitor parse failed, retrying', { coin, slot: llm.label, error: (err as Error).message }); continue }
      throw err
    }

    break
  }

  if (!raw) throw new LLMError('Monitor returned no valid review after retries')
  return raw
}

async function monitorCoin(
  coin: string,
  entry: MonitorEntry,
  cycleId: string,
  p: CycleParams,
): Promise<PositionReview | null> {
  const { ensemble } = p

  // The coin's fresh context + prompt is built lazily and memoized: the first voter
  // dispatched for this coin triggers the JIT build, every later voter (and the
  // synthesizer) reuses that same snapshot, and the post-LLM merge/validate stage
  // below reads it back — so prompt and engine logic agree on one market view.
  let cachedContext: Promise<ReviewContext> | null = null
  const getContext = (): Promise<ReviewContext> => {
    // Share one snapshot across voters/synthesizer, but never cache a rejection — a
    // failed build (e.g. a transient market fetch) must be retryable by askModel.
    if (!cachedContext) cachedContext = buildReviewContext(coin, entry, p).catch((err) => { cachedContext = null; throw err })
    return cachedContext
  }
  const voterPrompt = async () => { const c = await getContext(); return { system: c.system, user: c.user } }

  // Gather each voter's independent verdict. Voters run concurrently — calls to the
  // same endpoint are still serialized by the per-URL LLM gate, so this only adds
  // real parallelism when A and B point at different endpoints.
  const opinions: Opinion[] = await Promise.all(
    ensemble.voters.map(async (voter) => ({ llm: voter, review: await askModel(voter, voterPrompt, coin, cycleId) })),
  )

  // Read back the JIT snapshot the voters reviewed (already resolved at this point).
  const { ctx, history, effectiveUseHorizon } = await getContext()
  const useHorizon = effectiveUseHorizon

  // Resolve the voters into the single verdict the engine will act on.
  let raw: RawReview
  let finalLlm: MonitorLLM
  if (ensemble.mode === 'abc' && ensemble.synthesizer) {
    // Model C is the final arbiter: it sees the position + both voter verdicts and
    // writes its own. Its output is authoritative. Its prompt is likewise built JIT.
    const voterSummaries = opinions.map(o => ({
      label: o.llm.label, model: o.llm.model, action: o.review.action, confidence: o.review.confidence,
      reasoning: o.review.reasoning, new_stop_loss_pct: o.review.new_stop_loss_pct,
      new_take_profit_pct: o.review.new_take_profit_pct, reduce_to_pct: o.review.reduce_to_pct,
    }))
    const synthPrompt = async () => { const c = await getContext(); return { system: c.synthSystem, user: buildSynthesizerUser(c.user, voterSummaries) } }
    raw = await askModel(ensemble.synthesizer, synthPrompt, coin, cycleId)
    finalLlm = ensemble.synthesizer
  } else if (ensemble.mode === 'ab') {
    // Confidence-weighted: the more certain verdict wins, intact.
    const winner = pickHigherConfidence(opinions)
    raw = winner.review
    finalLlm = winner.llm
    logger.info('Monitor A+B merged', { coin, cycleId, winner: winner.llm.label, votes: opinions.map(o => `${o.llm.label}:${o.review.action}@${o.review.confidence.toFixed(2)}`) })
  } else {
    raw = opinions[0].review
    finalLlm = opinions[0].llm
  }

  // Detect disagreement among the underlying models (voters, plus C's override in
  // 'abc'). Surfaced via Telegram so contested positions are visible even though the
  // engine still acts on the resolved verdict.
  const ensembleActions = opinions.map(o => o.review.action)
  if (ensemble.mode === 'abc') ensembleActions.push(raw.action)
  const modelsDisagreed = ensemble.mode !== 'single' && new Set(ensembleActions).size > 1

  const confidence = Math.min(1, Math.max(0, raw.confidence))
  let reduceToPct = raw.action === 'REDUCE' && typeof raw.reduce_to_pct === 'number'
    ? Math.min(99, Math.max(1, Math.round(raw.reduce_to_pct)))
    : null

  // Downgrade actions the engine cannot or should not execute. The stored review keeps
  // an honest record — otherwise the LLM sees its own unexecuted CLOSE/REDUCE in the
  // decision history and assumes it already happened.
  if (raw.action !== 'HOLD' && ctx.positionId == null) {
    logger.warn('Monitor action has no position record to act on — storing as HOLD', { coin: ctx.coin, action: raw.action })
    raw = { ...raw, action: 'HOLD', reasoning: `[${raw.action} not executable — no position record] ${raw.reasoning}` }
    reduceToPct = null
  }
  // REDUCE disabled in settings: the prompt no longer offers it, but downgrade defensively
  // in case the LLM returns it anyway, so a partial exit is never executed.
  if (raw.action === 'REDUCE' && !p.reduceEnabled) {
    logger.warn('Monitor REDUCE disabled by setting — storing as HOLD', { coin: ctx.coin })
    raw = { ...raw, action: 'HOLD', reasoning: `[REDUCE disabled — not executed] ${raw.reasoning}` }
    reduceToPct = null
  }
  if (raw.action === 'REDUCE' && reduceToPct == null) {
    logger.warn('Monitor REDUCE missing reduce_to_pct — storing as HOLD', { coin: ctx.coin })
    raw = { ...raw, action: 'HOLD', reasoning: `[REDUCE missing reduce_to_pct — not executed] ${raw.reasoning}` }
  }
  if ((raw.action === 'CLOSE' || raw.action === 'REDUCE') && confidence < p.minConfidence) {
    logger.warn('Monitor action below confidence threshold — storing as HOLD', { coin: ctx.coin, action: raw.action, confidence, minConfidence: p.minConfidence })
    raw = { ...raw, action: 'HOLD', reasoning: `[${raw.action} suppressed: confidence ${confidence.toFixed(2)} < required ${p.minConfidence.toFixed(2)}] ${raw.reasoning}` }
    reduceToPct = null
  }

  // Adjustment cooldown: one applied SL/TP change per window, scaled by horizon.
  // The 5-min review cadence runs a different clock than a medium/long-horizon
  // trade — without this, the LLM re-trails the stop dozens of times per position
  // (58× observed), each costing an exchange-side OCO cancel+replace.
  // Seeding (no SL or TP yet) is exempt: protection must never wait.
  if (raw.action === 'ADJUST' && ctx.positionId != null && p.adjustCooldownMin > 0 &&
      ctx.stopLoss != null && ctx.takeProfit != null) {
    const horizonFactor = ctx.horizon === 'short' ? 0.5 : ctx.horizon === 'long' ? 2 : 1
    const cooldownMs = p.adjustCooldownMin * horizonFactor * 60_000
    const last = (await positionAdjustments.findOne(
      { position_id: ctx.positionId, status: 'APPLIED' },
      { sort: { id: -1 }, projection: { created_at: 1 } },
    )) as { created_at: string } | null
    if (last) {
      const elapsed = Date.now() - new Date(last.created_at.replace(' ', 'T') + 'Z').getTime()
      if (elapsed >= 0 && elapsed < cooldownMs) {
        const waitMin = Math.ceil((cooldownMs - elapsed) / 60_000)
        logger.info('Monitor ADJUST suppressed by cooldown', { coin: ctx.coin, positionId: ctx.positionId, waitMin })
        raw = { ...raw, action: 'HOLD', reasoning: `[ADJUST suppressed: adjustment cooldown, ~${waitMin}m left] ${raw.reasoning}` }
      }
    }
  }

  let newStopLoss: number | null = null
  let newTakeProfit: number | null = null
  let proposalToEmit: { newSl: number | null; newTp: number | null } | null = null

  if (raw.action === 'ADJUST' && ctx.positionId != null) {
    // #2a: LLM expresses levels as % relative to CURRENT price. A null side means
    // "leave unchanged" — backfill it from the existing level, or (when none was
    // ever set) from the horizon default, so the resulting OCO always carries BOTH
    // a stop and a target. An OCO with a missing leg can't be placed and would
    // otherwise cancel existing protection (see replaceProtection).
    const isLlmHorizon = ctx.horizon === 'llm'
    const effectiveHorizon: 'short' | 'medium' | 'long' =
      (ctx.horizon === 'disabled' || isLlmHorizon) ? 'medium' : ctx.horizon as 'short' | 'medium' | 'long'
    const hcfg = p.horizonConfigs[effectiveHorizon]
    const pctToPrice = (pct: number) => ctx.currentPrice * (1 + pct / 100)
    // LLM-horizon: null means "keep existing" — don't seed from horizon config.
    const proposedSl = typeof raw.new_stop_loss_pct === 'number'
      ? pctToPrice(raw.new_stop_loss_pct)
      : (ctx.stopLoss ?? (isLlmHorizon ? null : pctToPrice(-hcfg.slPct)))
    const proposedTp = typeof raw.new_take_profit_pct === 'number'
      ? pctToPrice(raw.new_take_profit_pct)
      : (ctx.takeProfit ?? (isLlmHorizon ? null : pctToPrice(hcfg.tpPct)))

    if (p.trustLlm) {
      // Trust mode: bypass risk rules, only enforce SL < price and TP > price.
      // 0.25%-of-price deadband: an LLM echoing the displayed (2-dp rounded) level must
      // not register as a change — each one costs an OCO cancel+replace on the exchange.
      const deadband = ctx.currentPrice * 0.0025
      const same = (a: number, b: number) => Math.abs(a - b) <= deadband
      if ((proposedSl != null && proposedSl >= ctx.currentPrice) || (proposedTp != null && proposedTp <= ctx.currentPrice)) {
        logger.warn('ADJUST trust-mode: degenerate SL/TP, downgrading to HOLD', { coin: ctx.coin, proposedSl, proposedTp })
        raw = { ...raw, action: 'HOLD' }
      } else {
        const slChanged = proposedSl != null && !(ctx.stopLoss != null && same(proposedSl, ctx.stopLoss))
        const tpChanged = proposedTp != null && !(ctx.takeProfit != null && same(proposedTp, ctx.takeProfit))
        if (slChanged || tpChanged) {
          if (p.adjustEnabled) {
            newStopLoss = slChanged ? proposedSl! : null
            newTakeProfit = tpChanged ? proposedTp! : null
            proposalToEmit = { newSl: newStopLoss, newTp: newTakeProfit }
          }
          logger.info('SL/TP trusted (bypass validation)', { coin: ctx.coin, sl: proposedSl, tp: proposedTp, applied: p.adjustEnabled })
        } else {
          raw = { ...raw, action: 'HOLD' }
        }
      }
    } else {
      // Anti flip-flop: a recent (≤24h, last 3 reviews) tightening blocks loosening,
      // so the LLM can't alternate "trail to -2%" / "widen to -3%" every cycle.
      const slRecentlyTightened = history.some(r =>
        r.new_stop_loss != null && r.old_stop_loss != null &&
        r.new_stop_loss > r.old_stop_loss &&
        Date.now() - new Date(r.created_at.replace(' ', 'T') + 'Z').getTime() < 24 * 3_600_000)
      const validated = validateSlTpAdjustment({
        currentPrice: ctx.currentPrice,
        oldStopLoss: ctx.stopLoss,
        oldTakeProfit: ctx.takeProfit,
        proposedStopLoss: proposedSl,
        proposedTakeProfit: proposedTp,
        // LLM horizon: no floor — the LLM decides its own risk management.
        maxSlPct: isLlmHorizon ? 100 : hcfg.slPct,
        entryPrice: ctx.entryPrice,
        slRecentlyTightened,
        feeRoundTripPct: p.feeRate * 2 * 100,
        // Same trigger the prompt's profit-protection rule announces — the engine
        // rejects break-even stops before it instead of trusting the LLM to wait.
        breakevenTriggerPct: useHorizon ? hcfg.tpPct / 2 : p.breakevenPct,
        // Same gap the prompt announces: horizon-scaled when guidance is on,
        // the 0.5% floor when the LLM manages risk freely.
        minSlGapPct: minStopGapPct(useHorizon && !isLlmHorizon ? hcfg.slPct : null),
      })
      if (validated.notes.length > 0) {
        logger.info('SL/TP adjustment validated', { coin: ctx.coin, changed: validated.changed, notes: validated.notes })
      }
      if (validated.changed && p.adjustEnabled) {
        // Final safety net: never emit a half OCO. If validation left a side null
        // (old was unset and the proposal was rejected), seed from horizon unless in
        // llm-horizon mode where null means "keep whatever is in the DB".
        newStopLoss = validated.stopLoss ?? (isLlmHorizon ? null : pctToPrice(-hcfg.slPct))
        newTakeProfit = validated.takeProfit ?? (isLlmHorizon ? null : pctToPrice(hcfg.tpPct))
        proposalToEmit = { newSl: newStopLoss, newTp: newTakeProfit }
      } else if (!validated.changed) {
        // Proposal was no-op or invalid — downgrade to HOLD
        logger.warn('ADJUST proposal rejected by validation, storing as HOLD', {
          coin: ctx.coin,
          sl_pct: raw.new_stop_loss_pct,
          tp_pct: raw.new_take_profit_pct,
          current_price: ctx.currentPrice,
          notes: validated.notes,
        })
        raw = { ...raw, action: 'HOLD' }
      }
    }
  }

  const marketData = JSON.stringify({
    currentPrice: ctx.currentPrice,
    entryPrice: ctx.entryPrice,
    pnlPct: Math.round(ctx.pnlPct * 100) / 100,
    rsi14: ctx.rsi14,
    trend: ctx.trend,
    volatility: ctx.volatility,
    change24h: Math.round(ctx.change24h * 100) / 100,
    horizon: ctx.horizon,
  })

  // Guard: if the position closed while the LLM was thinking (race with OCO reconciler),
  // discard the review rather than inserting stale data for a coin we no longer hold.
  const stillOpen = await portfolioEntries.findOne(
    { coin: ctx.coin, status: 'OPEN' },
    { projection: { _id: 1 } },
  )
  if (!stillOpen) {
    logger.info('Monitor review discarded — position closed during analysis', { coin: ctx.coin, cycleId })
    return null
  }

  // Persist the LLM's note: a non-empty string replaces the stored one, null/absent keeps it.
  if (typeof raw.notes === 'string' && raw.notes.trim().length > 0) {
    const notes = raw.notes.trim().slice(0, MAX_NOTES_LENGTH)
    await monitorNotes.upsert(ctx.coin, { coin: ctx.coin, notes, updated_at: nowSql() })
    logger.info('Monitor notes updated', { coin: ctx.coin, length: notes.length })
  }

  const reviewId = await positionReviews.insert({
    coin: ctx.coin, action: raw.action, confidence, reasoning: raw.reasoning,
    reduce_to_pct: reduceToPct, old_stop_loss: ctx.stopLoss ?? null, old_take_profit: ctx.takeProfit ?? null,
    new_stop_loss: newStopLoss, new_take_profit: newTakeProfit, market_data: marketData,
    model: finalLlm.model, cycle_id: cycleId, created_at: nowSql(),
  })

  const review: PositionReview = {
    id: Number(reviewId),
    coin: ctx.coin,
    action: raw.action,
    confidence,
    reasoning: raw.reasoning,
    reduce_to_pct: reduceToPct,
    old_stop_loss: ctx.stopLoss ?? null,
    old_take_profit: ctx.takeProfit ?? null,
    new_stop_loss: newStopLoss,
    new_take_profit: newTakeProfit,
    market_data: marketData,
    model: finalLlm.model,
    cycle_id: cycleId,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  }

  logger.info('Position review saved', { coin: ctx.coin, action: raw.action, confidence })
  broadcast('monitor_coin_completed', { cycle_id: cycleId, review })

  // Alert when the ensemble's models genuinely disagreed on the action. The engine
  // still executes the resolved verdict above; this only flags the contested call.
  if (modelsDisagreed && (ensemble.mode === 'ab' || ensemble.mode === 'abc')) {
    const opinionPayload = opinions.map(o => ({ label: o.llm.label, model: o.llm.model, action: o.review.action, confidence: o.review.confidence }))
    if (ensemble.mode === 'abc' && ensemble.synthesizer) {
      opinionPayload.push({ label: 'C', model: ensemble.synthesizer.model, action: raw.action, confidence })
    }
    logger.info('Monitor models disagreed', { coin: ctx.coin, cycleId, mode: ensemble.mode, finalAction: raw.action, opinions: opinionPayload.map(o => `${o.label}:${o.action}`) })
    bus.emit('monitor_disagreement', {
      coin: ctx.coin, mode: ensemble.mode, finalAction: raw.action, finalConfidence: confidence,
      opinions: opinionPayload, cycleId,
    })
  }

  // Fire close immediately — don't wait for other coins
  if (raw.action === 'CLOSE' && ctx.positionId != null) {
    bus.emit('monitor_close_requested', {
      positionId: ctx.positionId,
      coin: ctx.coin,
      currentPrice: ctx.currentPrice,
      reasoning: raw.reasoning,
      confidence,
      cycleId,
    })
  }

  // Fire partial exit immediately — don't wait for other coins
  if (raw.action === 'REDUCE' && ctx.positionId != null && reduceToPct != null) {
    bus.emit('monitor_reduce_requested', {
      positionId: ctx.positionId,
      coin: ctx.coin,
      currentPrice: ctx.currentPrice,
      reduceToPct,
      reasoning: raw.reasoning,
      confidence,
      cycleId,
    })
  }

  // Fire adjustment immediately — don't wait for other coins
  if (proposalToEmit && ctx.positionId != null) {
    bus.emit('position_adjustment_proposed', {
      positionId: ctx.positionId,
      coin: ctx.coin,
      oldStopLoss: ctx.stopLoss,
      oldTakeProfit: ctx.takeProfit,
      newStopLoss: proposalToEmit.newSl,
      newTakeProfit: proposalToEmit.newTp,
      reasoning: raw.reasoning,
      confidence,
      model: finalLlm.model,
      cycleId,
    })
  }

  return review
}

export function isRunning(): boolean {
  return running
}

export async function clearReviewsForCoin(coin: string): Promise<void> {
  await positionReviews.deleteMany({ coin })
  await monitorNotes.deleteMany({ _id: coin })
  logger.info('Monitor history cleared for closed position', { coin })
}

export async function runMonitor(cycleId: string): Promise<void> {
  if (running) {
    logger.warn('Monitor already running, skipping')
    return
  }
  running = true
  logger.info('Position monitor started', { cycleId })
  broadcast('monitor_started', { cycle_id: cycleId })

  try {
    // #2c: Use a weighted-average entry timestamp (centre of mass in epoch ms)
    // instead of MIN, to reflect a position built across multiple entries.
    const entries = await portfolioEntries.aggregate<{ coin: string; quantity: number; avg_buy_price: number; avg_date_ms: number }>([
      { $match: { status: 'OPEN', coin: { $ne: 'USDC' } } },
      {
        $group: {
          _id: '$coin',
          quantity: { $sum: '$quantity' },
          qBuy: { $sum: { $multiply: ['$quantity', '$buy_price'] } },
          qMs: { $sum: { $multiply: ['$quantity', { $toLong: { $dateFromString: { dateString: '$created_at', format: '%Y-%m-%d %H:%M:%S', timezone: 'UTC' } } }] } },
        },
      },
      {
        $project: {
          _id: 0,
          coin: '$_id',
          quantity: 1,
          avg_buy_price: { $cond: [{ $gt: ['$quantity', 0] }, { $divide: ['$qBuy', '$quantity'] }, 0] },
          avg_date_ms: { $cond: [{ $gt: ['$quantity', 0] }, { $divide: ['$qMs', '$quantity'] }, 0] },
        },
      },
    ])

    if (entries.length === 0) {
      logger.info('Position monitor: no open positions to review')
      broadcast('monitor_completed', { cycle_id: cycleId, reviews: [], message: 'No open positions' })
      return
    }

    // Subscribe early so the live price feed is warm by the time each coin's prompt
    // is built JIT inside the scheduler (buildReviewContext reads priceCache.getPrice).
    priceCache.subscribe(entries.map(e => e.coin))

    const s = getSettings()
    const ensemble = await buildEnsemble()
    logger.info('Monitor using model', {
      cycleId,
      mode: s.monitor_model,
      voters: ensemble.voters.map(v => `${v.label}:${v.model}`),
      synthesizer: ensemble.synthesizer ? `${ensemble.synthesizer.label}:${ensemble.synthesizer.model}` : null,
    })

    const p: CycleParams = {
      ensemble,
      adjustEnabled: s.monitor_adjust_sltp,
      reduceEnabled: s.monitor_reduce_enabled,
      trustLlm: s.monitor_trust_llm_sltp,
      useHorizon: s.monitor_use_horizon,
      utcOffsetHours: s.utc_offset_hours,
      horizonConfigs: {
        short:  { slPct: s.monitor_sl_pct_short,  tpPct: s.monitor_tp_pct_short  },
        medium: { slPct: s.monitor_sl_pct_medium, tpPct: s.monitor_tp_pct_medium },
        long:   { slPct: s.monitor_sl_pct_long,   tpPct: s.monitor_tp_pct_long   },
      },
      historyTf: s.monitor_history_tf,
      historyCount: s.monitor_history_count,
      minConfidence: Math.min(1, Math.max(0, s.monitor_min_confidence)),
      reviewIntervalMin: s.monitor_auto_run ? cronIntervalMinutes(s.monitor_cron) : null,
      breakevenPct: s.monitor_breakeven_pct > 0 ? s.monitor_breakeven_pct : 3,
      feeRate: s.fee_rate,
      adjustCooldownMin: s.monitor_adjust_cooldown_min,
    }

    // Decide which coins to review using only the horizon (a stable position-config
    // field): a `disabled` position is skipped entirely so no LLM call is wasted on
    // it. All live market/position values are fetched fresh at dispatch, not here.
    const posRows = (await positionsRepo.find(
      { status: 'OPEN', coin: { $ne: 'USDC' } },
      { projection: { coin: 1, horizon: 1 } },
    )) as unknown as { coin: string; horizon: string | null }[]
    const horizonByCoin = new Map(posRows.map(r => [r.coin, r.horizon ?? 'medium']))

    const toReview = entries.filter(e => (horizonByCoin.get(e.coin) ?? 'medium') !== 'disabled')
    const skipped = entries.length - toReview.length
    if (skipped > 0) logger.info('Monitor skipping disabled positions', { cycleId, skipped })

    logger.info('Monitor scheduling coins for review', { cycleId, coins: toReview.map(e => e.coin) })

    // Hand every coin to the LLM scheduler up front (each coin enqueues its voter
    // jobs synchronously below), so the scheduler sees the full set of waiting monitor
    // calls at once and can order/batch them by model affinity. Each coin's prompt is
    // built JIT when its call is actually dispatched — never here — so a coin that
    // waited behind a busy endpoint is still reviewed against current market data.
    const settled = await Promise.all(
      toReview.map(async (entry): Promise<PositionReview | null> => {
        try {
          return await monitorCoin(entry.coin, entry, cycleId, p)
        } catch (err) {
          logger.error('Monitor coin failed', { coin: entry.coin, cycleId, error: (err as Error).message })
          broadcast('monitor_coin_error', { cycle_id: cycleId, coin: entry.coin, error: (err as Error).message })
          return null
        }
      }),
    )
    const reviews: PositionReview[] = settled.filter((r): r is PositionReview => r !== null)

    await pruneMonitorHistory()

    broadcast('monitor_completed', { cycle_id: cycleId, reviews })
    logger.info('Position monitor completed', { cycleId, reviewed: reviews.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Position monitor failed', { cycleId, error: message })
    broadcast('monitor_error', { cycle_id: cycleId, error: message })
  } finally {
    running = false
  }
}

async function openCoinSet(): Promise<string[]> {
  return portfolioEntries.col().distinct('coin', { status: 'OPEN' }) as Promise<string[]>
}

export async function getNotes(): Promise<(MonitorNotes & { coin: string })[]> {
  // Same open-position filter as getReviews: hide notes left behind by a race
  // between position close and a monitor run.
  const coins = await openCoinSet()
  return monitorNotes.find(
    { coin: { $in: coins } },
    { sort: { coin: 1 }, projection: { coin: 1, notes: 1, updated_at: 1 } },
  ) as unknown as Promise<(MonitorNotes & { coin: string })[]>
}

export async function getReviews(limit = 100): Promise<PositionReview[]> {
  // Only return reviews for coins that still have an open position.
  // This filters stale reviews left behind if the delete raced with a monitor run.
  const coins = await openCoinSet()
  return positionReviews.find(
    { coin: { $in: coins } },
    { sort: { created_at: -1 }, limit },
  ) as unknown as Promise<PositionReview[]>
}
