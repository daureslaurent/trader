// Entry pipeline: research → extraction → selection → analyst signal, then the
// BUY gauntlet that either defers to the entry-timing engine or executes. The
// app/wiring layer connects bus events to these entry points.
export { runPipeline, runSingleCoinPipeline, isPipelineRunning, PIPELINE_TIMEOUT_MS } from './runner.js'
export { runSimulatedSignal } from './simulate.js'
export { stageManualEntry, deferToEntryDesk } from './entryStaging.js'
export type { ManualEntryResult } from './entryStaging.js'
export { prepareBuyOrder } from './buyEvaluation.js'
export type { BuyEvaluation, PreparedBuyOrder } from './buyEvaluation.js'
export { executeEntryFire } from './entryFire.js'
export { logPipelineEvent } from './events.js'
export { requestCancel } from './cancellation.js'
