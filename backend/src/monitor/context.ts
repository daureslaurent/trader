import { logger } from '../core/logger.js'
import {
  getSettings, nowSql,
  positionReviews, monitorNotes, positionAdjustments, positions as positionsRepo, portfolioEntries,
} from '../db/index.js'
import { getMarketContext } from '../portfolio/market.js'
import { validateSlTpAdjustment, minStopGapPct } from '../portfolio/risk.js'
import * as priceCache from '../market/index.js'
import { broadcast } from '../api/ws.js'
import { bus } from '../core/events.js'
import { PositionReview, BotSettings, ReviewRiskFields, ThesisStatus, MarketRegime } from '../types.js'
import { PositionContext, HorizonConfigs, MonitorNotes, fmtOffsetLabel } from './types.js'
import { LLMError } from '../core/errors.js'

export interface RawReview extends Partial<ReviewRiskFields> {
  action: 'HOLD' | 'CLOSE' | 'ADJUST'
  confidence: number
  reasoning: string
  // #2a: LLM returns percentages relative to current price — engine converts to abs prices
  new_stop_loss_pct?: number | null
  new_take_profit_pct?: number | null
  // Persistent per-coin memory: a non-empty string replaces the stored note, null keeps it
  notes?: string | null
}

// Defensive coercion for the optional structured risk fields the agentic monitor emits. A
// missing or malformed field never invalidates a verdict — it just resolves to null.
const THESIS_STATUSES: ThesisStatus[] = ['intact', 'weakening', 'invalidated']
const MARKET_REGIMES: MarketRegime[] = ['risk_on', 'risk_off', 'neutral']
function parseRiskFields(c: Record<string, unknown>): ReviewRiskFields {
  const thesis = typeof c.thesis_status === 'string' ? c.thesis_status.trim().toLowerCase() : null
  const regimeRaw = typeof c.regime === 'string' ? c.regime.trim().toLowerCase().replace(/[\s-]/g, '_') : null
  const rr = typeof c.risk_reward === 'number' && Number.isFinite(c.risk_reward) && c.risk_reward >= 0
    ? Math.round(c.risk_reward * 100) / 100
    : null
  return {
    thesis_status: thesis && (THESIS_STATUSES as string[]).includes(thesis) ? thesis as ThesisStatus : null,
    risk_reward: rr,
    regime: regimeRaw && (MARKET_REGIMES as string[]).includes(regimeRaw) ? regimeRaw as MarketRegime : null,
  }
}

// Hard cap on stored note size — the prompt asks for ≤500 chars, this guards
// against a runaway model flooding the prompt of every future review.
const MAX_NOTES_LENGTH = 1000

export function parseReview(content: string): RawReview {
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
    !['HOLD', 'CLOSE', 'ADJUST'].includes(candidate.action as string) ||
    typeof candidate.confidence !== 'number' ||
    typeof candidate.reasoning !== 'string'
  ) throw new LLMError('Invalid review in monitor response')

  return { ...(candidate as unknown as RawReview), ...parseRiskFields(candidate) }
}

// Approximate review cadence from the monitor cron expression, for the cycle params.
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

export async function pruneMonitorHistory(
  maxCycles = Math.max(1, getSettings().monitor_review_retain_cycles || 20),
): Promise<void> {
  // Keep the most recent `maxCycles` distinct cycles (by latest created_at), delete the rest.
  const recent = await positionReviews.aggregate<{ _id: string }>([
    { $group: { _id: '$cycle_id', latest: { $max: '$created_at' } } },
    { $sort: { latest: -1 } },
    { $limit: maxCycles },
  ])
  const keep = recent.map(r => r._id)
  await positionReviews.deleteMany({ cycle_id: { $nin: keep } })
}

// One OPEN portfolio entry, aggregated across multiple fills (see getMonitorEntries).
export interface MonitorEntry { coin: string; quantity: number; avg_buy_price: number; avg_date_ms: number }

// Per-cycle knobs resolved once from settings and shared by every coin's review. These are
// configuration, not market data, so they don't go stale.
export interface CycleParams {
  adjustEnabled: boolean
  trustLlm: boolean
  useHorizon: boolean
  utcOffsetHours: number
  horizonConfigs: HorizonConfigs
  minConfidence: number
  protectWinners: boolean
  protectWinnersAtr: number
  reviewIntervalMin: number | null
  breakevenPct: number
  feeRate: number
  adjustCooldownMin: number
}

// The fresh position context for a coin's review plus the horizon-resolved guidance flag.
// Produced JIT by buildReviewContext, then reused by the merge/validate stage so the engine
// always acts on the SAME market snapshot it reasoned over.
interface ReviewContext {
  ctx: PositionContext
  effectiveUseHorizon: boolean
}

