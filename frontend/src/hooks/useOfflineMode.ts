import { useEffect, useState } from 'react'
import { useWebSocket } from './useWebSocket'

export type OfflineReason = 'forced' | 'endpoints_down' | 'online'

export interface OfflineState {
  active: boolean
  reason: OfflineReason
}

/**
 * The bot's effective LLM/offline mode for the header badge. The backend is the source of
 * truth (manual override OR auto-fallback when every endpoint is down): we seed from
 * `GET /api/llm/offline-mode` on mount, then stay live via the `offline_mode` WS broadcast.
 */
export function useOfflineMode(): OfflineState {
  const [state, setState] = useState<OfflineState>({ active: false, reason: 'online' })

  useEffect(() => {
    let cancelled = false
    fetch('/api/llm/offline-mode')
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(data => { if (!cancelled && data && typeof data.active === 'boolean') setState(data) })
      .catch(() => { /* leave default (online) — the WS broadcast will correct it */ })
    return () => { cancelled = true }
  }, [])

  useWebSocket((event, data) => {
    if (event === 'offline_mode' && data && typeof (data as OfflineState).active === 'boolean') {
      setState(data as OfflineState)
    }
  })

  return state
}
