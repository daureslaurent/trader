import { queryAll } from '../db/index.js'
import { PositionRecord } from '../types.js'
import { reconcileOpenPositions } from './service.js'

export function getOpenPositions(): PositionRecord[] {
  return queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown[] as PositionRecord[]
}

/**
 * Reconcile open positions against their exchange-side OCO orders (detect fills,
 * re-protect, software fallback). Kept under the old name so existing callers
 * (cycle + interval poll) need no change.
 */
export async function checkOpenPositions(): Promise<void> {
  await reconcileOpenPositions()
}

export {
  getOpenEntries,
  getCoinEntries,
  getUsdtEntry,
  getEntryByCoin,
  seedUsdtIfAbsent,
  detectExternalWithdrawal,
  depositUsdt,
  withdrawUsdt,
  updatePortfolioForTrade,
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
  getCoinPortfolioContext,
  reconcileOpenPositions,
  closePositionFromExit,
  placeProtection,
  cancelProtection,
  replaceProtection,
} from './service.js'
export type { CoinPortfolioContext, PositionExit } from './service.js'

export { getMarketContext, classifyRegime } from './market.js'
export type { MarketRegime, RegimeMomentum } from './market.js'
export { buildAnalysisPrompt } from './prompts.js'
export {
  recordPositionOpen,
  recordSlTpUpdate,
  recordPositionClose,
  getSlTpHistory,
} from './slTpHistory.js'
export type { SlTpEvent } from './slTpHistory.js'
export {
  calculatePositionSize,
  calculateStopLoss,
  calculateTakeProfit,
  computeRiskLevels,
  checkPosition,
  validateSlTpAdjustment,
  minStopGapPct,
  netRealizedPnl,
  hasSufficientEdge,
} from './risk.js'
export type { SlTpProposal, SlTpValidation, RiskLevels } from './risk.js'
