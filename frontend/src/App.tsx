import { useState, useCallback, useRef } from 'react'
import { ThemeProvider } from './contexts/ThemeContext'
import { Sidebar } from './components/layout/Sidebar'
import { ThemeSelector } from './components/layout/ThemeSelector'
import { Page, Toast, ApprovalRequest } from './types'
import { useWebSocket } from './hooks/useWebSocket'
import { cn } from './lib/utils'
import Dashboard from './pages/Dashboard'
import Portfolio from './pages/Portfolio'
import Trade from './pages/Trade'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import Charts from './pages/Charts'
import LLM from './pages/LLM'
import CacheView from './pages/CacheView'

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard',
  portfolio: 'Portfolio',
  trade: 'Trade',
  pipeline: 'Pipeline',
  charts: 'Signals',
  logs: 'Logs',
  cache: 'Article Cache',
  settings: 'Settings',
}

let toastId = 0

function ToastList({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const ICONS: Record<Toast['type'], string> = {
    success: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    error:   'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z',
    warning: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z',
    info:    'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z',
  }
  const COLORS: Record<Toast['type'], string> = {
    success: 'text-buy',
    error:   'text-sell',
    warning: 'text-warn',
    info:    'text-accent',
  }
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className="animate-slide-up flex items-center gap-3 px-4 py-3 bg-surface-card border border-border rounded-2xl shadow-lg pointer-events-auto max-w-xs"
        >
          <svg className={cn('w-4 h-4 shrink-0', COLORS[t.type])} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d={ICONS[t.type]} />
          </svg>
          <p className="text-sm text-foreground flex-1">{t.message}</p>
          <button
            onClick={() => onDismiss(t.id)}
            className="text-muted hover:text-foreground transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

function AppInner() {
  const [page, setPage] = useState<Page>('dashboard')
  const [wsConnected, setWsConnected] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const pendingRef = useRef(0)

  function addToast(type: Toast['type'], message: string) {
    const id = ++toastId
    setToasts(ts => [...ts, { id, type, message }])
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 4000)
  }

  function dismissToast(id: number) {
    setToasts(ts => ts.filter(t => t.id !== id))
  }

  const handleMessage = useCallback((event: string, data: unknown) => {
    if (event === 'approval_requested') {
      const req = data as ApprovalRequest
      pendingRef.current += 1
      setPendingCount(pendingRef.current)
      addToast('warning', `Trade approval needed: ${req.side} ${req.coin}`)
    } else if (event === 'trade_executed') {
      addToast('success', `Trade executed successfully`)
    } else if (event === 'stop_loss_hit') {
      const d = data as { coin: string }
      addToast('error', `Stop loss hit: ${d.coin}`)
    } else if (event === 'take_profit_hit') {
      const d = data as { coin: string }
      addToast('success', `Take profit hit: ${d.coin}`)
    } else if (event === 'trade_rejected') {
      pendingRef.current = Math.max(0, pendingRef.current - 1)
      setPendingCount(pendingRef.current)
    }
  }, [])

  useWebSocket(handleMessage, setWsConnected)

  function clearPending() {
    pendingRef.current = 0
    setPendingCount(0)
  }

  return (
    <div className="flex h-full bg-surface-base">
      <Sidebar
        active={page}
        onNavigate={setPage}
        wsConnected={wsConnected}
        pendingCount={pendingCount}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 ml-[220px]">
        {/* Header */}
        <header className="flex items-center justify-between px-8 h-16 border-b border-border bg-surface-card shrink-0 sticky top-0 z-20">
          <div>
            <h1 className="text-base font-semibold text-foreground">{PAGE_TITLES[page]}</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className={cn(
              'flex items-center gap-1.5 text-xs',
              wsConnected ? 'text-buy' : 'text-muted',
            )}>
              <span className={cn('w-1.5 h-1.5 rounded-full', wsConnected ? 'bg-buy animate-pulse' : 'bg-muted')} />
              <span>{wsConnected ? 'Live' : 'Offline'}</span>
            </div>
            <div className="w-px h-4 bg-border" />
            <ThemeSelector />
          </div>
        </header>

        {/* Page */}
        <main className="flex-1 overflow-y-auto p-8">
          {page === 'dashboard' && <Dashboard onApprovalAction={clearPending} />}
          {page === 'portfolio' && <Portfolio />}
          {page === 'trade' && <Trade />}
          {page === 'pipeline' && <LLM />}
          {page === 'charts' && <Charts />}
          {page === 'logs' && <Logs />}
          {page === 'cache' && <CacheView />}
          {page === 'settings' && <Settings />}
        </main>
      </div>

      <ToastList toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  )
}
