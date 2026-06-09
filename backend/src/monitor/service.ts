import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { getMarketContext } from '../portfolio/market.js'
import { validateSlTpAdjustment } from '../portfolio/risk.js'
import * as priceCache from '../market/index.js'
import { getOHLCV, isTimeframe } from '../market/index.js'
import { broadcast } from '../api/ws.js'
import { bus } from '../core/events.js'
import { PositionReview } from '../types.js'
import { buildMonitorPrompt, fmtOffsetLabel, PositionContext, HorizonConfigs } from './prompts.js'
import { LLMError } from '../core/errors.js'
import { config } from '../config/index.js'

const client = new OpenAI({ baseURL: config.monitor.baseURL, apiKey: 'ollama' })

let running = false

interface RawReview {
  action: 'HOLD' | 'CLOSE' | 'REDUCE' | 'ADJUST'
  confidence: number
  reasoning: string
  reduce_to_pct?: number | null
  // #2a: LLM returns percentages relative to current price — engine converts to abs prices
  new_stop_loss_pct?: number | null
  new_take_profit_pct?: number | null
}

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

function pruneMonitorHistory(maxCycles = 20): void {
  runSQL(`
    DELETE FROM position_reviews
    WHERE cycle_id NOT IN (
      SELECT cycle_id FROM (
        SELECT DISTINCT cycle_id FROM position_reviews ORDER BY created_at DESC LIMIT ?
      )
    )
  `, [maxCycles])
}

