import { logger } from '../core/logger.js'
import { FireContext } from './types.js'
import { fireNode, getGraph } from './engine.js'
import { loadGraph } from './store.js'
import { wireSources, fireStartup } from './sources.js'
import { stopTimers } from './scheduler.js'
import { stopBinanceStreams } from '../market/index.js'

export type { RoutingGraph, RouteNode, RouteEdge, NodeKind, NodeTypeMeta, ConfigField } from './types.js'
export { getGraph } from './engine.js'
export { saveGraph, syncFromSettings, setGlobalEnabled } from './store.js'
export { getCatalog } from './registry.js'
export { refreshBinanceStreams } from './binanceSync.js'
export { getDebugLogs, clearDebugLogs } from './debugLog.js'

/** Wire live sources, then load/seed + activate the persisted graph. */
export async function initRouting(): Promise<void> {
  wireSources()
  await loadGraph()
  logger.info('Routing engine initialized', { nodes: getGraph().nodes.length, edges: getGraph().edges.length })
}

/** Fire the one-shot startup inputs (call once the system is fully up). */
export function fireRoutingStartup(): void {
  fireStartup()
}

/**
 * Manually fire any node by id (the UI "fire" button / API). Returns false if
 * the node doesn't exist so the caller can 404.
 */
export async function fireManual(nodeId: string, ctx?: Partial<FireContext>): Promise<boolean> {
  const exists = getGraph().nodes.some((n) => n.id === nodeId)
  if (!exists) return false
  await fireNode(nodeId, { trigger: 'manual', ...ctx })
  return true
}

export function stopRouting(): void {
  stopTimers()
  stopBinanceStreams()
}
