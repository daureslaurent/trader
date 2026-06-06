import { initDB, queryAll, queryOne, runSQL, saveDB, getSettings, updateSetting } from './db/index.js'
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
import { getMarketContext, checkOpenPositions, getPortfolioState, addEntry, closeEntry, reduceEntryQuantity, increaseEntryQuantity, getOpenEntries, getCoinEntries, getUsdtEntry, seedUsdtIfAbsent, detectExternalWithdrawal, calculatePositionSize, calculateStopLoss, calculateTakeProfit, calculateBreakEven } from './portfolio/index.js'
import { Signal, ApprovalRequest, PipelineStage } from './types.js'
import { broadcast } from './api/ws.js'
import { closeBrowser } from './scraper/browser.js'
import { runDiscovery } from './discoverer/index.js'

let pendingApprovals: Map<number, Signal> = new Map()
let approvalTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

const PIPELINE_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour

let cronTask: ScheduledTask | null = null
let discoveryCronTask: ScheduledTask | null = null
let cycleCounter = 0

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
  }
}

type MarketDataItem = { symbol: string; price: number; change24h: number; volume: number }
type CoinAnalysisResult = {
  data: MarketDataItem
  signal: Signal
  marketCtx: Awaited<ReturnType<typeof getMarketContext>>
}

async function analyzeCoin(
  data: MarketDataItem,
  portfolioState: ReturnType<typeof getPortfolioState>,
  cycleId: string,
): Promise<CoinAnalysisResult> {
  // Research and market context are independent — fetch in parallel
  logPipelineEvent('research_started', data.symbol, cycleId, { symbol: data.symbol })
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

  logPipelineEvent('extraction_started', data.symbol, cycleId, { symbol: data.symbol, articleCount: rawResearch.articles.length })
  const extractedResearch = await extractResearch(rawResearch)
  logPipelineEvent('extraction_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    articles: extractedResearch.articles,
    aggregated_sentiment: extractedResearch.aggregated_sentiment,
    top_headlines: extractedResearch.top_headlines,
  })

  logPipelineEvent('selection_started', data.symbol, cycleId, {
    symbol: data.symbol, articleCount: extractedResearch.articles.length,
  })
  const selectedArticles = await selectArticles(data.symbol, extractedResearch.articles)
  const selectedResearch = { ...extractedResearch, articles: selectedArticles }
  logPipelineEvent('selection_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    selectedCount: selectedArticles.length,
    totalCount: extractedResearch.articles.length,
    articles: selectedArticles,
  })

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

  return { data, signal, marketCtx }
}

async function tradingLoop() {
  logger.info('Trading loop started')

  const settings = getSettings()
  const symbols = [...settings.watchlist]

  if (symbols.length === 0) {
    const topPairs = await getTopPairs(3)
    symbols.push(...topPairs)
  }

  const marketData = await fetchMarketData(symbols)
  const balance = await fetchBalance()
  const usdtBalance = balance['USDC']?.total || 0
  if (config.stub) {
    seedUsdtIfAbsent(usdtBalance)
  } else {
    detectExternalWithdrawal(usdtBalance)
  }

  await checkOpenPositions()

  const portfolioState = getPortfolioState(marketData, settings)

  // Phase 1: research + extraction + selection + analysis — parallel across all coins
  const analysisResults = await Promise.allSettled(
    marketData.map(async (data): Promise<CoinAnalysisResult> => {
      const cycleId = `${Date.now().toString(36)}-${(++cycleCounter).toString(36)}`
      try {
        return await analyzeCoin(data, portfolioState, cycleId)
      } catch (err) {
        logPipelineEvent('pipeline_error', data.symbol, cycleId, {
          symbol: data.symbol, error: err instanceof Error ? err.message : String(err),
          price: data.price, change24h: data.change24h, volume: data.volume,
        } as Record<string, unknown>)
        logger.error('Error in pipeline', { coin: data.symbol, error: err instanceof Error ? err.message : String(err) })
        throw err
      }
    })
  )

  // Phase 2: trade execution is sequential — preserves position count checks and ledger integrity
  let tradesInitiated = 0

  for (const result of analysisResults) {
    if (result.status === 'rejected') continue
    const { data, signal, marketCtx } = result.value

    if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
      logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
      continue
    }

    try {
      if (signal.action === 'BUY') {
        if (portfolioState.openPositionCount >= portfolioState.maxOpenPositions) {
          logger.warn('Max open positions reached, skipping BUY', { coin: data.symbol, openPositions: portfolioState.openPositionCount })
          continue
        }

        const qty = calculatePositionSize(data.price, marketCtx.atr14, signal.confidence, portfolioState.totalValueUsd, settings)
        if (qty <= 0) continue

        const buySignal: Signal = { ...signal, quantity: qty }
        await handleTradeSignal(buySignal, data.price, marketCtx.atr14, settings)
        tradesInitiated++
      } else if (signal.action === 'SELL') {
        const existing = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [data.symbol])
        if (existing) {
          const sellSignal: Signal = { ...signal, quantity: (existing.quantity as number) }
          await handleTradeSignal(sellSignal, data.price)
          tradesInitiated++
          runSQL(
            "UPDATE positions SET status = 'CLOSED', pnl = (? * (? - entry_price)) WHERE id = ?",
            [(existing.quantity as number), data.price, (existing.id as number)]
          )
          const sellEntries = queryAll("SELECT id, quantity FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC", [data.symbol]) as { id: number; quantity: number }[]
          for (const entry of sellEntries) {
            reduceEntryQuantity(entry.id, (existing.quantity as number))
          }
          const usdtEntry = getUsdtEntry()
          if (usdtEntry) {
            // Net USDC after sell-side fee
            const feeRate = settings.fee_rate ?? 0.001
            const grossUsdc = (existing.quantity as number) * data.price
            increaseEntryQuantity(usdtEntry.id, grossUsdc * (1 - feeRate))
          }
        } else {
          logger.debug('No open position to sell', { coin: data.symbol })
        }
      }
    } catch (err) {
      logger.error('Error in trade execution', { coin: data.symbol, error: err instanceof Error ? err.message : String(err) })
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
  logger.info('Trading loop completed', { totalValue: snapshotTotal, tradesInitiated })
}

