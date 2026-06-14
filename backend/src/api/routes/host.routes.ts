import { Router, Request, Response } from 'express'
import { getHostStats } from '../../host/index.js'
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
