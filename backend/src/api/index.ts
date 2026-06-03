import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { router } from './routes.js'
import { initWS } from './ws.js'

export function startAPI() {
  const app = express()
  app.use(cors())
  app.use(express.json())
  app.use('/api', router)

  const server = createServer(app)
  initWS(server)

  server.listen(config.port, () => {
    logger.info(`API server running on port ${config.port}`)
  })

  return server
}
