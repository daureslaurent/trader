import { useEffect, useState } from 'react'
import { Page } from '../../types'
import { cn } from '../../lib/utils'
import { useTheme } from '../../contexts/ThemeContext'

interface SidebarProps {
  active: Page
  onNavigate: (page: Page) => void
  wsConnected: boolean
  pendingCount: number
  /** Show the "update available" pin on the System entry + its group header. */
  updateAvailable: boolean
}

interface NavItem {
  key: Page
  label: string
  path: string
}

const ITEMS: Record<Page, NavItem> = {
  dashboard: {
    key: 'dashboard',
    label: 'Dashboard',
    path: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z',
  },
  agent: {
    key: 'agent',
    label: 'Agent',
    path: 'M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155',
  },
  'trading-state': {
    key: 'trading-state',
    label: 'Trading State',
    path: 'M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941',
  },
  portfolio: {
    key: 'portfolio',
    label: 'Portfolio',
    path: 'M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3',
  },
  monitor: {
    key: 'monitor',
    label: 'Monitor',
    path: 'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  },
  'agent-monitor': {
    key: 'agent-monitor',
    label: 'Agent Monitor',
    path: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z',
  },
  summary: {
    key: 'summary',
    label: 'Summary',
    path: 'M9 17v-6h13M9 11V5h13M3 5h.01M3 11h.01M3 17h.01',
  },
  trade: {
    key: 'trade',
    label: 'Trade',
    path: 'M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  },
  entry: {
    key: 'entry',
    label: 'Entry Desk',
    path: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0-4.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zm0-3a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  },
  pipeline: {
    key: 'pipeline',
    label: 'Pipeline',
    path: 'M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z',
  },
  charts: {
    key: 'charts',
    label: 'Signals',
    path: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  },
  discover: {
    key: 'discover',
    label: 'Discover',
    path: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6',
  },
  'llm-debug': {
    key: 'llm-debug',
    label: 'LLM Debug',
    path: 'M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z',
  },
  'llm-stats': {
    key: 'llm-stats',
    label: 'LLM Stats',
    path: 'M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z',
  },
  'control-room': {
    key: 'control-room',
    label: 'Control Room',
    path: 'M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6',
  },
  cache: {
    key: 'cache',
    label: 'Cache',
    path: 'M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125',
  },
  logs: {
    key: 'logs',
    label: 'Logs',
    path: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
  },
  host: {
    key: 'host',
    label: 'System',
    path: 'M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z',
  },
  settings: {
    key: 'settings',
    label: 'Settings',
    path: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  },
}

// Section header icons (heroicons outline)
const SECTION_ICONS = {
  trading: 'M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941',
  engine: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25',
  intelligence: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z',
  system: 'M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0H16.5',
} as const

// Pinned, always-visible primary item(s)
const PINNED: Page[] = ['dashboard', 'agent']

interface NavGroup {
  id: string
  label: string
  icon: string
  keys: Page[]
}

const GROUPS: NavGroup[] = [
  { id: 'trading', label: 'Trading', icon: SECTION_ICONS.trading, keys: ['portfolio', 'monitor', 'agent-monitor', 'summary', 'entry', 'trade', 'trading-state'] },
  { id: 'engine', label: 'Engine', icon: SECTION_ICONS.engine, keys: ['pipeline', 'charts', 'discover'] },
  { id: 'intelligence', label: 'Intelligence', icon: SECTION_ICONS.intelligence, keys: ['control-room', 'llm-debug', 'llm-stats', 'cache'] },
  { id: 'system', label: 'Platform', icon: SECTION_ICONS.system, keys: ['host', 'logs', 'settings'] },
]

const STORAGE_KEY = 'cb-sidebar-collapsed'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* ignore */
  }
  return new Set()
}

