import { Router, Request, Response } from 'express'
import { getHostStats, requestUpdate, getUpdateReadiness } from '../../host/index.js'
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

// Whether the in-app update action is usable: the feature toggle plus whether the
// host bind mount is actually wired up so a trigger would reach the watcher.
router.get('/host/update', async (_req: Request, res: Response) => {
  try {
    const enabled = getSettings().update_enabled
    const readiness = await getUpdateReadiness()
    res.json({ enabled, ...readiness })
  } catch (err) {
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
