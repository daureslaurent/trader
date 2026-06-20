import { Router, Request, Response } from 'express'
import express from 'express'
import {
  exportCollections, importCollections, resolveExportSelection,
  getDbStats, clearCaches, reseedCounters, ensureIndexes,
} from '../../db/index.js'
import { logger } from '../../core/logger.js'

export const router = Router()

// Live per-collection counts for the Settings → Database stats panel.
router.get('/database/stats', async (_req: Request, res: Response) => {
  try {
    res.json(await getDbStats())
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Export selected collections (or 'all') as a downloadable JSON backup.
router.post('/database/export', async (req: Request, res: Response) => {
  try {
    const { collections = 'all', includeCaches = false } = (req.body ?? {}) as {
      collections?: string[] | 'all'
      includeCaches?: boolean
    }
    const names = resolveExportSelection(collections, !!includeCaches)
    const dump = await exportCollections(names)
    const stamp = dump.exportedAt.replace(/[: ]/g, '-')
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="cryptobot-backup-${stamp}.json"`)
    res.send(JSON.stringify(dump))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Import a backup, replacing the contents of each collection it contains. A
// dedicated large JSON body parser overrides the global 100kb limit for the
// (potentially very large) upload.
router.post('/database/import', express.json({ limit: '256mb' }), async (req: Request, res: Response) => {
  try {
    logger.warn('Database import requested')
    const result = await importCollections(req.body)
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Maintenance: empty all cache/log collections.
router.post('/database/clear-caches', async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, cleared: await clearCaches() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Maintenance: reseed integer-id counters to the current max id.
router.post('/database/reseed-counters', async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, seeded: await reseedCounters() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Maintenance: re-ensure all indexes (idempotent).
router.post('/database/reindex', async (_req: Request, res: Response) => {
  try {
    await ensureIndexes()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
