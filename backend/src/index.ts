import { initDB, queryAll, queryOne, runSQL, withTransaction, saveDB, getSettings, updateSetting, runLLMRetention } from './db/index.js'
import { config } from './config/index.js'
import { logger } from './core/logger.js'
import { bus } from './core/events.js'
import { startAPI } from './api/index.js'
import { startTelegramBot, sendApprovalMessage, startNotifier } from './telegram/index.js'
import { fetchMarketData, fetchBalance, executeTrade, getTopPairs } from './trader/index.js'
import * as priceCache from './market/index.js'
import cron, { ScheduledTask } from 'node-cron'
import { researchCoin } from './researcher/index.js'
import { extractResearch, selectArticles } from './extractor/index.js'
import { analyzeSignal } from './analyst/index.js'
import { getMarketContext, checkOpenPositions, getPortfolioState, addEntry, reduceEntryQuantity, increaseEntryQuantity, getOpenEntries, getCoinEntries, getUsdtEntry, seedUsdtIfAbsent, detectExternalWithdrawal, calculatePositionSize, calculateStopLoss, calculateTakeProfit, recordPositionOpen, recordPositionClose, recordSlTpUpdate, placeProtection, cancelProtection, replaceProtection, closePositionFromExit } from './portfolio/index.js'
import { Signal, ApprovalRequest, PipelineStage } from './types.js'
import { broadcast } from './api/ws.js'
import { closeBrowser } from './scraper/browser.js'
import { runDiscovery } from './discoverer/index.js'
import { runMonitor, clearReviewsForCoin } from './monitor/index.js'
import { isTradeable } from './core/tradeable.js'

interface PendingApproval { signal: Signal; estimatedPrice: number; atr?: number; settings?: ReturnType<typeof getSettings>; req: ApprovalRequest }
let pendingApprovals: Map<number, PendingApproval> = new Map()
let approvalTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

const PIPELINE_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour

const cancelledCycles = new Set<string>()

class PipelineCancelledError extends Error {
  constructor() { super('Pipeline cancelled'); this.name = 'PipelineCancelledError' }
}

function checkCancelled(cycleId: string): void {
  if (cancelledCycles.has(cycleId)) throw new PipelineCancelledError()
}

let cronTask: ScheduledTask | null = null
let discoveryCronTask: ScheduledTask | null = null
let monitorCronTask: ScheduledTask | null = null
let positionCheckInterval: ReturnType<typeof setInterval> | null = null
let cycleCounter = 0
let pipelineRunning = false

export function isPipelineRunning(): boolean { return pipelineRunning }
export function getPendingApprovals(): ApprovalRequest[] {
  return Array.from(pendingApprovals.values()).map(p => p.req)
}

const POSITION_CHECK_INTERVAL_MS = 30 * 1000 // every 30 seconds


function scheduleDiscovery(expression: string): void {
  discoveryCronTask?.stop()
  if (!cron.validate(expression)) {
    logger.error('Invalid discovery cron expression, falling back to daily', { expression })
    expression = '0 6 * * *'
  }
  discoveryCronTask = cron.schedule(expression, () => {
    const cycleId = `${Date.now().toString(36)}-discovery`
    runDiscovery(cycleId)
  })
  logger.info('Discovery pipeline scheduled', { cron: expression })
}

