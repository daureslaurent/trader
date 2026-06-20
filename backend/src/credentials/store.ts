// The credential store — the single source of truth for the Binance API keys and
// the admin login, plus the bearer-token signing secret and the at-rest
// encryption master key.
//
// Precedence (decided with the user): the DB wins, env is the bootstrap/fallback.
//   - If the first-run setup wizard wrote credentials to the `app_config`
//     collection, those are used (the Binance secret encrypted at rest).
//   - Otherwise the BINANCE_*/AUTH_* env vars seed the values, so an existing
//     env/helm-secret deployment keeps working and skips the wizard entirely.
//
// Reads are synchronous (getExchange / getAuthState run in hot paths), so the
// store is cached in memory: loadCredentials() hydrates it once at boot and the
// setters keep it current. Secrets are deliberately not put in the settings
// cache (see db/repositories.ts appConfig) so they can't leak via GET /settings.
import { randomBytes } from 'node:crypto'
import { appConfig } from '../db/repositories.js'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { hashPassword } from '../auth/password.js'
import { encryptSecret, decryptSecret } from './crypto.js'

// app_config document ids.
const K_MASTER_KEY = 'encryption_key'
const K_AUTH_SECRET = 'auth_secret'
const K_ADMIN = 'admin'
const K_BINANCE = 'binance_keys'

interface BinanceKeys { apiKey: string; secret: string }
interface AdminCred { username: string; passwordHash: string }

interface CredCache {
  masterKey: string
  authSecret: string
  admin: AdminCred | null
  binance: BinanceKeys | null
}

let cache: CredCache | null = null

function ensureLoaded(): CredCache {
  if (!cache) throw new Error('Credential store used before loadCredentials()')
  return cache
}

async function readDoc(id: string): Promise<Record<string, any> | null> {
  return (await appConfig.findById(id)) as Record<string, any> | null
}

/**
 * Hydrate the in-memory credential cache from the DB. Must run once after initDB,
 * before getExchange()/getAuthState() are first used. Resolves (and, if needed,
 * generates + persists) the at-rest master key here so later setters are sync.
 */
export async function loadCredentials(): Promise<void> {
  // Master encryption key: env wins (the helm/k8s-secret path). Without it we
  // generate one and persist it so encrypted blobs survive restarts — but that
  // weakens protection against a DB dump (the key sits next to the data), so warn.
  let masterKey = config.encryptionKey
  if (!masterKey) {
    const existing = await readDoc(K_MASTER_KEY)
    if (existing?.value) {
      masterKey = existing.value as string
    } else {
      masterKey = randomBytes(32).toString('hex')
      await appConfig.upsert(K_MASTER_KEY, { value: masterKey })
      logger.warn(
        'APP_ENCRYPTION_KEY is not set — generated and stored a master key in the DB. ' +
        'Secrets are encrypted at rest, but a DB dump would also contain the key. ' +
        'Set APP_ENCRYPTION_KEY (e.g. a k8s secret) for real at-rest protection.',
      )
    }
  }

  // Bearer-token signing secret: env wins, else DB, else generate + persist so
  // sessions survive restarts (unlike the auth module's ephemeral fallback).
  let authSecret = config.auth.secret
  if (!authSecret) {
    const existing = await readDoc(K_AUTH_SECRET)
    if (existing?.value) {
      authSecret = existing.value as string
    } else {
      authSecret = randomBytes(48).toString('hex')
      await appConfig.upsert(K_AUTH_SECRET, { value: authSecret })
    }
  }

  // Admin login + Binance keys from the DB (the setup wizard / rotation writes).
  const adminDoc = await readDoc(K_ADMIN)
  const admin: AdminCred | null =
    adminDoc?.username && adminDoc?.password_hash
      ? { username: adminDoc.username as string, passwordHash: adminDoc.password_hash as string }
      : null

  let binance: BinanceKeys | null = null
  const binDoc = await readDoc(K_BINANCE)
  if (binDoc?.api_key_enc && binDoc?.secret_enc) {
    try {
      binance = {
        apiKey: decryptSecret(binDoc.api_key_enc as string, masterKey),
        secret: decryptSecret(binDoc.secret_enc as string, masterKey),
      }
    } catch (err) {
      logger.error('Failed to decrypt stored Binance keys (wrong APP_ENCRYPTION_KEY?)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  cache = { masterKey, authSecret, admin, binance }
}

// ── Reads (synchronous, served from cache) ──────────────────────────────────

/** Effective Binance keys: DB-stored if present, else the env fallback, else null. */
export function getBinanceKeys(): BinanceKeys | null {
  const c = ensureLoaded()
  if (c.binance) return c.binance
  if (config.binance.apiKey && config.binance.secret) {
    return { apiKey: config.binance.apiKey, secret: config.binance.secret }
  }
  return null
}

/** Effective admin login. Returns null when no password is configured (DB or env). */
export function getAuthCreds(): { username: string; passwordHash: string; secret: string } | null {
  const c = ensureLoaded()
  if (c.admin) {
    return { username: c.admin.username, passwordHash: c.admin.passwordHash, secret: c.authSecret }
  }
  // Env fallback: a precomputed hash, or a plaintext convenience password.
  const envHash = config.auth.passwordHash || (config.auth.password ? hashPassword(config.auth.password) : '')
  if (envHash) {
    return { username: config.auth.username, passwordHash: envHash, secret: c.authSecret }
  }
  return null
}

export function isBinanceConfigured(): boolean {
  return getBinanceKeys() !== null
}

export function isAdminConfigured(): boolean {
  return getAuthCreds() !== null
}

/** First-run is "complete" once both the exchange keys and the admin login exist. */
export function isConfigured(): boolean {
  return isBinanceConfigured() && isAdminConfigured()
}

// ── Writes (persist + refresh cache) ────────────────────────────────────────

/** Store (encrypted) Binance keys and refresh the cache. */
export async function setBinanceKeys(apiKey: string, secret: string): Promise<void> {
  const c = ensureLoaded()
  await appConfig.upsert(K_BINANCE, {
    api_key_enc: encryptSecret(apiKey, c.masterKey),
    secret_enc: encryptSecret(secret, c.masterKey),
  })
  c.binance = { apiKey, secret }
}

/** Create/replace the admin login (scrypt-hashed) and refresh the cache. */
export async function setAdmin(username: string, plainPassword: string): Promise<void> {
  const c = ensureLoaded()
  const passwordHash = hashPassword(plainPassword)
  await appConfig.upsert(K_ADMIN, { username, password_hash: passwordHash })
  c.admin = { username, passwordHash }
}
