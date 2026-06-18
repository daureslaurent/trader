import { Router, Request, Response } from 'express'
import { getHostStats, requestUpdate, requestReboot, getUpdateReadiness, readUpdateStatus, runUpdateCheck } from '../../host/index.js'
import { getSettings } from '../../db/index.js'
import { logger } from '../../core/logger.js'

export const router = Router()

// Live host machine telemetry (CPU/RAM/temperature/system) for the Host page.
router.get('/host/stats', async (_req: Request, res: Response) => {
  try {
    res.json(await getHostStats())
  } catch (err) {
    logger.error('host stats failed', { err: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Update status: whether the action is usable (feature toggle + host bind mount
// wired up) plus the last known origin/main comparison. `updateAvailable` drives
// the sidebar pin and is fetched on load (so it survives a page reload).
router.get('/host/update', async (_req: Request, res: Response) => {
  try {
    const enabled = getSettings().update_enabled
    const readiness = await getUpdateReadiness()
    const status = await readUpdateStatus()
    const updateAvailable = enabled && !!status && status.behindBy > 0
    res.json({ enabled, ...readiness, status, updateAvailable })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Run a check now (read-only: host git fetch + status.json). Gated by the bridge
// being ready; independent of whether an update has been authorized to execute.
router.post('/host/update/check', async (_req: Request, res: Response) => {
  const readiness = await getUpdateReadiness()
  if (!readiness.ready) {
    res.status(503).json({ error: `Update host bridge not ready: ${readiness.reason}` })
    return
  }
  try {
    const status = await runUpdateCheck()
    const enabled = getSettings().update_enabled
    const updateAvailable = enabled && !!status && status.behindBy > 0
    res.json({ enabled, ...readiness, status, updateAvailable })
  } catch (err) {
    logger.error('manual update check failed', { err: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Signal the host watcher to pull latest main and rebuild/restart the stack.
// Gated by the update_enabled setting so the action can't fire unless explicitly
// turned on. This only drops a trigger file — the actual update runs on the host.
router.post('/host/update', async (_req: Request, res: Response) => {
  if (!getSettings().update_enabled) {
    res.status(403).json({ error: 'App updates are disabled. Enable them in Settings → System first.' })
    return
  }
  const readiness = await getUpdateReadiness()
  if (!readiness.ready) {
    res.status(503).json({ error: `Update host bridge not ready: ${readiness.reason}` })
    return
  }
  try {
    await requestUpdate({ by: 'web' })
    logger.warn('host self-update requested via web')
    res.json({ ok: true })
  } catch (err) {
    logger.error('host update trigger failed', { err: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Signal the host watcher to restart the stack (`docker compose restart`) without
// pulling or rebuilding. Shares the update master switch + host bridge as the
// single trust boundary for letting the app command the host lifecycle. Only
// drops a trigger file — the actual restart runs on the host.
router.post('/host/reboot', async (_req: Request, res: Response) => {
  if (!getSettings().update_enabled) {
    res.status(403).json({ error: 'Host actions are disabled. Enable them in Settings → System first.' })
    return
  }
  const readiness = await getUpdateReadiness()
  if (!readiness.ready) {
    res.status(503).json({ error: `Update host bridge not ready: ${readiness.reason}` })
    return
  }
  try {
    await requestReboot({ by: 'web' })
    logger.warn('host stack reboot requested via web')
    res.json({ ok: true })
  } catch (err) {
    logger.error('host reboot trigger failed', { err: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