function scheduleMonitor(expression: string, enabled: boolean): void {
  monitorCronTask?.stop()
  monitorCronTask = null
  if (!enabled) {
    logger.info('Position monitor auto-run disabled')
    return
  }
  if (!cron.validate(expression)) {
    logger.error('Invalid monitor cron expression, falling back to 4-hourly', { expression })
    expression = '0 */4 * * *'
  }
  monitorCronTask = cron.schedule(expression, () => {
    const cycleId = `${Date.now().toString(36)}-monitor`
    runMonitor(cycleId).catch(err => {
      logger.error('Scheduled monitor run failed', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  logger.info('Position monitor scheduled', { cron: expression })
}

function schedulePipeline(expression: string): void {
  cronTask?.stop()
  if (!cron.validate(expression)) {
    logger.error('Invalid cron expression, falling back to hourly', { expression })
    expression = '0 * * * *'
  }
  cronTask = cron.schedule(expression, () => {
    runPipeline()
  })
  logger.info('Pipeline scheduled', { cron: expression })
}

function logPipelineEvent(
  stage: PipelineStage,
  coin: string,
  cycleId: string,
  data: Record<string, unknown>
): void {
  const payload = JSON.stringify(data)
  const { lastInsertRowid } = runSQL(
    'INSERT INTO pipeline_events (coin, cycle_id, stage, data) VALUES (?, ?, ?, ?)',
    [coin, cycleId, stage, payload]
  )
  broadcast('pipeline_event', {
    id: lastInsertRowid,
    coin,
    cycle_id: cycleId,
    stage,
    data: payload,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  })
}

async function runPipeline(): Promise<void> {
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

type MarketDataItem = { symbol: string; price: number; change24h: number; volume: number }
type CoinAnalysisResult = {
  data: MarketDataItem
  signal: Signal
  marketCtx: Awaited<ReturnType<typeof getMarketContext>>
  cycleId: string
}

async function analyzeCoin(
  data: MarketDataItem,
  portfolioState: ReturnType<typeof getPortfolioState>,
  cycleId: string,
): Promise<CoinAnalysisResult> {
  // Research and market context are independent — fetch in parallel
  logPipelineEvent('research_started', data.symbol, cycleId, { symbol: data.symbol })
  checkCancelled(cycleId)
  const [rawResearch, marketCtx] = await Promise.all([
    researchCoin(data.symbol),
    getMarketContext(data.symbol, data.price),
  ])
  logPipelineEvent('research_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    headlines: rawResearch.headlines,
    articles: rawResearch.articles,
    summary: rawResearch.summary,
  })

  checkCancelled(cycleId)
  logPipelineEvent('extraction_started', data.symbol, cycleId, { symbol: data.symbol, articleCount: rawResearch.articles.length })
  const extractedResearch = await extractResearch(rawResearch)
  logPipelineEvent('extraction_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    articles: extractedResearch.articles,
    skipped_articles: extractedResearch.skipped_articles,
    aggregated_sentiment: extractedResearch.aggregated_sentiment,
    top_headlines: extractedResearch.top_headlines,
  })

  checkCancelled(cycleId)
  logPipelineEvent('selection_started', data.symbol, cycleId, {
    symbol: data.symbol, articleCount: extractedResearch.articles.length,
  })
  const selectedArticles = await selectArticles(data.symbol, extractedResearch.articles)
  logPipelineEvent('selection_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    selectedCount: selectedArticles.length,
    totalCount: extractedResearch.articles.length,
    articles: selectedArticles,
  })

  checkCancelled(cycleId)
  const selectedResearch = { ...extractedResearch, articles: selectedArticles }
  logPipelineEvent('analysis_started', data.symbol, cycleId, {
    symbol: data.symbol, price: data.price, change24h: data.change24h, volume: data.volume,
    rsi14: marketCtx.rsi14, trend: marketCtx.trend, atr14: marketCtx.atr14,
    sma7: marketCtx.sma7, sma25: marketCtx.sma25, sma99: marketCtx.sma99,
    perf7d: marketCtx.perf7d, volatility: marketCtx.volatility,
  })

  const signal = await analyzeSignal(data.symbol, marketCtx, portfolioState, selectedResearch)

  logPipelineEvent('signal_generated', data.symbol, cycleId, {
    symbol: data.symbol, action: signal.action, reason: signal.reason, confidence: signal.confidence,
  })

  runSQL(
    'INSERT INTO decisions (coin, action, reason, confidence, context) VALUES (?, ?, ?, ?, ?)',
    [data.symbol, signal.action, signal.reason, signal.confidence, JSON.stringify({ price: data.price, selectedResearch })]
  )

  return { data, signal, marketCtx, cycleId }
}

async function tradingLoop() {
  logger.info('Trading loop started')

  const settings = getSettings()

  // Include coins currently held in the portfolio so the bot can SELL them even
  // if they were removed from the watchlist.
  const portfolioCoins = (getOpenEntries() as unknown as { coin: string }[])
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
  const usdtBalance = balance['USDC']?.total || 0
  if (config.stub) {
    seedUsdtIfAbsent(usdtBalance)
  } else {
    detectExternalWithdrawal(usdtBalance)
  }

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
    const cycleId = `${Date.now().toString(36)}-${(++cycleCounter).toString(36)}`
    // Re-fetch portfolio state so position counts reflect any trades already done this cycle
    const portfolioState = getPortfolioState(marketData, settings)

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
        if (portfolioState.openPositionCount >= portfolioState.maxOpenPositions) {
          logger.warn('Max open positions reached, skipping BUY', { coin: data.symbol, openPositions: portfolioState.openPositionCount })
          logPipelineEvent('trade_skipped', data.symbol, cycleId, { reason: 'Max open positions reached' })
          continue
        }

        const existingHolding = queryOne("SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [data.symbol])
        if (existingHolding) {
          logger.warn('Skipping BUY — coin already held in portfolio', { coin: data.symbol })
          logPipelineEvent('trade_skipped', data.symbol, cycleId, { reason: 'Coin already held in portfolio' })
          continue
        }

        const availableUsdc = getUsdtEntry()?.quantity ?? 0
        if (availableUsdc < settings.min_trade_usdc) {
          logger.warn('Skipping BUY — USDC below minimum threshold', { coin: data.symbol, availableUsdc, min: settings.min_trade_usdc })
          logPipelineEvent('trade_skipped', data.symbol, cycleId, {
            reason: `Insufficient USDC ($${availableUsdc.toFixed(2)} < minimum $${settings.min_trade_usdc})`,
          })
          continue
        }

        const qty = calculatePositionSize(data.price, marketCtx.atr14, signal.confidence, portfolioState.totalValueUsd, settings, availableUsdc)
        if (qty <= 0) {
          logger.warn('Skipping BUY — insufficient USDC or zero position size', { coin: data.symbol, availableUsdc })
          logPipelineEvent('trade_skipped', data.symbol, cycleId, {
            reason: `Insufficient USDC (available: $${availableUsdc.toFixed(2)})`,
          })
          continue
        }

        const sl = signal.stop_loss_pct != null
          ? data.price * (1 - signal.stop_loss_pct / 100)
          : calculateStopLoss(data.price, marketCtx.atr14, settings)
        const tp = signal.take_profit_pct != null
          ? data.price * (1 + signal.take_profit_pct / 100)
          : calculateTakeProfit(data.price, marketCtx.atr14, settings)
        const buySignal: Signal = { ...signal, quantity: qty }
        const { outcome, error: tradeErr } = await handleTradeSignal(buySignal, data.price, marketCtx.atr14, settings)
        logPipelineEvent('trade_executed', data.symbol, cycleId, {
          action: 'BUY', price: data.price, quantity: qty,
          stop_loss: sl, take_profit: tp,
          pending_approval: outcome === 'pending',
          sl_source: signal.stop_loss_pct != null ? 'rule' : 'atr',
          error: outcome === 'failed' ? tradeErr : undefined,
        })
        if (outcome !== 'failed') tradesInitiated++
      } else if (signal.action === 'SELL') {
        const existing = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [data.symbol])
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
      cancelledCycles.delete(cycleId)
      const stage = isCancelled ? 'pipeline_cancelled' : 'pipeline_error'
      logPipelineEvent(stage, data.symbol, cycleId, {
        symbol: data.symbol, error: err instanceof Error ? err.message : String(err),
        price: data.price, change24h: data.change24h, volume: data.volume,
      } as Record<string, unknown>)
      if (!isCancelled) logger.error('Error in pipeline', { coin: data.symbol, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const snapshotEntries = getOpenEntries()
  let snapshotTotal = 0
  const holdings: Record<string, number> = {}
  for (const entry of snapshotEntries) {
    if (entry.coin === 'USDC') {
      snapshotTotal += entry.quantity
      holdings[entry.coin] = entry.quantity
    } else {
      const md = marketData.find(d => d.symbol === entry.coin)
      if (md) {
        snapshotTotal += entry.quantity * md.price
        holdings[entry.coin] = entry.quantity
      }
    }
  }

  runSQL(
    'INSERT INTO portfolio_snapshots (total_value_usd, holdings) VALUES (?, ?)',
    [snapshotTotal, JSON.stringify(holdings)]
  )

  if (tradesInitiated > 0) bus.emit('portfolio_updated')

  // #7: Notify frontend that the full cycle is done so it can refresh state
  const completedPayload = { total_value_usd: snapshotTotal, trades_initiated: tradesInitiated, holdings }
  bus.emit('pipeline_completed', completedPayload)
  broadcast('pipeline_completed', completedPayload)

  logger.info('Trading loop completed', { totalValue: snapshotTotal, tradesInitiated })
}

async function runSingleCoinPipeline(symbol: string, cycleId: string): Promise<void> {
  logger.info('Manual pipeline started', { symbol, cycleId })

  const existingHolding = queryOne("SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [symbol])
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

  const balance = await fetchBalance()
  const usdtBalance = balance['USDC']?.total || 0
  if (config.stub) seedUsdtIfAbsent(usdtBalance)

  const portfolioState = getPortfolioState(marketData, settings)

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
      if (portfolioState.openPositionCount >= portfolioState.maxOpenPositions) {
        logPipelineEvent('trade_skipped', symbol, cycleId, { reason: 'Max open positions reached' })
        return
      }

      const existingHolding = queryOne("SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [symbol])
      if (existingHolding) {
        logger.warn('Skipping BUY — coin already held in portfolio', { coin: symbol })
        logPipelineEvent('trade_skipped', symbol, cycleId, { reason: 'Coin already held in portfolio' })
        return
      }

      const availableUsdc = getUsdtEntry()?.quantity ?? 0
      if (availableUsdc < settings.min_trade_usdc) {
        logger.warn('Skipping BUY — USDC below minimum threshold', { coin: symbol, availableUsdc, min: settings.min_trade_usdc })
        logPipelineEvent('trade_skipped', symbol, cycleId, {
          reason: `Insufficient USDC ($${availableUsdc.toFixed(2)} < minimum $${settings.min_trade_usdc})`,
        })
        return
      }

      const qty = calculatePositionSize(data.price, marketCtx.atr14, signal.confidence, portfolioState.totalValueUsd, settings, availableUsdc)
      if (qty <= 0) {
        logPipelineEvent('trade_skipped', symbol, cycleId, {
          reason: `Insufficient USDC (available: $${availableUsdc.toFixed(2)})`,
        })
        return
      }
      const sl = signal.stop_loss_pct != null
        ? data.price * (1 - signal.stop_loss_pct / 100)
        : calculateStopLoss(data.price, marketCtx.atr14, settings)
      const tp = signal.take_profit_pct != null
        ? data.price * (1 + signal.take_profit_pct / 100)
        : calculateTakeProfit(data.price, marketCtx.atr14, settings)
      const { outcome, error: tradeErr } = await handleTradeSignal({ ...signal, quantity: qty }, data.price, marketCtx.atr14, settings)
      logPipelineEvent('trade_executed', symbol, cycleId, {
        action: 'BUY', price: data.price, quantity: qty,
        stop_loss: sl, take_profit: tp,
        pending_approval: outcome === 'pending',
        sl_source: signal.stop_loss_pct != null ? 'llm' : 'atr',
        error: outcome === 'failed' ? tradeErr : undefined,
      })
      if (outcome !== 'failed') bus.emit('portfolio_updated')
    } else if (signal.action === 'SELL') {
      const existing = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [symbol])
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
    cancelledCycles.delete(cycleId)
    if (!isCancelled) {
      logPipelineEvent('pipeline_error', symbol, cycleId, {
        symbol, error: err instanceof Error ? err.message : String(err),
      })
      logger.error('Manual pipeline error', { symbol, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function handleTradeSignal(signal: Signal, price: number, atr?: number, settings?: any): Promise<{ outcome: 'ok' | 'pending' | 'failed'; error?: string }> {
  if (signal.action === 'HOLD') return { outcome: 'ok' }

  const s = getSettings()

  if (s.approval_required || config.approvalsEnabled) {
    const total = price * signal.quantity
    const info = runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
      [signal.coin, signal.action, signal.quantity, price, total]
    )

    const tradeId = info.lastInsertRowid
    const req: ApprovalRequest = {
      tradeId,
      coin: signal.coin,
      side: signal.action,
      quantity: signal.quantity,
      estimatedPrice: price,
      reason: signal.reason,
      confidence: signal.confidence,
      expiresAt: new Date(Date.now() + config.approvalTimeoutMs).toISOString(),
    }

    pendingApprovals.set(tradeId, { signal, estimatedPrice: price, atr, settings: s, req })
    bus.emit('approval_requested', req)
    broadcast('approval_requested', req)
    sendApprovalMessage(req)

    const timer = setTimeout(() => {
      bus.emit('trade_rejected', tradeId)
      pendingApprovals.delete(tradeId)
      approvalTimers.delete(tradeId)
    }, config.approvalTimeoutMs)
    approvalTimers.set(tradeId, timer)
    return { outcome: 'pending' }
  } else {
    const result = await submitTrade(signal, price, undefined, atr, s)
    return result.ok ? { outcome: 'ok' } : { outcome: 'failed', error: result.error }
  }
}

async function submitTrade(signal: Signal, estimatedPrice: number, tradeId?: number, atr?: number, settings?: any): Promise<{ ok: boolean; error?: string }> {
  try {
    // Cancel exchange-side OCO before our own market sell — the coins are locked
    // in the open OCO and Binance would otherwise reject the sell.
    if (signal.action === 'SELL') {
      const openPos = queryOne("SELECT id FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
      if (openPos) await cancelProtection(openPos.id as number)
    }

    // Exchange API call — must happen OUTSIDE the transaction (async)
    const result = await executeTrade(signal)

    // Capture data needed post-transaction (OCO placement needs the new position ID)
    let newPositionId: number | undefined

    // Atomic DB writes: trade record + position + portfolio entries
    withTransaction(() => {
      if (tradeId) {
        runSQL(
          "UPDATE trades SET price = ?, total = ?, fee_cost = ?, fee_currency = ?, status = 'EXECUTED', approved = 1 WHERE id = ?",
          [result.price, result.cost, result.fee_cost, result.fee_currency, tradeId]
        )
      } else {
        runSQL(
          "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?, 'EXECUTED', 1)",
          [signal.coin, signal.action, result.quantity, result.price, result.cost, result.fee_cost, result.fee_currency]
        )
      }

      if (signal.action === 'BUY' && atr && settings) {
        const sl = calculateStopLoss(result.price, atr, settings)
        const tp = calculateTakeProfit(result.price, atr, settings)
        const existing = queryOne("SELECT id FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
        if (!existing) {
          const { lastInsertRowid } = runSQL(
            'INSERT INTO positions (coin, side, quantity, entry_price, stop_loss, take_profit, current_sl, horizon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [signal.coin, 'BUY', result.quantity, result.price, sl, tp, sl, signal.horizon ?? 'medium']
          )
          newPositionId = Number(lastInsertRowid)
          recordPositionOpen(newPositionId, signal.coin, sl, tp ?? null, result.price)
        }
        const costBasis = result.quantity > 0 ? result.cost / result.quantity : result.price
        addEntry(signal.coin, result.quantity, costBasis, new Date().toISOString().split('T')[0], 'trade', tradeId)
        const usdtEntry = getUsdtEntry()
        if (usdtEntry) reduceEntryQuantity(usdtEntry.id, result.cost)

      } else if (signal.action === 'SELL') {
        // Consolidate all SELL portfolio writes here so callers don't need to
        // duplicate them — and so they're in the same atomic transaction.
        const existingPos = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
        if (existingPos) {
          const posId = existingPos.id as number
          const qty = result.quantity || (existingPos.quantity as number)
          recordPositionClose(posId, result.price)
          runSQL(
            "UPDATE positions SET status = 'CLOSED', pnl = (? * (? - entry_price)) WHERE id = ?",
            [qty, result.price, posId]
          )
          const sellEntries = queryAll(
            "SELECT id, quantity FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC",
            [signal.coin]
          ) as { id: number; quantity: number }[]
          for (const entry of sellEntries) reduceEntryQuantity(entry.id, qty)
          const usdtEntry = getUsdtEntry()
          if (usdtEntry) increaseEntryQuantity(usdtEntry.id, qty * result.price)
        }
      }
    })

    // Post-transaction: broadcasts and async exchange operations
    clearReviewsForCoin(signal.coin)
    const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    bus.emit('trade_executed', trade as any)
    broadcast('trade_executed', trade)

    if (newPositionId !== undefined) {
      logger.info('Position opened', { coin: signal.coin, price: result.price })
      await placeProtection(newPositionId)
      const openedPos = queryOne("SELECT * FROM positions WHERE id = ?", [newPositionId]) as import('./types.js').PositionRecord | null
      if (openedPos) bus.emit('position_opened', openedPos)
    }

    logger.info('Trade executed', { coin: signal.coin, action: signal.action, price: result.price })
    return { ok: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('Trade failed', { coin: signal.coin, error: errMsg })
    let failedId = tradeId
    if (tradeId) {
      runSQL("UPDATE trades SET status = 'FAILED', error = ? WHERE id = ? AND status = 'PENDING'", [errMsg, tradeId])
    } else {
      runSQL(
        "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved, error) VALUES (?, ?, ?, ?, ?, 0, 'USDC', 'FAILED', 1, ?)",
        [signal.coin, signal.action, signal.quantity, estimatedPrice, estimatedPrice * signal.quantity, errMsg]
      )
      failedId = (queryOne('SELECT last_insert_rowid() AS id') as any)?.id
    }
    const failedTrade = failedId
      ? queryOne('SELECT * FROM trades WHERE id = ?', [failedId])
      : null
    broadcast('trade_failed', failedTrade)
    bus.emit('trade_failed', { coin: signal.coin, side: signal.action, error: errMsg })
    return { ok: false, error: errMsg }
  }
}

bus.on('trade_approved', async (tradeId: number) => {
  logger.info('Trade approval received, executing', { tradeId })
  const pending = pendingApprovals.get(tradeId)
  if (!pending) {
    // In-memory state is gone (e.g. server restarted) — mark FAILED so the DB doesn't stay PENDING
    logger.error('Trade approval failed: in-memory state not found', { tradeId })
    runSQL("UPDATE trades SET status = 'FAILED', error = 'Approval state lost (server restart)' WHERE id = ? AND status = 'PENDING'", [tradeId])
    broadcast('trade_failed', { tradeId, error: 'Approval state lost after server restart' })
    return
  }

  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)

  const result = await submitTrade(pending.signal, pending.estimatedPrice, tradeId, pending.atr, pending.settings)
  logger.info('Trade execution result', { tradeId, success: result.ok, error: result.error })
  bus.emit('trade_result', { tradeId, success: result.ok, error: result.error })
})

bus.on('trade_rejected', (tradeId: number) => {
  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)

  runSQL("UPDATE trades SET approved = 0, status = 'FAILED' WHERE id = ? AND status = 'PENDING'", [tradeId])
  broadcast('trade_rejected', tradeId)
  logger.info('Trade rejected by user', { tradeId })
})

// ── Position SL/TP adjustments (from the Position Monitor) ───────────────────
const adjustmentTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

async function applyAdjustment(adjId: number): Promise<void> {
  const adj = queryOne("SELECT * FROM position_adjustments WHERE id = ? AND status = 'PENDING'", [adjId]) as
    | { id: number; position_id: number; coin: string; new_stop_loss: number | null; new_take_profit: number | null }
    | null
  if (!adj) return

  const pos = queryOne("SELECT id, stop_loss, take_profit FROM positions WHERE id = ? AND status = 'OPEN'", [adj.position_id]) as
    | { id: number; stop_loss: number; take_profit: number | null }
    | null
  if (!pos) {
    runSQL("UPDATE position_adjustments SET status = 'REJECTED' WHERE id = ?", [adjId])
    broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'REJECTED', reason: 'Position no longer open' })
    return
  }

  const newSl = adj.new_stop_loss != null ? adj.new_stop_loss : pos.stop_loss
  const newTp = adj.new_take_profit != null ? adj.new_take_profit : pos.take_profit
  const price = priceCache.getPrice(adj.coin)?.price ?? null

  // stop_loss drives the SL-hit check; keep current_sl in sync.
  runSQL("UPDATE positions SET stop_loss = ?, current_sl = ?, take_profit = ? WHERE id = ?", [newSl, newSl, newTp, adj.position_id])
  recordSlTpUpdate(adj.position_id, adj.coin, newSl, newTp, price)
  runSQL("UPDATE position_adjustments SET status = 'APPLIED' WHERE id = ?", [adjId])

  // Push the new levels to the exchange-side OCO (cancel + replace).
  await replaceProtection(adj.position_id)

  logger.info('Position SL/TP adjusted', { coin: adj.coin, positionId: adj.position_id, stop_loss: newSl, take_profit: newTp })
  broadcast('position_adjusted', { coin: adj.coin, positionId: adj.position_id, old_stop_loss: pos.stop_loss, old_take_profit: pos.take_profit, stop_loss: newSl, take_profit: newTp })
  broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'APPLIED' })
  bus.emit('portfolio_updated')
  const adjPos = queryOne("SELECT entry_price FROM positions WHERE id = ?", [adj.position_id]) as { entry_price: number } | null
  bus.emit('sl_tp_adjusted', {
    coin: adj.coin,
    positionId: adj.position_id,
    oldStopLoss: pos.stop_loss,
    oldTakeProfit: pos.take_profit,
    newStopLoss: newSl,
    newTakeProfit: newTp,
    currentPrice: price,
    entryPrice: adjPos?.entry_price ?? null,
  })
}

bus.on('position_adjustment_proposed', (p) => {
  // Position must still be open.
  const open = queryOne("SELECT id FROM positions WHERE id = ? AND status = 'OPEN'", [p.positionId])
  if (!open) return

  const { lastInsertRowid } = runSQL(
    `INSERT INTO position_adjustments
      (position_id, coin, old_stop_loss, old_take_profit, new_stop_loss, new_take_profit, reasoning, confidence, status, cycle_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    [p.positionId, p.coin, p.oldStopLoss, p.oldTakeProfit, p.newStopLoss, p.newTakeProfit, p.reasoning, p.confidence, p.cycleId]
  )
  const adjId = Number(lastInsertRowid)

  const s = getSettings()
  if (!s.monitor_auto_approve && (s.approval_required || config.approvalsEnabled)) {
    const req = {
      adjustmentId: adjId,
      coin: p.coin,
      oldStopLoss: p.oldStopLoss,
      oldTakeProfit: p.oldTakeProfit,
      newStopLoss: p.newStopLoss,
      newTakeProfit: p.newTakeProfit,
      reasoning: p.reasoning,
      confidence: p.confidence,
      expiresAt: new Date(Date.now() + config.approvalTimeoutMs).toISOString(),
    }
    broadcast('adjustment_requested', req)
    logger.info('SL/TP adjustment awaiting approval', { adjId, coin: p.coin })

    const timer = setTimeout(() => {
      runSQL("UPDATE position_adjustments SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'", [adjId])
      adjustmentTimers.delete(adjId)
      broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'EXPIRED' })
    }, config.approvalTimeoutMs)
    adjustmentTimers.set(adjId, timer)
  } else {
    applyAdjustment(adjId).catch(err => logger.error('Failed to apply SL/TP adjustment', { adjId, error: err instanceof Error ? err.message : String(err) }))
  }
})

bus.on('adjustment_approved', (adjId: number) => {
  const timer = adjustmentTimers.get(adjId)
  if (timer) clearTimeout(timer)
  adjustmentTimers.delete(adjId)
  applyAdjustment(adjId).catch(err => logger.error('Failed to apply SL/TP adjustment', { adjId, error: err instanceof Error ? err.message : String(err) }))
})

bus.on('adjustment_rejected', (adjId: number) => {
  const timer = adjustmentTimers.get(adjId)
  if (timer) clearTimeout(timer)
  adjustmentTimers.delete(adjId)
  runSQL("UPDATE position_adjustments SET status = 'REJECTED' WHERE id = ? AND status = 'PENDING'", [adjId])
  broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'REJECTED' })
  logger.info('SL/TP adjustment rejected by user', { adjId })
})

// Monitor-initiated CLOSE: move SL to current price so the OCO stop leg
// triggers immediately on Binance (avoids the cancel-then-market-sell path
// that fails when coins are locked in a partially-cancelled OCO).
async function executeMonitorClose(
  positionId: number,
  coin: string,
  triggerPrice: number,
  reasoning: string,
): Promise<void> {
  try {
    const pos = queryOne(
      "SELECT quantity, oco_status, take_profit FROM positions WHERE id = ? AND status = 'OPEN'",
      [positionId],
    ) as { quantity: number; oco_status: string; take_profit: number | null } | null
    if (!pos) return

    const qty = pos.quantity

    // If an active OCO is in place, move its SL to the current price rather than
    // cancelling it and issuing a market sell. The stop-limit triggers immediately,
    // and the reconciler closes the ledger entry once the fill is detected.
    if (pos.oco_status === 'ACTIVE' && pos.take_profit != null && pos.take_profit > triggerPrice) {
      runSQL(
        'UPDATE positions SET stop_loss = ?, current_sl = ? WHERE id = ?',
        [triggerPrice, triggerPrice, positionId],
      )
      await replaceProtection(positionId)

      const refreshed = queryOne(
        "SELECT oco_status FROM positions WHERE id = ? AND status = 'OPEN'",
        [positionId],
      ) as { oco_status: string } | null

      if (refreshed?.oco_status === 'ACTIVE') {
        logger.warn('Monitor CLOSE: SL moved to current price, awaiting OCO fill', { coin, positionId, price: triggerPrice })
        broadcast('monitor_position_closing', { coin, positionId, price: triggerPrice, reasoning })
        return
      }
      // OCO replacement failed (e.g. Binance rejected stop at current price after
      // the cancel succeeded) — fall through to market sell. The coins are now
      // unlocked because the cancel step did complete.
    }

    // No active OCO or OCO replacement failed: cancel any remnants and market-sell.
    await cancelProtection(positionId)
    const result = await executeTrade({ coin, action: 'SELL', quantity: qty, reason: `Monitor close: ${reasoning}`, confidence: 1 })
    closePositionFromExit({
      positionId,
      coin,
      status: 'CLOSED',
      fillPrice: result.price || triggerPrice,
      fillQty: result.quantity || qty,
      reason: `Monitor close: ${reasoning}`,
    })
    broadcast('monitor_position_closed', { coin, positionId, price: result.price || triggerPrice, reasoning })
    logger.warn('Monitor CLOSE executed', { coin, positionId, price: result.price || triggerPrice })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('Monitor close failed', { coin, error: errMsg })
    runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved, error) VALUES (?, 'SELL', 0, 0, 0, 0, 'USDC', 'FAILED', 1, ?)",
      [coin, errMsg]
    )
    const failedTrade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    broadcast('trade_failed', failedTrade)
    bus.emit('trade_failed', { coin, side: 'SELL', error: errMsg })
  }
}

bus.on('monitor_close_requested', ({ positionId, coin, currentPrice, reasoning }) => {
  logger.warn('Monitor CLOSE requested', { coin, positionId, currentPrice })
  executeMonitorClose(positionId, coin, currentPrice, reasoning).catch(err =>
    logger.error('Monitor close handler error', { coin, error: err instanceof Error ? err.message : String(err) })
  )
})

// Software-fallback exits. These fire only from the reconciler when a position
// has NO live exchange-side OCO (placement failed / unsupported). The bot issues
// the market sell itself, then closePositionFromExit handles the bookkeeping.
// When an OCO is active, Binance executes the exit and the reconciler detects the
// fill directly — these handlers do not run.
async function executeFallbackExit(
  positionId: number,
  coin: string,
  triggerPrice: number,
  status: 'SL_HIT' | 'TP_HIT',
  label: string,
): Promise<void> {
  try {
    const pos = queryOne("SELECT quantity FROM positions WHERE id = ? AND status = 'OPEN'", [positionId])
    if (!pos) return
    const qty = pos.quantity as number
    const result = await executeTrade({ coin, action: 'SELL', quantity: qty, reason: label, confidence: 1 })
    closePositionFromExit({
      positionId,
      coin,
      status,
      fillPrice: result.price || triggerPrice,
      fillQty: result.quantity || qty,
      reason: `${label} (software fallback)`,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error(`Failed to execute ${label.toLowerCase()}`, { coin, error: errMsg })
    runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved, error) VALUES (?, 'SELL', 0, 0, 0, 0, 'USDC', 'FAILED', 1, ?)",
      [coin, errMsg]
    )
    const failedId = (queryOne('SELECT last_insert_rowid() AS id') as any)?.id
    broadcast('trade_failed', failedId ? queryOne('SELECT * FROM trades WHERE id = ?', [failedId]) : null)
    bus.emit('trade_failed', { coin, side: 'SELL', error: errMsg })
  }
}

bus.on('stop_loss_hit', ({ positionId, coin, price }: { positionId: number; coin: string; price: number }) => {
  logger.warn('Stop loss triggered (software fallback)', { coin, positionId, price })
  executeFallbackExit(positionId, coin, price, 'SL_HIT', 'Stop loss')
})

bus.on('take_profit_hit', ({ positionId, coin, price }: { positionId: number; coin: string; price: number }) => {
  logger.info('Take profit triggered (software fallback)', { coin, positionId, price })
  executeFallbackExit(positionId, coin, price, 'TP_HIT', 'Take profit')
})

let server: ReturnType<typeof startAPI> | undefined

async function start() {
  logger.info('Starting CryptoBot...')
  await initDB()

  // Orphaned PENDING trades can't be executed after a restart (signal state is lost)
  const orphaned = runSQL("UPDATE trades SET status = 'FAILED' WHERE status = 'PENDING'")
  if (orphaned.changes > 0) {
    logger.warn('Marked orphaned PENDING trades as FAILED on startup', { count: orphaned.changes })
  }

  // Cancel any pipeline cycles that never reached a terminal stage (process was killed mid-run)
  const TERMINAL_STAGES = ['signal_generated', 'trade_executed', 'trade_skipped', 'pipeline_error', 'pipeline_timeout', 'pipeline_failed', 'pipeline_cancelled']
  const terminalPlaceholders = TERMINAL_STAGES.map(() => '?').join(', ')
  const openCycles = queryAll(
    `SELECT DISTINCT cycle_id, coin FROM pipeline_events
     WHERE cycle_id NOT IN (
       SELECT DISTINCT cycle_id FROM pipeline_events WHERE stage IN (${terminalPlaceholders})
     )`,
    TERMINAL_STAGES
  ) as { cycle_id: string; coin: string }[]

  if (openCycles.length > 0) {
    const seen = new Set<string>()
    for (const { cycle_id, coin } of openCycles) {
      if (seen.has(cycle_id)) continue
      seen.add(cycle_id)
      logPipelineEvent('pipeline_cancelled', coin, cycle_id, { error: 'Server restarted' })
    }
    logger.warn('Cancelled orphaned pipeline cycles on startup', { count: seen.size })
  }

  // Env var seeds the DB setting on every startup so .env stays authoritative
  if (config.pipelineCron) {
    updateSetting('pipeline_cron', config.pipelineCron)
  }

  server = startAPI()
  startTelegramBot()
  startNotifier()

  // Start price cache and subscribe to known coins
  priceCache.start()
  let settings = getSettings()

  // Seed watchlist with top 3 pairs if never configured by the user
  if (settings.watchlist.length === 0) {
    try {
      const top3 = (await getTopPairs(3)).filter(isTradeable)
      if (top3.length > 0) {
        updateSetting('watchlist', JSON.stringify(top3))
        settings = getSettings()
        logger.info('Watchlist seeded from top Binance pairs', { pairs: top3 })
      }
    } catch (err) {
      logger.warn('Could not seed watchlist on startup', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const initialCoins = [
    ...settings.watchlist,
    ...(getOpenEntries() as unknown as { coin: string }[]).filter(e => e.coin !== 'USDC').map(e => e.coin),
  ]
  if (initialCoins.length > 0) priceCache.subscribe([...new Set(initialCoins)])

  schedulePipeline(settings.pipeline_cron)
  scheduleDiscovery(settings.discover_cron)
  scheduleMonitor(settings.monitor_cron, settings.monitor_auto_run)

  // Run LLM retention on startup and then daily at 03:00 UTC
  try { runLLMRetention() } catch (err) {
    logger.warn('LLM retention on startup failed', { error: err instanceof Error ? err.message : String(err) })
  }
  cron.schedule('0 3 * * *', () => {
    try { runLLMRetention() } catch (err) {
      logger.warn('LLM retention failed', { error: err instanceof Error ? err.message : String(err) })
    }
  })

  positionCheckInterval = setInterval(async () => {
    try { await checkOpenPositions() } catch (err) {
      logger.warn('Position check failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }, POSITION_CHECK_INTERVAL_MS)

  // One-shot reconcile on boot: attaches to existing OCOs and re-protects any
  // open position lacking one (e.g. positions opened before exchange-side OCO).
  checkOpenPositions().catch(err =>
    logger.warn('Startup position reconcile failed', { error: err instanceof Error ? err.message : String(err) })
  )

  logger.info(`CryptoBot running. Pipeline cron: ${settings.pipeline_cron}`)
}

// Reschedule when the frontend saves new settings
bus.on('settings_updated', (updated) => {
  if (updated.pipeline_cron) schedulePipeline(updated.pipeline_cron)
  if (updated.discover_cron) scheduleDiscovery(updated.discover_cron)
  scheduleMonitor(updated.monitor_cron, updated.monitor_auto_run)
})

bus.on('pipeline_cancel_requested', ({ cycle_id }: { cycle_id: string }) => {
  cancelledCycles.add(cycle_id)
  logger.info('Pipeline cancellation requested', { cycle_id })
})

bus.on('trade_signal_simulated', async ({ symbol, action, confidence, reason, cycle_id }) => {
  logger.info('Simulated signal received', { symbol, action, confidence, cycle_id })
  try {
    const settings = getSettings()
    const marketData = await fetchMarketData([symbol])
    const data = marketData[0]
    if (!data) {
      logPipelineEvent('pipeline_failed', symbol, cycle_id, { error: 'Failed to fetch market data' })
      return
    }

    logPipelineEvent('signal_generated', symbol, cycle_id, {
      symbol, action, confidence, reason,
    })

    const signal: Signal = { coin: symbol, action, confidence, reason, quantity: 0 }

    if (action === 'BUY') {
      const portfolioState = getPortfolioState(marketData, settings)
      if (portfolioState.openPositionCount >= portfolioState.maxOpenPositions) {
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: 'Max open positions reached' })
        return
      }

      const existingHolding = queryOne("SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [symbol])
      if (existingHolding) {
        logger.warn('Skipping BUY — coin already held in portfolio', { coin: symbol })
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: 'Coin already held in portfolio' })
        return
      }

      const availableUsdc = getUsdtEntry()?.quantity ?? 0
      if (availableUsdc < settings.min_trade_usdc) {
        logger.warn('Skipping BUY — USDC below minimum threshold', { coin: symbol, availableUsdc, min: settings.min_trade_usdc })
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: `Insufficient USDC ($${availableUsdc.toFixed(2)} < minimum $${settings.min_trade_usdc})` })
        return
      }

      const marketCtx = await getMarketContext(symbol, data.price)
      const qty = calculatePositionSize(data.price, marketCtx.atr14, confidence, portfolioState.totalValueUsd, settings, availableUsdc)
      if (qty <= 0) {
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: `Insufficient USDC (available: $${availableUsdc.toFixed(2)})` })
        return
      }
      const sl = calculateStopLoss(data.price, marketCtx.atr14, settings)
      const tp = calculateTakeProfit(data.price, marketCtx.atr14, settings)
      const { outcome, error: tradeErr } = await handleTradeSignal({ ...signal, quantity: qty }, data.price, marketCtx.atr14, settings)
      logPipelineEvent('trade_executed', symbol, cycle_id, {
        action: 'BUY', price: data.price, quantity: qty, stop_loss: sl, take_profit: tp,
        pending_approval: outcome === 'pending',
        error: outcome === 'failed' ? tradeErr : undefined,
      })
    } else {
      const existing = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [symbol])
      if (!existing) {
        logPipelineEvent('trade_skipped', symbol, cycle_id, { reason: 'No open position to sell' })
        return
      }
      const qty = existing.quantity as number
      const { outcome, error: tradeErr } = await handleTradeSignal({ ...signal, quantity: qty }, data.price)
      logPipelineEvent('trade_executed', symbol, cycle_id, {
        action: 'SELL', price: data.price, quantity: qty,
        pending_approval: outcome === 'pending',
        error: outcome === 'failed' ? tradeErr : undefined,
      })
      // Portfolio writes are handled inside submitTrade atomically.
    }
  } catch (err) {
    logger.error('Simulated signal failed', { symbol, error: err instanceof Error ? err.message : String(err) })
    logPipelineEvent('pipeline_failed', symbol, cycle_id, { error: err instanceof Error ? err.message : String(err) })
  }
})

bus.on('pipeline_run_all_requested', () => {
  runPipeline().catch(err => {
    logger.error('Manual full pipeline run failed', { error: err instanceof Error ? err.message : String(err) })
  })
})

bus.on('discovery_run_requested', ({ cycle_id }) => {
  runDiscovery(cycle_id).catch(err => {
    logger.error('Discovery run failed', { error: err instanceof Error ? err.message : String(err) })
  })
})

bus.on('monitor_run_requested', ({ cycle_id }) => {
  runMonitor(cycle_id).catch(err => {
    logger.error('Monitor run failed', { error: err instanceof Error ? err.message : String(err) })
  })
})

bus.on('pipeline_run_requested', ({ symbol, cycle_id }) => {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Pipeline timed out after 1 hour')), PIPELINE_TIMEOUT_MS)
  )
  Promise.race([runSingleCoinPipeline(symbol, cycle_id), timeout]).catch(err => {
    const isTimeout = err instanceof Error && err.message.startsWith('Pipeline timed out')
    const stage = isTimeout ? 'pipeline_timeout' : 'pipeline_failed'
    logPipelineEvent(stage, symbol, cycle_id, { error: err instanceof Error ? err.message : String(err) })
    logger.error(isTimeout ? 'Manual pipeline timed out' : 'Manual pipeline failed', { symbol, error: String(err) })
  })
})

async function shutdown(signal: string) {
  logger.info(`Shutting down (${signal})`)
  cronTask?.stop()
  discoveryCronTask?.stop()
  monitorCronTask?.stop()
  if (positionCheckInterval) clearInterval(positionCheckInterval)
  priceCache.stop()
  try { await closeBrowser() } catch {}
  saveDB()
  if (server) server.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
