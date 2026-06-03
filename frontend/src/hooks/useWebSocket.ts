import { useEffect, useRef, useCallback, useState } from 'react'

interface WsMessage {
  type: string
  data: unknown
}

export function useWebSocket(onMessage?: (msg: WsMessage) => void) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/ws`
    ws.current = new WebSocket(url)

    ws.current.onopen = () => setConnected(true)
    ws.current.onclose = () => setConnected(false)
    ws.current.onerror = () => setConnected(false)

    ws.current.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage
        onMessage?.(msg)
      } catch { /* ignore malformed */ }
    }

    return () => ws.current?.close()
  }, [])

  const send = useCallback((msg: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg))
    }
  }, [])

  return { connected, send }
}
