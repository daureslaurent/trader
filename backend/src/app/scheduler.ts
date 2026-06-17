import cron from 'node-cron'
import { logger } from '../core/logger.js'
import { runLLMRetention, getSettings } from '../db/index.js'
import { BotSettings } from '../types.js'
import { checkOpenPositions } from '../portfolio/index.js'
import { runMonitor } from '../monitor/index.js'
import { runMonitorD } from '../agent/index.js'
import { startEndpointHealthMonitor, stopEndpointHealthMonitor, runEndpointHealthCheck } from '../core/endpointHealth.js'
import { scheduleUpdateCheck, stopUpdateCheck } from '../host/index.js'
import { syncFromSettings, stopRouting, refreshBinanceStreams } from '../routing/index.js'

// The four engine triggers (pipeline / discovery / monitor / summary) are no
// longer scheduled here — they're timer input nodes owned by the routing engine
// (see routing/). This module keeps the infrastructure loops that aren't part of
// the user-facing routing graph: LLM retention, the 30s position reconcile, the
// endpoint-health probe, and the update check.

let positionCheckInterval: ReturnType<typeof setInterval> | null = null

const POSITION_CHECK_INTERVAL_MS = 30 * 1000 // every 30 seconds

// Runs whichever monitor engine the selected `monitor_model` resolves to. The classic
// single-shot ensemble (a/b/alternate/ab/abc) and the Type D agentic monitor ('d') are
// mutually exclusive. Shared by the routing monitor output and the
// `monitor_run_requested` bus handler so manual triggers route the same way.
export function dispatchMonitorRun(cycleId: string): Promise<void> {
  return getSettings().monitor_model === 'd'
    ? runMonitorD(cycleId)
    : runMonitor(cycleId)
}

/**
 * Start the infrastructure loops: the daily LLM-retention job (also run once
 * now), the 30s position-check interval, the endpoint-health monitor, and the
 * update check. Engine triggers are started separately by initRouting().
 */
export function startSchedulers(settings: BotSettings): void {
  // Run LLM retention on startup and then daily at 03:00 UTC
  runLLMRetention().catch(err =>
    logger.warn('LLM retention on startup failed', { error: err instanceof Error ? err.message : String(err) }))
  cron.schedule('0 3 * * *', () => {
    runLLMRetention().catch(err =>
      logger.warn('LLM retention failed', { error: err instanceof Error ? err.message : String(err) }))
  })

  positionCheckInterval = setInterval(async () => {
    try { await checkOpenPositions() } catch (err) {
      logger.warn('Position check failed', { error: err instanceof Error ? err.message : String(err) })
    }
    // Keep blank-filter Binance input subscriptions aligned with the watched set.
    try { refreshBinanceStreams() } catch { /* best-effort */ }
  }, POSITION_CHECK_INTERVAL_MS)

  // Background LLM endpoint health monitor — drives the header status badge and
  // lets module routing divert away from a dead primary endpoint.
  startEndpointHealthMonitor()

  // Periodic "is origin/main ahead?" check — drives the sidebar update pin.
  scheduleUpdateCheck(settings.update_check_interval_hours)
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
}
