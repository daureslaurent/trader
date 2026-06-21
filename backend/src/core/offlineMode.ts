import { getSettings } from '../db/index.js'
import { getEndpointHealth } from './endpointHealth.js'
import { broadcast } from '../api/ws.js'
import { logger } from './logger.js'

/**
 * Offline mode — the single source of truth for whether the bot should run LLM-free.
 *
 * When offline, the judgment engines (Analyst, Monitor, Discoverer) swap their LLM calls
 * for deterministic technical-analysis rules emitting the same Signal/verdict shapes, while
 * Summary and the conversational Agent are disabled. All trade *mechanics* (sizing, ATR
 * SL/TP, the BUY gauntlet, OCO, exit reconciliation) are deterministic already and run
 * unchanged in both modes.
 *
 * The effective state is `offline_mode_forced || (offline_auto && allEndpointsDown())`:
 *  - the manual override always wins;
 *  - otherwise we auto-fall-back to offline whenever every configured LLM endpoint is
 *    unreachable, and auto-recover once one comes back.
 */

export type OfflineReason = 'forced' | 'endpoints_down' | 'online'

export interface OfflineState {
  active: boolean
  reason: OfflineReason
}

let current: OfflineState = { active: false, reason: 'online' }

/**
 * Whether every non-disabled catalog endpoint is positively known to be unreachable.
 * Only the `down` status (probe failed) counts — `degraded` (reachable, model missing)
 * does not, since the server is up and the call may still succeed. An empty catalog (no
 * probed endpoints) is not treated as "all down": auto-fallback needs evidence of an
 * outage, and modules may still reach an env-var fallback target.
 */
function allEndpointsDown(): boolean {
  const health = getEndpointHealth()
  const probed = health.filter(h => h.status !== 'disabled')
  if (probed.length === 0) return false
  return probed.every(h => h.status === 'down')
}

/** Compute the effective offline state from settings + live endpoint health. */
function compute(): OfflineState {
  const s = getSettings()
  if (s.offline_mode_forced) return { active: true, reason: 'forced' }
  if (s.offline_auto && allEndpointsDown()) return { active: true, reason: 'endpoints_down' }
  return { active: false, reason: 'online' }
}

/** The current effective offline state (cached; refreshed by recomputeOfflineMode). */
export function getOfflineState(): OfflineState {
  return current
}

/** Whether the bot is currently in offline (LLM-free) mode. The hot-path check used by engines. */
export function isOffline(): boolean {
  return current.active
}

/**
 * Recompute the effective offline state and, if it changed, log and broadcast it so the
 * frontend mode badge updates live. Called after every endpoint health check and on every
 * settings change. Idempotent and never throws.
 */
export function recomputeOfflineMode(): OfflineState {
  const next = compute()
  if (next.active !== current.active || next.reason !== current.reason) {
    const prev = current
    current = next
    logger.info('Offline mode changed', { active: next.active, reason: next.reason, from: prev.reason })
    broadcast('offline_mode', next)
  } else {
    current = next
  }
  return current
}
