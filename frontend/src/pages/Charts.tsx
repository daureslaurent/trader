import { useState, useEffect } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { Card, CardHeader } from '../components/ui/Card'
import { ChartPoint } from '../types'
import { formatDate } from '../lib/utils'

interface ChartRow {
  created_at: string
  [coin: string]: number | string
}

interface ApiPoint extends ChartPoint {
  action: string
  confidence: number
}

const THEME_COLORS = [
  'rgb(var(--accent-rgb))',
  'rgb(var(--sell-rgb))',
  '#3b82f6',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
]

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--surface-elevated)',
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  fontSize: '12px',
  color: 'var(--foreground)',
}

export default function Charts() {
  const [data, setData] = useState<ApiPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/chart').then(r => r.json()).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const coins = [...new Set(data.map(d => d.coin))].sort()

  const rows: ChartRow[] = Object.values(
    data.reduce<Record<string, ChartRow>>((acc, pt) => {
      if (!acc[pt.created_at]) acc[pt.created_at] = { created_at: pt.created_at }
      acc[pt.created_at][pt.coin] = pt.value
      return acc
    }, {})
  ).sort((a, b) => new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime())

  function tooltipFormatter(value: number, name: string): [string, string] {
    const pt = data.find(d => d.coin === name && d.value === value)
    const label = pt ? `${value.toFixed(2)} — ${pt.action} (${Math.round(pt.confidence * 100)}%)` : value.toFixed(2)
    return [label, name.replace('/USDC', '')]
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <Card noPad>
        <div className="px-5 pt-5 pb-2">
          <CardHeader
            title="Analyst Signal Over Time"
            subtitle="LLM confidence values per coin across pipeline cycles"
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-sm text-muted">
            No pipeline cycles recorded yet.
          </div>
        ) : (
          <div className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={480}>
              <LineChart data={rows} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis
                  dataKey="created_at"
                  tickFormatter={formatDate}
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  domain={[-1, 1]}
                  stroke="var(--muted-fg)"
                  tick={{ fontSize: 11, fill: 'var(--muted-fg)' }}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={formatDate}
                  formatter={tooltipFormatter}
                  cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '12px', color: 'var(--muted-fg)' }}
                  formatter={v => v.replace('/USDC', '')}
                />
                <ReferenceLine y={0} stroke="var(--border-color)" strokeDasharray="4 4" />
                {coins.map((coin, i) => (
                  <Line
                    key={coin}
                    type="monotone"
                    dataKey={coin}
                    name={coin}
                    stroke={THEME_COLORS[i % THEME_COLORS.length]}
                    dot={false}
                    strokeWidth={2}
                    connectNulls
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  )
}
