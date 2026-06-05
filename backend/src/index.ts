import { initDB, queryOne, runSQL, saveDB, getSettings } from './db/index.js'
import { config } from './config/index.js'
import { logger } from './core/logger.js'
import { bus } from './core/events.js'
import { startAPI } from './api/index.js'
import { startTelegramBot, sendApprovalMessage, startNotifier } from './telegram/index.js'
import { fetchMarketData, fetchBalance, executeTrade, getTopPairs } from './trader/index.js'
import { researchCoin } from './researcher/index.js'
import { extractResearch } from './extractor/index.js'
import { analyzeSignal } from './analyst/index.js'
import { getMarketContext, checkOpenPositions, computePortfolioState } from './portfolio/index.js'
import { calculatePositionSize, calculateStopLoss, calculateTakeProfit } from './portfolio/risk.js'
import { Signal, ApprovalRequest, PipelineStage } from './types.js'
import { broadcast } from './api/ws.js'
import { closeBrowser } from './scraper/browser.js'

let pendingApprovals: Map<number, Signal> = new Map()
let approvalTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

const loopAbortController = new AbortController()

let cycleCounter = 0

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

  await checkOpenPositions()

  const portfolioState = computePortfolioState(balance, marketData, settings)

  for (const data of marketData) {
    const cycleId = `${Date.now().toString(36)}-${(++cycleCounter).toString(36)}`
    try {
      logPipelineEvent('research_started', data.symbol, cycleId, { symbol: data.symbol })
      const rawResearch = await researchCoin(data.symbol)
      logPipelineEvent('research_completed', data.symbol, cycleId, {
        symbol: data.symbol,
        headlines: rawResearch.headlines,
        articles: rawResearch.articles,
        sentiment: rawResearch.sentiment,
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

      const marketCtx = await getMarketContext(data.symbol, data.price)
      logPipelineEvent('analysis_started', data.symbol, cycleId, {
        symbol: data.symbol, price: data.price, change24h: data.change24h, volume: data.volume,
        rsi14: marketCtx.rsi14, trend: marketCtx.trend, atr14: marketCtx.atr14,
      })

      const signal = await analyzeSignal(data.symbol, marketCtx, portfolioState, extractedResearch)

      logPipelineEvent('signal_generated', data.symbol, cycleId, {
        symbol: data.symbol, action: signal.action, reason: signal.reason, confidence: signal.confidence,
      })

      runSQL(
        'INSERT INTO decisions (coin, action, reason, confidence, context) VALUES (?, ?, ?, ?, ?)',
        [data.symbol, signal.action, signal.reason, signal.confidence, JSON.stringify({ price: data.price, extractedResearch })]
      )

      if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
        logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
        continue
      }

      if (signal.action === 'BUY') {
        if (portfolioState.openPositionCount >= portfolioState.maxOpenPositions) {
          logger.warn('Max open positions reached, skipping BUY', { coin: data.symbol, openPositions: portfolioState.openPositionCount })
          continue
        }

        const qty = calculatePositionSize(data.price, marketCtx.atr14, signal.confidence, portfolioState.totalValueUsd, settings)
        if (qty <= 0) continue

        const buySignal: Signal = { ...signal, quantity: qty }
        await handleTradeSignal(buySignal, data.price, marketCtx.atr14, settings)
      } else if (signal.action === 'SELL') {
        const existing = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [data.symbol])
        if (existing) {
          const sellSignal: Signal = { ...signal, quantity: (existing.quantity as number) }
          await handleTradeSignal(sellSignal, data.price)
          runSQL(
            "UPDATE positions SET status = 'CLOSED', pnl = (? * (? - entry_price)) WHERE id = ?",
            [(existing.quantity as number), data.price, (existing.id as number)]
          )
        } else {
          logger.debug('No open position to sell', { coin: data.symbol })
        }
      }
    } catch (err) {
      logPipelineEvent('pipeline_error', data.symbol, cycleId, {
        symbol: data.symbol, error: err instanceof Error ? err.message : String(err),
        price: data.price, change24h: data.change24h, volume: data.volume,
      } as Record<string, unknown>)
      logger.error('Error in trading loop', { coin: data.symbol, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const snapshotBalance = await fetchBalance()
  let totalValue = 0
  for (const data of marketData) {
    const coin = data.symbol.replace('/USDT', '')
    if (snapshotBalance[coin]) totalValue += snapshotBalance[coin].total * data.price
  }
  if (snapshotBalance['USDT']) totalValue += snapshotBalance['USDT'].total

  runSQL(
    'INSERT INTO portfolio_snapshots (total_value_usd, holdings) VALUES (?, ?)',
    [totalValue, JSON.stringify(Object.fromEntries(Object.entries(snapshotBalance).map(([k, v]) => [k, v.total])))]
  )

  bus.emit('portfolio_updated')
  logger.info('Trading loop completed', { totalValue })
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

    if (tradeId) {
      runSQL(
        "UPDATE trades SET price = ?, total = ?, status = 'EXECUTED', approved = 1 WHERE id = ?",
        [result.price, result.cost, tradeId]
      )
    } else {
      runSQL(
        'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [signal.coin, signal.action, signal.quantity, result.price, result.cost, 'EXECUTED', 1]
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
        logger.info('Position opened', { coin: signal.coin, price: result.price, sl, tp })
      }
    }

    const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    bus.emit('trade_executed', trade as any)
    logger.info('Trade executed', { coin: signal.coin, action: signal.action, price: result.price })
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
    runSQL(
      "UPDATE positions SET status = 'SL_HIT', pnl = (quantity * (? - entry_price)) WHERE id = ?",
      [price, positionId]
    )
    runSQL(
      'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [coin, 'SELL', result.quantity, result.price, result.cost, 'EXECUTED', 1]
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
    runSQL(
      "UPDATE positions SET status = 'TP_HIT', pnl = (quantity * (? - entry_price)) WHERE id = ?",
      [price, positionId]
    )
    runSQL(
      'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [coin, 'SELL', result.quantity, result.price, result.cost, 'EXECUTED', 1]
    )
    broadcast('take_profit_hit', { coin, price, pnl: null })
  } catch (err) {
    logger.error('Failed to execute take profit', { coin, error: err instanceof Error ? err.message : String(err) })
  }
})

export async function runLoop(intervalMs: number, signal: AbortSignal) {
  while (!signal.aborted) {
    await tradingLoop()
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

let server: ReturnType<typeof startAPI> | undefined

async function start() {
  logger.info('Starting CryptoBot...')
  await initDB()
  server = startAPI()
  startTelegramBot()
  startNotifier()

  const settings = getSettings()
  const intervalMs = settings.interval_minutes * 60 * 1000

  runLoop(intervalMs, loopAbortController.signal)

  logger.info(`CryptoBot running. Loop every ${settings.interval_minutes} minutes.`)
}

async function shutdown(signal: string) {
  logger.info(`Shutting down (${signal})`)
  loopAbortController.abort()
  try { await closeBrowser() } catch {}
  saveDB()
  if (server) server.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
