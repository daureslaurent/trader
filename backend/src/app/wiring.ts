import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import {
  approveTrade, rejectTrade,
  proposeAdjustment, approveAdjustment, rejectAdjustment,
  executeMonitorClose, executeMonitorReduce, executeFallbackExit,
} from '../execution/index.js'
import {
  executeEntryFire, runSimulatedSignal,
  runPipeline, runSingleCoinPipeline, requestCancel, logPipelineEvent, PIPELINE_TIMEOUT_MS,
} from '../pipeline/index.js'
import { runDiscovery } from '../discoverer/index.js'
import { runMonitor } from '../monitor/index.js'
import { rescheduleFromSettings } from './scheduler.js'

const errMsg = (err: unknown) => err instanceof Error ? err.message : String(err)

/**
 * Connect the event bus to the pipeline / execution / scheduler layers. The
 * engines only ever emit events; these handlers are the single place where
 * those events turn into actions. Call once at startup.
 */
export function registerEventHandlers(): void {
  // ── Trade execution & approvals ────────────────────────────────────────────
  bus.on('entry_fire', (payload) => {
    executeEntryFire(payload).catch(err => logger.error('Entry fire handler error', { error: errMsg(err) }))
  })

  bus.on('trade_approved', (tradeId) => {
    approveTrade(tradeId).catch(err => logger.error('Trade approval handler error', { tradeId, error: errMsg(err) }))
  })

  bus.on('trade_rejected', (tradeId) => {
    rejectTrade(tradeId)
  })

  // ── Position SL/TP adjustments (from the Position Monitor) ──────────────────
  bus.on('position_adjustment_proposed', (p) => {
    proposeAdjustment(p)
  })

  bus.on('adjustment_approved', (adjId) => {
    approveAdjustment(adjId)
  })

  bus.on('adjustment_rejected', (adjId) => {
    rejectAdjustment(adjId)
  })

  // ── Monitor-initiated exits ────────────────────────────────────────────────
  bus.on('monitor_close_requested', ({ positionId, coin, currentPrice, reasoning }) => {
    logger.warn('Monitor CLOSE requested', { coin, positionId, currentPrice })
    executeMonitorClose(positionId, coin, currentPrice, reasoning).catch(err =>
      logger.error('Monitor close handler error', { coin, error: errMsg(err) })
    )
  })

  bus.on('monitor_reduce_requested', ({ positionId, coin, currentPrice, reduceToPct, reasoning }) => {
    logger.warn('Monitor REDUCE requested', { coin, positionId, reduceToPct, currentPrice })
    executeMonitorReduce(positionId, coin, reduceToPct, currentPrice, reasoning).catch(err =>
      logger.error('Monitor reduce handler error', { coin, error: errMsg(err) })
    )
  })

  // ── Software-fallback exits (reconciler, no live OCO) ──────────────────────
  bus.on('stop_loss_hit', ({ positionId, coin, price }) => {
    logger.warn('Stop loss triggered (software fallback)', { coin, positionId, price })
    executeFallbackExit(positionId, coin, price, 'SL_HIT', 'Stop loss')
  })

  bus.on('take_profit_hit', ({ positionId, coin, price }) => {
    logger.info('Take profit triggered (software fallback)', { coin, positionId, price })
    executeFallbackExit(positionId, coin, price, 'TP_HIT', 'Take profit')
  })

  // ── Scheduling & manual pipeline triggers ──────────────────────────────────
  bus.on('settings_updated', (updated) => {
    rescheduleFromSettings(updated)
  })

  bus.on('pipeline_cancel_requested', ({ cycle_id }) => {
    requestCancel(cycle_id)
  })

  bus.on('trade_signal_simulated', (payload) => {
    runSimulatedSignal(payload).catch(err => logger.error('Simulated signal handler error', { error: errMsg(err) }))
  })

  bus.on('pipeline_run_all_requested', () => {
    runPipeline().catch(err => {
      logger.error('Manual full pipeline run failed', { error: errMsg(err) })
    })
  })

  bus.on('discovery_run_requested', ({ cycle_id }) => {
    runDiscovery(cycle_id).catch(err => {
      logger.error('Discovery run failed', { error: errMsg(err) })
    })
  })

  bus.on('monitor_run_requested', ({ cycle_id }) => {
    runMonitor(cycle_id).catch(err => {
      logger.error('Monitor run failed', { error: errMsg(err) })
    })
  })

  bus.on('pipeline_run_requested', ({ symbol, cycle_id }) => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Pipeline timed out after 1 hour')), PIPELINE_TIMEOUT_MS)
    )
    Promise.race([runSingleCoinPipeline(symbol, cycle_id), timeout]).catch(err => {
      const isTimeout = err instanceof Error && err.message.startsWith('Pipeline timed out')
      const stage = isTimeout ? 'pipeline_timeout' : 'pipeline_failed'
      logPipelineEvent(stage, symbol, cycle_id, { error: errMsg(err) })
      logger.error(isTimeout ? 'Manual pipeline timed out' : 'Manual pipeline failed', { symbol, error: String(err) })
    })
  })
}
