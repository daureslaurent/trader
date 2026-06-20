import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import rateLimit from 'express-rate-limit'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { router } from './routes.js'
import { initWS } from './ws.js'
import { initEventStream } from './eventStream.js'
import { authRouter, requireAuth, getAuthState } from '../auth/index.js'
import { setupRouter } from './routes/setup.routes.js'

export function startAPI() {
  const app = express()
  app.use(cors())
  // Global JSON parser keeps the default ~100kb limit, but skips the DB import
  // route — its body can be very large and is parsed by a dedicated high-limit
  // parser in database.routes.ts.
  const jsonParser = express.json()
  app.use((req, res, next) =>
    req.path === '/api/database/import' ? next() : jsonParser(req, res, next))

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  })
  app.use('/api', apiLimiter)

  // Resolve auth config once at startup (validates and logs enabled/disabled).
  getAuthState()

  // Public auth endpoints (login / status) — mounted BEFORE the guard so they
  // remain reachable without a token. The login route carries its own strict
  // rate limiter internally.
  app.use('/api/auth', authRouter)

  // Public first-run setup endpoints (status + the wizard POST). Mounted BEFORE
  // the guard so a fresh, credential-less deployment can configure itself; the
  // wizard locks itself once configured.
  app.use('/api', setupRouter)

  // Everything else under /api requires a valid bearer token (no-op if auth is
  // disabled). The guard sits in front of the full domain router.
  app.use('/api', requireAuth, router)

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled API error', { error: err.message })
    res.status(500).json({ error: err.message })
  })

  const server = createServer(app)
  initWS(server)
  initEventStream()

  server.listen(config.port, () => {
    logger.info(`API server running on port ${config.port}`)
  })

  return server
}
