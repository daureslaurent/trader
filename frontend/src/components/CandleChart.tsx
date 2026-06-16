import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ReferenceDot, ReferenceLine, ReferenceArea,
  ResponsiveContainer,
} from 'recharts'
import type { Decision, Trade, SlTpEvent, PositionReview } from '../types'
import { fmtUSD, fmt, cn } from '../lib/utils'
import { usePrices } from '../hooks/usePrices'
import { useApi } from '../hooks/useApi'

export interface Candle {
  time: number   // epoch seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
type Timeframe = (typeof TIMEFRAMES)[number]

// Per-timeframe refresh cadence (ms) — matches the backend cache TTL roughly.
const REFRESH_MS: Record<Timeframe, number> = {
  '1m': 15_000, '5m': 30_000, '15m': 60_000,
  '1h': 60_000, '4h': 120_000, '1d': 300_000,
}

interface Signal {
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  reason: string
}

interface TradeMark {
  id: number
  side: 'BUY' | 'SELL'
  price: number
  quantity: number
}

interface ReviewMark {
  id: number
  action: PositionReview['action']
  confidence: number
  reasoning: string
}

interface ChartDatum extends Candle {
  range: [number, number]   // [low, high] — drives the floating bar
  signal?: Signal
  trades?: TradeMark[]
  reviews?: ReviewMark[]    // monitor runs that reviewed the position during this candle
  sl?: number | null        // active stop-loss at this candle's time
  tp?: number | null        // active take-profit at this candle's time
}

// A horizontal price level drawn across the chart (e.g. entry trigger lines).
export interface ChartLevel {
  price: number
  label: string
  color: string       // CSS color, e.g. 'rgb(var(--accent-rgb))'
  dash?: string       // strokeDasharray, omit for solid
}

// A shaded horizontal band between two prices (e.g. the entry fill window).
export interface ChartZone {
  y1: number
  y2: number
  color: string       // CSS color for the fill
}

// Left-anchored pill label for a horizontal level — keeps clear of the right-axis live tag.
function LevelLabel(props: any) {
  const { viewBox, text, color } = props
  if (!viewBox) return null
  const { x, y } = viewBox
  const w = text.length * 5.6 + 14, h = 15
  return (
    <g>
      <rect x={x + 5} y={y - h / 2} width={w} height={h} rx={3}
        fill="var(--surface-elevated)" stroke={color} strokeWidth={1} />
      <text x={x + 5 + w / 2} y={y + 3.5} textAnchor="middle" fontSize={9} fontWeight={600} fill={color}>
        {text}
      </text>
    </g>
  )
}

function fmtPrice(n: number): string {
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (n >= 0.01) return n.toFixed(4)
  return n.toExponential(2)
}

function fmtAxisTime(time: number, tf: Timeframe): string {
  const d = new Date(time * 1000)
  if (tf === '1d') return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (tf === '4h' || tf === '1h') return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function parseTime(s: string): number {
  return Math.floor(new Date(s.includes('T') ? s : s + 'Z').getTime() / 1000)
}

function clampIdx(i: number, len: number): number {
  return Math.min(Math.max(i, 0), len - 1)
}

// Custom candle shape: high–low wick + open–close body, colored by direction.
function Candlestick(props: any) {
  const { x, y, width, height, payload } = props
  const { open, close, high, low } = payload as ChartDatum
  if (high === low || width == null) return null

  const ratio = height / (high - low)
  const isUp = close >= open
  const color = isUp ? 'rgb(var(--buy-rgb))' : 'rgb(var(--sell-rgb))'

  const cx = x + width / 2
  const bodyTop = y + (high - Math.max(open, close)) * ratio
  const bodyBottom = y + (high - Math.min(open, close)) * ratio
  const bodyH = Math.max(bodyBottom - bodyTop, 1)
  const bodyW = Math.max(width * 0.6, 1)
  const bodyX = cx - bodyW / 2

  return (
    <g stroke={color} fill={color}>
      <line x1={cx} y1={y} x2={cx} y2={y + height} strokeWidth={1} />
      <rect x={bodyX} y={bodyTop} width={bodyW} height={bodyH} />
    </g>
  )
}

// Soft radial halo behind a marker — gives the modern "glow" without SVG filters
// (mirrors the layered-opacity trick the live dot uses). Two stacked translucent
// discs fade outward so the marker reads as lit from within against any candle.
function Halo({ cx, cy, color, r = 9 }: { cx: number; cy: number; color: string; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={color} opacity={0.12} />
      <circle cx={cx} cy={cy} r={r * 0.6} fill={color} opacity={0.18} />
    </g>
  )
}

// Analyst signal marker — a glowing rounded chevron (BUY ▲ below low, SELL ▼ above
// high) or a ringed dot for HOLD. Rounded joins + a halo read cleaner than the old
// hard triangles, and the card-colored outline keeps it crisp over any candle.
function SignalMarker(props: any) {
  const { cx, cy, action } = props
  if (cx == null || cy == null) return null
  const s = 5.5
  if (action === 'BUY') {
    const y = cy + 11
    const color = 'rgb(var(--buy-rgb))'
    return (
      <g>
        <Halo cx={cx} cy={y} color={color} r={8} />
        <path d={`M${cx},${y - s} L${cx - s},${y + s} L${cx + s},${y + s} Z`}
          fill={color} stroke="var(--surface-card)" strokeWidth={1} strokeLinejoin="round" />
      </g>
    )
  }
  if (action === 'SELL') {
    const y = cy - 11
    const color = 'rgb(var(--sell-rgb))'
    return (
      <g>
        <Halo cx={cx} cy={y} color={color} r={8} />
        <path d={`M${cx},${y + s} L${cx - s},${y - s} L${cx + s},${y - s} Z`}
          fill={color} stroke="var(--surface-card)" strokeWidth={1} strokeLinejoin="round" />
      </g>
    )
  }
  const color = 'rgb(var(--warn-rgb))'
  return (
    <g>
      <Halo cx={cx} cy={cy} color={color} r={6} />
      <circle cx={cx} cy={cy} r={3.5} fill={color} stroke="var(--surface-card)" strokeWidth={1} />
    </g>
  )
}

function reviewColor(action: ReviewMark['action']): string {
  if (action === 'CLOSE') return 'rgb(var(--sell-rgb))'
  if (action === 'HOLD') return 'rgb(var(--accent-rgb))'
  return 'rgb(var(--warn-rgb))' // REDUCE / ADJUST
}

// Monitor review marker: a glowing diamond above the candle (stacked above any SELL
// signal), with a tethered count pill when a candle holds several reviews.
function MonitorMarker(props: any) {
  const { cx, cy, reviews } = props as { cx?: number; cy?: number; reviews: ReviewMark[] }
  if (cx == null || cy == null) return null
  const s = 5
  const y = cy - 24
  const color = reviewColor(reviews[reviews.length - 1].action)
  const count = reviews.length
  return (
    <g>
      <Halo cx={cx} cy={y} color={color} r={8} />
      <path d={`M${cx},${y - s} L${cx + s},${y} L${cx},${y + s} L${cx - s},${y} Z`}
        fill={color} stroke="var(--surface-card)" strokeWidth={1} strokeLinejoin="round" />
      {count > 1 && (
        <g>
          <rect x={cx + s - 1} y={y - s - 9} width={count > 9 ? 17 : 13} height={12} rx={6}
            fill={color} stroke="var(--surface-card)" strokeWidth={1} />
          <text x={cx + s - 1 + (count > 9 ? 8.5 : 6.5)} y={y - s} textAnchor="middle"
            fontSize={8} fontWeight={800} fill="#fff">
            {count}
          </text>
        </g>
      )}
    </g>
  )
}

// Executed-trade marker: a glowing badge at the fill price with a B / S label.
function TradeMarker(props: any) {
  const { cx, cy, side } = props
  if (cx == null || cy == null) return null
  const color = side === 'BUY' ? 'rgb(var(--buy-rgb))' : 'rgb(var(--sell-rgb))'
  return (
    <g>
      <Halo cx={cx} cy={cy} color={color} r={12} />
      <circle cx={cx} cy={cy} r={7.5} fill={color} stroke="var(--surface-card)" strokeWidth={1.75} />
      <text x={cx} y={cy + 3} textAnchor="middle" fontSize={9} fontWeight={800} fill="#fff">
        {side === 'BUY' ? 'B' : 'S'}
      </text>
    </g>
  )
}

// Pulsing live-price dot (radar ping), self-contained SVG animation.
function LiveDot(props: any) {
  const { cx, cy, color } = props
  if (cx == null || cy == null) return null
  return (
    <g>
      <circle cx={cx} cy={cy} fill={color} opacity={0.45}>
        <animate attributeName="r" values="4;14" dur="1.6s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0" dur="1.6s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx} cy={cy} r={3.5} fill={color} stroke="var(--surface-card)" strokeWidth={1} />
    </g>
  )
}

// Colored price tag pinned to the right Y-axis (outside the chart area so it never overlaps candles).
function LivePriceTag(props: any) {
  const { viewBox, value, color } = props
  if (!viewBox) return null
  const { x, y, width } = viewBox
  // x + width is the right edge of the chart area = left edge of the Y-axis strip.
  // Place the tag flush there so it sits in the axis, not on the candles.
  const w = 54, h = 16
  const tx = x + width + 1
  return (
    <g>
      <rect x={tx} y={y - h / 2} width={w} height={h} rx={3} fill={color} />
      <text x={tx + w / 2} y={y + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--surface-base)">
        {value}
      </text>
    </g>
  )
}

// Outlined SL/TP tag — same position as LivePriceTag but with border-only style.
// nudge=true shifts it down by TAG_H+2 to avoid colliding with the live price tag.
function SlTpPriceTag(props: any) {
  const { viewBox, value, color, nudge } = props
  if (!viewBox) return null
  const { x, y, width } = viewBox
  const w = 54, h = 16
  const tx = x + width + 1
  const ty = nudge ? y + h + 2 : y
  return (
    <g>
      <rect x={tx} y={ty - h / 2} width={w} height={h} rx={3}
        fill="var(--surface-elevated)" stroke={color} strokeWidth={1} />
      <text x={tx + w / 2} y={ty + 3.5} textAnchor="middle"
        fontSize={10} fontWeight={600} fill={color}>
        {value}
      </text>
    </g>
  )
}

// Convert a price to its approximate pixel Y inside the chart.
// margin.top=12, height=300, margin.bottom=4 → innerH=284
function pixelY(price: number, domain: [number, number]): number {
  const [min, max] = domain
  return 12 + ((max - price) / (max - min)) * 284
}

function CandleTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartDatum }[] }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const isUp = d.close >= d.open
  const chgPct = d.open > 0 ? ((d.close - d.open) / d.open) * 100 : 0
  const sigColor = d.signal?.action === 'BUY' ? 'text-buy' : d.signal?.action === 'SELL' ? 'text-sell' : 'text-warn'
  return (
    <div
      className="px-3 py-2 rounded-xl border text-xs space-y-1 max-w-[240px]"
      style={{ backgroundColor: 'var(--surface-elevated)', borderColor: 'var(--border-color)' }}
    >
      <p className="text-[11px] text-muted">{new Date(d.time * 1000).toLocaleString()}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
        <span className="text-muted">O <span className="text-foreground">{fmtPrice(d.open)}</span></span>
        <span className="text-muted">H <span className="text-foreground">{fmtPrice(d.high)}</span></span>
        <span className="text-muted">L <span className="text-foreground">{fmtPrice(d.low)}</span></span>
        <span className="text-muted">C <span className="text-foreground">{fmtPrice(d.close)}</span></span>
      </div>
      <p className={cn('text-[11px] font-semibold', isUp ? 'text-buy' : 'text-sell')}>
        {isUp ? '+' : ''}{chgPct.toFixed(2)}%
      </p>
      {d.signal && (
        <div className="pt-1 mt-1 border-t border-border/50 space-y-0.5">
          <p className={cn('text-[11px] font-bold', sigColor)}>
            ⬤ {d.signal.action} signal — {Math.round(d.signal.confidence * 100)}%
          </p>
          {d.signal.reason && (
            <p className="text-[11px] text-muted leading-snug line-clamp-3">{d.signal.reason}</p>
          )}
        </div>
      )}
      {d.trades && d.trades.length > 0 && (
        <div className="pt-1 mt-1 border-t border-border/50 space-y-0.5">
          {d.trades.map(t => (
            <p key={t.id} className={cn('text-[11px] font-semibold', t.side === 'BUY' ? 'text-buy' : 'text-sell')}>
              {t.side === 'BUY' ? '▲' : '▼'} {t.side} {fmt(t.quantity, 4)} @ {fmtPrice(t.price)}
            </p>
          ))}
        </div>
      )}
      {d.reviews && d.reviews.length > 0 && (
        <div className="pt-1 mt-1 border-t border-border/50 space-y-1">
          {d.reviews.map(r => (
            <div key={r.id} className="space-y-0.5">
              <p className="text-[11px] font-bold" style={{ color: reviewColor(r.action) }}>
                ◆ Monitor: {r.action} — {Math.round(r.confidence * 100)}%
              </p>
              {r.reasoning && (
                <p className="text-[11px] text-muted leading-snug line-clamp-3">{r.reasoning}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function CandleChart({ symbol, decisions = [], trades = [], levels = [], zones = [], hideSlTp = false }: {
  symbol: string
  decisions?: Decision[]
  trades?: Trade[]
  levels?: ChartLevel[]
  zones?: ChartZone[]
  hideSlTp?: boolean
}) {
  const [tf, setTf] = useState<Timeframe>(() => (localStorage.getItem('chart_tf') as Timeframe | null) ?? '1h')
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSl, setShowSl] = useState(true)
  const [showTp, setShowTp] = useState(true)
  const [slTpEvents, setSlTpEvents] = useState<SlTpEvent[]>([])
  const [monitorReviews, setMonitorReviews] = useState<PositionReview[]>([])
  const [coinDecisions, setCoinDecisions] = useState<Decision[]>([])
  const reqId = useRef(0)

  useEffect(() => { localStorage.setItem('chart_tf', tf) }, [tf])

  // Marker-retention settings (Trade-page chart). Fall back to the built-in defaults
  // when settings haven't loaded yet so the chart always renders.
  const { data: chartSettings } = useApi<{ chart_candle_limit?: number; chart_marker_limit?: number }>('/api/settings')
  const candleLimit = Math.min(Math.max(chartSettings?.chart_candle_limit ?? 150, 10), 1000)

  const livePrices = usePrices()
  const liveSnap = livePrices.get(symbol)

  // SL/TP change history + monitor review history + per-coin analyst signals for the
  // coin (refetched when coin or the marker-depth setting changes). Pulling decisions
  // per coin — rather than relying on the global latest-50 feed passed in as a prop —
  // is what gives the signal markers real history depth.
  useEffect(() => {
    let cancelled = false
    const base = symbol.replace('/USDC', '')
    fetch(`/api/decisions/${base}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setCoinDecisions(Array.isArray(d) ? d : []) })
      .catch(() => { if (!cancelled) setCoinDecisions([]) })
    if (hideSlTp) { setSlTpEvents([]); setMonitorReviews([]); return () => { cancelled = true } }
    fetch(`/api/sl-tp/${base}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setSlTpEvents(Array.isArray(d) ? d : []) })
      .catch(() => { if (!cancelled) setSlTpEvents([]) })
    fetch(`/api/monitor/reviews/${base}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setMonitorReviews(Array.isArray(d) ? d : []) })
      .catch(() => { if (!cancelled) setMonitorReviews([]) })
    return () => { cancelled = true }
  }, [symbol, hideSlTp, chartSettings?.chart_marker_limit])

  useEffect(() => {
    let cancelled = false
    const id = ++reqId.current
    const base = symbol.replace('/USDC', '')

    function load(initial: boolean) {
      if (initial) { setLoading(true); setError(null) }
      fetch(`/api/ohlcv/${base}?tf=${tf}&limit=${candleLimit}`)
        .then(r => r.json())
        .then(data => {
          if (cancelled || id !== reqId.current) return
          if (data.error) setError(data.error)
          else { setCandles(data.candles ?? []); setError(null) }
        })
        .catch(() => { if (!cancelled) setError('Failed to load chart data') })
        .finally(() => { if (!cancelled && initial) setLoading(false) })
    }

    load(true)
    const t = setInterval(() => load(false), REFRESH_MS[tf])
    return () => { cancelled = true; clearInterval(t) }
  }, [symbol, tf, candleLimit])

  // Candle data enriched with signal + trade markers (independent of live price).
  const data = useMemo<ChartDatum[]>(() => {
    if (candles.length === 0) return []

    const step = candles.length > 1 ? candles[1].time - candles[0].time : 3600
    const firstTime = candles[0].time
    const lastTime = candles[candles.length - 1].time
    const inRange = (ts: number) => ts >= firstTime && ts < lastTime + step
    const candleTimeFor = (ts: number) => candles[clampIdx(Math.floor((ts - firstTime) / step), candles.length)].time

    // Analyst signals — most recent decision wins per candle. Merge the per-coin
    // history (deep) with whatever decisions were passed in as a prop (the global
    // feed), deduped by id, so markers keep their full configured depth.
    const seenIds = new Set<number>()
    const allDecisions = [...coinDecisions, ...decisions].filter(d => {
      if (seenIds.has(d.id)) return false
      seenIds.add(d.id)
      return true
    })
    const signalByTime = new Map<number, Signal>()
    allDecisions
      .filter(d => d.coin === symbol)
      .map(d => ({ ...d, ts: parseTime(d.created_at) }))
      .sort((a, b) => a.ts - b.ts)
      .forEach(d => {
        if (!inRange(d.ts)) return
        signalByTime.set(candleTimeFor(d.ts), { action: d.action, confidence: d.confidence, reason: d.reason })
      })

    // Executed trades — all of them, grouped by candle.
    const tradesByTime = new Map<number, TradeMark[]>()
    trades
      .filter(t => t.coin === symbol && t.status === 'EXECUTED' && t.price > 0)
      .forEach(t => {
        const ts = parseTime(t.created_at)
        if (!inRange(ts)) return
        const key = candleTimeFor(ts)
        const arr = tradesByTime.get(key) ?? []
        arr.push({ id: t.id, side: t.side, price: t.price, quantity: t.quantity })
        tradesByTime.set(key, arr)
      })

    // Monitor reviews — grouped by candle, in chronological order.
    const reviewsByTime = new Map<number, ReviewMark[]>()
    monitorReviews
      .map(r => ({ ...r, ts: parseTime(r.created_at) }))
      .sort((a, b) => a.ts - b.ts)
      .forEach(r => {
        if (!inRange(r.ts)) return
        const key = candleTimeFor(r.ts)
        const arr = reviewsByTime.get(key) ?? []
        arr.push({ id: r.id, action: r.action, confidence: r.confidence, reasoning: r.reasoning })
        reviewsByTime.set(key, arr)
      })

    // SL/TP active-state timeline: replay events to know the level at any time.
    // One open position per coin, so at most one active level at a time.
    const timeline: { ts: number; sl: number | null; tp: number | null }[] = []
    let activeId: number | null = null
    let curSl: number | null = null
    let curTp: number | null = null
    for (const e of [...slTpEvents].sort((a, b) => parseTime(a.created_at) - parseTime(b.created_at))) {
      const ts = parseTime(e.created_at)
      if (e.event === 'close') {
        if (activeId === null || e.position_id === activeId) { activeId = null; curSl = null; curTp = null }
      } else {
        activeId = e.position_id; curSl = e.stop_loss; curTp = e.take_profit
      }
      timeline.push({ ts, sl: curSl, tp: curTp })
    }
    const stateAt = (t: number) => {
      let sl: number | null = null, tp: number | null = null
      for (const s of timeline) { if (s.ts <= t) { sl = s.sl; tp = s.tp } else break }
      return { sl, tp }
    }

    return candles.map(c => {
      const { sl, tp } = stateAt(c.time)
      return {
        ...c,
        range: [c.low, c.high] as [number, number],
        signal: signalByTime.get(c.time),
        trades: tradesByTime.get(c.time),
        reviews: reviewsByTime.get(c.time),
        sl,
        tp,
      }
    })
  }, [candles, decisions, coinDecisions, trades, slTpEvents, monitorReviews, symbol])

  const last = candles[candles.length - 1]
  const first = candles[0]
  const livePrice = liveSnap?.price ?? last?.close ?? 0

  // Y-domain stretched to include the live price (and SL/TP when shown) so nothing clips.
  const domain = useMemo<[number, number]>(() => {
    if (data.length === 0) return [0, 1]
    let min = Infinity, max = -Infinity
    for (const d of data) {
      min = Math.min(min, d.low); max = Math.max(max, d.high)
      if (showSl && d.sl != null) { min = Math.min(min, d.sl); max = Math.max(max, d.sl) }
      if (showTp && d.tp != null) { min = Math.min(min, d.tp); max = Math.max(max, d.tp) }
    }
    if (livePrice > 0) { min = Math.min(min, livePrice); max = Math.max(max, livePrice) }
    for (const l of levels) { min = Math.min(min, l.price); max = Math.max(max, l.price) }
    for (const z of zones) { min = Math.min(min, z.y1, z.y2); max = Math.max(max, z.y1, z.y2) }
    const pad = (max - min) * 0.08 || max * 0.01
    return [min - pad, max + pad]
  }, [data, livePrice, showSl, showTp, levels, zones])

  const currentSl = useMemo(() => {
    if (!showSl) return null
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i].sl != null) return data[i].sl as number
    }
    return null
  }, [data, showSl])

  const currentTp = useMemo(() => {
    if (!showTp) return null
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i].tp != null) return data[i].tp as number
    }
    return null
  }, [data, showTp])

  const TAG_H = 16
  const livePixelY = livePrice > 0 ? pixelY(livePrice, domain) : null
  const slNudge = currentSl != null && livePixelY != null
    ? Math.abs(pixelY(currentSl, domain) - livePixelY) < TAG_H : false
  const tpNudge = currentTp != null && livePixelY != null
    ? Math.abs(pixelY(currentTp, domain) - livePixelY) < TAG_H : false

  const periodChange = first && first.open > 0 ? ((livePrice - first.open) / first.open) * 100 : 0
  const liveColor = periodChange >= 0 ? 'rgb(var(--buy-rgb))' : 'rgb(var(--sell-rgb))'

  const tradeMarkers = data.flatMap(d => (d.trades ?? []).map(t => ({ ...t, time: d.time })))
  const signalCount = data.filter(d => d.signal).length

  return (
    <div>
      {/* Header: live price, change, timeframe selector */}
      <div className="flex items-center justify-between px-5 pb-3">
        <div className="flex items-center gap-2.5">
          {last && (
            <>
              <span className="text-xl font-bold tabular-nums text-foreground">{fmtUSD(livePrice)}</span>
              {liveSnap && (
                <span className="flex items-center gap-1 text-[10px] font-medium text-buy">
                  <span className="w-1.5 h-1.5 rounded-full bg-buy animate-pulse" />
                  LIVE
                </span>
              )}
              <span className={cn(
                'text-xs font-semibold px-2 py-0.5 rounded-lg',
                periodChange >= 0 ? 'bg-buy/10 text-buy' : 'bg-sell/10 text-sell',
              )}>
                {periodChange >= 0 ? '+' : ''}{periodChange.toFixed(2)}%
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!hideSlTp && (
            <>
              <button
                onClick={() => setShowSl(v => !v)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-lg transition-all',
                  showSl ? 'bg-sell/10 text-sell' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                )}
                title="Toggle stop-loss level"
              >
                SL
              </button>
              <button
                onClick={() => setShowTp(v => !v)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-lg transition-all',
                  showTp ? 'bg-buy/10 text-buy' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                )}
                title="Toggle take-profit level"
              >
                TP
              </button>
              <div className="w-px h-4 bg-border mx-1" />
            </>
          )}
          {TIMEFRAMES.map(t => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={cn(
                'px-2.5 py-1 text-xs font-medium rounded-lg transition-all',
                tf === t ? 'bg-accent/10 text-accent' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-96">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-96 text-sm text-muted px-5 text-center">{error}</div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-96 text-sm text-muted">No candle data.</div>
      ) : (
        <>
          <div className="px-2 pb-2">
            <ResponsiveContainer width="100%" height={400}>
              <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                <XAxis
                  dataKey="time"
                  tickFormatter={(v: number) => fmtAxisTime(v, tf)}
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 10, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                />
                <YAxis
                  domain={domain}
                  orientation="right"
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 10, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tickFormatter={fmtPrice}
                />
                <Tooltip content={<CandleTooltip />} cursor={{ fill: 'var(--surface-elevated)', opacity: 0.4 }} />

                {/* Shaded zones (e.g. the entry fill window) — behind the candles */}
                {zones.map((z, i) => (
                  <ReferenceArea
                    key={`zone-${i}`}
                    y1={z.y1} y2={z.y2}
                    fill={z.color} fillOpacity={0.1}
                    stroke="none" ifOverflow="extendDomain"
                  />
                ))}

                <Bar dataKey="range" shape={<Candlestick />} isAnimationActive={false} />

                {/* Horizontal price levels (e.g. entry triggers) with left-anchored labels */}
                {levels.map((l, i) => (
                  <ReferenceLine
                    key={`level-${i}`}
                    y={l.price} stroke={l.color} strokeWidth={1.5}
                    strokeDasharray={l.dash} ifOverflow="extendDomain"
                    label={<LevelLabel text={`${l.label} ${fmtPrice(l.price)}`} color={l.color} />}
                  />
                ))}

                {/* Stop-loss / take-profit levels — stepped so they follow their history */}
                {showTp && (
                  <Line
                    dataKey="tp" name="Take profit" type="stepAfter"
                    stroke="rgb(var(--buy-rgb))" strokeWidth={1.5} strokeDasharray="5 3"
                    dot={false} activeDot={false} connectNulls={false} isAnimationActive={false}
                  />
                )}
                {showSl && (
                  <Line
                    dataKey="sl" name="Stop loss" type="stepAfter"
                    stroke="rgb(var(--sell-rgb))" strokeWidth={1.5} strokeDasharray="5 3"
                    dot={false} activeDot={false} connectNulls={false} isAnimationActive={false}
                  />
                )}

                {/* Analyst signal markers */}
                {data.filter(d => d.signal).map(d => (
                  <ReferenceDot
                    key={`sig-${d.time}`}
                    x={d.time}
                    y={d.signal!.action === 'SELL' ? d.high : d.low}
                    ifOverflow="extendDomain"
                    isFront
                    shape={<SignalMarker action={d.signal!.action} />}
                  />
                ))}

                {/* Monitor review markers (diamond above the candle) */}
                {data.filter(d => d.reviews?.length).map(d => (
                  <ReferenceDot
                    key={`rev-${d.time}`}
                    x={d.time}
                    y={d.high}
                    ifOverflow="extendDomain"
                    isFront
                    shape={<MonitorMarker reviews={d.reviews!} />}
                  />
                ))}

                {/* Executed trade markers (at fill price) */}
                {tradeMarkers.map(t => (
                  <ReferenceDot
                    key={`trade-${t.id}`}
                    x={t.time}
                    y={t.price}
                    ifOverflow="extendDomain"
                    isFront
                    shape={<TradeMarker side={t.side} />}
                  />
                ))}

                {/* SL/TP current-level price tags on Y-axis */}
                {showSl && currentSl != null && (
                  <ReferenceLine y={currentSl} stroke="transparent" ifOverflow="extendDomain"
                    label={<SlTpPriceTag value={fmtPrice(currentSl)} color="rgb(var(--sell-rgb))" nudge={slNudge} />}
                  />
                )}
                {showTp && currentTp != null && (
                  <ReferenceLine y={currentTp} stroke="transparent" ifOverflow="extendDomain"
                    label={<SlTpPriceTag value={fmtPrice(currentTp)} color="rgb(var(--buy-rgb))" nudge={tpNudge} />}
                  />
                )}

                {/* Live price line + pulsing dot */}
                {livePrice > 0 && (
                  <ReferenceLine
                    y={livePrice}
                    stroke={liveColor}
                    strokeDasharray="3 3"
                    strokeOpacity={0.6}
                    ifOverflow="extendDomain"
                    label={<LivePriceTag value={fmtPrice(livePrice)} color={liveColor} />}
                  />
                )}
                {livePrice > 0 && last && (
                  <ReferenceDot
                    x={last.time}
                    y={livePrice}
                    ifOverflow="extendDomain"
                    isFront
                    shape={<LiveDot color={liveColor} />}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 px-5 pb-4 text-[11px] text-muted">
            <span className="flex items-center gap-1.5"><span className="text-buy">▲</span> Buy signal</span>
            <span className="flex items-center gap-1.5"><span className="text-sell">▼</span> Sell signal</span>
            <span className="flex items-center gap-1.5"><span className="text-warn">⬤</span> Hold</span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-buy text-white text-[7px] font-bold">B</span>
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-sell text-white text-[7px] font-bold">S</span>
              Executed trade
            </span>
            {data.some(d => d.reviews?.length) && (
              <span className="flex items-center gap-1.5"><span className="text-accent">◆</span> Monitor review</span>
            )}
            {showSl && (
              <span className="flex items-center gap-1.5">
                <span className="w-4 border-t-2 border-dashed border-sell" /> Stop loss
              </span>
            )}
            {showTp && (
              <span className="flex items-center gap-1.5">
                <span className="w-4 border-t-2 border-dashed border-buy" /> Take profit
              </span>
            )}
            {signalCount === 0 && tradeMarkers.length === 0 && (
              <span className="text-muted/60 ml-auto">No signals or trades in this range</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
