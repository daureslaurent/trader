import { useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocket } from './useWebSocket'

export interface EndpointHealth {
  id: string
  name: string
  baseURL: string
  model: string
  status: 'up' | 'degraded' | 'down'
  /** Round-trip time of the probe in ms. */
  latencyMs: number
  /** Whether the configured model is advertised by the server. */
  modelPresent: boolean
  /** Failure reason when status is 'down'. */
  error?: string
  /** ISO timestamp of when the probe ran. */
  checkedAt: string
}

export interface EndpointHealthState {
  endpoints: EndpointHealth[]
  /** True until the first snapshot has loaded. */
  loading: boolean
  /** True if the backend itself was unreachable. */
  unreachable: boolean
  /** True while a manual re-check is in flight. */
  checking: boolean
  /** Local time of the last snapshot received. */
  lastChecked: Date | null
  /** Ask the backend to re-probe now. */
  refetch: () => void
}

/**
 * Live health of every LLM catalog endpoint for the header badge. Probing is done
 * entirely by the backend monitor — this hook seeds from the cached snapshot
 * (`GET /api/llm/endpoints/health`) on mount and then stays current via the
 * `endpoint_health` WebSocket broadcast. `refetch` asks the backend to re-probe
 * immediately (the result arrives over the same WS channel).
 */
export function useEndpointHealth(): EndpointHealthState {
  const [endpoints, setEndpoints] = useState<EndpointHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  const [checking, setChecking] = useState(false)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)

  const apply = (data: unknown) => {
    if (!Array.isArray(data)) return
    setEndpoints(data as EndpointHealth[])
    setUnreachable(false)
    setLastChecked(new Date())
  }

  // Seed from the cached snapshot on mount.
  useEffect(() => {
    let cancelled = false
    fetch('/api/llm/endpoints/health')
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(data => { if (!cancelled) apply(data) })
      .catch(() => { if (!cancelled) setUnreachable(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Stay live via the backend's broadcast.
  useWebSocket((event, data) => {
    if (event === 'endpoint_health') apply(data)
  })

  const inFlight = useRef(false)
  const refetch = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setChecking(true)
    try {
      const res = await fetch('/api/llm/endpoints/health/check', { method: 'POST' })
      if (!res.ok) throw new Error(String(res.status))
      apply(await res.json())
    } catch {
      setUnreachable(true)
    } finally {
      setChecking(false)
      inFlight.current = false
    }
  }, [])

  return { endpoints, loading, unreachable, checking, lastChecked, refetch }
}