// JIT context binding: gathers the live price, market indicators and fresh position SL/TP for
// a coin at the moment the engine dispatches its review (never at cycle start). A monitor run
// can queue many coins; building here keeps the position/market values current rather than
// minutes-stale from the queue.
export async function buildReviewContext(coin: string, entry: MonitorEntry, p: CycleParams): Promise<ReviewContext> {
  const snap = priceCache.getPrice(coin)
  const currentPrice = snap?.price ?? entry.avg_buy_price

  const [marketCtx, position] = await Promise.all([
    getMarketContext(coin, currentPrice),
    positionsRepo.findOne(
      { coin, status: 'OPEN' },
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

  // Weighted-average entry timestamp (epoch ms) from the getMonitorEntries aggregation.
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

  // 'llm' horizon: monitor runs, but horizon guidance is suppressed.
  const effectiveUseHorizon = horizon === 'llm' ? false : p.useHorizon
  return { ctx, effectiveUseHorizon }
}

// Everything finalizeReview needs about a resolved verdict, independent of HOW it was produced.
export interface FinalizeReviewInput {
  ctx: PositionContext
  raw: RawReview
  /** Whether horizon guidance applied to this coin's review (see buildReviewContext). */
  effectiveUseHorizon: boolean
  /** The model id credited on the stored review. */
  modelName: string
  cycleId: string
}

// The shared post-decision safety net. Takes a resolved verdict + the live position
// context and applies every guard the monitor enforces before it acts: confidence
// threshold, ADJUST downgrades, OCO half-leg seeding, adjust cooldown, then persists a
// position_reviews row and emits the close/adjust bus events. Returns the stored review,
// or null if the position closed mid-analysis.
export async function finalizeReview(input: FinalizeReviewInput, p: CycleParams): Promise<PositionReview | null> {
  const { ctx, effectiveUseHorizon: useHorizon, cycleId } = input
  let raw = input.raw

  const confidence = Math.min(1, Math.max(0, raw.confidence))

  // Downgrade actions the engine cannot or should not execute. The stored review keeps
  // an honest record — otherwise the LLM sees its own unexecuted CLOSE in the
  // decision history and assumes it already happened.
  if (raw.action !== 'HOLD' && ctx.positionId == null) {
    logger.warn('Monitor action has no position record to act on — storing as HOLD', { coin: ctx.coin, action: raw.action })
    raw = { ...raw, action: 'HOLD', reasoning: `[${raw.action} not executable — no position record] ${raw.reasoning}` }
  }
  if (raw.action === 'CLOSE' && confidence < p.minConfidence) {
    logger.warn('Monitor action below confidence threshold — storing as HOLD', { coin: ctx.coin, action: raw.action, confidence, minConfidence: p.minConfidence })
    raw = { ...raw, action: 'HOLD', reasoning: `[${raw.action} suppressed: confidence ${confidence.toFixed(2)} < required ${p.minConfidence.toFixed(2)}] ${raw.reasoning}` }
  }

  // Profit-protection guard: don't let the engine close a healthy winner on a thin
  // reward:risk reading alone (the failure mode that exited a +4% trending SOL right before
  // it ran further). A CLOSE on a position that is (a) in profit, (b) whose stop is NOT
  // threatened — price sits ≥ protectWinnersAtr × ATR(14) above the SL — and (c) whose trend
  // has not reversed (still an uptrend) is downgraded to HOLD, UNLESS the model's own verdict
  // justifies the exit (thesis invalidated, or a risk-off regime turning against the position).
  // Cross-checking the action against the model's structured fields blocks only
  // self-contradictory exits (close a winner while calling the thesis intact / regime neutral),
  // never a CLOSE the model actually backs with a reversal/risk-off reason. With no stop set or
  // no ATR, the guard stays inert and the CLOSE proceeds (it may be the only protection).
  if (raw.action === 'CLOSE' && p.protectWinners && ctx.positionId != null) {
    const stopGapAtr = ctx.stopLoss != null && ctx.atr14 > 0
      ? (ctx.currentPrice - ctx.stopLoss) / ctx.atr14
      : null
    const inProfit = ctx.pnlPct > 0
    const stopSafe = stopGapAtr != null && stopGapAtr >= p.protectWinnersAtr
    const trendIntact = ctx.trend === 'uptrend'
    const modelJustifies = raw.thesis_status === 'invalidated' || raw.regime === 'risk_off'
    if (inProfit && stopSafe && trendIntact && !modelJustifies) {
      logger.info('Monitor CLOSE suppressed by profit-protection guard — storing as HOLD', {
        coin: ctx.coin, positionId: ctx.positionId, pnlPct: Number(ctx.pnlPct.toFixed(2)),
        stopGapAtr: Number(stopGapAtr.toFixed(2)), trend: ctx.trend,
        thesis_status: raw.thesis_status ?? null, regime: raw.regime ?? null,
      })
      raw = { ...raw, action: 'HOLD', reasoning: `[CLOSE suppressed: profit-protection — winner +${ctx.pnlPct.toFixed(1)}%, stop ${stopGapAtr.toFixed(1)}×ATR away, trend intact, model thesis ${raw.thesis_status ?? 'n/a'}/regime ${raw.regime ?? 'n/a'}] ${raw.reasoning}` }
    }
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
      const validated = validateSlTpAdjustment({
        currentPrice: ctx.currentPrice,
        oldStopLoss: ctx.stopLoss,
        oldTakeProfit: ctx.takeProfit,
        proposedStopLoss: proposedSl,
        proposedTakeProfit: proposedTp,
        // LLM horizon: no floor — the LLM decides its own risk management.
        maxSlPct: isLlmHorizon ? 100 : hcfg.slPct,
        entryPrice: ctx.entryPrice,
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

  const riskFields: ReviewRiskFields = {
    thesis_status: raw.thesis_status ?? null,
    risk_reward: raw.risk_reward ?? null,
    regime: raw.regime ?? null,
  }

  const reviewId = await positionReviews.insert({
    coin: ctx.coin, action: raw.action, confidence, reasoning: raw.reasoning,
    ...riskFields, old_stop_loss: ctx.stopLoss ?? null, old_take_profit: ctx.takeProfit ?? null,
    new_stop_loss: newStopLoss, new_take_profit: newTakeProfit, market_data: marketData,
    model: input.modelName, cycle_id: cycleId, created_at: nowSql(),
  })

  const review: PositionReview = {
    id: Number(reviewId),
    coin: ctx.coin,
    action: raw.action,
    confidence,
    reasoning: raw.reasoning,
    ...riskFields,
    old_stop_loss: ctx.stopLoss ?? null,
    old_take_profit: ctx.takeProfit ?? null,
    new_stop_loss: newStopLoss,
    new_take_profit: newTakeProfit,
    market_data: marketData,
    model: input.modelName,
    cycle_id: cycleId,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
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
      model: input.modelName,
      cycleId,
    })
  }

  return review
}

export async function clearReviewsForCoin(coin: string): Promise<void> {
  await positionReviews.deleteMany({ coin })
  await monitorNotes.deleteMany({ _id: coin })
  logger.info('Monitor history cleared for closed position', { coin })
}

// Aggregates the OPEN portfolio into one entry per coin, using a weighted-average
// entry timestamp (#2c: centre of mass in epoch ms, not MIN) so a position built
// across multiple fills ages from its true cost basis.
export async function getMonitorEntries(): Promise<MonitorEntry[]> {
  return portfolioEntries.aggregate<MonitorEntry>([
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
}

// Drops positions whose horizon is 'disabled' (a stable per-position config field):
// those are skipped entirely so no LLM call is ever wasted on a position the user
// has opted out of automated review for.
export async function filterReviewableEntries(entries: MonitorEntry[]): Promise<MonitorEntry[]> {
  const posRows = (await positionsRepo.find(
    { status: 'OPEN', coin: { $ne: 'USDC' } },
    { projection: { coin: 1, horizon: 1 } },
  )) as unknown as { coin: string; horizon: string | null }[]
  const horizonByCoin = new Map(posRows.map(r => [r.coin, r.horizon ?? 'medium']))
  return entries.filter(e => (horizonByCoin.get(e.coin) ?? 'medium') !== 'disabled')
}

// Resolves every per-cycle knob from settings once. These are configuration, not
// market data, so they're safe to bind at cycle start and share across all coins.
export function buildCycleParams(s: BotSettings): CycleParams {
  return {
    adjustEnabled: s.monitor_adjust_sltp,
    trustLlm: s.monitor_trust_llm_sltp,
    useHorizon: s.monitor_use_horizon,
    utcOffsetHours: s.utc_offset_hours,
    horizonConfigs: {
      short:  { slPct: s.monitor_sl_pct_short,  tpPct: s.monitor_tp_pct_short  },
      medium: { slPct: s.monitor_sl_pct_medium, tpPct: s.monitor_tp_pct_medium },
      long:   { slPct: s.monitor_sl_pct_long,   tpPct: s.monitor_tp_pct_long   },
    },
    minConfidence: Math.min(1, Math.max(0, s.monitor_min_confidence)),
    protectWinners: s.monitor_protect_winners,
    protectWinnersAtr: s.monitor_protect_winners_atr >= 0 ? s.monitor_protect_winners_atr : 1,
    reviewIntervalMin: s.monitor_auto_run ? cronIntervalMinutes(s.monitor_cron) : null,
    breakevenPct: s.monitor_breakeven_pct > 0 ? s.monitor_breakeven_pct : 3,
    feeRate: s.fee_rate,
    adjustCooldownMin: s.monitor_adjust_cooldown_min,
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
