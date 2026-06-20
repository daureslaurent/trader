// First-run setup + account management.
//
//   setupRouter  — PUBLIC (mounted before the auth guard). Only does anything
//                  while the app is unconfigured; once set up, the wizard locks.
//     GET  /api/setup/status   -> { configured, needsBinance, needsAdmin }
//     POST /api/setup          { binanceApiKey, binanceSecret, username, password }
//
//   accountRouter — PROTECTED (mounted inside the authed domain router). Rotates
//                   credentials after initial setup.
//     POST /api/account/binance-keys { binanceApiKey, binanceSecret }
//     POST /api/account/password     { currentPassword, newPassword }
import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { logger } from '../../core/logger.js'
import { bus } from '../../core/events.js'
import {
  isConfigured,
  isBinanceConfigured,
  isAdminConfigured,
  setBinanceKeys,
  setAdmin,
} from '../../credentials/index.js'
import { validateBinanceKeys, resetExchange } from '../../trader/index.js'
import { getAuthState, refreshAuthState } from '../../auth/index.js'
import { verifyPassword } from '../../auth/password.js'

const MIN_PASSWORD_LEN = 8

// A candidate string field must be a non-empty string after trimming.
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

// ── Public: first-run wizard ────────────────────────────────────────────────

export const setupRouter = Router()

// Strict limiter — the POST hits Binance to validate keys, so blunt abuse.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many setup attempts, please try again later' },
})

setupRouter.get('/setup/status', (_req: Request, res: Response) => {
  res.json({
    configured: isConfigured(),
    needsBinance: !isBinanceConfigured(),
    needsAdmin: !isAdminConfigured(),
  })
})

setupRouter.post('/setup', setupLimiter, async (req: Request, res: Response) => {
  // Lock the wizard once configured: refuse to overwrite credentials via the
  // unauthenticated path (rotation goes through the protected account routes).
  if (isConfigured()) {
    res.status(409).json({ error: 'Already configured' })
    return
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  const binanceApiKey = str(body.binanceApiKey)
  const binanceSecret = str(body.binanceSecret)
  const username = str(body.username)
  const password = typeof body.password === 'string' ? body.password : ''

  if (!binanceApiKey || !binanceSecret || !username || !password) {
    res.status(400).json({ error: 'binanceApiKey, binanceSecret, username and password are required' })
    return
  }
  if (password.length < MIN_PASSWORD_LEN) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` })
    return
  }

  const keyError = await validateBinanceKeys(binanceApiKey, binanceSecret)
  if (keyError) {
    res.status(400).json({ error: `Binance keys rejected: ${keyError}` })
    return
  }

  await setBinanceKeys(binanceApiKey, binanceSecret)
  await setAdmin(username, password)
  refreshAuthState() // gateway picks up the new admin
  resetExchange()    // next exchange call uses the new keys
  logger.info('First-run setup completed', { username })
  bus.emit('setup_completed') // lifecycle starts the trading engines

  res.json({ ok: true })
})

// ── Protected: credential rotation (behind requireAuth) ─────────────────────

export const accountRouter = Router()

accountRouter.post('/account/binance-keys', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const binanceApiKey = str(body.binanceApiKey)
  const binanceSecret = str(body.binanceSecret)
  if (!binanceApiKey || !binanceSecret) {
    res.status(400).json({ error: 'binanceApiKey and binanceSecret are required' })
    return
  }

  const keyError = await validateBinanceKeys(binanceApiKey, binanceSecret)
  if (keyError) {
    res.status(400).json({ error: `Binance keys rejected: ${keyError}` })
    return
  }

  await setBinanceKeys(binanceApiKey, binanceSecret)
  resetExchange()
  logger.info('Binance keys rotated')
  res.json({ ok: true })
})

accountRouter.post('/account/password', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

  if (newPassword.length < MIN_PASSWORD_LEN) {
    res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters` })
    return
  }

  const state = getAuthState()
  if (!state.enabled || !verifyPassword(currentPassword, state.passwordHash)) {
    res.status(401).json({ error: 'Current password is incorrect' })
    return
  }

  await setAdmin(state.username, newPassword)
  refreshAuthState()
  logger.info('Admin password changed', { username: state.username })
  res.json({ ok: true })
})
