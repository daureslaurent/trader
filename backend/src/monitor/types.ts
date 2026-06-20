// Domain types for the monitor module. These were previously colocated with the classic
// ensemble's prompt builder (prompts.ts); they survive the prompt builder's removal because
// the agentic engine (engine.ts) and the shared context/finalize helpers (context.ts) both
// describe a position with PositionContext and resolve horizon SL/TP targets with HorizonConfigs.

export interface PositionContext {
  positionId: number | null
  coin: string
  quantity: number
  entryPrice: number
  currentPrice: number
  pnlUsd: number
  pnlPct: number
  stopLoss: number | null
  takeProfit: number | null
  distanceToSlPct: number | null
  distanceToTpPct: number | null
  entryDate: string
  ageHours: number
  horizon: 'short' | 'medium' | 'long' | 'disabled' | 'llm'
  rsi14: number
  trend: 'uptrend' | 'downtrend' | 'ranging'
  volatility: 'high' | 'normal' | 'low'
  atr14: number
  sma7: number
  sma25: number
  change24h: number
  perf7d: number
}

export interface HorizonConfig {
  slPct: number
  tpPct: number
}

export type HorizonConfigs = Record<'short' | 'medium' | 'long', HorizonConfig>

export interface MonitorNotes {
  notes: string
  updated_at: string
}

export function fmtOffsetLabel(offsetHours: number): string {
  if (offsetHours === 0) return 'UTC'
  const sign = offsetHours > 0 ? '+' : '-'
  const abs = Math.abs(offsetHours)
  const h = Math.floor(abs)
  const m = Math.round((abs - h) * 60)
  return m > 0 ? `UTC${sign}${h}:${m.toString().padStart(2, '0')}` : `UTC${sign}${h}`
}
