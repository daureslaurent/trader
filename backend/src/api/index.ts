import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import rateLimit from 'express-rate-limit'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { router } from './routes.js'
import { initWS } from './ws.js'

export function startAPI() {
  const app = express()
  app.use(cors())
  app.use(express.json())

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  })
  app.use('/api', apiLimiter)

  app.use('/api', router)

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled API error', { error: err.message })
    res.status(500).json({ error: err.message })
  })

  const server = createServer(app)
  initWS(server)

  server.listen(config.port, () => {
    logger.info(`API server running on port ${config.port}`)
  })

  return server
}
