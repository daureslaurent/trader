import cron, { ScheduledTask } from 'node-cron'
import { logger } from '../core/logger.js'
import { RoutingGraph } from './types.js'
import { fireNode } from './engine.js'

/**
 * Schedules the graph's timer input nodes. This is where "crons become inputs":
 * each enabled `timer` node owns a node-cron job that, on tick, fires the node
 * into the routing engine instead of calling an engine directly.
 */

const tasks = new Map<string, ScheduledTask>()

export function rescheduleTimers(graph: RoutingGraph): void {
  for (const t of tasks.values()) t.stop()
  tasks.clear()

  if (!graph.enabled) {
    logger.info('Routing disabled — no timers scheduled')
    return
  }

  for (const node of graph.nodes) {
    if (node.kind !== 'input' || node.type !== 'timer' || !node.enabled) continue
    const expr = String(node.config.cron ?? '')
    if (!cron.validate(expr)) {
      logger.warn('Timer node has invalid cron, skipping', { nodeId: node.id, cron: expr })
      continue
    }
    const task = cron.schedule(expr, () => {
      fireNode(node.id, { trigger: `timer:${node.id}` }).catch((err) =>
        logger.error('Timer fire failed', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }))
    })
    tasks.set(node.id, task)
    logger.info('Routing timer scheduled', { nodeId: node.id, cron: expr })
  }
}

export function stopTimers(): void {
  for (const t of tasks.values()) t.stop()
  tasks.clear()
}
