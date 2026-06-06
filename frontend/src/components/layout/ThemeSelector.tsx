import { useState, useRef, useEffect } from 'react'
import { useTheme, THEMES } from '../../contexts/ThemeContext'
import { cn } from '../../lib/utils'

export function ThemeSelector() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const current = THEMES.find(t => t.id === theme) ?? THEMES[0]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-elevated border border-border hover:bg-surface-hover transition-colors duration-150 text-sm text-foreground"
        title="Change theme"
      >
        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: current.swatch }} />
        <span className="text-xs text-muted">{current.label}</span>
        <svg className={cn('w-3 h-3 text-muted transition-transform duration-150', open && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-44 bg-surface-card border border-border rounded-2xl shadow-xl py-2 z-50 animate-slide-down">
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => { setTheme(t.id); setOpen(false) }}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-100',
                theme === t.id
                  ? 'text-foreground bg-surface-elevated'
                  : 'text-muted hover:text-foreground hover:bg-surface-elevated',
              )}
            >
              <span
                className="w-4 h-4 rounded-full shrink-0 border border-border/50"
                style={{ background: t.swatch }}
              />
              <span className="flex-1 text-left">{t.label}</span>
              {theme === t.id && (
                <svg className="w-3.5 h-3.5 text-accent shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
