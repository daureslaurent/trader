import cron, { ScheduledTask } from 'node-cron'
import { logger } from '../core/logger.js'
import { runLLMRetention, getSettings } from '../db/index.js'
import { BotSettings } from '../types.js'
import { checkOpenPositions } from '../portfolio/index.js'
import { runDiscovery } from '../discoverer/index.js'
import { runMonitor } from '../monitor/index.js'
import { runMonitorD } from '../agent/index.js'
import { runPortfolioSummary } from '../summary/index.js'
import { runPipeline } from '../pipeline/index.js'
import { startEndpointHealthMonitor, stopEndpointHealthMonitor, runEndpointHealthCheck } from '../core/endpointHealth.js'
import { scheduleUpdateCheck, stopUpdateCheck } from '../host/index.js'

let cronTask: ScheduledTask | null = null
let discoveryCronTask: ScheduledTask | null = null
let monitorCronTask: ScheduledTask | null = null
let summaryCronTask: ScheduledTask | null = null
let positionCheckInterval: ReturnType<typeof setInterval> | null = null

const POSITION_CHECK_INTERVAL_MS = 30 * 1000 // every 30 seconds

export function schedulePipeline(expression: string): void {
  cronTask?.stop()
  if (!cron.validate(expression)) {
    logger.error('Invalid cron expression, falling back to hourly', { expression })
    expression = '0 * * * *'
  }
  cronTask = cron.schedule(expression, () => {
    runPipeline()
  })
  logger.info('Pipeline scheduled', { cron: expression })
}

export function scheduleDiscovery(expression: string): void {
  discoveryCronTask?.stop()
  if (!cron.validate(expression)) {
    logger.error('Invalid discovery cron expression, falling back to daily', { expression })
    expression = '0 6 * * *'
  }
  discoveryCronTask = cron.schedule(expression, () => {
    const cycleId = `${Date.now().toString(36)}-discovery`
    runDiscovery(cycleId)
  })
  logger.info('Discovery pipeline scheduled', { cron: expression })
}

// Runs whichever monitor engine the selected `monitor_model` resolves to. The classic
// single-shot ensemble (a/b/alternate/ab/abc) and the Type D agentic monitor ('d') are
// mutually exclusive — exactly one fires per cycle on the SAME monitor cron. Shared by
// the cron and the `monitor_run_requested` bus handler so manual triggers route too.
export function dispatchMonitorRun(cycleId: string): Promise<void> {
  return getSettings().monitor_model === 'd'
    ? runMonitorD(cycleId)
    : runMonitor(cycleId)
}

export function scheduleMonitor(expression: string, enabled: boolean): void {
  monitorCronTask?.stop()
  monitorCronTask = null
  if (!enabled) {
    logger.info('Position monitor auto-run disabled')
    return
  }
  if (!cron.validate(expression)) {
    logger.error('Invalid monitor cron expression, falling back to 4-hourly', { expression })
    expression = '0 */4 * * *'
  }
  monitorCronTask = cron.schedule(expression, () => {
    const cycleId = `${Date.now().toString(36)}-monitor`
    dispatchMonitorRun(cycleId).catch(err => {
      logger.error('Scheduled monitor run failed', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  logger.info('Position monitor scheduled', { cron: expression })
}

export function scheduleSummary(expression: string, enabled: boolean): void {
  summaryCronTask?.stop()
  summaryCronTask = null
  if (!enabled) {
    logger.info('Portfolio summary auto-run disabled')
    return
  }
  if (!cron.validate(expression)) {
    logger.error('Invalid summary cron expression, falling back to 6-hourly', { expression })
    expression = '0 */6 * * *'
  }
  summaryCronTask = cron.schedule(expression, () => {
    const cycleId = `${Date.now().toString(36)}-summary`
    runPortfolioSummary(cycleId).catch(err => {
      logger.error('Scheduled summary run failed', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  logger.info('Portfolio summary scheduled', { cron: expression })
}

/**
 * Start every recurring loop: pipeline / discovery / monitor crons, the daily
 * LLM-retention job (also run once now), and the 30s position-check interval.
 */
export function startSchedulers(settings: BotSettings): void {
  schedulePipeline(settings.pipeline_cron)
  scheduleDiscovery(settings.discover_cron)
  scheduleMonitor(settings.monitor_cron, settings.monitor_auto_run)
  scheduleSummary(settings.summary_cron, settings.summary_auto_run)

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
  }, POSITION_CHECK_INTERVAL_MS)

  // Background LLM endpoint health monitor — drives the header status badge and
  // lets module routing divert away from a dead primary endpoint.
  startEndpointHealthMonitor()

  // Periodic "is origin/main ahead?" check — drives the sidebar update pin.
  scheduleUpdateCheck(settings.update_check_interval_hours)
}

/** Reschedule the affected crons when the frontend saves new settings. */
export function rescheduleFromSettings(updated: BotSettings): void {
  if (updated.pipeline_cron) schedulePipeline(updated.pipeline_cron)
  if (updated.discover_cron) scheduleDiscovery(updated.discover_cron)
  scheduleMonitor(updated.monitor_cron, updated.monitor_auto_run)
  scheduleSummary(updated.summary_cron, updated.summary_auto_run)
  // The catalog may have changed (endpoints added/removed/re-pointed) — re-probe now.
  runEndpointHealthCheck()
  // Update-check interval or enable flag may have changed.
  scheduleUpdateCheck(updated.update_check_interval_hours)
}

/** Stop all recurring loops (graceful shutdown). */
export function stopSchedulers(): void {
  cronTask?.stop()
  discoveryCronTask?.stop()
  monitorCronTask?.stop()
  summaryCronTask?.stop()
  if (positionCheckInterval) clearInterval(positionCheckInterval)
  stopEndpointHealthMonitor()
  stopUpdateCheck()
}
