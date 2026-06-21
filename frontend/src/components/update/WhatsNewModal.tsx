import { useEffect } from 'react'
import { Button } from '../ui/Button'
import { WhatsNewData } from '../../lib/whatsNew'
import { cn } from '../../lib/utils'

// Conventional-commit prefix → a small coloured chip, so the changelog reads at a
// glance. Anything unrecognised falls back to a neutral "update" chip.
const TYPES: Record<string, { label: string; cls: string }> = {
  feat:     { label: 'Feature',  cls: 'bg-buy/15 text-buy' },
  fix:      { label: 'Fix',      cls: 'bg-sell/15 text-sell' },
  perf:     { label: 'Perf',     cls: 'bg-accent/15 text-accent' },
  refactor: { label: 'Refactor', cls: 'bg-warn/15 text-warn' },
  docs:     { label: 'Docs',     cls: 'bg-surface-elevated text-muted' },
  chore:    { label: 'Chore',    cls: 'bg-surface-elevated text-muted' },
  style:    { label: 'Style',    cls: 'bg-surface-elevated text-muted' },
  test:     { label: 'Test',     cls: 'bg-surface-elevated text-muted' },
}

/** Split `feat(scope): subject` into its chip + clean, human-readable title. */
function parseSubject(subject: string): { type: { label: string; cls: string } | null; title: string } {
  const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject)
  if (m && TYPES[m[1].toLowerCase()]) {
    return { type: TYPES[m[1].toLowerCase()], title: m[2] }
  }
  return { type: null, title: subject }
}

/**
 * "What's new" celebration modal shown once after an in-app update completes.
 * Lists the commits that were just applied (subject + body) with a tidy, modern
 * look. Driven by lib/whatsNew.ts — see that file for how the changelog is captured.
 */
export function WhatsNewModal({ data, onClose }: { data: WhatsNewData; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      <div className="relative z-10 mx-4 flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-border bg-surface-card shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="relative overflow-hidden border-b border-border px-6 pb-5 pt-6">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br from-accent/30 to-accent2/20 blur-3xl" />
          <div className="relative flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent2 text-surface-base shadow-glow">
              <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 002.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-foreground">What's new</h2>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                You're now on
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-[11px] font-semibold text-foreground">
                  v{data.toVersion || '—'}
                </span>
                {data.fromVersion && data.fromVersion !== data.toVersion && (
                  <span className="font-mono text-[11px] text-muted/70">(from v{data.fromVersion})</span>
                )}
              </p>
            </div>
            <button onClick={onClose} className="shrink-0 text-muted transition-colors hover:text-foreground">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Changelog */}
        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {data.commits.map(c => {
            const { type, title } = parseSubject(c.subject || '(no message)')
            const body = (c.body || '').trim()
            return (
              <div key={c.sha} className="rounded-2xl border border-border bg-surface-base/40 p-4 transition-colors hover:border-accent/30">
                <div className="flex items-start gap-2.5">
                  {type && (
                    <span className={cn('mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide', type.cls)}>
                      {type.label}
                    </span>
                  )}
                  <p className="flex-1 text-sm font-medium leading-snug text-foreground">{title}</p>
                </div>
                {body && (
                  <p className="mt-2 whitespace-pre-line border-l-2 border-border pl-3 text-xs leading-relaxed text-muted">
                    {body}
                  </p>
                )}
                <p className="mt-2 font-mono text-[10px] text-muted/60">{c.shortSha}</p>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <span className="text-[11px] text-muted">
            {data.commits.length} change{data.commits.length === 1 ? '' : 's'} applied
          </span>
          <Button type="button" variant="primary" size="md" onClick={onClose}>Got it</Button>
        </div>
      </div>
    </div>
  )
}
