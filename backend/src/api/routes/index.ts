import { Router } from 'express'
import { router as portfolioRoutes } from './portfolio.routes.js'
import { router as positionsRoutes } from './positions.routes.js'
import { router as pipelineRoutes } from './pipeline.routes.js'
import { router as tradesRoutes } from './trades.routes.js'
import { router as marketRoutes } from './market.routes.js'
import { router as cacheRoutes } from './cache.routes.js'
import { router as discoverRoutes } from './discover.routes.js'
import { router as monitorRoutes } from './monitor.routes.js'
import { router as summaryRoutes } from './summary.routes.js'
import { router as llmRoutes } from './llm.routes.js'
import { router as agentRoutes } from './agent.routes.js'
import { router as settingsRoutes } from './settings.routes.js'
import { router as hostRoutes } from './host.routes.js'
import { router as eventsRoutes } from './events.routes.js'
import { router as routingRoutes } from './routing.routes.js'

// Single API router composed of per-domain sub-routers. All sub-routers declare
// absolute paths and are mounted at the root, so the public URL surface is
// identical to the previous monolithic routes file. Order mirrors the original
// declaration order.
export const router = Router()

router.use(portfolioRoutes)
router.use(positionsRoutes)
router.use(pipelineRoutes)
router.use(tradesRoutes)
router.use(marketRoutes)
router.use(cacheRoutes)
router.use(discoverRoutes)
router.use(monitorRoutes)
router.use(summaryRoutes)
router.use(llmRoutes)
router.use(agentRoutes)
router.use(settingsRoutes)
router.use(hostRoutes)
router.use(eventsRoutes)
router.use(routingRoutes)
