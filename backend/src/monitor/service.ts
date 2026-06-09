import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { getMarketContext } from '../portfolio/market.js'
import { validateSlTpAdjustment } from '../portfolio/risk.js'
import * as priceCache from '../market/index.js'
import { broadcast } from '../api/ws.js'
import { bus } from '../core/events.js'
import { PositionReview } from '../types.js'
import { buildMonitorPrompt, PositionContext, HorizonConfigs } from './prompts.js'
import { LLMError } from '../core/errors.js'
import { config } from '../config/index.js'

const client = new OpenAI({ baseURL: config.monitor.baseURL, apiKey: 'ollama' })

let running = false

interface RawReview {
  action: 'HOLD' | 'CLOSE' | 'REDUCE' | 'ADJUST'
  confidence: number
  reasoning: string
  reduce_to_pct?: number | null
  new_stop_loss?: number | null
  new_take_profit?: number | null
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

  if (
    typeof obj !== 'object' || obj === null ||
    !['HOLD', 'CLOSE', 'REDUCE', 'ADJUST'].includes((obj as RawReview).action) ||
    typeof (obj as RawReview).confidence !== 'number' ||
    typeof (obj as RawReview).reasoning !== 'string'
  ) throw new LLMError('Invalid review in monitor response')

  return obj as RawReview
}

/**
 * If the LLM dropped the decimal point (e.g. returned 11780 for a $1.1787 coin),
 * try dividing by powers of 10 until the value lands within 50%–150% of reference.
 * Returns the original value if no rescaling produces a plausible result.
 */
