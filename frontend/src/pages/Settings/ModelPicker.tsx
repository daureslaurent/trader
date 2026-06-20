import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { LLMEndpoint } from '../../types'
import { findModelById, modelLabel } from './widgets'

// A grouped, searchable model picker. `value` is the selected model's globally-unique
// id ('' = the env default). Models are grouped under their endpoint (server). If the
// stored id no longer resolves (model/endpoint deleted), the trigger shows a clear
// "deleted" state instead of silently snapping to the default.
export function ModelPicker({ value, onChange, endpoints, emptyLabel, ariaLabel }: {
  value: string
  onChange: (id: string) => void
  endpoints: LLMEndpoint[]
  emptyLabel: string
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = findModelById(endpoints, value)
  const missing = !!value && !selected

  // Close on outside-click + Esc; focus the search box when opening.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    searchRef.current?.focus()
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(id: string) {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  const q = query.trim().toLowerCase()
  // For each endpoint, the models matching the query (an endpoint-name/URL match
  // surfaces all of its models).
  const groups = endpoints
    .map(ep => {
      const epHit = !q || ep.name.toLowerCase().includes(q) || ep.baseURL.toLowerCase().includes(q)
      const models = ep.models.filter(m => epHit || m.model.toLowerCase().includes(q))
      return { ep, models }
    })
    .filter(g => g.models.length > 0)

  const triggerLabel = value === ''
    ? emptyLabel
    : selected ? modelLabel(selected.ep, selected.m) : '⚠ deleted model'

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2 text-xs text-left',
          'bg-surface-elevated border border-border rounded-xl transition-colors duration-150',
          'hover:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50',
          missing && 'border-warn/50 text-warn',
        )}
      >
        <span className={cn('truncate', value === '' && 'text-muted')}>{triggerLabel}</span>
        <svg className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150', open && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-surface-card shadow-2xl neon-border animate-fade-in">
          <div className="border-b border-border p-2">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-surface-elevated border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>

          <div role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto p-1">
            {/* Env default / no-selection row */}
            <button
              type="button"
              role="option"
              aria-selected={value === ''}
              onClick={() => pick('')}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                value === '' ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface-elevated hover:text-foreground',
              )}
            >
              <span className="truncate">{emptyLabel}</span>
              {value === '' && <CheckIcon />}
            </button>

            {groups.map(({ ep, models }) => (
              <div key={ep.id} className="mt-1">
                <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted truncate">
                    {ep.name || ep.baseURL || 'endpoint'}
                  </span>
                  {ep.disabled && <span className="rounded bg-surface-elevated px-1 text-[9px] text-muted">disabled</span>}
                  {ep.parallel && <span className="rounded bg-accent/10 px-1 text-[9px] text-accent">{ep.maxParallel > 0 ? `∥${ep.maxParallel}` : '∥'}</span>}
                </div>
                {models.map(m => {
                  const on = m.id === value
                  const dim = ep.disabled || m.disabled
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => pick(m.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                        on ? 'bg-accent/10 text-accent' : 'text-foreground hover:bg-surface-elevated',
                      )}
                    >
                      <span className={cn('truncate font-mono', dim && !on && 'text-muted line-through')}>{m.model || 'model'}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {m.maxTokens > 0 && <span className="text-[10px] text-muted">{m.maxTokens} tok</span>}
                        {dim && <span className="rounded bg-surface-elevated px-1 text-[9px] text-muted">off</span>}
                        {on && <CheckIcon />}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}

            {groups.length === 0 && (
              <p className="px-2.5 py-3 text-center text-[11px] text-muted">
                {endpoints.some(e => e.models.length) ? 'No models match your search.' : 'No models defined yet.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  )
}
