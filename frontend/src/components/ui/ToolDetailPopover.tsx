import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

export interface ToolDetail { tool: string; args?: Record<string, unknown>; result?: unknown }

const HOVER_OPEN_MS = 200
const HOVER_CLOSE_MS = 150
const POPOVER_W = 380
const POPOVER_MAX_H = 420

// Pretty-prints a JSON value with lightweight syntax coloring (no extra deps).
function JsonView({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-muted/50 italic">none</span>
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const tokenized = text.split(/("(?:[^"\\]|\\.)*"(?:\s*:)?|\b-?\d+\.?\d*\b|\btrue\b|\bfalse\b|\bnull\b)/g)
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
      {tokenized.map((tok, i) => {
        if (/^"(?:[^"\\]|\\.)*"\s*:$/.test(tok)) return <span key={i} className="text-accent2/90">{tok}</span>
        if (/^"(?:[^"\\]|\\.)*"$/.test(tok)) return <span key={i} className="text-buy/80">{tok}</span>
        if (/^-?\d+\.?\d*$/.test(tok)) return <span key={i} className="text-accent">{tok}</span>
        if (tok === 'true' || tok === 'false') return <span key={i} className="text-warn">{tok}</span>
        if (tok === 'null') return <span key={i} className="text-muted/60">{tok}</span>
        return <span key={i} className="text-foreground/70">{tok}</span>
      })}
    </pre>
  )
}

// Floating glass popover showing a tool call's raw arguments and/or result. Opens on a short
// hover delay near the cursor; a click pins it open (scrollable, dismiss via the × or Escape)
// so large payloads (e.g. candle data) can be inspected without the mouse leaving the trigger.
export function ToolDetailPopover({ detail, children, kind }: { detail: ToolDetail; children: React.ReactNode; kind: 'call' | 'result' }) {
  const [visible, setVisible] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  function place() {
    const r = anchorRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.min(Math.max(8, r.left), window.innerWidth - POPOVER_W - 8)
    const spaceBelow = window.innerHeight - r.bottom
    const top = spaceBelow > POPOVER_MAX_H + 12 ? r.bottom + 6 : Math.max(8, r.top - POPOVER_MAX_H - 6)
    setPos({ top, left })
  }

  function clearTimers() {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }

  function onEnter() {
    clearTimers()
    if (pinned) return
    openTimer.current = setTimeout(() => { place(); setVisible(true) }, HOVER_OPEN_MS)
  }
  function onLeave() {
    clearTimers()
    if (pinned) return
    closeTimer.current = setTimeout(() => setVisible(false), HOVER_CLOSE_MS)
  }
  function onClick(e: React.MouseEvent) {
    e.stopPropagation()
    clearTimers()
    place()
    setVisible(true)
    setPinned(p => !p)
  }

  useEffect(() => {
    if (!pinned) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); setVisible(false) } }
    const onDocClick = () => { setPinned(false); setVisible(false) }
    const onResize = () => place()
    window.addEventListener('keydown', onKey)
    document.addEventListener('click', onDocClick)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onDocClick)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned])

  return (
    <span
      ref={anchorRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      className="cursor-help border-b border-dotted border-muted/40 hover:border-accent/60 transition-colors"
    >
      {children}
      {visible && pos && createPortal(
        <div
          onClick={e => e.stopPropagation()}
          onMouseEnter={() => clearTimers()}
          onMouseLeave={onLeave}
          style={{ top: pos.top, left: pos.left, width: POPOVER_W, maxHeight: POPOVER_MAX_H }}
          className={cn(
            'fixed z-50 overflow-hidden rounded-xl border border-border bg-surface-elevated/95 backdrop-blur-md shadow-soft animate-scale-in flex flex-col',
            pinned && 'ring-1 ring-accent/40',
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 shrink-0">
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-foreground/90">
              <span className={cn('w-1.5 h-1.5 rounded-full', kind === 'call' ? 'bg-accent' : 'bg-buy')} />
              {detail.tool}
              <span className="text-muted/50">· {kind === 'call' ? 'arguments' : 'result'}</span>
            </span>
            {pinned && (
              <button
                onClick={() => { setPinned(false); setVisible(false) }}
                className="text-muted hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          <div className="overflow-y-auto px-3 py-2.5">
            {kind === 'call'
              ? <JsonView value={detail.args ?? {}} />
              : <JsonView value={detail.result} />}
          </div>
          {!pinned && <div className="px-3 py-1 text-[10px] text-muted/50 border-t border-border shrink-0">click to pin</div>}
        </div>,
        document.body,
      )}
    </span>
  )
}