function rescalePrice(proposed: number, reference: number): number {
  if (reference <= 0) return proposed
  const ratio = proposed / reference
  if (ratio >= 0.1 && ratio <= 5) return proposed  // already reasonable
  for (const exp of [1, 2, 3, 4, 5]) {
    const scaled = proposed / Math.pow(10, exp)
    const r = scaled / reference
    if (r >= 0.5 && r <= 1.5) return scaled
  }
  return proposed
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
  now: string,
  horizonConfigs: HorizonConfigs,
): Promise<PositionReview | null> {
  const history = queryAll(
    'SELECT * FROM position_reviews WHERE coin = ? ORDER BY created_at DESC LIMIT 3',
    [ctx.coin],
  ) as unknown as PositionReview[]

  const { system, user } = buildMonitorPrompt(ctx, history, horizonConfigs)

  logger.info('Request LLM', { module: 'monitor', coin: ctx.coin, model: config.monitor.model })

  let raw: RawReview | null = null

  for (let attempt = 0; attempt <= 1; attempt++) {
    const resp = await llmChat(client, {
      model: config.monitor.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: config.monitor.maxTokens,
      response_format: { type: 'json_object' },
    }, { module: 'monitor', cycle_id: cycleId, coin: ctx.coin })

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
    const proposedSl = typeof raw.new_stop_loss === 'number'
      ? rescalePrice(raw.new_stop_loss, ctx.currentPrice) : null
    const proposedTp = typeof raw.new_take_profit === 'number'
      ? rescalePrice(raw.new_take_profit, ctx.currentPrice) : null

    if (proposedSl !== raw.new_stop_loss && proposedSl !== null)
      logger.info('Rescaled LLM stop-loss', { coin: ctx.coin, original: raw.new_stop_loss, rescaled: proposedSl })
    if (proposedTp !== raw.new_take_profit && proposedTp !== null)
      logger.info('Rescaled LLM take-profit', { coin: ctx.coin, original: raw.new_take_profit, rescaled: proposedTp })

    const validated = validateSlTpAdjustment({
      currentPrice: ctx.currentPrice,
      oldStopLoss: ctx.stopLoss,
      oldTakeProfit: ctx.takeProfit,
      proposedStopLoss: proposedSl,
      proposedTakeProfit: proposedTp,
    })
    if (validated.notes.length > 0) {
      logger.info('SL/TP adjustment validated', { coin: ctx.coin, changed: validated.changed, notes: validated.notes })
    }
    if (validated.changed && adjustEnabled) {
      newStopLoss = validated.stopLoss
      newTakeProfit = validated.takeProfit
      proposalToEmit = { newSl: newStopLoss, newTp: newTakeProfit }
    } else if (!validated.changed) {
      // Proposal was invalid or a no-op (e.g. LLM returned wrong scale) — downgrade to HOLD
      logger.warn('ADJUST proposal rejected by validation, storing as HOLD', {
        coin: ctx.coin,
        proposed_sl: raw.new_stop_loss,
        proposed_tp: raw.new_take_profit,
        current_price: ctx.currentPrice,
        notes: validated.notes,
      })
      raw = { ...raw, action: 'HOLD' }
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
    'INSERT INTO position_reviews (coin, action, confidence, reasoning, reduce_to_pct, new_stop_loss, new_take_profit, market_data, cycle_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ctx.coin, raw.action, confidence, raw.reasoning, reduceToPct, newStopLoss, newTakeProfit, marketData, cycleId],
  )

  const review: PositionReview = {
    id: Number(lastInsertRowid),
    coin: ctx.coin,
    action: raw.action,
    confidence,
    reasoning: raw.reasoning,
    reduce_to_pct: reduceToPct,
    new_stop_loss: newStopLoss,
    new_take_profit: newTakeProfit,
    market_data: marketData,
    cycle_id: cycleId,
    created_at: now,
  }

  logger.info('Position review saved', { coin: ctx.coin, action: raw.action, confidence })
  broadcast('monitor_coin_completed', { cycle_id: cycleId, review })

  // Fire decision immediately — don't wait for other coins
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
    const entries = queryAll(`
      SELECT
        coin,
        SUM(quantity) AS quantity,
        SUM(quantity * buy_price) / SUM(quantity) AS avg_buy_price,
        MIN(buy_date) AS earliest_date
      FROM portfolio_entries
      WHERE status = 'OPEN' AND coin != 'USDC'
      GROUP BY coin
    `) as { coin: string; quantity: number; avg_buy_price: number; earliest_date: string }[]

    if (entries.length === 0) {
      logger.info('Position monitor: no open positions to review')
      broadcast('monitor_completed', { cycle_id: cycleId, reviews: [], message: 'No open positions' })
      return
    }

    priceCache.subscribe(entries.map(e => e.coin))
    const allPrices = priceCache.getAll()

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

        const ageMs = Date.now() - new Date(entry.earliest_date + 'T00:00:00Z').getTime()
        const ageHours = ageMs / (1000 * 60 * 60)

        const rawHorizon = position?.horizon ?? 'medium'
        const horizon = (['short', 'medium', 'long'].includes(rawHorizon)
          ? rawHorizon : 'medium') as 'short' | 'medium' | 'long'

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

    const s = getSettings()
    const adjustEnabled = s.monitor_adjust_sltp
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    const horizonConfigs: HorizonConfigs = {
      short:  { slPct: s.monitor_sl_pct_short,  tpPct: s.monitor_tp_pct_short  },
      medium: { slPct: s.monitor_sl_pct_medium, tpPct: s.monitor_tp_pct_medium },
      long:   { slPct: s.monitor_sl_pct_long,   tpPct: s.monitor_tp_pct_long   },
    }

    logger.info('Monitor running per-coin in parallel', { cycleId, coins: positionContexts.map(c => c.coin) })

    // Each coin runs in parallel; decisions (bus events) fire as each coin resolves
    const reviews = (await Promise.all(
      positionContexts.map(ctx =>
        monitorCoin(ctx, cycleId, adjustEnabled, now, horizonConfigs).catch(err => {
          logger.error('Monitor coin failed', { coin: ctx.coin, cycleId, error: (err as Error).message })
          broadcast('monitor_coin_error', { cycle_id: cycleId, coin: ctx.coin, error: (err as Error).message })
          return null
        }),
      ),
    )).filter((v): v is PositionReview => v !== null)

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