async function monitorCoin(
  ctx: PositionContext,
  cycleId: string,
  adjustEnabled: boolean,
  trustLlm: boolean,
  useHorizon: boolean,
  utcOffsetHours: number,
  now: string,
  horizonConfigs: HorizonConfigs,
  historyTf: string,
  historyCount: number,
): Promise<PositionReview | null> {
  const history = queryAll(
    'SELECT * FROM position_reviews WHERE coin = ? ORDER BY created_at DESC LIMIT 1',
    [ctx.coin],
  ) as unknown as PositionReview[]

  const tf = isTimeframe(historyTf) ? historyTf : '1h'
  const count = Math.max(1, Math.min(100, historyCount))
  let candles: Awaited<ReturnType<typeof getOHLCV>> = []
  try {
    candles = await getOHLCV(ctx.coin, tf, count)
  } catch (err) {
    logger.warn('Failed to fetch candle history for monitor prompt', { coin: ctx.coin, tf, error: (err as Error).message })
  }

  const { system, user } = buildMonitorPrompt(ctx, history, horizonConfigs, useHorizon, utcOffsetHours, candles, tf)

  logger.info('Request LLM', { module: 'monitor', coin: ctx.coin, model: config.monitor.model })

  let raw: RawReview | null = null

  // #2d: Retry on both parse errors AND LLM API/network errors
  for (let attempt = 0; attempt <= 1; attempt++) {
    let resp: Awaited<ReturnType<typeof llmChat>>
    try {
      resp = await llmChat(client, {
        model: config.monitor.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: config.monitor.maxTokens,
        response_format: { type: 'json_object' },
      }, { module: 'monitor', cycle_id: cycleId, coin: ctx.coin, base_url: config.monitor.baseURL })
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
  const reduceToPct = raw.action === 'REDUCE' && typeof raw.reduce_to_pct === 'number'
    ? Math.min(99, Math.max(1, Math.round(raw.reduce_to_pct)))
    : null

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
      const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * 1e-6
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
      const validated = validateSlTpAdjustment({
        currentPrice: ctx.currentPrice,
        oldStopLoss: ctx.stopLoss,
        oldTakeProfit: ctx.takeProfit,
        proposedStopLoss: proposedSl,
        proposedTakeProfit: proposedTp,
        // LLM horizon: no floor — the LLM decides its own risk management.
        maxSlPct: isLlmHorizon ? 100 : hcfg.slPct,
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
  const stillOpen = queryOne(
    "SELECT 1 FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' LIMIT 1",
    [ctx.coin],
  )
  if (!stillOpen) {
    logger.info('Monitor review discarded — position closed during analysis', { coin: ctx.coin, cycleId })
    return null
  }

  const { lastInsertRowid } = runSQL(
    'INSERT INTO position_reviews (coin, action, confidence, reasoning, reduce_to_pct, old_stop_loss, old_take_profit, new_stop_loss, new_take_profit, market_data, cycle_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ctx.coin, raw.action, confidence, raw.reasoning, reduceToPct, ctx.stopLoss ?? null, ctx.takeProfit ?? null, newStopLoss, newTakeProfit, marketData, cycleId],
  )

  const review: PositionReview = {
    id: Number(lastInsertRowid),
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
      cycleId,
    })
  }

  return review
}

export function isRunning(): boolean {
  return running
}

export function clearReviewsForCoin(coin: string): void {
  runSQL('DELETE FROM position_reviews WHERE coin = ?', [coin])
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
    // #2c: Use weighted-average julian date instead of MIN to reflect the true
    // centre of mass of a position that was built across multiple entries.
    const entries = queryAll(`
      SELECT
        coin,
        SUM(quantity) AS quantity,
        SUM(quantity * buy_price) / SUM(quantity) AS avg_buy_price,
        SUM(quantity * julianday(created_at)) / SUM(quantity) AS avg_date_jd
      FROM portfolio_entries
      WHERE status = 'OPEN' AND coin != 'USDC'
      GROUP BY coin
    `) as { coin: string; quantity: number; avg_buy_price: number; avg_date_jd: number }[]

    if (entries.length === 0) {
      logger.info('Position monitor: no open positions to review')
      broadcast('monitor_completed', { cycle_id: cycleId, reviews: [], message: 'No open positions' })
      return
    }

    priceCache.subscribe(entries.map(e => e.coin))
    const allPrices = priceCache.getAll()

    const s = getSettings()
    const adjustEnabled = s.monitor_adjust_sltp
    const trustLlm = s.monitor_trust_llm_sltp
    const useHorizon = s.monitor_use_horizon
    const utcOffsetHours = s.utc_offset_hours
    const historyTf = s.monitor_history_tf
    const historyCount = s.monitor_history_count
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
          Promise.resolve(
            queryOne(
              "SELECT id, stop_loss, take_profit, horizon FROM positions WHERE coin = ? AND status = 'OPEN' LIMIT 1",
              [entry.coin],
            ) as { id: number; stop_loss: number | null; take_profit: number | null; horizon: string | null } | null
          ),
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

        // Convert Julian Day Number back to ms since epoch:
        // JDN 2440587.5 = 1970-01-01T00:00:00Z
        const msFromJd = (entry.avg_date_jd - 2440587.5) * 86400000
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
        const review = await monitorCoin(ctx, cycleId, adjustEnabled, trustLlm, effectiveUseHorizon, utcOffsetHours, now, horizonConfigs, historyTf, historyCount)
        if (review) reviews.push(review)
      } catch (err) {
        logger.error('Monitor coin failed', { coin: ctx.coin, cycleId, error: (err as Error).message })
        broadcast('monitor_coin_error', { cycle_id: cycleId, coin: ctx.coin, error: (err as Error).message })
      }
    }

    pruneMonitorHistory()

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

export function getReviews(limit = 100): PositionReview[] {
  // Only return reviews for coins that still have an open position.
  // This filters stale reviews left behind if the delete raced with a monitor run.
  return queryAll(
    `SELECT pr.* FROM position_reviews pr
     WHERE EXISTS (
       SELECT 1 FROM portfolio_entries pe
       WHERE pe.coin = pr.coin AND pe.status = 'OPEN'
     )
     ORDER BY pr.created_at DESC LIMIT ?`,
    [limit],
  ) as unknown as PositionReview[]
}
