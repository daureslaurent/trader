import { useTheme, THEMES } from '../../contexts/ThemeContext'
import { cn } from '../../lib/utils'
import { SettingsData } from './types'
import { SECTIONS, SectionId } from './constants'
import { SectionIcon } from './widgets'

type ChipTone = 'on' | 'off' | 'neutral'

const TONE: Record<ChipTone, string> = {
  on:      'bg-buy/10 text-buy border-buy/20',
  off:     'bg-surface-elevated text-muted border-border',
  neutral: 'bg-accent/10 text-accent border-accent/20',
}

// A small at-a-glance status chip per category, derived cheaply from settings.
function statusFor(id: SectionId, s: SettingsData, themeLabel: string): { text: string; tone: ChipTone } | null {
  switch (id) {
    case 'trading':    return { text: `${s.watchlist.length} coin${s.watchlist.length === 1 ? '' : 's'}`, tone: 'neutral' }
    case 'entry':      return s.entry_timing_enabled ? { text: 'On', tone: 'on' } : { text: 'Off', tone: 'off' }
    case 'risk':       return { text: `${s.max_open_positions} max open`, tone: 'neutral' }
    case 'monitor':    return s.monitor_auto_run
      ? { text: 'Agent Monitor', tone: 'on' }
      : { text: 'Paused', tone: 'off' }
    case 'summary':    return s.summary_auto_run ? { text: 'Auto', tone: 'on' } : { text: 'Manual', tone: 'off' }
    case 'coach':      return s.coach_auto_run ? { text: 'Auto', tone: 'on' } : { text: 'Manual', tone: 'off' }
    case 'models':     return { text: `${s.llm_endpoints.length} endpoint${s.llm_endpoints.length === 1 ? '' : 's'}`, tone: 'neutral' }
    case 'appearance': return { text: themeLabel, tone: 'neutral' }
    case 'telegram':   return s.telegram_notify_enabled ? { text: 'On', tone: 'on' } : { text: 'Off', tone: 'off' }
    case 'system':     return s.update_enabled ? { text: 'Updates on', tone: 'on' } : { text: 'Updates off', tone: 'off' }
    default:           return null
  }
}

export function CategoryGrid({ settings, onOpen }: {
  settings: SettingsData
  onOpen: (id: SectionId) => void
}) {
  const { theme } = useTheme()
  const themeLabel = THEMES.find(t => t.id === theme)?.label ?? 'Theme'

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground">Settings</h2>
        <p className="text-sm text-muted mt-0.5">Pick a category to configure.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {SECTIONS.map(sec => {
          const status = statusFor(sec.id, settings, themeLabel)
          return (
            <button
              key={sec.id}
              type="button"
              onClick={() => onOpen(sec.id)}
              className={cn(
                'group relative overflow-hidden text-left rounded-2xl border border-border p-5',
                'glass shadow-soft transition-all duration-200',
                'hover:border-accent/30 hover:-translate-y-0.5 hover:shadow-glow',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              )}
            >
              {/* top hairline that glows on hover */}
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

              <div className="flex items-start justify-between gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/15 to-accent2/10 ring-1 ring-accent/10 text-accent">
                  <SectionIcon path={sec.icon} className="h-5 w-5" />
                </div>
                {status && (
                  <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium', TONE[status.tone])}>
                    {status.text}
                  </span>
                )}
              </div>

              <div className="mt-4">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm font-semibold text-foreground">{sec.label}</h3>
                  <svg className="h-3.5 w-3.5 text-muted/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-accent" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
                <p className="text-xs text-muted mt-1 leading-relaxed">{sec.subtitle}</p>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
