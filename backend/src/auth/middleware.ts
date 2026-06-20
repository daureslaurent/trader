// Express auth guard. Attach to a router to require a valid bearer token on
// every request it covers. When auth is disabled, it's a transparent pass-through
// so local/dev deployments without credentials keep working.
import type { Request, Response, NextFunction } from 'express'
import { getAuthState } from './config.js'
import { verifyToken, type TokenClaims } from './token.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: TokenClaims
    }
  }
}

/** Pull a bearer token from the Authorization header, or null. */
export function extractBearer(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token.trim()
}

/** 401s any request without a valid token. No-op when auth is disabled. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const state = getAuthState()
  if (!state.enabled) {
    next()
    return
  }
  const token = extractBearer(req)
  const claims = token ? verifyToken(token, state.secret) : null
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  req.auth = claims
  next()
}
