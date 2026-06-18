// Host machine telemetry — CPU, memory, temperature, and system info for the
// "Host" system page. Pure Node built-ins (os, fs); no external deps. All
// readings are best-effort: anything unavailable (e.g. temperature in a
// container) resolves to null rather than throwing.
import os from 'node:os'
import fs from 'node:fs/promises'

// Host self-update bridge (trigger-file → host systemd watcher).
export { requestUpdate, requestReboot, getUpdateReadiness, requestCheck, readUpdateStatus } from './update.js'
export type { UpdateReadiness, UpdateStatus, UpdateCommit } from './update.js'
// Periodic update-availability check engine.
export { runUpdateCheck, scheduleUpdateCheck, stopUpdateCheck } from './updateChecker.js'

export interface CpuCoreLoad {
  core: number
  usage: number // 0..100
}

export interface TempSensor {
  label: string
  celsius: number
}

export interface HostStats {
  timestamp: number
  system: {
    hostname: string
    platform: string
    arch: string
    release: string
    uptimeSeconds: number
    nodeVersion: string
  }
  cpu: {
    model: string
    cores: number
    speedMhz: number
    usage: number // overall 0..100
    perCore: CpuCoreLoad[]
    loadAvg: [number, number, number] // 1/5/15 min (0 on platforms without it)
  }
  memory: {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    usedPct: number // 0..100
  }
  temperature: {
    sensors: TempSensor[]
    maxCelsius: number | null
  }
}

type CpuTimesSnapshot = { idle: number; total: number }[]

function sampleCpuTimes(): CpuTimesSnapshot {
  return os.cpus().map(c => {
    const t = c.times
    const total = t.user + t.nice + t.sys + t.idle + t.irq
    return { idle: t.idle, total }
  })
}

/**
 * Instantaneous per-core CPU usage. os.cpus() returns cumulative tick counts,
 * so we take two samples `ms` apart and diff them. Stateless — safe to call
 * per request.
 */
async function readCpuUsage(ms = 200): Promise<{ overall: number; perCore: CpuCoreLoad[] }> {
  const a = sampleCpuTimes()
  await new Promise(r => setTimeout(r, ms))
  const b = sampleCpuTimes()

  let idleSum = 0
  let totalSum = 0
  const perCore: CpuCoreLoad[] = a.map((prev, i) => {
    const cur = b[i] ?? prev
    const idleDelta = cur.idle - prev.idle
    const totalDelta = cur.total - prev.total
    idleSum += idleDelta
    totalSum += totalDelta
    const usage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0
    return { core: i, usage: clampPct(usage) }
  })

  const overall = totalSum > 0 ? (1 - idleSum / totalSum) * 100 : 0
  return { overall: clampPct(overall), perCore }
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10))
}

/**
 * Linux thermal sensors via the sysfs thermal_zone interface. Each zone exposes
 * a `type` (label) and `temp` in millidegrees Celsius. Returns [] on any error
 * or non-Linux platform (e.g. WSL2 often has no zones exposed).
 */
async function readTemperatures(): Promise<TempSensor[]> {
  if (os.platform() !== 'linux') return []
  const base = '/sys/class/thermal'
  try {
    const entries = await fs.readdir(base)
    const zones = entries.filter(e => e.startsWith('thermal_zone'))
    const sensors = await Promise.all(
      zones.map(async zone => {
        try {
          const [rawTemp, rawType] = await Promise.all([
            fs.readFile(`${base}/${zone}/temp`, 'utf8'),
            fs.readFile(`${base}/${zone}/type`, 'utf8').catch(() => zone),
          ])
          const milli = parseInt(rawTemp.trim(), 10)
          if (!Number.isFinite(milli)) return null
          return { label: rawType.trim() || zone, celsius: Math.round((milli / 1000) * 10) / 10 }
        } catch {
          return null
        }
      }),
    )
    return sensors.filter((s): s is TempSensor => s != null && s.celsius > 0 && s.celsius < 150)
  } catch {
    return []
  }
}

export async function getHostStats(): Promise<HostStats> {
  const [cpuUsage, sensors] = await Promise.all([readCpuUsage(), readTemperatures()])

  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const load = os.loadavg() as [number, number, number]
  const maxCelsius = sensors.length ? Math.max(...sensors.map(s => s.celsius)) : null

  return {
    timestamp: Date.now(),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptimeSeconds: Math.round(os.uptime()),
      nodeVersion: process.version,
    },
    cpu: {
      model: cpus[0]?.model.trim() ?? 'Unknown CPU',
      cores: cpus.length,
      speedMhz: cpus[0]?.speed ?? 0,
      usage: cpuUsage.overall,
      perCore: cpuUsage.perCore,
      loadAvg: load,
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPct: totalMem > 0 ? clampPct((usedMem / totalMem) * 100) : 0,
    },
    temperature: { sensors, maxCelsius },
  }
}
