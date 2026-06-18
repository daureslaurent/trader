import { Router, Request, Response } from 'express'
import { logger } from '../../core/logger.js'
import {
  getGraph, saveGraph, setGlobalEnabled, getCatalog, fireManual, RoutingGraph,
  getDebugLogs, clearDebugLogs, getRoutingState,
} from '../../routing/index.js'

export const router = Router()

// Recent debug-tap records for the docked log panel on the Routing page.
router.get('/debug-logs', async (req: Request, res: Response) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200))
  res.json({ logs: await getDebugLogs(limit) })
})

router.delete('/debug-logs', async (_req: Request, res: Response) => {
  await clearDebugLogs()
  res.json({ ok: true })
})

// The node-type palette (serializable metadata) the flow-graph UI renders.
router.get('/routing/catalog', (_req: Request, res: Response) => {
  res.json({ catalog: getCatalog() })
})

// The active routing graph (nodes + edges + global enabled).
router.get('/routing/graph', (_req: Request, res: Response) => {
  res.json(getGraph())
})

// Live guardrail state (cooldown timers, hourly caps) for the UI countdowns.
router.get('/routing/state', (_req: Request, res: Response) => {
  res.json(getRoutingState())
})

// Persist + hot-apply a user-edited graph from the flow-graph editor.
router.put('/routing/graph', async (req: Request, res: Response) => {
  try {
    const graph = await saveGraph(req.body as RoutingGraph)
    res.json(graph)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid graph'
    logger.warn('Rejected routing graph save', { error: msg })
    res.status(400).json({ error: msg })
  }
})

// Flip the global kill-switch.
router.post('/routing/enabled', async (req: Request, res: Response) => {
  const enabled = req.body?.enabled === true
  const graph = await setGlobalEnabled(enabled)
  res.json(graph)
})

// Manually fire any node by id (the per-node "fire" button).
router.post('/routing/fire/:nodeId', async (req: Request, res: Response) => {
  const ok = await fireManual(req.params.nodeId, req.body && typeof req.body === 'object' ? req.body : {})
  if (!ok) return res.status(404).json({ error: 'node not found' })
  res.json({ ok: true })
})
