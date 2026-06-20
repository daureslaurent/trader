import cron from 'node-cron'
import { logger } from '../core/logger.js'
import { runLLMRetention, runDataRetention, getSettings } from '../db/index.js'
import { BotSettings } from '../types.js'
import { checkOpenPositions } from '../portfolio/index.js'
import { runMonitor, runAgentSignal, runAgentSignalCoin } from '../agent/index.js'
import { runPipeline, runSingleCoinPipeline } from '../pipeline/index.js'
import { startEndpointHealthMonitor, stopEndpointHealthMonitor, runEndpointHealthCheck } from '../core/endpointHealth.js'
import { scheduleUpdateCheck, stopUpdateCheck, startAppSampler, stopAppSampler } from '../host/index.js'
import { syncFromSettings, stopRouting, refreshBinanceStreams, refreshHeldCoins } from '../routing/index.js'

// The four engine triggers (pipeline / discovery / monitor / summary) are no
// longer scheduled here — they're timer input nodes owned by the routing engine
// (see routing/). This module keeps the infrastructure loops that aren't part of
// the user-facing routing graph: LLM retention, the 30s position reconcile, the
// endpoint-health probe, and the update check.

let positionCheckInterval: ReturnType<typeof setInterval> | null = null

const POSITION_CHECK_INTERVAL_MS = 30 * 1000 // every 30 seconds

// Runs the Agent Monitor engine. Shared by the routing monitor output and the
// `monitor_run_requested` bus handler so manual triggers route the same way.
export function dispatchMonitorRun(cycleId: string): Promise<void> {
  return runMonitor(cycleId)
}

// Runs whichever entry-signal engine `signal_model` resolves to. The classic research
// pipeline (researcher → extractor → analyst) and the agentic Agent Signal engine ('agent')
// are mutually exclusive. Shared by the manual pipeline-run bus handlers so they route the
// same way the scheduled trigger does.
export function dispatchPipelineRun(): Promise<void> {
  return getSettings().signal_model === 'agent'
    ? runAgentSignal(`${Date.now().toString(36)}-signal`)
    : runPipeline()
}
export function dispatchSingleCoinPipeline(symbol: string, cycleId: string): Promise<void> {
  return getSettings().signal_model === 'agent'
    ? runAgentSignalCoin(symbol, cycleId)
    : runSingleCoinPipeline(symbol, cycleId)
}

/**
 * Start the infrastructure loops: the daily LLM-retention job (also run once
 * now), the 30s position-check interval, the endpoint-health monitor, and the
 * update check. Engine triggers are started separately by initRouting().
 */
export function startSchedulers(settings: BotSettings): void {
  // Run retention on startup and then daily at 03:00 UTC. LLM calls archive into
  // aggregate stats; the high-volume pipeline_events/debug_logs prune by age.
  const runRetention = (phase: string) => {
    runLLMRetention().catch(err =>
      logger.warn(`LLM retention ${phase} failed`, { error: err instanceof Error ? err.message : String(err) }))
    runDataRetention().catch(err =>
      logger.warn(`Data retention ${phase} failed`, { error: err instanceof Error ? err.message : String(err) }))
  }
  runRetention('on startup')
  cron.schedule('0 3 * * *', () => runRetention('daily'))

  positionCheckInterval = setInterval(async () => {
    try { await checkOpenPositions() } catch (err) {
      logger.warn('Position check failed', { error: err instanceof Error ? err.message : String(err) })
    }
    // Keep blank-filter Binance input subscriptions aligned with the watched set,
    // and the held-coins cache fresh for the `heldOnly` toggle.
    try { refreshBinanceStreams() } catch { /* best-effort */ }
    void refreshHeldCoins()
  }, POSITION_CHECK_INTERVAL_MS)

  // Background LLM endpoint health monitor — drives the header status badge and
  // lets module routing divert away from a dead primary endpoint.
  startEndpointHealthMonitor()

  // Periodic "is origin/main ahead?" check — drives the sidebar update pin.
  scheduleUpdateCheck(settings.update_check_interval_hours)

  // Rolling app-usage sampler (per-container CPU/mem, Mongo footprint) feeding
  // the System page sparklines.
  startAppSampler()
}

/** Reschedule on settings save: sync the managed engine timers + re-probe endpoints. */
export function rescheduleFromSettings(updated: BotSettings): void {
  // Keep the routing graph's managed timer nodes in sync with the Settings page.
  void syncFromSettings(updated).catch(err =>
    logger.error('Routing sync from settings failed', { error: err instanceof Error ? err.message : String(err) }))
  // The catalog may have changed (endpoints added/removed/re-pointed) — re-probe now.
  runEndpointHealthCheck()
  // Update-check interval or enable flag may have changed.
  scheduleUpdateCheck(updated.update_check_interval_hours)
}

/** Stop all recurring loops (graceful shutdown). */
export function stopSchedulers(): void {
  if (positionCheckInterval) clearInterval(positionCheckInterval)
  stopRouting()
  stopEndpointHealthMonitor()
  stopUpdateCheck()
  stopAppSampler()
}
