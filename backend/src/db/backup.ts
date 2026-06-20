import { getDb } from './client.js'
import { withTransaction } from './transaction.js'
import { seedCounter } from './counters.js'
import { nowSql } from './time.js'
import { ALL_REPOS } from './repositories.js'
import { loadSettings, getSettings } from './settings.js'
import { bus } from '../core/events.js'
import { BotSettings } from '../types.js'
import { logger } from '../core/logger.js'

// Disposable collections: regenerable caches and high-volume logs. Excluded from
// "export all" unless explicitly opted in, and the target of "clear caches".
export const CACHE_COLLECTIONS = [
  'extraction_cache', 'ohlcv_cache', 'llm_calls', 'llm_stats_snapshots',
  'debug_logs', 'pipeline_events', 'llm_jobs',
] as const

const CACHE_SET = new Set<string>(CACHE_COLLECTIONS)

// The export envelope. `collections` maps a collection name to its full document
// array (each doc keeps its `_id`/`id`, so the round-trip is lossless).
export interface ExportFile {
  version: number
  exportedAt: string
  collections: Record<string, Record<string, unknown>[]>
}

export interface ImportResult {
  imported: Record<string, number>
}

export interface DbStats {
  db: string
  totalDocs: number
  collections: { name: string; count: number; cache: boolean }[]
}

/** Names known to the app, in a stable order (the ALL_REPOS keys). */
export function knownCollections(): string[] {
  return Object.keys(ALL_REPOS)
}

/** Resolve a requested selection to a concrete, validated list of names. */
export function resolveExportSelection(
  collections: string[] | 'all',
  includeCaches: boolean,
): string[] {
  if (collections === 'all') {
    return knownCollections().filter(n => includeCaches || !CACHE_SET.has(n))
  }
  for (const n of collections) {
    if (!ALL_REPOS[n]) throw new Error(`Unknown collection: ${n}`)
  }
  return collections
}

/** Dump the requested collections into an ExportFile envelope. */
export async function exportCollections(names: string[]): Promise<ExportFile> {
  const collections: Record<string, Record<string, unknown>[]> = {}
  for (const name of names) {
    const repo = ALL_REPOS[name]
    if (!repo) throw new Error(`Unknown collection: ${name}`)
    collections[name] = (await repo.find({})) as Record<string, unknown>[]
  }
  return { version: 1, exportedAt: nowSql(), collections }
}

/**
 * Replace-import: for each collection in the file, wipe it then insert the
 * documents verbatim (preserving `_id`) inside a transaction. Integer-id
 * collections get their counter reseeded so freshly issued ids never collide.
 */
export async function importCollections(file: unknown): Promise<ImportResult> {
  const parsed = file as Partial<ExportFile>
  if (!parsed || typeof parsed !== 'object' || !parsed.collections || typeof parsed.collections !== 'object') {
    throw new Error('Invalid backup file: missing "collections" object')
  }

  const names = Object.keys(parsed.collections)
  for (const name of names) {
    if (!ALL_REPOS[name]) throw new Error(`Unknown collection in backup: ${name}`)
    if (!Array.isArray(parsed.collections[name])) {
      throw new Error(`Invalid backup file: "${name}" is not an array`)
    }
  }

  const db = getDb()
  const imported: Record<string, number> = {}
  let settingsTouched = false

  for (const name of names) {
    const docs = parsed.collections[name] as Record<string, unknown>[]
    let maxId = 0
    for (const d of docs) {
      if (typeof d._id === 'number' && d._id > maxId) maxId = d._id
    }

    await withTransaction(async session => {
      const col = db.collection(name)
      await col.deleteMany({}, { session })
      if (docs.length > 0) await col.insertMany(docs, { session, ordered: false })
    })

    // Reseed the id counter for integer-keyed collections (outside the txn — the
    // counters collection mutation is idempotent via $max).
    if (maxId > 0) await seedCounter(name, maxId)

    imported[name] = docs.length
    if (name === 'settings') settingsTouched = true
  }

  // Settings live in an in-memory cache; refresh it and reschedule crons.
  if (settingsTouched) {
    await loadSettings()
    bus.emit('settings_updated', getSettings() as BotSettings)
  }

  logger.warn('Database import applied', { collections: names.length, docs: Object.values(imported).reduce((s, n) => s + n, 0) })
  return { imported }
}

/** Live per-collection document counts + DB name. */
export async function getDbStats(): Promise<DbStats> {
  const names = knownCollections()
  const collections: DbStats['collections'] = []
  let totalDocs = 0
  for (const name of names) {
    const count = await ALL_REPOS[name].count({})
    totalDocs += count
    collections.push({ name, count, cache: CACHE_SET.has(name) })
  }
  return { db: getDb().databaseName, totalDocs, collections }
}

/** Empty every cache/log collection. Returns deleted counts per collection. */
export async function clearCaches(): Promise<Record<string, number>> {
  const cleared: Record<string, number> = {}
  for (const name of CACHE_COLLECTIONS) {
    cleared[name] = await ALL_REPOS[name].deleteMany({})
  }
  logger.warn('Cache/log collections cleared', { cleared })
  return cleared
}

/**
 * Reseed every integer-id collection's counter to its current max `_id`. Repairs
 * counter drift (e.g. after a manual restore). Natural-key collections are skipped.
 */
export async function reseedCounters(): Promise<Record<string, number>> {
  const seeded: Record<string, number> = {}
  for (const name of knownCollections()) {
    const top = await ALL_REPOS[name].find({ _id: { $type: 'number' } } as Record<string, unknown>, {
      sort: { _id: -1 },
      limit: 1,
      projection: { _id: 1 },
    })
    const maxId = typeof top[0]?._id === 'number' ? (top[0]._id as number) : 0
    if (maxId > 0) {
      await seedCounter(name, maxId)
      seeded[name] = maxId
    }
  }
  logger.info('Id counters reseeded', { seeded })
  return seeded
}
