// Trade execution layer: the single path from a decided signal to a real
// exchange order, plus exit and SL/TP-adjustment handling. The engines never
// touch the exchange directly — they go through these functions (usually via
// the event bus wiring in app/wiring.ts).
export { submitTrade } from './submitTrade.js'
export { isExitInFlight, claimExit, releaseExit } from './exitsInFlight.js'
export { handleTradeSignal, getPendingApprovals, approveTrade, rejectTrade } from './approvals.js'
export { executeMonitorClose, executeMonitorReduce, executeFallbackExit } from './exits.js'
export { applyAdjustment, proposeAdjustment, approveAdjustment, rejectAdjustment } from './adjustments.js'
