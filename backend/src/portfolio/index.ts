import { queryAll } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { PositionRecord } from '../types.js'
import { checkPosition } from './risk.js'

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
      const { getExchange } = await import('../trader/service.js')
      const exchange = getExchange()
      const ticker = await exchange.fetchTicker(pos.coin)
      const currentPrice = ticker.last
      if (!currentPrice) continue

      const status = checkPosition(currentPrice, pos)
      if (status === 'HOLD') continue

      logger.info(`Position ${status}`, { coin: pos.coin, entry: pos.entry_price, current: currentPrice })
      bus.emit(status === 'SL_HIT' ? 'stop_loss_hit' as any : 'take_profit_hit' as any, { positionId: pos.id, coin: pos.coin, price: currentPrice })
    } catch (err) {
      logger.warn('Failed to check position', { coin: pos.coin, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export {
  getOpenEntries,
  getCoinEntries,
  getUsdtEntry,
  syncUsdtEntry,
  getAllEntries,
  getEntryById,
  addEntry,
  closeEntry,
  reduceEntryQuantity,
  increaseEntryQuantity,
  removeEntry,
  updateEntryQuantity,
  updateEntry,
  getPortfolioState,
  enrichPortfolioEntriesWithPrices,
} from './service.js'

export { getMarketContext } from './market.js'
export { buildAnalysisPrompt } from './prompts.js'
export {
  calculatePositionSize,
  calculateStopLoss,
  calculateTakeProfit,
  checkPosition,
} from './risk.js'
