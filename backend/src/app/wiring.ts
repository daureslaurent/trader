import { bus } from '../core/events.js'
import { systemBus, SystemEvent } from '../core/bus.js'
import { logger } from '../core/logger.js'
import {
  approveTrade, rejectTrade,
  proposeAdjustment, approveAdjustment, rejectAdjustment,
  executeMonitorClose, executeFallbackExit,
} from '../execution/index.js'
import {
  executeEntryFire, runSimulatedSignal,
  requestCancel, logPipelineEvent, PIPELINE_TIMEOUT_MS,
} from '../pipeline/index.js'
import { runDiscovery } from '../discoverer/index.js'
import { runPortfolioSummary } from '../summary/index.js'
import { runEntryAgentCoin, runCoach } from '../agent/index.js'
import { getSettings } from '../db/index.js'
import { recomputeOfflineMode, isOffline } from '../core/offlineMode.js'
import { rescheduleFromSettings, dispatchMonitorRun, dispatchPipelineRun, dispatchSingleCoinPipeline } from './scheduler.js'

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
    rejectTrade(tradeId).catch(err => logger.error('Trade reject handler error', { tradeId, error: errMsg(err) }))
  })

  // ── Entry Agent first pass on a freshly deferred BUY ────────────────────────
  // No-op unless entry_model === 'agent' (the engine also guards). Gives a new intent
  // smart levels within seconds instead of waiting for the next routing tick.
  bus.on('entry_intent_registered', ({ coin, cycle_id }) => {
    // Offline: the Entry Agent is LLM-driven — skip it so the intent keeps the static band.
    if (getSettings().entry_model !== 'agent' || isOffline()) return
    runEntryAgentCoin(coin, cycle_id).catch(err => logger.error('Entry Agent first-pass handler error', { coin, error: errMsg(err) }))
  })

  // ── Position SL/TP adjustments (from the Position Monitor) ──────────────────
  bus.on('position_adjustment_proposed', (p) => {
    proposeAdjustment(p).catch(err => logger.error('Adjustment propose handler error', { error: errMsg(err) }))
  })

  bus.on('adjustment_approved', (adjId) => {
    approveAdjustment(adjId)
  })

  bus.on('adjustment_rejected', (adjId) => {
    rejectAdjustment(adjId).catch(err => logger.error('Adjustment reject handler error', { adjId, error: errMsg(err) }))
  })

  // ── Monitor-initiated exits ────────────────────────────────────────────────
  bus.on('monitor_close_requested', ({ positionId, coin, currentPrice, reasoning }) => {
    logger.warn('Monitor CLOSE requested', { coin, positionId, currentPrice })
    executeMonitorClose(positionId, coin, currentPrice, reasoning).catch(err =>
      logger.error('Monitor close handler error', { coin, error: errMsg(err) })
    )
  })

  // ── Software-fallback exits (reconciler, no live OCO) ──────────────────────
  bus.on('stop_loss_hit', ({ positionId, coin, price }) => {
    logger.warn('Stop loss triggered (software fallback)', { coin, positionId, price })
    executeFallbackExit(positionId, coin, price, 'SL_HIT', 'Stop loss').catch(err =>
      logger.error('Fallback SL exit handler error', { coin, error: errMsg(err) }))
  })

  bus.on('take_profit_hit', ({ positionId, coin, price }) => {
    logger.info('Take profit triggered (software fallback)', { coin, positionId, price })
    executeFallbackExit(positionId, coin, price, 'TP_HIT', 'Take profit').catch(err =>
      logger.error('Fallback TP exit handler error', { coin, error: errMsg(err) }))
  })

  // ── Scheduling & manual pipeline triggers ──────────────────────────────────
  bus.on('settings_updated', (updated) => {
    rescheduleFromSettings(updated)
    // The manual offline override (and offline_auto) live in settings — re-evaluate the
    // effective mode immediately so a toggle takes effect without waiting for a health tick.
    recomputeOfflineMode()
  })

  bus.on('pipeline_cancel_requested', ({ cycle_id }) => {
    requestCancel(cycle_id)
  })

  bus.on('trade_signal_simulated', (payload) => {
    runSimulatedSignal(payload).catch(err => logger.error('Simulated signal handler error', { error: errMsg(err) }))
  })

  bus.on('pipeline_run_all_requested', () => {
    dispatchPipelineRun().catch(err => {
      logger.error('Manual full pipeline run failed', { error: errMsg(err) })
    })
  })

  bus.on('discovery_run_requested', ({ cycle_id }) => {
    runDiscovery(cycle_id).catch(err => {
      logger.error('Discovery run failed', { error: errMsg(err) })
    })
  })

  bus.on('monitor_run_requested', ({ cycle_id }) => {
    dispatchMonitorRun(cycle_id).catch(err => {
      logger.error('Monitor run failed', { error: errMsg(err) })
    })
  })

  bus.on('summary_run_requested', ({ cycle_id }) => {
    runPortfolioSummary(cycle_id).catch(err => {
      logger.error('Portfolio summary run failed', { error: errMsg(err) })
    })
  })

  bus.on('coach_run_requested', ({ cycle_id }) => {
    runCoach(cycle_id).catch(err => {
      logger.error('Coach audit run failed', { error: errMsg(err) })
    })
  })

  bus.on('pipeline_run_requested', ({ symbol, cycle_id }) => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Pipeline timed out after 1 hour')), PIPELINE_TIMEOUT_MS)
    )
    Promise.race([dispatchSingleCoinPipeline(symbol, cycle_id), timeout]).catch(err => {
      const isTimeout = err instanceof Error && err.message.startsWith('Pipeline timed out')
      const stage = isTimeout ? 'pipeline_timeout' : 'pipeline_failed'
      logPipelineEvent(stage, symbol, cycle_id, { error: errMsg(err) })
      logger.error(isTimeout ? 'Manual pipeline timed out' : 'Manual pipeline failed', { symbol, error: String(err) })
    })
  })

  registerTelemetryBridge()
}

/**
 * Mirror selected command-bus events into the reactive telemetry bus that backs
 * the Event Stream page. This is a one-way tap: it only reads events and emits
 * facts — it never executes trades — so the observability stream can never
 * affect execution. Order-fill/fail and market ticks are emitted at their source
 * (submitTrade / priceCache); the rest are bridged here.
 */
function registerTelemetryBridge(): void {
  bus.on('signal_generated', (s) => {
    systemBus.emitEvent(SystemEvent.STRATEGY_SIGNAL_GENERATED, {
      symbol: s.coin,
      action: s.action,
      confidence: s.confidence,
      reason: s.reason,
    })
  })

  bus.on('stop_loss_hit', ({ positionId, coin, price }) => {
    systemBus.emitEvent(SystemEvent.RISK_STOP_TRIGGERED, { symbol: coin, positionId, price })
  })

  bus.on('take_profit_hit', ({ positionId, coin, price }) => {
    systemBus.emitEvent(SystemEvent.RISK_TAKE_PROFIT, { symbol: coin, positionId, price })
  })

  bus.on('sl_tp_adjusted', ({ coin, positionId, newStopLoss, newTakeProfit }) => {
    systemBus.emitEvent(SystemEvent.RISK_POSITION_ADJUSTED, {
      symbol: coin, positionId, stopLoss: newStopLoss, takeProfit: newTakeProfit,
    })
  })
}
