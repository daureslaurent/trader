import { useEffect, useMemo } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { useApi } from '../hooks/useApi'
import { HostStats, AppUsageResponse, ContainerStat } from '../types'
import { cn } from '../lib/utils'
import { SoftwareCard } from '../components/update/SoftwareCard'

const POLL_MS = 2000

/** Pick a semantic color token for a 0..100 utilization value. */
function loadTone(pct: number): { text: string; bg: string; stroke: string } {
  if (pct >= 85) return { text: 'text-sell', bg: 'bg-sell', stroke: 'rgb(var(--sell-rgb))' }
  if (pct >= 60) return { text: 'text-warn', bg: 'bg-warn', stroke: 'rgb(var(--warn-rgb))' }
  return { text: 'text-buy', bg: 'bg-buy', stroke: 'rgb(var(--buy-rgb))' }
}

/** Temperature tone: cool < 60°C, warm 60–80, hot > 80. */
function tempTone(c: number): { text: string; bg: string; stroke: string } {
  if (c >= 80) return { text: 'text-sell', bg: 'bg-sell', stroke: 'rgb(var(--sell-rgb))' }
  if (c >= 60) return { text: 'text-warn', bg: 'bg-warn', stroke: 'rgb(var(--warn-rgb))' }
  return { text: 'text-accent', bg: 'bg-accent', stroke: 'rgb(var(--accent-rgb))' }
}

function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h || d) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

/** Circular progress ring with a centered value. */
function RingGauge({
  value,
  label,
  display,
  sub,
  stroke,
  size = 168,
}: {
  value: number // 0..100
  label: string
  display: string
  sub?: string
  stroke: string
  size?: number
}) {
  const r = size / 2 - 12
  const circumference = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, value))
  const offset = circumference * (1 - clamped / 100)
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--border-color)"
            strokeWidth={10}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.4s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] font-bold text-foreground tabular-nums leading-none tracking-tight">
            {display}
          </span>
          {sub && <span className="mt-1 text-[11px] text-muted">{sub}</span>}
        </div>
      </div>
      <p className="mt-3 text-[11px] font-semibold text-muted uppercase tracking-wider">{label}</p>
    </div>
  )
}

/** Thin labelled utilization bar. */
function LoadBar({ label, pct, valueText }: { label: string; pct: number; valueText: string }) {
  const tone = loadTone(pct)
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-medium text-muted tabular-nums">{label}</span>
        <span className={cn('text-[11px] font-semibold tabular-nums', tone.text)}>{valueText}</span>
      </div>
      <div className="h-2 rounded-full bg-surface-elevated overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', tone.bg)}
          style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
        />
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/60 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xs font-medium text-foreground tabular-nums">{value}</span>
    </div>
  )
}

/** Tiny SVG trend line for a metric's recent history. */
function Sparkline({ values, stroke, height = 34 }: { values: number[]; stroke: string; height?: number }) {
  const width = 120
  if (values.length < 2) {
    return <div style={{ height }} className="flex items-center text-[10px] text-muted/40">collecting…</div>
  }
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const step = width / (values.length - 1)
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * (height - 4) - 2).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" className="block">
      <polyline fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" points={pts} />
    </svg>
  )
}

/** One compose container's CPU / memory / uptime with trend lines. */
function ContainerCard({ c, cpuSeries, memSeries }: { c: ContainerStat; cpuSeries: number[]; memSeries: number[] }) {
  const cpuTone = loadTone(Math.min(100, c.cpuPct))
  const memTone = loadTone(c.memPct)
  const running = c.state === 'running'
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{c.name}</p>
          <p className="text-[10px] text-muted truncate">{c.image}</p>
        </div>
        <span className={cn('flex items-center gap-1.5 text-[10px] font-medium', running ? 'text-buy' : 'text-muted')}>
          <span className={cn('w-1.5 h-1.5 rounded-full', running ? 'bg-buy animate-pulse' : 'bg-muted')} />
          {c.state}
        </span>
      </div>

      <div className="space-y-3">
        <div>
          <LoadBar label={`CPU · ${c.cpuCores} core${c.cpuCores > 1 ? 's' : ''}`} pct={Math.min(100, c.cpuPct)} valueText={`${c.cpuPct.toFixed(1)}%`} />
          <div className="mt-1"><Sparkline values={cpuSeries} stroke={cpuTone.stroke} /></div>
        </div>
        <div>
          <LoadBar
            label="Memory"
            pct={c.memPct}
            valueText={c.memLimitBytes > 0 ? `${fmtBytes(c.memUsedBytes)} / ${fmtBytes(c.memLimitBytes)}` : fmtBytes(c.memUsedBytes)}
          />
          <div className="mt-1"><Sparkline values={memSeries} stroke={memTone.stroke} /></div>
        </div>
      </div>

      <div className="mt-3 pt-2 border-t border-border/60">
        <InfoRow label="Uptime" value={fmtUptime(c.uptimeSeconds)} />
      </div>
    </Card>
  )
}

