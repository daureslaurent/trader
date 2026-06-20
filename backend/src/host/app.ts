// App-level resource usage for the System page — distinct from host telemetry
// (host/index.ts), which measures the whole machine. This reports what *this
// application* consumes: per-container CPU/memory (backend, frontend, mongo) via
// the Docker API, the MongoDB on-disk footprint, and the backend process itself.
//
// A lightweight in-memory sampler keeps a rolling history so the System page can
// draw sparklines immediately on load (rather than only accumulating while open).
import { getProjectContainerStats, type DockerContainerStat } from './docker.js'
import { getDb } from '../db/index.js'
import { logger } from '../core/logger.js'

export interface MongoUsage {
  collections: number
  objects: number
  dataSizeBytes: number // logical (uncompressed) document size
  storageSizeBytes: number // on-disk collection size (compressed)
  indexSizeBytes: number // on-disk index size
  totalSizeBytes: number // storage + indexes on disk
}

export interface BackendProcessUsage {
  pid: number
  uptimeSeconds: number
  rssBytes: number // resident set size
  heapUsedBytes: number
  heapTotalBytes: number
}

export interface AppStats {
  timestamp: number
  dockerAvailable: boolean
  dockerError?: string
  containers: DockerContainerStat[]
  mongo: MongoUsage | null
  backend: BackendProcessUsage
}

/** Compact sample stored in the rolling history (one per sampler tick). */
export interface AppStatsPoint {
  t: number
  containers: { name: string; cpuPct: number; memUsedBytes: number }[]
  mongoTotalBytes: number | null
  backendRssBytes: number
}

const HISTORY_MAX = 180 // ~15 min at a 5s cadence
const SAMPLE_MS = 5000

const history: AppStatsPoint[] = []
let latest: AppStats | null = null
let timer: NodeJS.Timeout | null = null

/** MongoDB on-disk footprint via the dbStats command (scale 1 = bytes). */
async function readMongoUsage(): Promise<MongoUsage | null> {
  try {
    const s = (await getDb().command({ dbStats: 1, scale: 1 })) as {
      collections?: number
      objects?: number
      dataSize?: number
      storageSize?: number
      indexSize?: number
      totalSize?: number
    }
    const storage = s.storageSize ?? 0
    const index = s.indexSize ?? 0
    return {
      collections: s.collections ?? 0,
      objects: s.objects ?? 0,
      dataSizeBytes: s.dataSize ?? 0,
      storageSizeBytes: storage,
      indexSizeBytes: index,
      totalSizeBytes: s.totalSize ?? storage + index,
    }
  } catch (err) {
    logger.warn('mongo dbStats failed', { err: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function readBackendUsage(): BackendProcessUsage {
  const m = process.memoryUsage()
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
  }
}

/** One full app-usage reading. Best-effort: Docker/Mongo failures degrade gracefully. */
export async function getAppStats(): Promise<AppStats> {
  let containers: DockerContainerStat[] = []
  let dockerAvailable = true
  let dockerError: string | undefined
  try {
    containers = await getProjectContainerStats()
  } catch (err) {
    dockerAvailable = false
    dockerError = err instanceof Error ? err.message : String(err)
  }

  const mongo = await readMongoUsage()

  return {
    timestamp: Date.now(),
    dockerAvailable,
    dockerError,
    containers,
    mongo,
    backend: readBackendUsage(),
  }
}

/** Latest sampled reading + the rolling history. Served by GET /api/host/app. */
export function getAppUsage(): { current: AppStats | null; history: AppStatsPoint[] } {
  return { current: latest, history: history.slice() }
}

async function sample(): Promise<void> {
  try {
    const stats = await getAppStats()
    latest = stats
    history.push({
      t: stats.timestamp,
      containers: stats.containers.map(c => ({ name: c.name, cpuPct: c.cpuPct, memUsedBytes: c.memUsedBytes })),
      mongoTotalBytes: stats.mongo?.totalSizeBytes ?? null,
      backendRssBytes: stats.backend.rssBytes,
    })
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX)
  } catch (err) {
    logger.warn('app stats sample failed', { err: err instanceof Error ? err.message : String(err) })
  }
}

/** Begin the rolling-history sampler. Idempotent; safe to call once at boot. */
export function startAppSampler(): void {
  if (timer) return
  void sample() // seed immediately so the first page load has data
  timer = setInterval(() => void sample(), SAMPLE_MS)
  if (typeof timer.unref === 'function') timer.unref()
  logger.info('App-usage sampler started', { everyMs: SAMPLE_MS, historyMax: HISTORY_MAX })
}

export function stopAppSampler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