async function runSingleCoinPipeline(symbol: string, cycleId: string): Promise<void> {
  logger.info('Manual pipeline started', { symbol, cycleId })
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
    const result = await analyzeCoin(data, portfolioState, cycleId)
    logger.info('Manual pipeline completed', { symbol, action: result.signal.action })
  } catch (err) {
    logPipelineEvent('pipeline_error', symbol, cycleId, {
      symbol, error: err instanceof Error ? err.message : String(err),
    })
    logger.error('Manual pipeline error', { symbol, error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleTradeSignal(signal: Signal, price: number, atr?: number, settings?: any) {
  if (signal.action === 'HOLD') return

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

    pendingApprovals.set(tradeId, signal)
    bus.emit('approval_requested', req)
    sendApprovalMessage(req)

    const timer = setTimeout(() => {
      bus.emit('trade_rejected', tradeId)
      pendingApprovals.delete(tradeId)
      approvalTimers.delete(tradeId)
    }, config.approvalTimeoutMs)
    approvalTimers.set(tradeId, timer)
  } else {
    await submitTrade(signal, undefined, atr, s)
  }
}

async function submitTrade(signal: Signal, tradeId?: number, atr?: number, settings?: any) {
  try {
    const result = await executeTrade(signal)
    const feeCost = result.fee?.cost ?? 0
    const feeCurrency = result.fee?.currency ?? 'USDC'

    if (tradeId) {
      runSQL(
        "UPDATE trades SET price = ?, total = ?, fee_cost = ?, fee_currency = ?, status = 'EXECUTED', approved = 1 WHERE id = ?",
        [result.price, result.cost, feeCost, feeCurrency, tradeId]
      )
    } else {
      runSQL(
        'INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [signal.coin, signal.action, result.quantity, result.price, result.cost, feeCost, feeCurrency, 'EXECUTED', 1]
      )
    }

    if (signal.action === 'BUY' && atr && settings) {
      const sl = calculateStopLoss(result.price, atr, settings)
      const tp = calculateTakeProfit(result.price, atr, settings)
      const existing = queryOne("SELECT id FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
      if (!existing) {
        runSQL(
          'INSERT INTO positions (coin, side, quantity, entry_price, stop_loss, take_profit, current_sl) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [signal.coin, 'BUY', result.quantity, result.price, sl, tp, sl]
        )
        logger.info('Position opened', { coin: signal.coin, price: result.price, sl, tp, feeCost })
      }
    }

    const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    bus.emit('trade_executed', trade as any)

    if (signal.action === 'BUY') {
      // cost basis = USDC spent / net coins received (fee already baked into result.quantity)
      const costBasis = result.quantity > 0 ? result.cost / result.quantity : result.price
      addEntry(signal.coin, result.quantity, costBasis, new Date().toISOString().split('T')[0], 'trade', (trade?.id as number) || (tradeId as number))
      const usdtEntry = getUsdtEntry()
      if (usdtEntry) {
        reduceEntryQuantity(usdtEntry.id, result.cost)
      }
    }

    logger.info('Trade executed', { coin: signal.coin, action: signal.action, price: result.price, fee: feeCost })
  } catch (err) {
    logger.error('Trade failed', { coin: signal.coin, error: err instanceof Error ? err.message : String(err) })
  }
}

bus.on('trade_approved', (tradeId: number) => {
  const signal = pendingApprovals.get(tradeId)
  if (!signal) return

  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)

  submitTrade(signal, tradeId)
})

bus.on('trade_rejected', (tradeId: number) => {
  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)

  runSQL("UPDATE trades SET approved = 0, status = 'FAILED' WHERE id = ? AND status = 'PENDING'", [tradeId])
  logger.info('Trade rejected by user', { tradeId })
})

  bus.on('stop_loss_hit', async ({ positionId, coin, price }: { positionId: number; coin: string; price: number }) => {
  logger.warn('Stop loss triggered', { coin, positionId, price })
  try {
    const pos = queryOne("SELECT quantity FROM positions WHERE id = ?", [positionId])
    const qty = pos ? (pos.quantity as number) : 0
    const signal: Signal = { coin, action: 'SELL', quantity: qty, reason: 'Stop loss', confidence: 1 }
    const result = await executeTrade(signal)
    const feeCost = result.fee?.cost ?? 0
    const feeCurrency = result.fee?.currency ?? 'USDC'
    runSQL(
      "UPDATE positions SET status = 'SL_HIT', pnl = (quantity * (? - entry_price)) WHERE id = ?",
      [price, positionId]
    )
    const slPortfolioEntries = queryAll("SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC", [coin]) as { id: number }[]
    for (const entry of slPortfolioEntries) {
      closeEntry(entry.id)
    }
    const slUsdtEntry = getUsdtEntry()
    if (slUsdtEntry) {
      increaseEntryQuantity(slUsdtEntry.id, result.cost)
    }
    runSQL(
      'INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [coin, 'SELL', result.quantity, result.price, result.cost, feeCost, feeCurrency, 'EXECUTED', 1]
    )
    broadcast('stop_loss_hit', { coin, price, pnl: null })
  } catch (err) {
    logger.error('Failed to execute stop loss', { coin, error: err instanceof Error ? err.message : String(err) })
  }
})

  bus.on('take_profit_hit', async ({ positionId, coin, price }: { positionId: number; coin: string; price: number }) => {
  logger.info('Take profit triggered', { coin, positionId, price })
  try {
    const pos = queryOne("SELECT quantity FROM positions WHERE id = ?", [positionId])
    const qty = pos ? (pos.quantity as number) : 0
    const signal: Signal = { coin, action: 'SELL', quantity: qty, reason: 'Take profit', confidence: 1 }
    const result = await executeTrade(signal)
    const feeCost = result.fee?.cost ?? 0
    const feeCurrency = result.fee?.currency ?? 'USDC'
    runSQL(
      "UPDATE positions SET status = 'TP_HIT', pnl = (quantity * (? - entry_price)) WHERE id = ?",
      [price, positionId]
    )
    const tpPortfolioEntries = queryAll("SELECT id FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC", [coin]) as { id: number }[]
    for (const entry of tpPortfolioEntries) {
      closeEntry(entry.id)
    }
    const tpUsdtEntry = getUsdtEntry()
    if (tpUsdtEntry) {
      increaseEntryQuantity(tpUsdtEntry.id, result.cost)
    }
    runSQL(
      'INSERT INTO trades (coin, side, quantity, price, total, fee_cost, fee_currency, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [coin, 'SELL', result.quantity, result.price, result.cost, feeCost, feeCurrency, 'EXECUTED', 1]
    )
    broadcast('take_profit_hit', { coin, price, pnl: null })
  } catch (err) {
    logger.error('Failed to execute take profit', { coin, error: err instanceof Error ? err.message : String(err) })
  }
})

let server: ReturnType<typeof startAPI> | undefined

async function start() {
  logger.info('Starting CryptoBot...')
  await initDB()

  // Env var seeds the DB setting on every startup so .env stays authoritative
  if (config.pipelineCron) {
    updateSetting('pipeline_cron', config.pipelineCron)
  }

  server = startAPI()
  startTelegramBot()
  startNotifier()

  // Start price cache and subscribe to known coins
  priceCache.start()
  const settings = getSettings()
  const initialCoins = [
    ...settings.watchlist,
    ...(getOpenEntries() as unknown as { coin: string }[]).filter(e => e.coin !== 'USDC').map(e => e.coin),
  ]
  if (initialCoins.length > 0) priceCache.subscribe([...new Set(initialCoins)])

  schedulePipeline(settings.pipeline_cron)
  scheduleDiscovery(settings.discover_cron)

  // Run once immediately at startup, then cron takes over
  runPipeline()

  logger.info(`CryptoBot running. Pipeline cron: ${settings.pipeline_cron}`)
}

// Reschedule when the frontend saves new settings
bus.on('settings_updated', (updated) => {
  if (updated.pipeline_cron) schedulePipeline(updated.pipeline_cron)
  if (updated.discover_cron) scheduleDiscovery(updated.discover_cron)
})

bus.on('discovery_run_requested', ({ cycle_id }) => {
  runDiscovery(cycle_id).catch(err => {
    logger.error('Discovery run failed', { error: err instanceof Error ? err.message : String(err) })
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
  priceCache.stop()
  try { await closeBrowser() } catch {}
  saveDB()
  if (server) server.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
