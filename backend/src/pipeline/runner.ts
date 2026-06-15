import { portfolioSnapshots, positions as positionsRepo, portfolioEntries, nowSql, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { fetchMarketData, fetchBalance, getTopPairs } from '../trader/index.js'
import * as entry from '../entry/index.js'
import { getPortfolioState, getOpenEntries, detectExternalWithdrawal, checkOpenPositions } from '../portfolio/index.js'
import { isTradeable } from '../core/tradeable.js'
import { Signal, MarketContext } from '../types.js'
import { handleTradeSignal } from '../execution/index.js'
import { analyzeCoin } from './analyze.js'
import { prepareBuyOrder } from './buyEvaluation.js'
import { deferToEntryDesk } from './entryStaging.js'
import { logPipelineEvent } from './events.js'
import { PipelineCancelledError, clearCancel } from './cancellation.js'

export const PIPELINE_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour

let cycleCounter = 0
let pipelineRunning = false

export function isPipelineRunning(): boolean { return pipelineRunning }

/**
 * Shared handler for a BUY that has passed analysis. Runs the BUY gauntlet, then
 * either defers to the entry-timing engine (when `entry_timing_enabled`) or fills
 * immediately. Both the scheduled loop and the manual single-coin run go through
 * here so the two entry points can't drift — a past divergence let the manual
 * path skip the Entry Desk even with entry-timing on. Returns true when a trade
 * was initiated or deferred to an entry intent.
 */
async function handleBuySignal(args: {
  data: { symbol: string; price: number }
  marketCtx: MarketContext
  signal: Signal
  portfolioState: Awaited<ReturnType<typeof getPortfolioState>>
  settings: ReturnType<typeof getSettings>
  cycleId: string
  checkActiveIntent: boolean
}): Promise<boolean> {
  const { data, marketCtx, signal, portfolioState, settings, cycleId, checkActiveIntent } = args
  const symbol = data.symbol

  const evaluation = await prepareBuyOrder({
    symbol, price: data.price, atr14: marketCtx.atr14,
    signal, portfolioState, settings, checkActiveIntent,
  })
  if (!evaluation.ok) {
    logPipelineEvent('trade_skipped', symbol, cycleId, { reason: evaluation.reason })
    return false
  }
  const { qty, sl, tp } = evaluation.order
  const buySignal: Signal = { ...signal, quantity: qty }

  if (settings.entry_timing_enabled) {
    // Defer the fill to the entry engine, which waits for a good price before
    // firing via the 'entry_fire' bus event. The shared helper bases the band on
    // the LIVE price at registration (data.price can be minutes stale by the time
    // this slow pipeline signal lands) while sizing stays on the analyzed price,
    // and runs the Entry Planner LLM (or falls back to the static entry_* band).
    await deferToEntryDesk({ buySignal, analyzedPrice: data.price, marketCtx, settings, cycleId })
    return true
  }

  const { outcome, error: tradeErr } = await handleTradeSignal(buySignal, data.price, marketCtx.atr14, settings)
  logPipelineEvent('trade_executed', symbol, cycleId, {
    action: 'BUY', price: data.price, quantity: qty,
    stop_loss: sl, take_profit: tp,
    pending_approval: outcome === 'pending',
    sl_source: signal.stop_loss_pct != null ? 'rule' : 'atr',
    error: outcome === 'failed' ? tradeErr : undefined,
  })
  return outcome !== 'failed'
}

/** Run the full watchlist trading loop once, guarded against overlap and a 1h timeout. */
export async function runPipeline(): Promise<void> {
  if (pipelineRunning) {
    logger.warn('Pipeline already running, skipping trigger')
    return
  }
  pipelineRunning = true
  const runCycleId = `${Date.now().toString(36)}-run`

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Pipeline timed out after 1 hour')), PIPELINE_TIMEOUT_MS)
  )

  try {
    await Promise.race([tradingLoop(), timeout])
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.startsWith('Pipeline timed out')
    const stage = isTimeout ? 'pipeline_timeout' : 'pipeline_failed'
    const message = err instanceof Error ? err.message : String(err)

    logPipelineEvent(stage, 'SYSTEM', runCycleId, { error: message })
    logger.error(isTimeout ? 'Pipeline timed out' : 'Pipeline failed', { error: message })
  } finally {
    pipelineRunning = false
  }
}

