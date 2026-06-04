# LLM Chart Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a chart page showing LLM analysis values (confidence × direction) over time per coin.

**Architecture:** New `GET /api/chart` endpoint computes value server-side; new `Charts.tsx` page renders a recharts line chart with one line per coin.

**Tech Stack:** Express + TypeScript, React + recharts + Tailwind

---

### Task 1: Backend — `GET /api/chart` endpoint

**Files:**
- Modify: `backend/src/api/routes.ts`

- [ ] **Step 1: Add the chart route**

Add after the existing `/decisions` route:

```typescript
router.get('/chart', (_req: Request, res: Response) => {
  const rows = queryAll(
    "SELECT coin, action, confidence, created_at FROM decisions ORDER BY created_at ASC"
  ) as { coin: string; action: string; confidence: number; created_at: string }[]
  const data = rows.map((r) => ({
    coin: r.coin,
    action: r.action,
    confidence: r.confidence,
    value: r.confidence * (r.action === 'BUY' ? 1 : r.action === 'SELL' ? -1 : 0),
    created_at: r.created_at,
  }))
  res.json(data)
})
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit`
Expected: no errors

---

### Task 2: Frontend — `Charts.tsx` page

**Files:**
- Create: `frontend/src/pages/Charts.tsx`

- [ ] **Step 1: Create the Charts page**

```tsx
import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from 'recharts'

interface ChartPoint {
  coin: string
  action: string
  confidence: number
  value: number
  created_at: string
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

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'Z')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-lg font-semibold text-green-400 mb-4">LLM Value Over Time</h2>
      {data.length === 0 ? (
        <p className="text-gray-500">No decisions recorded yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={500}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="created_at" tickFormatter={formatDate} stroke="#9ca3af" tick={{ fontSize: 11 }} />
            <YAxis domain={[-1, 1]} stroke="#9ca3af" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              labelFormatter={formatDate}
              formatter={(value: number, name: string) => {
                const pt = data.find((d) => d.coin === name)
                return [`${value.toFixed(2)} (${pt?.action} @ ${(pt?.confidence * 100).toFixed(0)}%)`, name]
              }}
            />
            <Legend />
            <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="5 5" />
            {coins.map((coin, i) => (
              <Line
                key={coin}
                type="monotone"
                dataKey="value"
                data={data.filter((d) => d.coin === coin)}
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
```

---

### Task 3: Frontend — Add Charts tab to `App.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Import Charts page and add tab**

Add import:
```typescript
import Charts from './pages/Charts'
```

Update the `Page` type:
```typescript
type Page = 'dashboard' | 'portfolio' | 'logs' | 'settings' | 'charts'
```

Add to the `tabs` array:
```typescript
{ key: 'charts', label: 'Charts' },
```

Add conditional render:
```typescript
{page === 'charts' && <Charts />}
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd /home/dauresl/cryptoBot/frontend && npx tsc --noEmit`
Expected: no errors
