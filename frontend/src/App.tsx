import { useState } from 'react'
import Dashboard from './pages/Dashboard'
import Portfolio from './pages/Portfolio'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import Charts from './pages/Charts'

type Page = 'dashboard' | 'portfolio' | 'logs' | 'settings' | 'charts'

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')

  const tabs: { key: Page; label: string }[] = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'portfolio', label: 'Portfolio' },
    { key: 'logs', label: 'Logs' },
    { key: 'settings', label: 'Settings' },
    { key: 'charts', label: 'Charts' },
  ]

  return (
    <div className="min-h-screen p-4 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-green-400">CryptoBot</h1>
        <nav className="flex gap-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setPage(t.key)}
              className={`px-4 py-2 rounded ${page === t.key ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {page === 'dashboard' && <Dashboard />}
      {page === 'portfolio' && <Portfolio />}
      {page === 'logs' && <Logs />}
      {page === 'settings' && <Settings />}
      {page === 'charts' && <Charts />}
    </div>
  )
}
