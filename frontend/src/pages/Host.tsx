import { useEffect, useMemo } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { useApi } from '../hooks/useApi'
import { HostStats } from '../types'
import { cn } from '../lib/utils'

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
      <div className="flex items-center justify-center h-64 text-muted text-sm">
        <span className="animate-pulse">Reading host telemetry…</span>
      </div>
    )
  }

  if (error && !data) {
    return (
      <Card className="border-sell/30">
        <p className="text-sm text-sell">Failed to load host stats: {error}</p>
      </Card>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-6">
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
    </div>
  )
}
