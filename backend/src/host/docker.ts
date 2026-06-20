// Minimal Docker Engine API client over the unix socket — no external deps.
// Used by the App-usage section of the System page to read per-container CPU /
// memory for this compose project's containers (backend, frontend, mongo).
//
// Requires the docker socket bind-mounted into the backend container
// (docker-compose mounts /var/run/docker.sock read-only). Every call is
// best-effort: if the socket is missing or the daemon errors, callers get a
// rejected promise and surface `dockerAvailable: false` rather than crashing.
import http from 'node:http'
import os from 'node:os'

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock'
// Docker pins the API version; an unset version negotiates the daemon default.
const API_PREFIX = process.env.DOCKER_API_VERSION ? `/${process.env.DOCKER_API_VERSION}` : ''

/** GET a Docker Engine API path over the unix socket, parsing the JSON body. */
function dockerGet<T>(path: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: `${API_PREFIX}${path}`, method: 'GET', timeout: timeoutMs },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', d => (body += d))
        res.on('end', () => {
          const code = res.statusCode ?? 0
          if (code >= 400) return reject(new Error(`docker ${path} -> HTTP ${code}`))
          try {
            resolve(body ? (JSON.parse(body) as T) : (null as T))
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`docker ${path} timed out`)))
    req.end()
  })
}

interface ContainerSummary {
  Id: string
  Names: string[]
  Image: string
  State: string
  Labels: Record<string, string>
}

interface ContainerInspect {
  Config: { Labels: Record<string, string> }
  State: { StartedAt: string }
}

interface ContainerStatsRaw {
  cpu_stats: CpuStatsRaw
  precpu_stats: CpuStatsRaw
  memory_stats: {
    usage?: number
    limit?: number
    stats?: { cache?: number; inactive_file?: number }
  }
}

interface CpuStatsRaw {
  cpu_usage: { total_usage: number; percpu_usage?: number[] }
  system_cpu_usage?: number
  online_cpus?: number
}

export interface DockerContainerStat {
  id: string
  name: string // compose service name when available, else container name
  image: string
  state: string
  cpuPct: number // 0..(cores*100) — Docker convention, can exceed 100
  cpuCores: number // online CPUs visible to the container
  memUsedBytes: number
  memLimitBytes: number
  memPct: number // 0..100
  uptimeSeconds: number
}

const COMPOSE_PROJECT = 'com.docker.compose.project'
const COMPOSE_SERVICE = 'com.docker.compose.service'

/**
 * Determine which compose project this backend belongs to, so we only report
 * sibling containers. Inside a container `os.hostname()` is the short id, so we
 * inspect ourselves and read the compose-project label. Falls back to the
 * COMPOSE_PROJECT_NAME env (or "cryptobot") when self-inspection is unavailable
 * (e.g. `npm run dev` on the host).
 */
async function resolveProject(): Promise<string | null> {
  try {
    const self = await dockerGet<ContainerInspect>(`/containers/${os.hostname()}/json`)
    const project = self.Config?.Labels?.[COMPOSE_PROJECT]
    if (project) return project
  } catch {
    // not running as a compose container, or can't see ourselves — fall through
  }
  return process.env.COMPOSE_PROJECT_NAME || 'cryptobot'
}

/** Docker's CPU% formula: share of total system CPU time, scaled by core count. */
function computeCpuPct(s: ContainerStatsRaw): { pct: number; cores: number } {
  const cpu = s.cpu_stats
  const pre = s.precpu_stats
  const cores = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1
  const cpuDelta = cpu.cpu_usage.total_usage - (pre.cpu_usage?.total_usage ?? 0)
  const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0)
  if (cpuDelta <= 0 || sysDelta <= 0) return { pct: 0, cores }
  const pct = (cpuDelta / sysDelta) * cores * 100
  return { pct: Math.max(0, Math.round(pct * 10) / 10), cores }
}

/** Memory actually used = usage minus reclaimable page cache (cgroup v1/v2). */
function computeMem(s: ContainerStatsRaw): { used: number; limit: number; pct: number } {
  const m = s.memory_stats
  const usage = m.usage ?? 0
  const cache = m.stats?.inactive_file ?? m.stats?.cache ?? 0
  const used = Math.max(0, usage - cache)
  const limit = m.limit ?? 0
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0
  return { used, limit, pct }
}

/**
 * Per-container CPU/memory/uptime for every container in this compose project.
 * Rejects only on a hard daemon/socket failure; individual containers that fail
 * to report are skipped.
 */
export async function getProjectContainerStats(): Promise<DockerContainerStat[]> {
  const project = await resolveProject()
  const all = await dockerGet<ContainerSummary[]>('/containers/json?all=false')
  const mine = project ? all.filter(c => c.Labels?.[COMPOSE_PROJECT] === project) : all

  const stats = await Promise.all(
    mine.map(async (c): Promise<DockerContainerStat | null> => {
      try {
        const [raw, inspect] = await Promise.all([
          dockerGet<ContainerStatsRaw>(`/containers/${c.Id}/stats?stream=false`),
          dockerGet<ContainerInspect>(`/containers/${c.Id}/json`),
        ])
        const { pct: cpuPct, cores } = computeCpuPct(raw)
        const mem = computeMem(raw)
        const startedMs = Date.parse(inspect.State?.StartedAt ?? '')
        const uptimeSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : 0
        const name = c.Labels?.[COMPOSE_SERVICE] || c.Names?.[0]?.replace(/^\//, '') || c.Id.slice(0, 12)
        return {
          id: c.Id.slice(0, 12),
          name,
          image: c.Image,
          state: c.State,
          cpuPct,
          cpuCores: cores,
          memUsedBytes: mem.used,
          memLimitBytes: mem.limit,
          memPct: mem.pct,
          uptimeSeconds,
        }
      } catch {
        return null
      }
    }),
  )

  return stats
    .filter((s): s is DockerContainerStat => s != null)
    .sort((a, b) => a.name.localeCompare(b.name))
}
