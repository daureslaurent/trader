import { useEffect, useRef, useState } from 'react'
import { useWebSocket } from './useWebSocket'

export interface ActiveLLMCall {
  module: string
  coin: string | null
  /** 'queued' = waiting in the per-URL serialization list; 'running' = in flight. */
  status: 'queued' | 'running'
  /** Model + base URL the call is bound to — used to resolve the catalog endpoint. */
  model: string
  base_url: string
  /** UTC 'YYYY-MM-DD HH:MM:SS' when the call was enqueued. */
  created_at: string
  /** UTC timestamp the request actually went in flight; null while still queued. */
  running_at: string | null
}

/** Shape of the running-call payload from the backend (REST seed + WS events). */
interface RunningCallPayload {
  temp_id: string
  module: string
  coin: string | null
  status?: 'queued' | 'running'
  model?: string
  base_url?: string
  created_at?: string
  running_at?: string | null
}

function toCall(c: RunningCallPayload): ActiveLLMCall {
  return {
    module: c.module,
    coin: c.coin ?? null,
    status: c.status ?? 'running',
    model: c.model ?? '',
    base_url: c.base_url ?? '',
    created_at: c.created_at ?? '',
    running_at: c.running_at ?? null,
  }
}

/**
 * Tracks LLM calls currently in flight across the backend. State is seeded from
 * `/api/llm-calls/running` on mount (so a freshly-loaded tab reflects work that
 * started before it connected) and kept live via the `llm_call_start` /
 * `llm_call_status` / `llm_call` WebSocket events emitted by `core/llm.ts`.
 */
export function useLLMActivity(): ActiveLLMCall[] {
  const [active, setActive] = useState<ActiveLLMCall[]>([])
  // temp_id -> call. Kept in a ref so the WS handler always sees the latest map.
  const callsRef = useRef<Map<string, ActiveLLMCall>>(new Map())

  const sync = () => setActive(Array.from(callsRef.current.values()))

  useEffect(() => {
    let cancelled = false
    fetch('/api/llm-calls/running')
      .then(r => r.json())
      .then((running: RunningCallPayload[]) => {
        if (cancelled || !Array.isArray(running)) return
        for (const c of running) {
          callsRef.current.set(c.temp_id, toCall(c))
        }
        sync()
      })
      .catch(() => { /* offline — WS events will populate once connected */ })
    return () => { cancelled = true }
  }, [])

  useWebSocket((event, data) => {
    if (event === 'llm_call_start') {
      const c = data as RunningCallPayload
      callsRef.current.set(c.temp_id, toCall(c))
      sync()
    } else if (event === 'llm_call_status') {
      const c = data as { temp_id?: string; status?: 'queued' | 'running'; running_at?: string | null }
      const existing = c.temp_id ? callsRef.current.get(c.temp_id) : undefined
      if (existing && c.status) {
        existing.status = c.status
        if (c.running_at !== undefined) existing.running_at = c.running_at
        sync()
      }
    } else if (event === 'llm_call') {
      const c = data as { temp_id?: string }
      if (c.temp_id && callsRef.current.delete(c.temp_id)) sync()
    }
  })

  return active
}