function NavLink({
  item,
  isActive,
  onNavigate,
  badge,
  dot,
}: {
  item: NavItem
  isActive: boolean
  onNavigate: (page: Page) => void
  badge?: number
  /** A small pulsing pin (e.g. "update available"), distinct from the count badge. */
  dot?: boolean
}) {
  return (
    <button
      onClick={() => onNavigate(item.key)}
      className={cn(
        'group relative w-full flex items-center gap-3 px-3 py-2 rounded-xl text-[13px] font-medium transition-all duration-150',
        isActive
          ? 'bg-gradient-to-r from-accent/15 to-transparent text-accent'
          : 'text-muted hover:text-foreground hover:bg-surface-elevated',
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-accent" />
      )}
      <span className="relative shrink-0">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={isActive ? 2 : 1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={item.path} />
        </svg>
        {dot && (
          <span className="absolute -top-1 -right-1 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
        )}
      </span>
      <span className="truncate">{item.label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-warn/15 text-warn text-xs font-semibold flex items-center justify-center">
          {badge}
        </span>
      )}
      {dot && (badge == null || badge <= 0) && (
        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-accent">Update</span>
      )}
    </button>
  )
}

export function Sidebar({ active, onNavigate, wsConnected, pendingCount, updateAvailable }: SidebarProps) {
  const { theme } = useTheme()
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  // Persist collapsed state
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]))
  }, [collapsed])

  // Auto-expand the group that contains the active page (e.g. when navigated externally)
  useEffect(() => {
    const owner = GROUPS.find(g => g.keys.includes(active))
    if (owner && collapsed.has(owner.id)) {
      setCollapsed(prev => {
        const next = new Set(prev)
        next.delete(owner.id)
        return next
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  function toggle(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-30 w-[230px] flex flex-col bg-surface-card border-r border-border">
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 h-16 border-b border-border shrink-0">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-gradient-to-br from-accent to-accent2 shadow-glow">
          <svg className="w-[18px] h-[18px] text-surface-base" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-foreground leading-tight tracking-tight">CryptoBot</p>
          <p className="text-[11px] text-muted">Trading Engine</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 px-3">
        {/* Pinned primary items */}
        <div className="space-y-0.5">
          {PINNED.map(key => (
            <NavLink
              key={key}
              item={ITEMS[key]}
              isActive={active === key}
              onNavigate={onNavigate}
              badge={key === 'dashboard' ? pendingCount : undefined}
            />
          ))}
        </div>

        {/* Collapsible groups */}
        {GROUPS.map(group => {
          const isOpen = !collapsed.has(group.id)
          const containsActive = group.keys.includes(active)
          return (
            <div key={group.id} className="mt-5">
              <button
                onClick={() => toggle(group.id)}
                className="group w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-muted/70 hover:text-foreground hover:bg-surface-elevated/60 transition-colors"
              >
                <svg className="w-3.5 h-3.5 shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d={group.icon} />
                </svg>
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">{group.label}</span>
                {/* active-in-collapsed indicator */}
                {!isOpen && containsActive && (
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                )}
                {/* update-available pin when this group (System) is collapsed */}
                {!isOpen && updateAvailable && group.keys.includes('host') && (
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                  </span>
                )}
                <svg
                  className={cn(
                    'ml-auto w-3.5 h-3.5 shrink-0 transition-transform duration-200',
                    isOpen ? 'rotate-0' : '-rotate-90',
                  )}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              {/* Smooth collapse via grid-rows trick */}
              <div
                className={cn(
                  'grid transition-[grid-template-rows] duration-200 ease-out',
                  isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                )}
              >
                <div className="overflow-hidden">
                  <div className="space-y-0.5 pt-1 pl-2">
                    {group.keys.map(key => (
                      <NavLink
                        key={key}
                        item={ITEMS[key]}
                        isActive={active === key}
                        onNavigate={onNavigate}
                        dot={key === 'host' ? updateAvailable : undefined}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </nav>

      {/* Connection status */}
      <div className="px-3 py-3 border-t border-border shrink-0">
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-surface-elevated/70 border border-border">
          <span className={cn(
            'w-2 h-2 rounded-full shrink-0',
            wsConnected
              ? theme === 'aurora' ? 'bg-accent aurora-dot' : 'bg-buy animate-pulse'
              : 'bg-sell',
          )} />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground leading-tight">
              {wsConnected ? 'Connected' : 'Disconnected'}
            </p>
            <p className="text-[10px] text-muted">{wsConnected ? 'Real-time stream active' : 'Reconnecting…'}</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
