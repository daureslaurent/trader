import { initDB, queryAll, queryOne, runSQL, getSettings } from './db/index.js'
import { config } from './config/index.js'
import { logger } from './core/logger.js'
import { bus } from './core/events.js'
import { startAPI } from './api/index.js'
import { startTelegramBot, sendApprovalMessage } from './telegram/index.js'
import { fetchMarketData, fetchBalance, executeTrade, getTopPairs } from './trader/index.js'
import { researchCoin, extractResearch } from './researcher/index.js'
import { analyzeSignal } from './analyst/index.js'
import { Signal, ApprovalRequest } from './types.js'

let pendingApprovals: Map<number, Signal> = new Map()
let approvalTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

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

  for (const data of marketData) {
    try {
      const rawResearch = await researchCoin(data.symbol)
      const extractedResearch = await extractResearch(rawResearch)
      const portfolioPercent = balance[data.symbol.replace('/USDT', '')]
        ? ((balance[data.symbol.replace('/USDT', '')].total * data.price) / (Object.values(balance).reduce((s, b) => s + b.total * data.price, 0.01))) * 100
        : 0

      const signal = await analyzeSignal(
        data.symbol,
        data.price,
        data.change24h,
        data.volume,
        extractedResearch,
        portfolioPercent,
      )

      runSQL(
        'INSERT INTO decisions (coin, action, reason, confidence, context) VALUES (?, ?, ?, ?, ?)',
        [data.symbol, signal.action, signal.reason, signal.confidence, JSON.stringify({ price: data.price, extractedResearch })]
      )

      if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
        logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
        continue
      }

      await handleTradeSignal(signal, data.price)
    } catch (err) {
      logger.error('Error in trading loop', { coin: data.symbol, error: (err as Error).message })
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

async function handleTradeSignal(signal: Signal, price: number = 0) {
  if (signal.action === 'HOLD') return

  const settings = getSettings()

  if (settings.approval_required || config.approvalsEnabled) {
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
      logger.info('Approval timed out', { tradeId })
    }, config.approvalTimeoutMs)
    approvalTimers.set(tradeId, timer)
  } else {
    await submitTrade(signal)
  }
}

async function submitTrade(signal: Signal, tradeId?: number) {
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

    const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    bus.emit('trade_executed', trade as any)
    logger.info('Trade executed', { coin: signal.coin, action: signal.action, price: result.price })
  } catch (err) {
    logger.error('Trade failed', { coin: signal.coin, error: (err as Error).message })
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

async function start() {
  logger.info('Starting CryptoBot...')
  await initDB()
  startAPI()
  startTelegramBot()

  const settings = getSettings()
  const intervalMs = settings.interval_minutes * 60 * 1000

  tradingLoop()
  setInterval(tradingLoop, intervalMs)

  logger.info(`CryptoBot running. Loop every ${settings.interval_minutes} minutes.`)
}

start()
