import { useState, useEffect } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from 'recharts'

interface ChartPoint {
  coin: string
  action: string
  confidence: number
  value: number
  created_at: string
}

interface ChartRow {
  created_at: string
  [coin: string]: number | string
}

const COLORS = ['#22c55e', '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

export default function Charts() {
  const [data, setData] = useState<ChartPoint[]>([])

  useEffect(() => {
    fetch('/api/chart')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
  }, [])

  const coins = [...new Set(data.map((d) => d.coin))].sort()

  const rows: ChartRow[] = Object.values(
    data.reduce<Record<string, ChartRow>>((acc, pt) => {
      if (!acc[pt.created_at]) acc[pt.created_at] = { created_at: pt.created_at }
      acc[pt.created_at][pt.coin] = pt.value
      return acc
    }, {})
  )

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'Z')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const tooltipFormatter = (value: number, name: string) => {
    const pt = data.find((d) => d.coin === name && d.value === value)
    const label = pt ? `${value.toFixed(2)} (${pt.action} @ ${(pt.confidence * 100).toFixed(0)}%)` : value.toFixed(2)
    return [label, name] as [string, string]
  }

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-lg font-semibold text-green-400 mb-4">LLM Value Over Time</h2>
      {data.length === 0 ? (
        <p className="text-gray-500">No decisions recorded yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={500}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="created_at" tickFormatter={formatDate} stroke="#9ca3af" tick={{ fontSize: 11 }} />
            <YAxis domain={[-1, 1]} stroke="#9ca3af" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              labelFormatter={formatDate}
              formatter={tooltipFormatter}
            />
            <Legend />
            <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="5 5" />
            {coins.map((coin, i) => (
              <Line
                key={coin}
                type="monotone"
                dataKey={coin}
                name={coin}
                stroke={COLORS[i % COLORS.length]}
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
