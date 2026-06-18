import { useState, useCallback, useRef, useEffect } from 'react'
import { ThemeProvider } from './contexts/ThemeContext'
import { Sidebar } from './components/layout/Sidebar'
import { ThemeSelector } from './components/layout/ThemeSelector'
import { ControlRoomBadge } from './components/layout/ControlRoomBadge'
import { EndpointStatusBadge } from './components/layout/EndpointStatusBadge'
import { Page, Toast, ApprovalRequest, UpdateInfo } from './types'
import { useWebSocket } from './hooks/useWebSocket'
import { cn } from './lib/utils'
import Dashboard from './pages/Dashboard'
import TradingState from './pages/TradingState'
import Portfolio from './pages/Portfolio'
import Monitor from './pages/Monitor'
import AgentMonitor from './pages/AgentMonitor'
import AgentSignal from './pages/AgentSignal'
import Summary from './pages/Summary'
import Trade from './pages/Trade'
import EntryDesk from './pages/EntryDesk'
import Settings from './pages/Settings'
import LLM from './pages/LLM'
import LLMDebug from './pages/LLMDebug'
import CacheView from './pages/CacheView'
import Discover from './pages/Discover'
import LLMStats from './pages/LLMStats'
import ControlRoom from './pages/ControlRoom'
import Agent from './pages/Agent'
import Host from './pages/Host'
import EventStream from './pages/EventStream'
import RoutingGraph from './pages/RoutingGraph'

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard',
  'trading-state': 'Trading State',
  portfolio: 'Portfolio',
  monitor: 'Position Monitor',
  'agent-monitor': 'Agent Monitor',
  summary: 'Portfolio Summary',
  trade: 'Trade',
  entry: 'Entry Desk',
  pipeline: 'Pipeline',
  'agent-signal': 'Agent Signal',
  cache: 'Article Cache',
  settings: 'Settings',
  discover: 'Discover Coins',
  'llm-debug': 'LLM Debug',
  'llm-stats': 'LLM Stats',
  'control-room': 'Inference Control Room',
  agent: 'Agent',
  host: 'System',
  'event-stream': 'Event Stream',
  routing: 'Event Routing',
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
  const [updateAvailable, setUpdateAvailable] = useState(false)

  // Seed the update pin from the server on load so it survives a page reload.
  useEffect(() => {
    fetch('/api/host/update')
      .then(r => r.json())
      .then((d: UpdateInfo) => setUpdateAvailable(!!d.updateAvailable))
      .catch(() => { /* bridge not ready / feature off — no pin */ })
  }, [])

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
    } else if (event === 'trade_failed') {
      const d = data as { coin?: string; side?: string; error?: string }
      const label = d.coin ? `${d.side ?? 'Trade'} ${d.coin.replace('/USDC', '')} failed` : 'Trade failed'
      addToast('error', d.error ? `${label}: ${d.error}` : label)
    } else if (event === 'stop_loss_hit') {
      const d = data as { coin: string }
      addToast('error', `Stop loss hit: ${d.coin}`)
    } else if (event === 'take_profit_hit') {
      const d = data as { coin: string }
      addToast('success', `Take profit hit: ${d.coin}`)
    } else if (event === 'trade_rejected') {
      pendingRef.current = Math.max(0, pendingRef.current - 1)
      setPendingCount(pendingRef.current)
    } else if (event === 'adjustment_requested') {
      const r = data as { coin: string }
      pendingRef.current += 1
      setPendingCount(pendingRef.current)
      addToast('warning', `SL/TP change needs approval: ${r.coin.replace('/USDC', '')}`)
    } else if (event === 'position_adjusted') {
      const d = data as { coin: string; old_stop_loss: number; old_take_profit: number | null; stop_loss: number; take_profit: number | null }
      const coin = d.coin.replace('/USDC', '')
      const fmt = (v: number | null) => v != null ? v.toFixed(4) : '—'
      const slChanged = d.stop_loss !== d.old_stop_loss
      const tpChanged = d.take_profit !== d.old_take_profit
      const parts: string[] = []
      if (slChanged) parts.push(`SL ${fmt(d.old_stop_loss)} → ${fmt(d.stop_loss)}`)
      if (tpChanged) parts.push(`TP ${fmt(d.old_take_profit)} → ${fmt(d.take_profit)}`)
      addToast('success', `${coin} adjusted: ${parts.length ? parts.join(', ') : 'SL/TP updated'}`)
    } else if (event === 'adjustment_resolved') {
      pendingRef.current = Math.max(0, pendingRef.current - 1)
      setPendingCount(pendingRef.current)
    } else if (event === 'update_available') {
      const d = data as { updateCount?: number }
      setUpdateAvailable(true)
      const n = d.updateCount ?? 0
      addToast('info', n > 0 ? `Update available — ${n} new commit${n === 1 ? '' : 's'}` : 'Update available')
    } else if (event === 'coin_discovered') {
      const d = data as { coin: string; score: number; auto_added: boolean }
      const coin = d.coin.replace('/USDC', '')
      if (d.auto_added) {
        addToast('success', `Discovered ${coin} — auto-added to watchlist (score ${Math.round(d.score * 100)}%)`)
      } else {
        addToast('info', `New candidate: ${coin} (score ${Math.round(d.score * 100)}%)`)
      }
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
        updateAvailable={updateAvailable}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 ml-[230px]">
        {/* Header */}
        <header className="flex items-center justify-between px-8 h-16 border-b border-border glass shrink-0 sticky top-0 z-20">
          <h1 className="text-[15px] font-semibold text-foreground tracking-tight">{PAGE_TITLES[page]}</h1>
          <div className="flex items-center gap-3">
            <span className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border',
              wsConnected ? 'text-buy bg-buy/10 border-buy/20' : 'text-muted bg-surface-elevated border-border',
            )}>
              <span className={cn('w-1.5 h-1.5 rounded-full bg-current', wsConnected && 'animate-pulse')} />
              {wsConnected ? 'Live' : 'Offline'}
            </span>
            <ControlRoomBadge onOpen={() => setPage('control-room')} />
            <EndpointStatusBadge />
            <ThemeSelector />
          </div>
        </header>

        {/* Page */}
        <main className="flex-1 overflow-y-auto p-8">
          {page === 'agent' && <Agent />}
          {page === 'dashboard' && <Dashboard onApprovalAction={clearPending} />}
          {page === 'trading-state' && <TradingState />}
          {page === 'portfolio' && <Portfolio />}
          {page === 'monitor' && <Monitor />}
          {page === 'agent-monitor' && <AgentMonitor />}
          {page === 'agent-signal' && <AgentSignal />}
          {page === 'summary' && <Summary />}
          {page === 'trade' && <Trade />}
          {page === 'entry' && <EntryDesk />}
          {page === 'pipeline' && <LLM />}
          {page === 'cache' && <CacheView />}
          {page === 'discover' && <Discover />}
          {page === 'llm-debug' && <LLMDebug />}
          {page === 'llm-stats' && <LLMStats />}
          {page === 'control-room' && <ControlRoom />}
          {page === 'host' && <Host />}
          {page === 'event-stream' && <EventStream />}
          {page === 'routing' && <RoutingGraph />}
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
