// Public auth endpoints (mounted WITHOUT requireAuth):
//   POST /api/auth/login   { username, password } -> { token, expiresAt, username }
//   GET  /api/auth/status                          -> { authEnabled, authenticated }
//
// Login is wrapped by a strict rate limiter (loginLimiter) to blunt brute-force
// attempts, and returns a single generic error for any bad credential to avoid
// leaking whether the username exists. The password check always runs so the
// response timing doesn't reveal a valid vs. invalid username.
import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { logger } from '../core/logger.js'
import { getAuthState } from './config.js'
import { verifyPassword } from './password.js'
import { signToken, verifyToken } from './token.js'
import { extractBearer } from './middleware.js'

// Scoped to the login POST only (NOT /status, which the UI polls freely).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
})

export const authRouter = Router()

// Tells the frontend whether the gateway is active and whether the presented
// token (if any) is currently valid. Always 200 — safe to call unauthenticated.
authRouter.get('/status', (req: Request, res: Response) => {
  const state = getAuthState()
  if (!state.enabled) {
    res.json({ authEnabled: false, authenticated: true })
    return
  }
  const token = extractBearer(req)
  const authenticated = !!token && verifyToken(token, state.secret) !== null
  res.json({ authEnabled: true, authenticated })
})

authRouter.post('/login', loginLimiter, (req: Request, res: Response) => {
  const state = getAuthState()
  if (!state.enabled) {
    // Nothing to log into — report success so the UI doesn't gate a fresh setup.
    res.json({ authEnabled: false })
    return
  }

  const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown }
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username and password are required' })
    return
  }

  const userOk = username === state.username
  const passOk = verifyPassword(password, state.passwordHash) // always run (constant-ish timing)
  if (!userOk || !passOk) {
    logger.warn('Failed login attempt', { username, ip: req.ip })
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const { token, expiresAt } = signToken(state.username, state.secret, state.tokenTtlSeconds)
  logger.info('Login succeeded', { username: state.username, ip: req.ip })
  res.json({ token, expiresAt, username: state.username })
})
