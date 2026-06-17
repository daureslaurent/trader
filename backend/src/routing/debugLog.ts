import { debugLogs, nowSql, getRawSetting } from '../db/index.js'
import { broadcast } from '../api/ws.js'
import { logger } from '../core/logger.js'
import { RouteNode, FireContext } from './types.js'

/**
 * Capture log for `debug` processor nodes. Each debug node records what flows
 * through it to the `debug_logs` collection and broadcasts a live `debug_log`
 * frame for the docked panel. High-frequency Binance inputs can flood this, so:
 *   - per-node `sampleN`: record only 1 of every N events,
 *   - count-pruning: keep roughly the last `debug_log_retain` rows.
 */

export interface DebugRecord {
  id: number
  node_id: string
  label: string
  note: string
  trigger: string
  symbol: string | null
  payload: string
  created_at: string
}

const sampleCounters = new Map<string, number>()
let insertsSincePrune = 0

function retainCount(): number {
  const n = Number(getRawSetting('debug_log_retain') ?? '2000')
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000
}

/** Record one event for a debug node (respecting its sample rate). */
export async function recordDebug(node: RouteNode, ctx: FireContext): Promise<void> {
  const sampleN = Math.max(1, Math.floor(Number(node.config.sampleN ?? 1)) || 1)
  const seen = (sampleCounters.get(node.id) ?? 0) + 1
  sampleCounters.set(node.id, seen)
  if (seen % sampleN !== 0) return // sampled out

  // Strip the noisy `trigger` key out of the captured payload (it's a column).
  // When `logData` is off, record only metadata and omit the payload entirely.
  const { trigger: _t, ...payload } = ctx
  const record = {
    node_id: node.id,
    label: node.label,
    note: String(node.config.note ?? ''),
    trigger: ctx.trigger,
    symbol: ctx.symbol ?? null,
    payload: node.config.logData === false ? '' : JSON.stringify(payload),
    created_at: nowSql(),
  }
  try {
    const id = await debugLogs.insert(record)
    broadcast('debug_log', { id, ...record })
    void prune()
  } catch (err) {
    logger.warn('debug log insert failed', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) })
  }
}

// Throttled count-prune: every ~100 inserts, trim rows older than the newest N.
async function prune(): Promise<void> {
  if (++insertsSincePrune < 100) return
  insertsSincePrune = 0
  try {
    const newest = await debugLogs.findOne({}, { sort: { id: -1 }, projection: { id: 1 } })
    if (!newest) return
    const cutoff = Number((newest as { id: number }).id) - retainCount()
    if (cutoff > 0) await debugLogs.deleteMany({ id: { $lte: cutoff } })
  } catch (err) {
    logger.warn('debug log prune failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Recent debug records, newest first. Served by the history endpoint. */
export async function getDebugLogs(limit = 200): Promise<DebugRecord[]> {
  const rows = await debugLogs.find({}, { sort: { id: -1 }, limit })
  return rows as unknown as DebugRecord[]
}

export async function clearDebugLogs(): Promise<void> {
  await debugLogs.deleteMany({})
  sampleCounters.clear()
}
