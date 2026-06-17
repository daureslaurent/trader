import { Router, Request, Response } from 'express'
import { logger } from '../../core/logger.js'
import {
  getGraph, saveGraph, setGlobalEnabled, getCatalog, fireManual, RoutingGraph,
} from '../../routing/index.js'

export const router = Router()

// The node-type palette (serializable metadata) the flow-graph UI renders.
router.get('/routing/catalog', (_req: Request, res: Response) => {
  res.json({ catalog: getCatalog() })
})

// The active routing graph (nodes + edges + global enabled).
router.get('/routing/graph', (_req: Request, res: Response) => {
  res.json(getGraph())
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
