// Debug API keys — long-lived bearer tokens that let the `tools/` CLIs (and the
// AI driving them) read bot data over the read-only debug API, WITHOUT direct DB
// access. Distinct from the admin login: these authenticate non-interactive
// tooling, are created/revoked from Settings → API Keys, and never expire.
//
// Storage mirrors the credential store (store.ts): a single in-memory cache
// hydrated once at boot, persisted in `app_config` (NOT a settings/ALL_REPOS
// collection) so the hashes can't leak via GET /settings, a DB export, or the
// debug query proxy (which is whitelisted to ALL_REPOS). Tokens are stored only
// as a SHA-256 hash — a fast hash is appropriate because the token is a
// high-entropy random secret (unlike a low-entropy password), so there's nothing
// to brute-force; verification is a constant-time compare.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { appConfig } from '../db/repositories.js'
import { nowSql } from '../db/time.js'
import { logger } from '../core/logger.js'

const K_API_KEYS = 'api_keys'
const TOKEN_PREFIX = 'cbk_' // cryptobot key
const PREFIX_DISPLAY_LEN = 12 // how much of the token we keep for display

interface ApiKeyRecord {
  id: string
  name: string
  hash: string // SHA-256 hex of the full token
  prefix: string // first chars of the token, for display
  created_at: string
  last_used_at: string | null
}

/** Public shape — never includes the hash. */
export interface ApiKeyInfo {
  id: string
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
}

let cache: ApiKeyRecord[] | null = null

function ensureLoaded(): ApiKeyRecord[] {
  if (!cache) throw new Error('API key store used before loadApiKeys()')
  return cache
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function persist(): Promise<void> {
  await appConfig.upsert(K_API_KEYS, { keys: ensureLoaded() })
}

function toInfo(r: ApiKeyRecord): ApiKeyInfo {
  return { id: r.id, name: r.name, prefix: r.prefix, created_at: r.created_at, last_used_at: r.last_used_at }
}

/**
 * Hydrate the in-memory cache from the DB. Must run once at boot (after initDB)
 * before verifyApiKey() is first used on a request.
 */
export async function loadApiKeys(): Promise<void> {
  const doc = (await appConfig.findById(K_API_KEYS)) as { keys?: ApiKeyRecord[] } | null
  cache = Array.isArray(doc?.keys) ? doc!.keys : []
}

/** All keys, hashes stripped — for the Settings list. */
export function listApiKeys(): ApiKeyInfo[] {
  return ensureLoaded().map(toInfo).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/**
 * Mint a new key. Returns the **plaintext token once** (it is never recoverable
 * afterwards — only its hash is stored).
 */
export async function createApiKey(name: string): Promise<{ id: string; name: string; token: string }> {
  const keys = ensureLoaded()
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const record: ApiKeyRecord = {
    id: randomBytes(8).toString('hex'),
    name,
    hash: sha256(token),
    prefix: token.slice(0, PREFIX_DISPLAY_LEN),
    created_at: nowSql(),
    last_used_at: null,
  }
  keys.push(record)
  await persist()
  logger.info('API key created', { id: record.id, name })
  return { id: record.id, name, token }
}

/** Revoke a key by id. Returns true if a key was removed. */
export async function revokeApiKey(id: string): Promise<boolean> {
  const keys = ensureLoaded()
  const idx = keys.findIndex(k => k.id === id)
  if (idx === -1) return false
  keys.splice(idx, 1)
  await persist()
  logger.info('API key revoked', { id })
  return true
}

/**
 * Resolve a presented token to its key record, or null. Constant-time compares
 * the SHA-256 against every stored hash (no early-exit on the matching key), and
 * stamps last_used_at on a hit (fire-and-forget persist — failures are logged,
 * never block the request).
 */
export function verifyApiKey(token: string): ApiKeyInfo | null {
  const keys = ensureLoaded()
  const presented = Buffer.from(sha256(token), 'hex')
  let match: ApiKeyRecord | null = null
  for (const k of keys) {
    const stored = Buffer.from(k.hash, 'hex')
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = k
  }
  if (!match) return null
  match.last_used_at = nowSql()
  void persist().catch(err =>
    logger.warn('Failed to persist API key last_used_at', { error: err instanceof Error ? err.message : String(err) }),
  )
  return toInfo(match)
}
