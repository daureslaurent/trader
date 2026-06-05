import { useEffect, useRef, useCallback, useState } from 'react'

interface WsMessage {
  type: string
  data: unknown
}

let sharedSocket: WebSocket | null = null
let listenerCount = 0
let sharedConnected = false
const messageListeners = new Set<(msg: WsMessage) => void>()
const connectCallbacks = new Set<() => void>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let retries = 0
const maxRetries = 10

function notifyConnectCallbacks() {
  connectCallbacks.forEach(fn => fn())
}

function start() {
  if (sharedSocket?.readyState === WebSocket.OPEN || sharedSocket?.readyState === WebSocket.CONNECTING) return
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}/ws`
  sharedSocket = new WebSocket(url)

  sharedSocket.onopen = () => {
    retries = 0
    sharedConnected = true
    notifyConnectCallbacks()
  }

  sharedSocket.onclose = () => {
    sharedConnected = false
    notifyConnectCallbacks()
    if (listenerCount > 0 && retries < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, retries), 30000)
      retries++
      reconnectTimer = setTimeout(start, delay)
    }
  }

  sharedSocket.onerror = () => {
    sharedSocket?.close()
  }

  sharedSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as WsMessage
      messageListeners.forEach(fn => fn(msg))
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
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

export function useWebSocket(onMessage?: (msg: WsMessage) => void) {
  const [connected, setConnected] = useState(sharedConnected)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    listenerCount++

    const handler = (msg: WsMessage) => onMessageRef.current?.(msg)
    messageListeners.add(handler)

    function onConnectChange() {
      setConnected(sharedConnected)
    }
    connectCallbacks.add(onConnectChange)
    start()

    return () => {
      listenerCount--
      messageListeners.delete(handler)
      connectCallbacks.delete(onConnectChange)
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