async function tradingLoop() {
  logger.info('Trading loop started')

  const settings = getSettings()

  // Include coins currently held in the portfolio so the bot can SELL them even
  // if they were removed from the watchlist.
  const portfolioCoins = ((await getOpenEntries()) as unknown as { coin: string }[])
    .map(e => e.coin)

  const combined = [...new Set([...settings.watchlist, ...portfolioCoins])]
    .filter(isTradeable)

  const symbols = combined.length > 0 ? combined : (await getTopPairs(3)).filter(isTradeable)

  const rawMarketData = await fetchMarketData(symbols)

  // Drop symbols that came back with price=0 — they're not listed on Binance as a USDC pair
  const marketData = rawMarketData.filter(d => {
    if (d.price > 0) return true
    logger.warn('Symbol returned price=0, skipping — may not be a valid Binance pair', { symbol: d.symbol })
    return false
  })

  const balance = await fetchBalance()
  const usdcBalance = balance['USDC']?.total || 0
  await detectExternalWithdrawal(usdcBalance)

  await checkOpenPositions()

  let tradesInitiated = 0

  // Coins already in the portfolio are managed by the monitor (SL/TP, CLOSE).
  // The pipeline is entry-only — skip them here.
  const portfolioCoinSet = new Set(portfolioCoins)

  // Each coin runs its full pipeline sequentially; trade is proposed immediately after
  // analysis completes — not batched after all coins finish.
  for (const data of marketData) {
    if (portfolioCoinSet.has(data.symbol)) {
      logger.debug('Skipping pipeline for held coin — managed by monitor', { coin: data.symbol })
      continue
    }
    // A coin with a pending entry intent is already awaiting a deferred BUY on the
    // Entry Desk — skip its whole pipeline (no point spending research + LLM calls
    // to re-issue a signal the entry engine is already working). The late
    // checkActiveIntent gate in buyEvaluation stays as a backstop for SELL/manual paths.
    if (entry.hasActiveIntent(data.symbol)) {
      logger.debug('Skipping pipeline for coin with active entry intent — on the Entry Desk', { coin: data.symbol })
      continue
    }
    const cycleId = `${Date.now().toString(36)}-${(++cycleCounter).toString(36)}`
    // Re-fetch portfolio state so position counts reflect any trades already done this cycle
    const portfolioState = await getPortfolioState(marketData, settings)

    try {
      const { signal, marketCtx } = await analyzeCoin(data, portfolioState, cycleId)

      if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
        logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
        if (signal.action !== 'HOLD' && signal.confidence < settings.min_confidence) {
          logPipelineEvent('trade_skipped', data.symbol, cycleId, {
            reason: `Confidence ${Math.round(signal.confidence * 100)}% below threshold ${Math.round(settings.min_confidence * 100)}%`,
          })
        }
        continue
      }

      if (signal.action === 'BUY') {
        if (await handleBuySignal({ data, marketCtx, signal, portfolioState, settings, cycleId, checkActiveIntent: true })) {
          tradesInitiated++
        }
      } else if (signal.action === 'SELL') {
        const existing = await positionsRepo.findOne({ coin: data.symbol, status: 'OPEN' })
        if (existing) {
          const qty = existing.quantity as number
          const sellSignal: Signal = { ...signal, quantity: qty }
          const { outcome, error: tradeErr } = await handleTradeSignal(sellSignal, data.price)
          logPipelineEvent('trade_executed', data.symbol, cycleId, {
            action: 'SELL', price: data.price, quantity: qty,
            pending_approval: outcome === 'pending',
            error: outcome === 'failed' ? tradeErr : undefined,
          })
          if (outcome !== 'failed') tradesInitiated++
        } else {
          logger.debug('No open position to sell', { coin: data.symbol })
          logPipelineEvent('trade_skipped', data.symbol, cycleId, { reason: 'No open position to sell' })
        }
      }
    } catch (err) {
      const isCancelled = err instanceof PipelineCancelledError
      clearCancel(cycleId)
      const stage = isCancelled ? 'pipeline_cancelled' : 'pipeline_error'
      logPipelineEvent(stage, data.symbol, cycleId, {
        symbol: data.symbol, error: err instanceof Error ? err.message : String(err),
        price: data.price, change24h: data.change24h, volume: data.volume,
      } as Record<string, unknown>)
      if (!isCancelled) logger.error('Error in pipeline', { coin: data.symbol, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const snapshotEntries = await getOpenEntries()
  let snapshotTotal = 0
  const holdings: Record<string, number> = {}
  for (const snapEntry of snapshotEntries) {
    if (snapEntry.coin === 'USDC') {
      snapshotTotal += snapEntry.quantity
      holdings[snapEntry.coin] = snapEntry.quantity
    } else {
      const md = marketData.find(d => d.symbol === snapEntry.coin)
      if (md) {
        snapshotTotal += snapEntry.quantity * md.price
        holdings[snapEntry.coin] = snapEntry.quantity
      }
    }
  }

  await portfolioSnapshots.insert({
    total_value_usd: snapshotTotal, holdings: JSON.stringify(holdings), created_at: nowSql(),
  })

  if (tradesInitiated > 0) bus.emit('portfolio_updated')

  // #7: Notify frontend that the full cycle is done so it can refresh state
  const completedPayload = { total_value_usd: snapshotTotal, trades_initiated: tradesInitiated, holdings }
  bus.emit('pipeline_completed', completedPayload)
  broadcast('pipeline_completed', completedPayload)

  logger.info('Trading loop completed', { totalValue: snapshotTotal, tradesInitiated })
}

/** Run the entry pipeline for a single coin on demand (manual trigger). */
export async function runSingleCoinPipeline(symbol: string, cycleId: string): Promise<void> {
  logger.info('Manual pipeline started', { symbol, cycleId })

  const existingHolding = await portfolioEntries.findOne({ coin: symbol, status: 'OPEN' }, { projection: { id: 1 } })
  if (existingHolding) {
    logger.info('Skipping manual pipeline — coin already held in portfolio', { symbol })
    logPipelineEvent('trade_skipped', symbol, cycleId, { reason: 'Coin already held in portfolio — managed by monitor' })
    return
  }

  const settings = getSettings()

  const marketData = await fetchMarketData([symbol])
  const data = marketData[0]
  if (!data) {
    logPipelineEvent('pipeline_failed', symbol, cycleId, { error: 'Failed to fetch market data for ' + symbol })
    return
  }

  const portfolioState = await getPortfolioState(marketData, settings)

  try {
    const { signal, marketCtx } = await analyzeCoin(data, portfolioState, cycleId)
    logger.info('Manual pipeline analysis done', { symbol, action: signal.action, confidence: signal.confidence })

    if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
      if (signal.action !== 'HOLD' && signal.confidence < settings.min_confidence) {
        logPipelineEvent('trade_skipped', symbol, cycleId, {
          reason: `Confidence ${Math.round(signal.confidence * 100)}% below threshold ${Math.round(settings.min_confidence * 100)}%`,
        })
      }
      return
    }

    if (signal.action === 'BUY') {
      // checkActiveIntent: false — a manual relaunch is an explicit re-run and
      // should proceed even if an intent is already pending for this coin.
      if (await handleBuySignal({ data, marketCtx, signal, portfolioState, settings, cycleId, checkActiveIntent: false })) {
        bus.emit('portfolio_updated')
      }
    } else if (signal.action === 'SELL') {
      const existing = await positionsRepo.findOne({ coin: symbol, status: 'OPEN' })
      if (!existing) {
        logPipelineEvent('trade_skipped', symbol, cycleId, { reason: 'No open position to sell' })
        return
      }
      const qty = existing.quantity as number
      const { outcome, error: tradeErr } = await handleTradeSignal({ ...signal, quantity: qty }, data.price)
      logPipelineEvent('trade_executed', symbol, cycleId, {
        action: 'SELL', price: data.price, quantity: qty,
        pending_approval: outcome === 'pending',
        error: outcome === 'failed' ? tradeErr : undefined,
      })
      // Portfolio writes are handled inside submitTrade atomically.
      if (outcome !== 'failed') bus.emit('portfolio_updated')
    }
  } catch (err) {
    const isCancelled = err instanceof PipelineCancelledError
    clearCancel(cycleId)
    if (!isCancelled) {
      logPipelineEvent('pipeline_error', symbol, cycleId, {
        symbol, error: err instanceof Error ? err.message : String(err),
      })
      logger.error('Manual pipeline error', { symbol, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
