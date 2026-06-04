import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { getMarketContext } from './market.js'
import { checkPosition, parseSettings } from './risk.js'
import { buildAnalysisPrompt } from './prompts.js'
import {
  MarketContext, PortfolioState, PositionRecord,
  BotSettings
} from '../types.js'

export function getOpenPositions(): PositionRecord[] {
  return queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown[] as PositionRecord[]
}

export async function checkOpenPositions(): Promise<void> {
  const positions = getOpenPositions()
  if (positions.length === 0) return

  logger.debug('Checking open positions', { count: positions.length })

  for (const pos of positions) {
    try {
      if (!pos.coin) continue
      const ccxt = await import('ccxt')
      const exchange = new ccxt.default.binance()
      const ticker = await exchange.fetchTicker(pos.coin)
      const currentPrice = ticker.last
      if (!currentPrice) continue

      const status = checkPosition(currentPrice, pos)
      if (status === 'HOLD') continue

      logger.info(`Position ${status}`, { coin: pos.coin, entry: pos.entry_price, current: currentPrice })
      bus.emit(status === 'SL_HIT' ? 'stop_loss_hit' as any : 'take_profit_hit' as any, { positionId: pos.id, coin: pos.coin, price: currentPrice })
    } catch (err) {
      logger.warn('Failed to check position', { coin: pos.coin, error: (err as Error).message })
    }
  }
}

export function computePortfolioState(
  balance: Record<string, { free: number; total: number }>,
  marketData: { symbol: string; price: number }[],
  settings: BotSettings,
): PortfolioState {
  const coinValues: Record<string, number> = {}
  let totalValue = 0

  for (const coin of Object.keys(balance)) {
    if (coin === 'USDT') continue
    const md = marketData.find(d => d.symbol.replace('/USDT', '') === coin)
    if (md) {
      const val = balance[coin].total * md.price
      coinValues[coin] = val
      totalValue += val
    }
  }

  if (balance['USDT']) {
    totalValue += balance['USDT'].total
    coinValues['USDT'] = balance['USDT'].total
  }

  const risk = parseSettings(settings)
  const openPositions = getOpenPositions()

  const positions = openPositions.map(p => {
    const coinName = p.coin.replace('/USDT', '')
    const allocationPct = totalValue > 0 ? (coinValues[coinName] || 0) / totalValue : 0
    const currentPrice = marketData.find(d => d.symbol === p.coin)?.price || p.entry_price
    const pnlPct = ((currentPrice - p.entry_price) / p.entry_price) * 100
    return { coin: p.coin, allocationPct, pnlPct }
  })

  const coinCount = Object.keys(coinValues).length || 1
  const targetAllocationPct = 1 / coinCount

  const allocs = Object.values(coinValues)
  const idealAlloc = totalValue / coinCount
  const deviations = allocs.map(a => Math.abs(a - idealAlloc) / idealAlloc)
  const avgDeviation = deviations.reduce((s, d) => s + d, 0) / deviations.length || 0
  const diversificationScore = Math.max(0, 1 - avgDeviation)

  return {
    totalValueUsd: totalValue,
    positions,
    diversificationScore,
    openPositionCount: openPositions.length,
    maxOpenPositions: risk.maxOpenPositions,
    targetAllocationPct,
  }
}

export { getMarketContext, buildAnalysisPrompt }
