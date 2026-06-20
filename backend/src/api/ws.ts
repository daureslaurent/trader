import { WebSocketServer, WebSocket } from 'ws'
import { Server } from 'http'
import { logger } from '../core/logger.js'
import { eventBuffer } from '../core/eventBuffer.js'
import { isWsRequestAuthorized } from '../auth/index.js'

let wss: WebSocketServer

/** Replay the event-stream gap to one socket using its last-seen seq cursor. */
function replayEventStream(ws: WebSocket, lastSeq: number): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const events = eventBuffer.since(Number.isFinite(lastSeq) ? lastSeq : 0)
  ws.send(JSON.stringify({
    type: 'EVENT_STREAM_TICK',
    data: { events, lastSeq: eventBuffer.lastSeq },
  }))
}

export function initWS(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket, req) => {
    // Authenticate the handshake (token passed as ?token= on the /ws URL, since
    // browsers can't set headers on a WebSocket). Reject with 1008 (policy
    // violation) when unauthorized; no-op when auth is disabled.
    if (!isWsRequestAuthorized(req)) {
      logger.warn('Rejected unauthenticated WebSocket connection')
      ws.close(1008, 'Unauthorized')
      return
    }

    logger.info('Frontend connected via WebSocket')
    ws.send(JSON.stringify({ type: 'connected' }))

    // Client-driven control messages. Currently only the Event Stream resync:
    // the client sends the last seq it saw and we replay just the gap.
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; lastSeq?: number }
        if (msg.type === 'event_stream_sync') {
          replayEventStream(ws, msg.lastSeq ?? 0)
        }
      } catch { /* ignore malformed client frames */ }
    })

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
