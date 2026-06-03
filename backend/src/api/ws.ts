import { WebSocketServer, WebSocket } from 'ws'
import { Server } from 'http'
import { logger } from '../core/logger.js'

let wss: WebSocketServer

export function initWS(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket) => {
    logger.info('Frontend connected via WebSocket')
    ws.send(JSON.stringify({ type: 'connected' }))

    ws.on('close', () => logger.info('Frontend disconnected'))
    ws.on('error', (err) => logger.error('WebSocket error', { error: err.message }))
  })

  logger.info('WebSocket server initialized')
  return wss
}

export function broadcast(event: string, data: unknown): void {
  if (!wss) return
  const msg = JSON.stringify({ type: event, data })
  let count = 0
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
      count++
    }
  })
  if (count > 0) logger.debug('WS broadcast', { event, clients: count })
}
