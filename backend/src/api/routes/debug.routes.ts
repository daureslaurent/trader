// Read-only debug API — lets the `tools/` CLIs (and the AI driving them) inspect
// bot data over HTTP without direct DB access. A generic mirror of the read
// commands the old direct-Mongo db.mjs offered, operating through the typed repos
// (never the raw driver). Mounted behind requireApiKey (see api/index.ts), so it
// is its own key-gated auth domain, separate from the admin login.
//
// Strictly read-only: there are no write endpoints. The :collection param is
// whitelisted to ALL_REPOS, which excludes app_config/counters — so the API-key
// hashes and other secrets in app_config are unreachable here.
import { Router, type Request, type Response } from 'express'
import type { Sort } from 'mongodb'
import { ALL_REPOS } from '../../db/repositories.js'
import { getDbStats } from '../../db/index.js'

export const router = Router()

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 500

// Resolve + validate the :collection param against the app's known repos. Sends
// a 400 and returns null for an unknown name (so secrets/system collections that
// aren't in ALL_REPOS can never be queried).
function resolveRepo(req: Request, res: Response) {
  const name = req.params.collection
  const repo = ALL_REPOS[name]
  if (!repo) {
    res.status(400).json({ error: `Unknown collection: ${name}` })
    return null
  }
  return repo
}

// Parse a JSON query param (filter/sort/projection). Empty/absent → fallback.
// Throws on malformed JSON so the caller can answer 400.
function parseJsonParam(raw: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'string') throw new Error('expected a JSON string')
  return JSON.parse(raw) as Record<string, unknown>
}

// Mongo _id is an integer for most collections, a natural string key for a few.
// Coerce a path param the same way the old db.mjs did.
function coerceId(raw: string): number | string {
  return /^-?\d+$/.test(raw) ? Number(raw) : raw
}

// GET /collections — names with document counts (+ DB name, cache flags).
router.get('/collections', async (_req: Request, res: Response) => {
  try {
    res.json(await getDbStats())
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /schema/:collection — indexes + the newest sample document.
router.get('/schema/:collection', async (req: Request, res: Response) => {
  const repo = resolveRepo(req, res)
  if (!repo) return
  try {
    const indexes = await repo.col().indexes()
    const sample = await repo.findOne({}, { sort: { _id: -1 } })
    res.json({ collection: repo.name, indexes, sample })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /query/:collection?filter=&sort=&projection=&limit= — find documents.
router.get('/query/:collection', async (req: Request, res: Response) => {
  const repo = resolveRepo(req, res)
  if (!repo) return
  let filter: Record<string, unknown>, sort: Record<string, unknown>, projection: Record<string, unknown> | undefined
  try {
    filter = parseJsonParam(req.query.filter)
    sort = parseJsonParam(req.query.sort, { _id: -1 })
    const proj = parseJsonParam(req.query.projection, {})
    projection = Object.keys(proj).length ? proj : undefined
  } catch (err) {
    res.status(400).json({ error: `Invalid JSON parameter: ${err instanceof Error ? err.message : String(err)}` })
    return
  }
  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT
  try {
    const docs = await repo.find(filter, { sort: sort as Sort, projection, limit })
    res.json(docs)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /get/:collection/:id — one document by _id (int or string key).
router.get('/get/:collection/:id', async (req: Request, res: Response) => {
  const repo = resolveRepo(req, res)
  if (!repo) return
  try {
    const doc = await repo.findById(coerceId(req.params.id))
    if (!doc) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.json(doc)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /count/:collection?filter= — document count.
router.get('/count/:collection', async (req: Request, res: Response) => {
  const repo = resolveRepo(req, res)
  if (!repo) return
  let filter: Record<string, unknown>
  try {
    filter = parseJsonParam(req.query.filter)
  } catch (err) {
    res.status(400).json({ error: `Invalid JSON parameter: ${err instanceof Error ? err.message : String(err)}` })
    return
  }
  try {
    res.json({ count: await repo.count(filter) })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
