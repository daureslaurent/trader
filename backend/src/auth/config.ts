// Resolves the raw AUTH_* env into a single, validated auth state used across
// the auth module. Decisions made here:
//
//  - Auth is ENABLED when a credential (password hash or plaintext) is present,
//    unless AUTH_ENABLED is explicitly 'false'. AUTH_ENABLED='true' with no
//    credential is a hard config error (fail closed — don't pretend to be
//    protected). With no credential and no explicit flag, auth is OFF so an
//    existing local deployment keeps working (with a loud warning).
//  - A plaintext AUTH_PASSWORD is hashed once at boot; AUTH_PASSWORD_HASH wins
//    if both are set.
//  - AUTH_SECRET signs the bearer tokens. If auth is enabled but no secret is
//    set, we generate a strong random one for this process and warn — tokens
//    then reset on restart. Set AUTH_SECRET for stable sessions.
import { randomBytes } from 'node:crypto'
import { config } from '../config/index.js'
import { BotError } from '../core/errors.js'
import { logger } from '../core/logger.js'
import { getAuthCreds } from '../credentials/index.js'

export interface AuthState {
  enabled: boolean
  username: string
  passwordHash: string
  secret: string
  tokenTtlSeconds: number
}

function resolve(): AuthState {
  const a = config.auth
  // The credential store merges DB (setup wizard / rotation) over env, and owns
  // the signing secret (a stable, persisted one once the wizard has run).
  const creds = getAuthCreds()
  const hasCredential = creds !== null
  const explicit = a.enabled === 'true' ? true : a.enabled === 'false' ? false : undefined

  if (explicit === true && !hasCredential) {
    throw new BotError('AUTH_ENABLED=true requires an admin login (set up via the wizard or AUTH_PASSWORD)', 'AUTH_MISCONFIGURED')
  }

  const enabled = explicit ?? hasCredential

  if (!enabled || !creds) {
    logger.warn(
      'Authentication is DISABLED — the API and WebSocket are open to anyone who can reach this port. ' +
      'Complete the setup wizard (or set AUTH_PASSWORD) to protect the trader.',
    )
    return { enabled: false, username: a.username, passwordHash: '', secret: '', tokenTtlSeconds: 0 }
  }

  let secret = creds.secret
  if (!secret) {
    secret = randomBytes(48).toString('hex')
    logger.warn(
      'AUTH_SECRET is not set — generated an ephemeral signing secret. ' +
      'All sessions will be invalidated on restart. Set AUTH_SECRET for stable logins.',
    )
  } else if (secret.length < 16) {
    throw new BotError('AUTH_SECRET must be at least 16 characters', 'AUTH_MISCONFIGURED')
  }

  logger.info('Authentication gateway enabled', { username: creds.username, tokenTtlMinutes: a.tokenTtlMinutes })
  return {
    enabled: true,
    username: creds.username,
    passwordHash: creds.passwordHash,
    secret,
    tokenTtlSeconds: Math.max(60, a.tokenTtlMinutes * 60),
  }
}

let cached: AuthState | null = null

/** The resolved auth state (computed once, then cached). */
export function getAuthState(): AuthState {
  if (!cached) cached = resolve()
  return cached
}

/**
 * Drop the cached auth state so the next getAuthState() re-resolves from the
 * credential store. Call after the setup wizard creates the admin, or after a
 * password change, so the gateway picks up the new credential without a restart.
 */
export function refreshAuthState(): void {
  cached = null
}
