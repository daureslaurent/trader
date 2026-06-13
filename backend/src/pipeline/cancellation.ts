import { logger } from '../core/logger.js'

// Cycles the user (or a restart) asked to abort. analyzeCoin polls this between
// each slow stage via checkCancelled and bails by throwing.
const cancelledCycles = new Set<string>()

export class PipelineCancelledError extends Error {
  constructor() { super('Pipeline cancelled'); this.name = 'PipelineCancelledError' }
}

/** Throw PipelineCancelledError if the given cycle has been flagged for abort. */
export function checkCancelled(cycleId: string): void {
  if (cancelledCycles.has(cycleId)) throw new PipelineCancelledError()
}

/** Flag a running cycle for cancellation (handled at the next checkCancelled). */
export function requestCancel(cycleId: string): void {
  cancelledCycles.add(cycleId)
  logger.info('Pipeline cancellation requested', { cycle_id: cycleId })
}

/** Drop a cycle's cancellation flag once its run has unwound. */
export function clearCancel(cycleId: string): void {
  cancelledCycles.delete(cycleId)
}
