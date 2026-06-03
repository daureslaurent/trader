import { initDB, getSettings, getDB } from './db/index.js'
import { config } from './config/index.js'
import { logger } from './core/logger.js'
import { bus } from './core/events.js'
import { startAPI } from './api/index.js'
import { startTelegramBot, sendApprovalMessage } from './telegram/index.js'
import { fetchMarketData, fetchBalance, executeTrade, getTopPairs } from './trader/index.js'
import { researchCoin } from './researcher/index.js'
import { analyzeSignal } from './analyst/index.js'
import { Signal, ApprovalRequest } from './types.js'

let pendingApprovals: Map<number, Signal> = new Map()
let approvalTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

async function tradingLoop() {
  logger.info('Trading loop started')

  const settings = getSettings()
  const symbols = [...settings.watchlist]

  if (symbols.length === 0) {
    const topPairs = await getTopPairs(20)
    symbols.push(...topPairs)
  }

  const marketData = await fetchMarketData(symbols)
  const balance = await fetchBalance()

  for (const data of marketData) {
    try {
      const research = await researchCoin(data.symbol)
      const portfolioPercent = balance[data.symbol.replace('/USDT', '')]
        ? ((balance[data.symbol.replace('/USDT', '')].total * data.price) / (Object.values(balance).reduce((s, b) => s + b.total * data.price, 0.01))) * 100
        : 0

      const signal = await analyzeSignal(
        data.symbol,
        data.price,
        data.change24h,
        data.volume,
        research,
        portfolioPercent,
      )

      const db = getDB()
      db.prepare(
        'INSERT INTO decisions (coin, action, reason, confidence, context) VALUES (?, ?, ?, ?, ?)'
      ).run(data.symbol, signal.action, signal.reason, signal.confidence, JSON.stringify({ price: data.price, research }))

      if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
        logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
        continue
      }

      await handleTradeSignal(signal)
    } catch (err) {
      logger.error('Error in trading loop', { coin: data.symbol, error: (err as Error).message })
    }
  }

  // snapshot
  const snapshotBalance = await fetchBalance()
  let totalValue = 0
  for (const data of marketData) {
    const coin = data.symbol.replace('/USDT', '')
    if (snapshotBalance[coin]) totalValue += snapshotBalance[coin].total * data.price
  }
  if (snapshotBalance['USDT']) totalValue += snapshotBalance['USDT'].total

  getDB().prepare('INSERT INTO portfolio_snapshots (total_value_usd, holdings) VALUES (?, ?)')
    .run(totalValue, JSON.stringify(Object.fromEntries(
      Object.entries(snapshotBalance).map(([k, v]) => [k, v.total])
    )))

  bus.emit('portfolio_updated')
  logger.info('Trading loop completed', { totalValue })
}

async function handleTradeSignal(signal: Signal) {
  if (signal.action === 'HOLD') return

  const settings = getSettings()

  if (settings.approval_required || config.approvalsEnabled) {
    const db = getDB()
    const info = db.prepare(
      'INSERT INTO trades (coin, side, quantity, status) VALUES (?, ?, ?, ?)'
    ).run(signal.coin, signal.action, signal.quantity, 'PENDING')

    const tradeId = info.lastInsertRowid as number
    const req: ApprovalRequest = {
      tradeId,
      coin: signal.coin,
      side: signal.action,
      quantity: signal.quantity,
      estimatedPrice: 0,
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

async function submitTrade(signal: Signal) {
  try {
    const result = await executeTrade(signal)
    const db = getDB()
    db.prepare(
      'INSERT INTO trades (coin, side, quantity, price_usd, total_usd, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(signal.coin, signal.action, signal.quantity, result.price, result.cost, 'EXECUTED', 1)

    const trade = db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 1').get()
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

  submitTrade(signal)
})

bus.on('trade_rejected', (tradeId: number) => {
  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)

  logger.info('Trade rejected by user', { tradeId })
})

function start() {
  logger.info('Starting CryptoBot...')
  initDB()
  startAPI()
  startTelegramBot()

  const settings = getSettings()
  const intervalMs = settings.interval_minutes * 60 * 1000

  tradingLoop()
  setInterval(tradingLoop, intervalMs)

  logger.info(`CryptoBot running. Loop every ${settings.interval_minutes} minutes.`)
}

start()
