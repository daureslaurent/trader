import { useEffect, useState, FormEvent } from 'react'

interface Settings {
  watchlist: string[]
  interval_minutes: number
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
}

export default function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then(setSettings).catch(() => {})
  }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
    } catch (err) {
      alert('Failed to save settings: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return <p className="text-gray-500">Loading...</p>

  return (
    <div className="bg-gray-900 rounded-lg p-4 max-w-lg">
      <h2 className="text-lg font-semibold mb-4">Settings</h2>
      <form onSubmit={save} className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Watchlist (comma-separated pairs)</label>
          <input
            type="text"
            className="w-full bg-gray-800 rounded px-3 py-2 text-sm"
            value={settings.watchlist.join(', ')}
            onChange={(e) => setSettings({
              ...settings,
              watchlist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                .map((s) => s.endsWith('/USDT') ? s : s + '/USDT')
            })}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Interval (minutes)</label>
           <input type="number" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.interval_minutes} onChange={(e) => setSettings({ ...settings, interval_minutes: parseInt(e.target.value) || 0 })} />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Min Confidence (0-1)</label>
           <input type="number" step="0.1" min="0" max="1" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.min_confidence} onChange={(e) => setSettings({ ...settings, min_confidence: parseFloat(e.target.value) || 0 })} />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Max Position ($)</label>
           <input type="number" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.max_position_size_usd} onChange={(e) => setSettings({ ...settings, max_position_size_usd: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="approval" checked={settings.approval_required} onChange={(e) => setSettings({ ...settings, approval_required: e.target.checked })} />
          <label htmlFor="approval" className="text-sm">Approval required</label>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Stop Loss ATR</label>
             <input type="number" step="0.1" min="0" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.stop_loss_atr} onChange={(e) => setSettings({ ...settings, stop_loss_atr: parseFloat(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Take Profit ATR</label>
             <input type="number" step="0.1" min="0" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.take_profit_atr} onChange={(e) => setSettings({ ...settings, take_profit_atr: parseFloat(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Max Risk Per Trade (%)</label>
             <input type="number" step="0.01" min="0" max="1" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.max_risk_per_trade} onChange={(e) => setSettings({ ...settings, max_risk_per_trade: parseFloat(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Max Open Positions</label>
             <input type="number" step="1" min="0" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.max_open_positions} onChange={(e) => setSettings({ ...settings, max_open_positions: parseInt(e.target.value) || 0 })} />
          </div>
        </div>
        <button type="submit" disabled={saving} className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded text-sm font-medium disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </form>
    </div>
  )
}
