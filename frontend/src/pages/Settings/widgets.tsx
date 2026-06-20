import { ReactNode, useState, KeyboardEvent } from 'react'
import { Card } from '../../components/ui/Card'
import { Input, Select } from '../../components/ui/Input'
import { cn } from '../../lib/utils'
import { LLMEndpoint } from '../../types'
import { CRON_PRESETS, describeCron, isValidCron } from './constants'

export function SectionIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d={path} />
    </svg>
  )
}

// Card wrapper for a section's fields. The detail-view header (icon + title + back
// button) is rendered by the page shell, so this is just the bordered list body.
export function Panel({ children }: { children: ReactNode }) {
  return (
    <Card noPad>
      <div className="px-5 divide-y divide-border">{children}</div>
    </Card>
  )
}

export function Row({ label, hint, children, stacked }: {
  label: string
  hint?: string
  children: ReactNode
  stacked?: boolean
}) {
  if (stacked) {
    return (
      <div className="py-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          {hint && <p className="text-xs text-muted mt-1 leading-relaxed">{hint}</p>}
        </div>
        {children}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted mt-1 leading-relaxed">{hint}</p>}
      </div>
      <div className="shrink-0 sm:w-44">{children}</div>
    </div>
  )
}

export function UnitInput({ unit, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { unit?: string }) {
  return (
    <div className="relative">
      <Input {...rest} className={cn(unit && 'pr-12', className)} />
      {unit && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
          {unit}
        </span>
      )}
    </div>
  )
}

export function CronEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const valid = isValidCron(value)
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map(p => (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            className={cn(
              'px-2.5 py-1 text-xs rounded-full border transition-all duration-150',
              value === p.value
                ? 'bg-accent/10 border-accent/40 text-accent font-medium'
                : 'bg-surface-elevated border-border text-muted hover:text-foreground hover:border-foreground/20',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="*/30 * * * *"
          className="font-mono max-w-[180px]"
          error={!valid ? 'Invalid cron expression' : undefined}
        />
        {valid && (
          <span className="text-xs text-muted whitespace-nowrap">
            Runs: <span className="text-accent font-medium">{describeCron(value)}</span>
          </span>
        )}
      </div>
    </div>
  )
}

export function WatchlistEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')

  function commit() {
    const parts = draft.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    if (!parts.length) return
    const next = [...value]
    for (const p of parts) {
      const pair = p.endsWith('/USDC') ? p : `${p}/USDC`
      if (!next.includes(pair)) next.push(pair)
    }
    onChange(next)
    setDraft('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 px-3 py-2 min-h-[42px]',
        'bg-surface-elevated border border-border rounded-xl',
        'focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/50 transition-colors duration-150',
      )}
    >
      {value.map(pair => {
        const sym = pair.replace('/USDC', '')
        return (
          <span
            key={pair}
            className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full bg-accent/10 border border-accent/20 text-xs font-medium text-accent"
          >
            {sym}
            <button
              type="button"
              aria-label={`Remove ${sym}`}
              onClick={() => onChange(value.filter(v => v !== pair))}
              className="flex h-4 w-4 items-center justify-center rounded-full text-accent/60 hover:text-accent hover:bg-accent/15 transition-colors"
            >
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        )
      })}
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={value.length ? 'Add coin…' : 'BTC, ETH, SOL…'}
        className="flex-1 min-w-[80px] bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none py-0.5"
      />
    </div>
  )
}

// Short label for an endpoint in the dropdowns: "Name · model" (+ a ∥ marker when
// the endpoint is flagged parallel-capable, + a disabled marker when out of rotation).
export function endpointLabel(e: LLMEndpoint): string {
  let s = e.name ? `${e.name} · ${e.model}` : (e.model || e.baseURL || 'endpoint')
  if (e.maxTokens > 0) s += ` · ${e.maxTokens} tok`
  if (e.parallel) s += e.maxParallel > 0 ? ` ∥${e.maxParallel}` : ' ∥'
  if (e.disabled) s += ' · disabled'
  return s
}

// A catalog-backed endpoint picker. `value` is the selected endpoint id; an empty
// id selects the first option (`emptyLabel`). If the stored id no longer matches a
// catalog entry (endpoint deleted), a disabled placeholder keeps it visible so the
// stale selection is obvious rather than silently snapping to the default.
export function EndpointSelect({ value, onChange, endpoints, emptyLabel, ariaLabel }: {
  value: string
  onChange: (v: string) => void
  endpoints: LLMEndpoint[]
  emptyLabel: string
  ariaLabel: string
}) {
  const missing = !!value && !endpoints.some(e => e.id === value)
  return (
    <Select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="text-xs"
    >
      <option value="">{emptyLabel}</option>
      {endpoints.map(e => (
        <option key={e.id} value={e.id}>{endpointLabel(e)}</option>
      ))}
      {missing && <option value={value} disabled>⚠ deleted endpoint</option>}
    </Select>
  )
}
