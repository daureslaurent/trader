import { getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { fetchMarketData } from '../trader/index.js'
import * as priceCache from '../market/index.js'
import * as entry from '../entry/index.js'
import { planEntry, resolveEntryBand } from '../entryPlanner/index.js'
import { EntryBand } from '../entryPlanner/types.js'
import { getPortfolioState, getUsdcEntry, getMarketContext } from '../portfolio/index.js'
import { isTradeable } from '../core/tradeable.js'
import { Signal, MarketContext, BotSettings } from '../types.js'
import { prepareBuyOrder } from './buyEvaluation.js'
import { logPipelineEvent } from './events.js'

/**
 * Register an already-sized BUY as a deferred entry intent on the Entry Desk. The
 * entry band is the per-coin Entry Planner LLM plan (when `entry_planner_enabled`)
 * or — on a disabled planner / LLM failure / unusable output — the static `entry_*`
 * settings, via `resolveEntryBand`. The band tracks the LIVE price at registration
 * (not the decision-time price, which may be stale); sizing stays on the analyzed
 * price. Shared by the pipeline BUY path (`runner.handleBuySignal`) and the manual
 * "Add to Entry Desk" action so the two can't drift.
 */
export async function deferToEntryDesk(args: {
  /** The BUY signal with `quantity` already set by the gauntlet/override. */
  buySignal: Signal
  /** Decision-time price used for sizing + the band's static fallback. */
  analyzedPrice: number
  marketCtx: MarketContext
  settings: BotSettings
  cycleId: string
  /** Pre-resolved entry band (e.g. the Agent Signal engine plans its own). When given,
   *  the Entry Planner LLM is skipped entirely and this band is used as-is — the static
   *  settings still serve as the safety fallback if it's somehow unusable. */
  band?: EntryBand
}): Promise<void> {
  const { buySignal, analyzedPrice, marketCtx, settings, cycleId } = args
  const symbol = buySignal.coin
  const qty = buySignal.quantity

  const entryBasis = priceCache.getPrice(symbol)?.price ?? analyzedPrice

  let band: EntryBand
  if (args.band) {
    band = args.band
  } else {
    const plan = settings.entry_planner_enabled
      ? await planEntry({
          coin: symbol, price: analyzedPrice, market: marketCtx, signal: buySignal,
          candleTf: settings.entry_planner_candle_tf, candleCount: settings.entry_planner_candle_count,
        })
      : null
    band = resolveEntryBand(plan, settings)
  }

  entry.register({ signal: buySignal, signalPrice: entryBasis, notionalUsdc: qty * analyzedPrice, atr: marketCtx.atr14, band })
  logPipelineEvent('entry_intent_created', symbol, cycleId, {
    action: 'BUY', signal_price: entryBasis, analyzed_price: analyzedPrice, quantity: qty,
    target_price: entryBasis * (1 - band.pullbackPct / 100),
    invalidate_price: entryBasis * (1 - band.invalidatePct / 100),
    chase_cap_price: entryBasis * (1 + band.chaseCapPct / 100),
    ttl_minutes: band.ttlMinutes,
    band_source: band.source,
    plan_reason: band.reason,
  })
}

export interface ManualEntryResult {
  ok: boolean
  error?: string
  coin?: string
}

/**
 * Stage a coin onto the Entry Desk on demand — the "Add to Entry Desk" action. It
 * is a manual conviction BUY: the research/analyst pipeline is skipped entirely and
 * a synthetic BUY signal is pushed straight through the normal BUY gauntlet
 * (max-positions, already-held, min-USDC, sizing, fee-edge) and then deferred to
 * the entry engine, where the Entry Planner LLM picks the entry window exactly as
 * it would for a pipeline BUY. Sizing is the usual confidence/ATR auto-size unless
 * `notionalUsdc` is given, in which case that USDC amount is used (still gated).
 * Returns a human-readable reason on any rejection — nothing is staged on failure.
 */
export async function stageManualEntry(input: { symbol: string; notionalUsdc?: number }): Promise<ManualEntryResult> {
  const { symbol, notionalUsdc } = input

  if (!isTradeable(symbol)) return { ok: false, error: `Cannot stage ${symbol} — fiat/stablecoin` }
  if (entry.hasActiveIntent(symbol)) return { ok: false, error: 'An entry intent is already pending for this coin' }

  const settings = getSettings()

  const marketData = await fetchMarketData([symbol])
  const data = marketData[0]
  if (!data || !(data.price > 0)) {
    return { ok: false, error: `No Binance market data for ${symbol} — is it a valid USDC pair?` }
  }

  const portfolioState = await getPortfolioState(marketData, settings)
  const marketCtx = await getMarketContext(symbol, data.price)

  // Full conviction: confidence 1 so position sizing isn't damped, and a clear
  // synthetic thesis the Entry Planner can read.
  const signal: Signal = { coin: symbol, action: 'BUY', quantity: 0, reason: 'Manual entry (Entry Desk)', confidence: 1 }

  const evaluation = await prepareBuyOrder({
    symbol, price: data.price, atr14: marketCtx.atr14,
    signal, portfolioState, settings, checkActiveIntent: true,
  })
  if (!evaluation.ok) return { ok: false, error: evaluation.reason }

  let qty = evaluation.order.qty
  if (notionalUsdc != null) {
    if (!(notionalUsdc > 0)) return { ok: false, error: 'Notional must be a positive number' }
    if (notionalUsdc < settings.min_trade_usdc) {
      return { ok: false, error: `Notional $${notionalUsdc.toFixed(2)} is below the minimum $${settings.min_trade_usdc}` }
    }
    const availableUsdc = (await getUsdcEntry())?.quantity ?? 0
    if (notionalUsdc > availableUsdc) {
      return { ok: false, error: `Notional $${notionalUsdc.toFixed(2)} exceeds available USDC $${availableUsdc.toFixed(2)}` }
    }
    qty = notionalUsdc / data.price
  }

  const cycleId = `${Date.now().toString(36)}-manual-entry`
  logPipelineEvent('signal_generated', symbol, cycleId, {
    symbol, action: 'BUY', confidence: signal.confidence, reason: signal.reason,
  })
  await deferToEntryDesk({ buySignal: { ...signal, quantity: qty }, analyzedPrice: data.price, marketCtx, settings, cycleId })
  logger.info('Manual entry staged on Entry Desk', { coin: symbol, qty, notionalUsdc: notionalUsdc ?? qty * data.price })
  return { ok: true, coin: symbol }
}
