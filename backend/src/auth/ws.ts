// WebSocket authentication. Browsers can't set custom headers on a WebSocket
// handshake, so the token is passed as a `?token=` query param on the /ws URL.
// The raw upgrade request carries that URL; we verify before accepting the
// connection. No-op when auth is disabled.
import type { IncomingMessage } from 'node:http'
import { getAuthState } from './config.js'
import { verifyToken } from './token.js'

/** True if the WS upgrade request is allowed to connect. */
export function isWsRequestAuthorized(req: IncomingMessage): boolean {
  const state = getAuthState()
  if (!state.enabled) return true
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    const token = url.searchParams.get('token')
    return !!token && verifyToken(token, state.secret) !== null
  } catch {
    return false
  }
}
