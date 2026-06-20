import { useEffect, useRef, useCallback, useState } from 'react'
import { getToken } from '../lib/auth'

let sharedSocket: WebSocket | null = null
let listenerCount = 0
let sharedConnected = false
const messageListeners = new Set<(event: string, data: unknown) => void>()
const connectCallbacks = new Set<(connected: boolean) => void>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let retries = 0
const maxRetries = 10

function notifyConnect(connected: boolean) {
  connectCallbacks.forEach(fn => fn(connected))
}

function start() {
  if (sharedSocket?.readyState === WebSocket.OPEN || sharedSocket?.readyState === WebSocket.CONNECTING) return
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // Browsers can't set headers on a WS handshake, so the bearer token rides as a
  // query param; the backend verifies it before accepting the connection.
  const token = getToken()
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  sharedSocket = new WebSocket(`${protocol}//${window.location.host}/ws${query}`)

  sharedSocket.onopen = () => {
    retries = 0
    sharedConnected = true
    notifyConnect(true)
  }

  sharedSocket.onclose = () => {
    sharedConnected = false
    notifyConnect(false)
    if (listenerCount > 0 && retries < maxRetries) {
      const delay = Math.min(1000 * 2 ** retries, 30000)
      retries++
      reconnectTimer = setTimeout(start, delay)
    }
  }

  sharedSocket.onerror = () => sharedSocket?.close()

  sharedSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as { type: string; data: unknown }
      messageListeners.forEach(fn => fn(msg.type, msg.data))
    } catch { /* ignore malformed */ }
  }
}

function stop() {
  if (sharedSocket) {
    sharedSocket.onclose = null
    sharedSocket.close()
    sharedSocket = null
  }
  sharedConnected = false
  retries = 0
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
}

export function useWebSocket(
  onMessage?: (event: string, data: unknown) => void,
  onConnected?: (connected: boolean) => void,
) {
  const [connected, setConnected] = useState(sharedConnected)
  const msgRef = useRef(onMessage)
  const connRef = useRef(onConnected)
  msgRef.current = onMessage
  connRef.current = onConnected

  useEffect(() => {
    listenerCount++

    const msgHandler = (event: string, data: unknown) => msgRef.current?.(event, data)
    messageListeners.add(msgHandler)

    const connHandler = (c: boolean) => {
      setConnected(c)
      connRef.current?.(c)
    }
    connectCallbacks.add(connHandler)

    start()

    return () => {
      listenerCount--
      messageListeners.delete(msgHandler)
      connectCallbacks.delete(connHandler)
      if (listenerCount === 0) stop()
    }
  }, [])

  const send = useCallback((msg: unknown) => {
    if (sharedSocket?.readyState === WebSocket.OPEN) {
      sharedSocket.send(JSON.stringify(msg))
    }
  }, [])

  return { connected, send }
}
