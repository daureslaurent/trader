import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import type { LLMTarget } from '../core/llm.js'
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
import { buildMonitorPrompt, fmtOffsetLabel, PositionContext, HorizonConfigs, MonitorNotes } from './prompts.js'
import { LLMError } from '../core/errors.js'
import { resolveLLM } from '../config/llm.js'

let running = false

interface MonitorSlot { slot: 'a' | 'b'; model: string; baseURL: string; maxTokens: number; fallback?: LLMTarget }

// Resolves a monitor slot through the shared Settings-aware LLM resolver, so the
// model / endpoint / max-tokens overrides from the Settings page take effect.
function resolveSlot(slot: 'a' | 'b'): MonitorSlot {
  const { model, baseURL, maxTokens, fallback } = resolveLLM(slot === 'b' ? 'monitorB' : 'monitorA')
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
// without advancing the rotation (use advanceMonitorModel for that).
export function getActiveMonitorModel(): MonitorSlot {
  const mode = getSettings().monitor_model
  const slot = mode === 'alternate' ? alternateNextSlot() : (mode === 'b' ? 'b' : 'a')
  return resolveSlot(slot)
}

// Picks the slot for a cycle about to run, advancing the alternate rotation as a
// side effect so the next cycle gets the other model. Non-alternate modes are fixed.
export async function advanceMonitorModel(): Promise<MonitorSlot> {
  const mode = getSettings().monitor_model
  if (mode !== 'alternate') return resolveSlot(mode === 'b' ? 'b' : 'a')
  const slot = alternateNextSlot()
  await updateSetting('monitor_alternate_last', slot)
  return resolveSlot(slot)
}

interface MonitorLLM {
  client: OpenAI
  model: string
  baseURL: string
  maxTokens: number
  fallback?: LLMTarget
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

async function monitorCoin(
  ctx: PositionContext,
  cycleId: string,
  llm: MonitorLLM,
  adjustEnabled: boolean,
  reduceEnabled: boolean,
  trustLlm: boolean,
  useHorizon: boolean,
  utcOffsetHours: number,
  now: string,
  horizonConfigs: HorizonConfigs,
  historyTf: string,
  historyCount: number,
  minConfidence: number,
  reviewIntervalMin: number | null,
  breakevenPct: number,
  feeRate: number,
  adjustCooldownMin: number,
): Promise<PositionReview | null> {
  const history = (await positionReviews.find(
    { coin: ctx.coin },
    { sort: { created_at: -1 }, limit: 3 },
  )) as unknown as PositionReview[]

  const storedNotes = (await monitorNotes.findOne(
    { _id: ctx.coin },
    { projection: { notes: 1, updated_at: 1 } },
  )) as MonitorNotes | null

  const tf = isTimeframe(historyTf) ? historyTf : '1h'
  const count = Math.max(1, Math.min(100, historyCount))
  let candles: Awaited<ReturnType<typeof getOHLCV>> = []
  try {
    candles = await getOHLCV(ctx.coin, tf, count)
  } catch (err) {
    logger.warn('Failed to fetch candle history for monitor prompt', { coin: ctx.coin, tf, error: (err as Error).message })
  }

  const { system, user } = buildMonitorPrompt(ctx, history, horizonConfigs, useHorizon, utcOffsetHours, candles, tf, reviewIntervalMin, storedNotes, breakevenPct, reduceEnabled)

  logger.info('Request LLM', { module: 'monitor', coin: ctx.coin, model: llm.model })

  let raw: RawReview | null = null

  // #2d: Retry on both parse errors AND LLM API/network errors
  for (let attempt = 0; attempt <= 1; attempt++) {
    let resp: Awaited<ReturnType<typeof llmChat>>
    try {
      resp = await llmChat(llm.client, {
        model: llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: llm.maxTokens,
        response_format: { type: 'json_object' },
      }, { module: 'monitor', cycle_id: cycleId, coin: ctx.coin, base_url: llm.baseURL }, llm.fallback)
    } catch (apiErr) {
      if (attempt === 0) {
        logger.warn('Monitor LLM API error, retrying', { coin: ctx.coin, error: (apiErr as Error).message })
        continue
      }
      throw apiErr
    }

    const finish = resp.choices[0]?.finish_reason
    const content = resp.choices[0]?.message?.content ?? ''

    logger.info('Monitor LLM response', { coin: ctx.coin, attempt, finish_reason: finish, length: content.length })

    if (!content.trim()) {
      if (attempt === 0) { logger.warn('Empty monitor response, retrying', { coin: ctx.coin, finish_reason: finish }); continue }
      throw new LLMError(`Empty LLM response (finish_reason: ${finish ?? 'unknown'})`)
    }

    try {
      raw = parseReview(content)
    } catch (err) {
      if (attempt === 0) { logger.warn('Monitor parse failed, retrying', { coin: ctx.coin, error: (err as Error).message }); continue }
      throw err
    }

    break
  }

  if (!raw) throw new LLMError('Monitor returned no valid review after retries')

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
  if (raw.action === 'REDUCE' && !reduceEnabled) {
    logger.warn('Monitor REDUCE disabled by setting — storing as HOLD', { coin: ctx.coin })
    raw = { ...raw, action: 'HOLD', reasoning: `[REDUCE disabled — not executed] ${raw.reasoning}` }
    reduceToPct = null
  }
  if (raw.action === 'REDUCE' && reduceToPct == null) {
    logger.warn('Monitor REDUCE missing reduce_to_pct — storing as HOLD', { coin: ctx.coin })
    raw = { ...raw, action: 'HOLD', reasoning: `[REDUCE missing reduce_to_pct — not executed] ${raw.reasoning}` }
  }
  if ((raw.action === 'CLOSE' || raw.action === 'REDUCE') && confidence < minConfidence) {
    logger.warn('Monitor action below confidence threshold — storing as HOLD', { coin: ctx.coin, action: raw.action, confidence, minConfidence })
    raw = { ...raw, action: 'HOLD', reasoning: `[${raw.action} suppressed: confidence ${confidence.toFixed(2)} < required ${minConfidence.toFixed(2)}] ${raw.reasoning}` }
    reduceToPct = null
  }

  // Adjustment cooldown: one applied SL/TP change per window, scaled by horizon.
  // The 5-min review cadence runs a different clock than a medium/long-horizon
  // trade — without this, the LLM re-trails the stop dozens of times per position
  // (58× observed), each costing an exchange-side OCO cancel+replace.
  // Seeding (no SL or TP yet) is exempt: protection must never wait.
  if (raw.action === 'ADJUST' && ctx.positionId != null && adjustCooldownMin > 0 &&
      ctx.stopLoss != null && ctx.takeProfit != null) {
    const horizonFactor = ctx.horizon === 'short' ? 0.5 : ctx.horizon === 'long' ? 2 : 1
    const cooldownMs = adjustCooldownMin * horizonFactor * 60_000
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
    const hcfg = horizonConfigs[effectiveHorizon]
    const pctToPrice = (pct: number) => ctx.currentPrice * (1 + pct / 100)
    // LLM-horizon: null means "keep existing" — don't seed from horizon config.
    const proposedSl = typeof raw.new_stop_loss_pct === 'number'
      ? pctToPrice(raw.new_stop_loss_pct)
      : (ctx.stopLoss ?? (isLlmHorizon ? null : pctToPrice(-hcfg.slPct)))
    const proposedTp = typeof raw.new_take_profit_pct === 'number'
      ? pctToPrice(raw.new_take_profit_pct)
      : (ctx.takeProfit ?? (isLlmHorizon ? null : pctToPrice(hcfg.tpPct)))

    if (trustLlm) {
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
          if (adjustEnabled) {
            newStopLoss = slChanged ? proposedSl! : null
            newTakeProfit = tpChanged ? proposedTp! : null
            proposalToEmit = { newSl: newStopLoss, newTp: newTakeProfit }
          }
          logger.info('SL/TP trusted (bypass validation)', { coin: ctx.coin, sl: proposedSl, tp: proposedTp, applied: adjustEnabled })
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
        feeRoundTripPct: feeRate * 2 * 100,
        // Same trigger the prompt's profit-protection rule announces — the engine
        // rejects break-even stops before it instead of trusting the LLM to wait.
        breakevenTriggerPct: useHorizon ? hcfg.tpPct / 2 : breakevenPct,
        // Same gap the prompt announces: horizon-scaled when guidance is on,
        // the 0.5% floor when the LLM manages risk freely.
        minSlGapPct: minStopGapPct(useHorizon && !isLlmHorizon ? hcfg.slPct : null),
      })
      if (validated.notes.length > 0) {
        logger.info('SL/TP adjustment validated', { coin: ctx.coin, changed: validated.changed, notes: validated.notes })
      }
      if (validated.changed && adjustEnabled) {
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
    model: llm.model, cycle_id: cycleId, created_at: nowSql(),
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
    model: llm.model,
    cycle_id: cycleId,
    created_at: now,
  }

  logger.info('Position review saved', { coin: ctx.coin, action: raw.action, confidence })
  broadcast('monitor_coin_completed', { cycle_id: cycleId, review })

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
      model: llm.model,
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

    priceCache.subscribe(entries.map(e => e.coin))
    const allPrices = priceCache.getAll()

    const s = getSettings()
    const active = await advanceMonitorModel()
    const llm: MonitorLLM = {
      client: new OpenAI({ baseURL: active.baseURL, apiKey: 'ollama' }),
      model: active.model,
      baseURL: active.baseURL,
      maxTokens: active.maxTokens,
      fallback: active.fallback,
    }
    logger.info('Monitor using model', { cycleId, slot: active.slot, mode: s.monitor_model, model: active.model, baseURL: active.baseURL })
    const adjustEnabled = s.monitor_adjust_sltp
    const reduceEnabled = s.monitor_reduce_enabled
    const trustLlm = s.monitor_trust_llm_sltp
    const useHorizon = s.monitor_use_horizon
    const utcOffsetHours = s.utc_offset_hours
    const historyTf = s.monitor_history_tf
    const historyCount = s.monitor_history_count
    const minConfidence = Math.min(1, Math.max(0, s.monitor_min_confidence))
    const breakevenPct = s.monitor_breakeven_pct > 0 ? s.monitor_breakeven_pct : 3
    const feeRate = s.fee_rate
    const adjustCooldownMin = s.monitor_adjust_cooldown_min
    const reviewIntervalMin = s.monitor_auto_run ? cronIntervalMinutes(s.monitor_cron) : null
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    const horizonConfigs: HorizonConfigs = {
      short:  { slPct: s.monitor_sl_pct_short,  tpPct: s.monitor_tp_pct_short  },
      medium: { slPct: s.monitor_sl_pct_medium, tpPct: s.monitor_tp_pct_medium },
      long:   { slPct: s.monitor_sl_pct_long,   tpPct: s.monitor_tp_pct_long   },
    }

    const positionContexts: PositionContext[] = await Promise.all(
      entries.map(async (entry): Promise<PositionContext> => {
        const snap = allPrices.get(entry.coin)
        const currentPrice = snap?.price ?? entry.avg_buy_price

        const [marketCtx, position] = await Promise.all([
          getMarketContext(entry.coin, currentPrice),
          positionsRepo.findOne(
            { coin: entry.coin, status: 'OPEN' },
            { projection: { id: 1, stop_loss: 1, take_profit: 1, horizon: 1 } },
          ) as Promise<{ id: number; stop_loss: number | null; take_profit: number | null; horizon: string | null } | null>,
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

        // Weighted-average entry timestamp (epoch ms) from the aggregation above.
        const msFromJd = entry.avg_date_ms
        const ageHours = (Date.now() - msFromJd) / (1000 * 60 * 60)
        const entryDate = new Date(msFromJd + utcOffsetHours * 3600000)
          .toISOString().replace('T', ' ').slice(0, 19) + ' ' + fmtOffsetLabel(utcOffsetHours)

        const rawHorizon = position?.horizon ?? 'medium'
        const horizon = (['short', 'medium', 'long', 'disabled', 'llm'].includes(rawHorizon)
          ? rawHorizon : 'medium') as 'short' | 'medium' | 'long' | 'disabled' | 'llm'

        return {
          positionId: position?.id ?? null,
          coin: entry.coin,
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
      }),
    )

    logger.info('Monitor running per-coin sequentially', { cycleId, coins: positionContexts.map(c => c.coin) })

    const reviews: PositionReview[] = []
    for (const ctx of positionContexts) {
      if (ctx.horizon === 'disabled') {
        logger.info('Monitor skipping disabled position', { coin: ctx.coin, cycleId })
        continue
      }
      // 'llm' horizon: monitor runs, but horizon guidance is suppressed in the prompt.
      try {
        const effectiveUseHorizon = ctx.horizon === 'llm' ? false : useHorizon
        const review = await monitorCoin(ctx, cycleId, llm, adjustEnabled, reduceEnabled, trustLlm, effectiveUseHorizon, utcOffsetHours, now, horizonConfigs, historyTf, historyCount, minConfidence, reviewIntervalMin, breakevenPct, feeRate, adjustCooldownMin)
        if (review) reviews.push(review)
      } catch (err) {
        logger.error('Monitor coin failed', { coin: ctx.coin, cycleId, error: (err as Error).message })
        broadcast('monitor_coin_error', { cycle_id: cycleId, coin: ctx.coin, error: (err as Error).message })
      }
    }

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
