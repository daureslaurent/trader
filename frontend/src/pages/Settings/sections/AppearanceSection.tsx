import { useTheme, THEMES } from '../../../contexts/ThemeContext'
import { cn } from '../../../lib/utils'
import { Panel } from '../widgets'

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  return (
    <Panel>
      <div className="py-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {THEMES.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTheme(t.id)}
            className={cn(
              'flex items-center gap-3 px-4 py-3 rounded-xl border text-sm transition-all duration-150',
              theme === t.id
                ? 'border-accent/40 bg-accent/5 text-foreground ring-1 ring-accent/20'
                : 'border-border bg-surface-elevated text-muted hover:bg-surface-hover',
            )}
          >
            <span
              className="w-7 h-7 rounded-lg shrink-0 border border-border/60 flex items-center justify-center"
              style={{ background: t.bg }}
            >
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: t.swatch }} />
            </span>
            <span className="flex-1 text-left font-medium">{t.label}</span>
            {theme === t.id && (
              <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </Panel>
  )
}
