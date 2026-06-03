import { Router, Request, Response } from 'express'
import { getDB, getSettings, updateSetting } from '../db/index.js'
import { executeTrade } from '../trader/index.js'

export const router = Router()

router.get('/portfolio', (_req: Request, res: Response) => {
  const snapshots = getDB().prepare('SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1').all()
  const latest = snapshots[0] || null
  if (latest) (latest as any).holdings = JSON.parse((latest as any).holdings as string)
  res.json(latest || { total_value_usd: 0, holdings: {} })
})

router.get('/decisions', (_req: Request, res: Response) => {
  const decisions = getDB().prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 50').all()
  res.json(decisions)
})

router.get('/trades', (_req: Request, res: Response) => {
  const trades = getDB().prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT 50').all()
  res.json(trades)
})

router.post('/trade/approve/:id', (req: Request, res: Response) => {
  const { id } = req.params
  getDB().prepare('UPDATE trades SET approved = 1, status = ? WHERE id = ? AND status = ?')
    .run('PENDING', id, 'PENDING')
  res.json({ ok: true })
})

router.post('/trade/reject/:id', (req: Request, res: Response) => {
  const { id } = req.params
  getDB().prepare('UPDATE trades SET approved = 0, status = ? WHERE id = ? AND status = ?')
    .run('FAILED', id, 'PENDING')
  res.json({ ok: true })
})

router.post('/trade/manual', async (req: Request, res: Response) => {
  const { coin, side, quantity } = req.body
  try {
    const result = await executeTrade({ coin, action: side, quantity, reason: 'Manual', confidence: 1 })
    const stmt = getDB().prepare(
      'INSERT INTO trades (coin, side, quantity, price_usd, total_usd, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const info = stmt.run(coin, side, quantity, result.price, result.cost, 'EXECUTED', 1)
    res.json({ ok: true, id: info.lastInsertRowid })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/settings', (_req: Request, res: Response) => {
  res.json(getSettings())
})

router.put('/settings', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>
  for (const [key, value] of Object.entries(body)) {
    updateSetting(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  res.json(getSettings())
})
