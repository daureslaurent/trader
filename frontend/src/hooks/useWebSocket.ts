import { useEffect, useRef, useCallback, useState } from 'react'

interface WsMessage {
  type: string
  data: unknown
}

export function useWebSocket(onMessage?: (msg: WsMessage) => void) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>
    let retries = 0
    let closed = false
    const maxRetries = 10

    function connect() {
      if (closed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${protocol}//${window.location.host}/ws`
      const socket = new WebSocket(url)
      ws.current = socket

      socket.onopen = () => {
        if (closed) { socket.close(); return }
        retries = 0
        setConnected(true)
      }

      socket.onclose = () => {
        setConnected(false)
        if (!closed && retries < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, retries), 30000)
          retries++
          reconnectTimer = setTimeout(connect, delay)
        }
      }

      socket.onerror = () => {
        socket.close()
      }

      socket.onmessage = (event) => {
        if (closed) return
        try {
          const msg = JSON.parse(event.data) as WsMessage
          onMessageRef.current?.(msg)
        } catch { /* ignore malformed */ }
      }
    }

    connect()

    return () => {
      closed = true
      clearTimeout(reconnectTimer)
      ws.current?.close()
    }
  }, [])

  const send = useCallback((msg: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg))
    }
  }, [])

  return { connected, send }
}
