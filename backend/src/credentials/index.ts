// Credential store — Binance keys + admin login, env-seeded and DB-backed.
// Public API (per the "every module exposes its API via index.ts" convention).
export {
  loadCredentials,
  getBinanceKeys,
  getAuthCreds,
  isBinanceConfigured,
  isAdminConfigured,
  isConfigured,
  setBinanceKeys,
  setAdmin,
} from './store.js'
export {
  loadApiKeys,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  verifyApiKey,
  type ApiKeyInfo,
} from './apiKeys.js'
