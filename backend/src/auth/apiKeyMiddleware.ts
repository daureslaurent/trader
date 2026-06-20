// Express guard for the read-only debug API. A request must carry a valid debug
// API key (created in Settings → API Keys) in either the `Authorization: Bearer`
// header or an `X-API-Key` header. This is an INDEPENDENT auth domain from the
// admin-login bearer tokens (requireAuth): non-interactive tooling authenticates
// with an API key, never a session token. There is no "disabled" pass-through —
// the debug API is always key-gated.
import type { Request, Response, NextFunction } from 'express'
import { verifyApiKey, type ApiKeyInfo } from '../credentials/index.js'
import { extractBearer } from './middleware.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyInfo
    }
  }
}

/** Pull the API key from `X-API-Key` or an `Authorization: Bearer` header. */
function extractApiKey(req: Request): string | null {
  const header = req.headers['x-api-key']
  if (typeof header === 'string' && header.trim()) return header.trim()
  return extractBearer(req)
}

/** 401s any request without a valid debug API key. */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const token = extractApiKey(req)
  const key = token ? verifyApiKey(token) : null
  if (!key) {
    res.status(401).json({ error: 'Invalid or missing API key' })
    return
  }
  req.apiKey = key
  next()
}
