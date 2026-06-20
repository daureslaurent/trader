import { getSettings } from '../db/index.js'
import { broadcast } from '../api/ws.js'
import { logger } from './logger.js'
import { pingEndpoint } from './llm.js'
import type { EndpointPing } from './llm.js'

/** Cached health of a single LLM catalog endpoint. */
export interface EndpointHealth {
  id: string
  name: string
  baseURL: string
  model: string
  /** up = reachable & model advertised · degraded = reachable, model missing · down = unreachable · disabled = taken out of rotation by the user (not probed). */
  status: 'up' | 'degraded' | 'down' | 'disabled'
  /** Round-trip time of the last probe in ms. */
  latencyMs: number
  /** Whether the configured model is advertised by the server. */
  modelPresent: boolean
  /** Failure reason when status is 'down'. */
  error?: string
  /** ISO timestamp of the probe. */
  checkedAt: string
}

// Latest probe results, keyed implicitly by catalog order. Read by the API and by
// LLM routing; refreshed by the background monitor.
let cache: EndpointHealth[] = []
// Coalesces overlapping checks (scheduled tick + manual recheck) into one probe.
let pending: Promise<EndpointHealth[]> | null = null
let timer: ReturnType<typeof setInterval> | null = null

const DEFAULT_INTERVAL_MS = 30 * 1000

// Loose match between a configured model id and what a server advertises. Servers
// vary (Ollama tags models `name:tag`, llama.cpp may report a file path or alias),
// so accept an exact hit, a tag-prefix hit, or either id containing the other.
function modelAdvertised(configured: string, advertised: string[]): boolean {
  const want = configured.trim().toLowerCase()
  if (!want) return false
  return advertised.some(m => {
    const have = m.toLowerCase()
    return have === want || have.startsWith(`${want}:`) || have.includes(want) || want.includes(have)
  })
}

/** The latest cached health snapshot (empty until the first check completes). */
export function getEndpointHealth(): EndpointHealth[] {
  return cache
}

/**
 * Whether the catalog endpoint backing this target is positively known to be down.
 * Targets not in the catalog (e.g. env-var fallbacks) have no health entry and are
 * treated as healthy — we only ever divert away from an endpoint we *know* is dead.
 */
export function isEndpointDown(baseURL: string, model: string): boolean {
  const e = cache.find(h => h.baseURL === baseURL && h.model === model)
  return e ? e.status === 'down' : false
}

async function probeAll(): Promise<EndpointHealth[]> {
  const endpoints = getSettings().llm_endpoints ?? []
  // Several catalog entries can share a base URL — probe each URL once.
  const pings = new Map<string, Promise<EndpointPing>>()
  const probe = (baseURL: string) => {
    let p = pings.get(baseURL)
    if (!p) { p = pingEndpoint(baseURL); pings.set(baseURL, p) }
    return p
  }

  const checkedAt = new Date().toISOString()
  // One health row per (endpoint, model). The probe is still issued once per base
  // URL (shared via `probe`), then fanned out across that endpoint's models.
  return Promise.all(
    endpoints.flatMap(ep => {
      const baseURL = ep.baseURL.trim()
      return ep.models.map(async (m): Promise<EndpointHealth> => {
        // A user-disabled endpoint or model is intentionally out of rotation —
        // never probe it; report `disabled` so the UI distinguishes it from an outage.
        if (ep.disabled || m.disabled) {
          return { id: m.id, name: ep.name, baseURL, model: m.model, status: 'disabled', latencyMs: 0, modelPresent: false, checkedAt }
        }
        if (!baseURL || !m.model.trim()) {
          return { id: m.id, name: ep.name, baseURL, model: m.model, status: 'down', latencyMs: 0, modelPresent: false, error: 'Endpoint not configured', checkedAt }
        }
        const ping = await probe(baseURL)
        const modelPresent = ping.ok && modelAdvertised(m.model, ping.models)
        // `degraded` is suppressed when the server lists no models at all (some
        // healthy servers return an empty list).
        const status: EndpointHealth['status'] = !ping.ok
          ? 'down'
          : ping.models.length > 0 && !modelPresent
            ? 'degraded'
            : 'up'
        return { id: m.id, name: ep.name, baseURL, model: m.model, status, latencyMs: ping.latencyMs, modelPresent, error: ping.error, checkedAt }
      })
    }),
  )
}

/**
 * Probe every catalog endpoint, update the cache, and broadcast the snapshot to
 * the frontend. Concurrent calls share a single in-flight probe. Never throws.
 */
export function runEndpointHealthCheck(): Promise<EndpointHealth[]> {
  if (pending) return pending
  pending = probeAll()
    .then(results => {
      cache = results
      broadcast('endpoint_health', cache)
      return cache
    })
    .catch(err => {
      logger.warn('Endpoint health check failed', { error: err instanceof Error ? err.message : String(err) })
      return cache
    })
    .finally(() => { pending = null })
  return pending
}

/** Start the periodic health monitor (runs an immediate check, then every tick). */
export function startEndpointHealthMonitor(intervalMs = DEFAULT_INTERVAL_MS): void {
  runEndpointHealthCheck()
  timer = setInterval(() => { runEndpointHealthCheck() }, intervalMs)
  logger.info('Endpoint health monitor started', { intervalMs })
}

/** Stop the periodic health monitor (graceful shutdown). */
export function stopEndpointHealthMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
}
