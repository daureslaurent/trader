import { Router, Request, Response } from 'express'
import { getSettings, updateSetting } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { BotSettings } from '../../types.js'

export const router = Router()

router.get('/settings', (_req: Request, res: Response) => {
  res.json(getSettings())
})

router.put('/settings', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>
  for (const [key, value] of Object.entries(body)) {
    updateSetting(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const updated = getSettings()
  bus.emit('settings_updated', updated as BotSettings)
  res.json(updated)
})
