import { queryAll } from '../db/index.js'
import { PositionRecord } from '../types.js'

export function getOpenPositions(): PositionRecord[] {
  return queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown[] as PositionRecord[]
}

export {
  getOpenEntries,
  getAllEntries,
  getEntryById,
  addEntry,
  closeEntry,
  reduceEntryQuantity,
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