/** App resource usage — per-container CPU/mem, Mongo footprint, backend process. */
function AppUsageSection() {
  const { data, error, reload } = useApi<AppUsageResponse>('/api/host/app')

  useEffect(() => {
    const id = setInterval(reload, POLL_MS)
    return () => clearInterval(id)
  }, [reload])

  // Build per-container history series keyed by name.
  const series = useMemo(() => {
    const cpu: Record<string, number[]> = {}
    const mem: Record<string, number[]> = {}
    for (const pt of data?.history ?? []) {
      for (const c of pt.containers) {
        ;(cpu[c.name] ??= []).push(c.cpuPct)
        ;(mem[c.name] ??= []).push(c.memUsedBytes)
      }
    }
    return { cpu, mem }
  }, [data])

  const mongoSeries = useMemo(() => (data?.history ?? []).map(p => p.mongoTotalBytes ?? 0), [data])
  const backendSeries = useMemo(() => (data?.history ?? []).map(p => p.backendRssBytes), [data])

  const current = data?.current
  if (!current) {
    return (
      <Card>
        <CardHeader title="Application usage" subtitle="resources consumed by this app" />
        <p className="text-xs text-muted">{error ? `Failed to load: ${error}` : 'Collecting app usage…'}</p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground tracking-tight">Application usage</h3>
          <p className="text-xs text-muted mt-0.5">Resources consumed by this app's containers &amp; database</p>
        </div>
      </div>

      {/* Containers */}
      {current.dockerAvailable ? (
        current.containers.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {current.containers.map(c => (
              <ContainerCard key={c.id} c={c} cpuSeries={series.cpu[c.name] ?? []} memSeries={series.mem[c.name] ?? []} />
            ))}
          </div>
        ) : (
          <Card><p className="text-xs text-muted">No project containers reported.</p></Card>
        )
      ) : (
        <Card className="border-warn/30">
          <p className="text-xs text-warn">
            Docker stats unavailable{current.dockerError ? `: ${current.dockerError}` : ''}. Mount
            <code className="mx-1 px-1 rounded bg-surface-elevated">/var/run/docker.sock</code>
            into the backend to enable per-container usage.
          </p>
        </Card>
      )}

      {/* Mongo + backend process */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="MongoDB footprint" subtitle="on-disk database size" />
          {current.mongo ? (
            <>
              <div className="flex items-end gap-2 mb-3">
                <span className="text-[26px] font-bold text-foreground tabular-nums leading-none">{fmtBytes(current.mongo.totalSizeBytes)}</span>
                <span className="text-[11px] text-muted mb-0.5">on disk</span>
              </div>
              <Sparkline values={mongoSeries} stroke="rgb(var(--accent-rgb))" height={40} />
              <div className="mt-2">
                <InfoRow label="Data (logical)" value={fmtBytes(current.mongo.dataSizeBytes)} />
                <InfoRow label="Storage (compressed)" value={fmtBytes(current.mongo.storageSizeBytes)} />
                <InfoRow label="Indexes" value={fmtBytes(current.mongo.indexSizeBytes)} />
                <InfoRow label="Collections" value={String(current.mongo.collections)} />
                <InfoRow label="Documents" value={current.mongo.objects.toLocaleString()} />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">Mongo stats unavailable.</p>
          )}
        </Card>

        <Card>
          <CardHeader title="Backend process" subtitle={`PID ${current.backend.pid} · Node`} />
          <div className="flex items-end gap-2 mb-3">
            <span className="text-[26px] font-bold text-foreground tabular-nums leading-none">{fmtBytes(current.backend.rssBytes)}</span>
            <span className="text-[11px] text-muted mb-0.5">resident memory</span>
          </div>
          <Sparkline values={backendSeries} stroke="rgb(var(--accent-rgb))" height={40} />
          <div className="mt-2">
            <InfoRow label="Heap used" value={fmtBytes(current.backend.heapUsedBytes)} />
            <InfoRow label="Heap total" value={fmtBytes(current.backend.heapTotalBytes)} />
            <InfoRow label="Process uptime" value={fmtUptime(current.backend.uptimeSeconds)} />
          </div>
        </Card>
      </div>
    </div>
  )
}

export default function Host() {
  const { data, loading, error, reload } = useApi<HostStats>('/api/host/stats')

  // Live polling.
  useEffect(() => {
    const id = setInterval(reload, POLL_MS)
    return () => clearInterval(id)
  }, [reload])

  const cpuTone = data ? loadTone(data.cpu.usage) : loadTone(0)
  const memTone = data ? loadTone(data.memory.usedPct) : loadTone(0)
  const maxTemp = data?.temperature.maxCelsius ?? null
  const tTone = maxTemp != null ? tempTone(maxTemp) : tempTone(0)

  const sortedSensors = useMemo(
    () => (data?.temperature.sensors ?? []).slice().sort((a, b) => b.celsius - a.celsius),
    [data],
  )

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <SoftwareCard />
        <div className="flex items-center justify-center h-48 text-muted text-sm">
          <span className="animate-pulse">Reading host telemetry…</span>
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="space-y-6">
        <SoftwareCard />
        <Card className="border-sell/30">
          <p className="text-sm text-sell">Failed to load host stats: {error}</p>
        </Card>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-6">
      <SoftwareCard />

      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground tracking-tight">{data.system.hostname}</h2>
          <p className="text-xs text-muted mt-0.5">
            {data.cpu.model} · {data.cpu.cores} cores · {(data.cpu.speedMhz / 1000).toFixed(2)} GHz
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-buy animate-pulse" />
          Live · updates every {POLL_MS / 1000}s
        </div>
      </div>

      {/* Hero gauges */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="flex items-center justify-center py-6">
          <RingGauge
            value={data.cpu.usage}
            display={`${Math.round(data.cpu.usage)}%`}
            label="CPU Usage"
            sub={`${data.cpu.cores} cores`}
            stroke={cpuTone.stroke}
          />
        </Card>
        <Card className="flex items-center justify-center py-6">
          <RingGauge
            value={data.memory.usedPct}
            display={`${Math.round(data.memory.usedPct)}%`}
            label="Memory"
            sub={`${fmtBytes(data.memory.usedBytes)} / ${fmtBytes(data.memory.totalBytes)}`}
            stroke={memTone.stroke}
          />
        </Card>
        <Card className="flex items-center justify-center py-6">
          {maxTemp != null ? (
            <RingGauge
              value={Math.min(100, (maxTemp / 100) * 100)}
              display={`${Math.round(maxTemp)}°`}
              label="Temperature"
              sub="hottest sensor"
              stroke={tTone.stroke}
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-center" style={{ height: 168 }}>
              <svg className="w-8 h-8 text-muted/50 mb-2" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" />
              </svg>
              <p className="text-xs text-muted">No temperature sensors</p>
              <p className="mt-1 text-[10px] text-muted/70 uppercase tracking-wider">Temperature</p>
            </div>
          )}
        </Card>
        <Card className="flex flex-col justify-center py-6 px-6">
          <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">Uptime</p>
          <p className="mt-2 text-[26px] font-bold text-foreground tabular-nums leading-none tracking-tight">
            {fmtUptime(data.system.uptimeSeconds)}
          </p>
          <div className="mt-5 space-y-2">
            <LoadBar label="Load 1m" pct={(data.cpu.loadAvg[0] / data.cpu.cores) * 100} valueText={data.cpu.loadAvg[0].toFixed(2)} />
            <LoadBar label="Load 5m" pct={(data.cpu.loadAvg[1] / data.cpu.cores) * 100} valueText={data.cpu.loadAvg[1].toFixed(2)} />
            <LoadBar label="Load 15m" pct={(data.cpu.loadAvg[2] / data.cpu.cores) * 100} valueText={data.cpu.loadAvg[2].toFixed(2)} />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Per-core CPU */}
        <Card className="lg:col-span-2">
          <CardHeader title="Per-core load" subtitle={`${data.cpu.cores} logical processors`} />
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-3">
            {data.cpu.perCore.map(c => (
              <LoadBar key={c.core} label={`Core ${c.core}`} pct={c.usage} valueText={`${Math.round(c.usage)}%`} />
            ))}
          </div>
        </Card>

        {/* System info */}
        <Card>
          <CardHeader title="System" />
          <div>
            <InfoRow label="Hostname" value={data.system.hostname} />
            <InfoRow label="Platform" value={`${data.system.platform} (${data.system.arch})`} />
            <InfoRow label="Kernel" value={data.system.release} />
            <InfoRow label="Node" value={data.system.nodeVersion} />
            <InfoRow label="Total RAM" value={fmtBytes(data.memory.totalBytes)} />
            <InfoRow label="Free RAM" value={fmtBytes(data.memory.freeBytes)} />
            <InfoRow label="CPU clock" value={`${(data.cpu.speedMhz / 1000).toFixed(2)} GHz`} />
          </div>
        </Card>
      </div>

      {/* Temperature sensors */}
      {sortedSensors.length > 0 && (
        <Card>
          <CardHeader title="Thermal sensors" subtitle={`${sortedSensors.length} zone${sortedSensors.length > 1 ? 's' : ''}`} />
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-3">
            {sortedSensors.map((s, i) => {
              const tone = tempTone(s.celsius)
              const pct = Math.min(100, (s.celsius / 100) * 100)
              return (
                <div key={`${s.label}-${i}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-medium text-muted truncate pr-2">{s.label}</span>
                    <span className={cn('text-[11px] font-semibold tabular-nums', tone.text)}>{s.celsius.toFixed(1)}°C</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-elevated overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all duration-500', tone.bg)} style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* App-level resource usage (containers, Mongo, backend process) */}
      <div className="pt-2 border-t border-border/60" />
      <AppUsageSection />
    </div>
  )
}
