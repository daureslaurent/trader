import { Router, Request, Response } from 'express'
import { queryAll, runSQL } from '../../db/index.js'

export const router = Router()

router.get('/cache', (_req: Request, res: Response) => {
  try {
    const rows = queryAll(
      "SELECT coin, COUNT(*) as count FROM extraction_cache GROUP BY coin ORDER BY coin ASC"
    ) as { coin: string; count: number }[]
    const total = rows.reduce((s, r) => s + r.count, 0)
    res.json({ coins: rows, total })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/cache/:coin', (req: Request, res: Response) => {
  try {
    const coin = decodeURIComponent(req.params.coin)
    const rows = queryAll(
      'SELECT url, coin, data, cached_at FROM extraction_cache WHERE coin = ? ORDER BY cached_at DESC',
      [coin]
    ) as { url: string; coin: string; data: string; cached_at: string }[]
    const articles = rows.map(r => {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(r.data) } catch {}
      return { url: r.url, coin: r.coin, cached_at: r.cached_at, ...parsed }
    })
    res.json(articles)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache', (_req: Request, res: Response) => {
  try {
    const info = runSQL('DELETE FROM extraction_cache')
    res.json({ ok: true, deleted: info.changes })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache/coin/:coin', (req: Request, res: Response) => {
  try {
    const coin = decodeURIComponent(req.params.coin)
    const info = runSQL('DELETE FROM extraction_cache WHERE coin = ?', [coin])
    res.json({ ok: true, deleted: info.changes })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache/article', (req: Request, res: Response) => {
  try {
    const { url } = req.body
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' })
    runSQL('DELETE FROM extraction_cache WHERE url = ?', [url])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
