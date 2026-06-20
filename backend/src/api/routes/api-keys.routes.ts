// Debug API-key management — drives the Settings → API Keys card. Mounted INSIDE
// the authed domain router (behind requireAuth), so only a logged-in admin can
// mint or revoke keys. The plaintext token is returned exactly once, on create.
import { Router, type Request, type Response } from 'express'
import { listApiKeys, createApiKey, revokeApiKey } from '../../credentials/index.js'

export const router = Router()

const MAX_NAME_LEN = 60

// GET /account/api-keys — list keys (prefix only; hashes never leave the server).
router.get('/account/api-keys', (_req: Request, res: Response) => {
  res.json(listApiKeys())
})

// POST /account/api-keys { name } — mint a key; returns { id, name, token } once.
router.post('/account/api-keys', async (req: Request, res: Response) => {
  const raw = (req.body ?? {}) as { name?: unknown }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) {
    res.status(400).json({ error: 'A key name is required' })
    return
  }
  if (name.length > MAX_NAME_LEN) {
    res.status(400).json({ error: `Name must be at most ${MAX_NAME_LEN} characters` })
    return
  }
  res.json(await createApiKey(name))
})

// DELETE /account/api-keys/:id — revoke a key.
router.delete('/account/api-keys/:id', async (req: Request, res: Response) => {
  const removed = await revokeApiKey(req.params.id)
  if (!removed) {
    res.status(404).json({ error: 'Key not found' })
    return
  }
  res.json({ ok: true })
})
