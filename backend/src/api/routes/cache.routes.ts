import { Router, Request, Response } from 'express'
import { extractionCache } from '../../db/index.js'

export const router = Router()

router.get('/cache', async (_req: Request, res: Response) => {
  try {
    const rows = await extractionCache.aggregate<{ coin: string; count: number }>([
      { $group: { _id: '$coin', count: { $sum: 1 } } },
      { $project: { _id: 0, coin: '$_id', count: 1 } },
      { $sort: { coin: 1 } },
    ])
    const total = rows.reduce((s, r) => s + r.count, 0)
    res.json({ coins: rows, total })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get('/cache/:coin', async (req: Request, res: Response) => {
  try {
    const coin = decodeURIComponent(req.params.coin)
    const rows = (await extractionCache.find(
      { coin },
      { sort: { cached_at: -1 }, projection: { _id: 0, url: 1, coin: 1, data: 1, cached_at: 1 } },
    )) as unknown as { url: string; coin: string; data: string; cached_at: string }[]
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

router.delete('/cache', async (_req: Request, res: Response) => {
  try {
    const deleted = await extractionCache.deleteMany({})
    res.json({ ok: true, deleted })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache/coin/:coin', async (req: Request, res: Response) => {
  try {
    const coin = decodeURIComponent(req.params.coin)
    const deleted = await extractionCache.deleteMany({ coin })
    res.json({ ok: true, deleted })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.delete('/cache/article', async (req: Request, res: Response) => {
  try {
    const { url } = req.body
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' })
    await extractionCache.deleteOne({ _id: url })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
