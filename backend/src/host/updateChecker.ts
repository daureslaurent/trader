// Periodic update-availability check. We can't run git inside the container, so
// this drops a `check` trigger for the host watcher (check_run.sh) which does the
// `git fetch` + comparison and writes status.json. We then read that file back,
// surface "an update is available" to the UI (pin), and — only the first time a
// given remote commit appears — push a Telegram notification + a live WS toast.
//
// Everything here is gated by the `update_enabled` setting (the same master switch
// as the destructive "Update app" action) and by the host bridge being wired up.
import { logger } from '../core/logger.js'
import { getSettings } from '../db/index.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { requestCheck, readUpdateStatus, getUpdateReadiness, type UpdateStatus } from './update.js'

// Remote SHA we've already notified about, so a still-pending update doesn't spam
// Telegram/toasts on every poll. Reset implicitly when a newer remote SHA appears.
let lastNotifiedSha: string | null = null

let checkInterval: ReturnType<typeof setInterval> | null = null

// How long to wait for the host watcher to produce a fresh status.json after we
// drop the trigger (git fetch is quick; this is a generous ceiling).
const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 30_000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Trigger a host-side check and process the result. No-op (returns the last known
 * status) when updates are disabled or the host bridge isn't ready. Safe to call
 * concurrently — the worst case is a redundant `git fetch` on the host.
 */
export async function runUpdateCheck(): Promise<UpdateStatus | null> {
  if (!getSettings().update_enabled) return readUpdateStatus()

  const readiness = await getUpdateReadiness()
  if (!readiness.ready) {
    logger.debug('Update check skipped — host bridge not ready', { reason: readiness.reason })
    return readUpdateStatus()
  }

  const before = await readUpdateStatus()
  const beforeAt = before?.checkedAt ?? ''

  try {
    await requestCheck({ by: 'auto' })
  } catch (err) {
    logger.warn('Failed to drop update-check trigger', { error: err instanceof Error ? err.message : String(err) })
    return before
  }

  // Poll until the host writes a newer status.json (checkedAt advances).
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let status: UpdateStatus | null = before
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const next = await readUpdateStatus()
    if (next && next.checkedAt !== beforeAt) {
      status = next
      break
    }
  }

  if (!status || status.checkedAt === beforeAt) {
    logger.warn('Update check timed out waiting for host status.json')
    return status
  }
  if (status.error) {
    logger.warn('Host update check reported an error', { error: status.error })
    return status
  }

  // Notify once per newly-seen remote commit.
  if (status.behindBy > 0 && status.remoteSha && status.remoteSha !== lastNotifiedSha) {
    lastNotifiedSha = status.remoteSha
    const latestSubject = status.commits[0]?.subject ?? ''
    logger.info('Update available', { behindBy: status.behindBy, remoteSha: status.remoteShortSha, latestSubject })
    broadcast('update_available', {
      updateCount: status.behindBy,
      currentShortSha: status.currentShortSha,
      remoteShortSha: status.remoteShortSha,
      latestSubject,
    })
    bus.emit('update_available', {
      updateCount: status.behindBy,
      currentShortSha: status.currentShortSha,
      remoteShortSha: status.remoteShortSha,
      latestSubject,
    })
  }

  return status
}

/**
 * (Re)start the periodic check loop. `intervalHours` comes from the
 * `update_check_interval_hours` setting (default 1). Also runs one check shortly
 * after startup so the pin reflects reality without waiting a full interval.
 */
export function scheduleUpdateCheck(intervalHours: number): void {
  stopUpdateCheck()

  const hours = Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 1
  const ms = Math.max(60_000, Math.round(hours * 60 * 60 * 1000))

  // Kick off an initial check a short while after boot (let the WS server + host
  // bridge settle first), then repeat on the interval.
  setTimeout(() => {
    runUpdateCheck().catch(err =>
      logger.warn('Initial update check failed', { error: err instanceof Error ? err.message : String(err) }))
  }, 15_000)

  checkInterval = setInterval(() => {
    runUpdateCheck().catch(err =>
      logger.warn('Scheduled update check failed', { error: err instanceof Error ? err.message : String(err) }))
  }, ms)

  logger.info('Update check scheduled', { everyHours: hours })
}

export function stopUpdateCheck(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}
