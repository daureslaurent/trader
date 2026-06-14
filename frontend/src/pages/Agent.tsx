import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { cn } from '../lib/utils'
import { AgentConversation, AgentMessage, AgentToolInfo } from '../types'

/* ----------------------------- tiny markdown ----------------------------- */
// Lightweight inline + block renderer (bold, `code`, bullet lists, headers, paragraphs).
// Deliberately minimal — no external dep — since the agent emits short markdown.

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[2] != null) nodes.push(<strong key={key++} className="font-semibold text-foreground">{m[2]}</strong>)
    else if (m[3] != null) nodes.push(<code key={key++} className="px-1 py-0.5 rounded bg-surface-elevated text-accent text-[12px] font-mono">{m[3]}</code>)
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// Split a markdown table row into trimmed cells, tolerating optional leading/trailing pipes.
function tableCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map(c => c.trim())
}

// A separator row looks like |---|:--:|---| (cells made only of dashes, colons, spaces).
function isTableSeparator(line: string): boolean {
  const t = line.trim()
  if (!t.includes('-') || !t.includes('|')) return false
  return tableCells(t).every(c => /^:?-+:?$/.test(c))
}

function isTableRow(line: string): boolean {
  return line.includes('|')
}

function RichText({ text }: { text: string }) {
  const out: ReactNode[] = []
  let bullets: ReactNode[] = []
  const flush = () => {
    if (bullets.length) {
      out.push(<ul key={`ul-${out.length}`} className="list-disc pl-5 space-y-1 my-2">{bullets}</ul>)
      bullets = []
    }
  }

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()

    // Tables: a header row followed by a separator row, then data rows.
    if (isTableRow(t) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush()
      const header = tableCells(t)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && isTableRow(lines[j]) && !isTableSeparator(lines[j]) && lines[j].trim()) {
        rows.push(tableCells(lines[j]))
        j++
      }
      out.push(
        <div key={`tbl-${i}`} className="my-3 overflow-x-auto rounded border border-border">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-elevated">
                {header.map((cell, c) => (
                  <th key={c} className="px-3 py-2 text-left font-semibold text-foreground border-b border-border whitespace-nowrap">
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="even:bg-surface-elevated/40">
                  {header.map((_, c) => (
                    <td key={c} className="px-3 py-2 align-top border-b border-border last:border-b-0">
                      {inline(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      i = j - 1
      continue
    }

    // Check for headers (# Header, ## Header, etc.)
    const headerMatch = t.match(/^(\#{1,6})\s+(.*)/)
    if (headerMatch) {
      const level = headerMatch[1].length
      const content = headerMatch[2]

      // Determine appropriate styling for each header level
      let headingClass = "font-bold text-foreground"
      switch (level) {
        case 1:
          headingClass += " text-2xl mt-6 mb-4"
          break
        case 2:
          headingClass += " text-xl mt-5 mb-3"
          break
        case 3:
          headingClass += " text-lg mt-4 mb-2"
          break
        case 4:
        case 5:
        case 6:
          headingClass += " text-base mt-3 mb-2"
          break
      }

      flush()
      // Dynamically create the appropriate heading element
      const HeadingTag = `h${level}` as keyof JSX.IntrinsicElements
      out.push(<HeadingTag key={i} className={headingClass}>{inline(content)}</HeadingTag>)
      continue
    }

    const b = t.match(/^[-*•]\s+(.*)/)
    if (b) { bullets.push(<li key={i}>{inline(b[1])}</li>); continue }
    flush()
    if (t) out.push(<p key={i} className="my-2 leading-relaxed first:mt-0 last:mb-0">{inline(t)}</p>)
  }
  flush()
  return <>{out}</>
}

/* ------------------------------- helpers ------------------------------- */

function relTime(iso: string): string {
  const t = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()
  const diff = Date.now() - t
  if (isNaN(diff)) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function prettyToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = (await res.json()).error ?? msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

const SUGGESTIONS = [
  { icon: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z', text: 'Summarize my portfolio' },
  { icon: 'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z', text: 'How are my open positions doing?' },
  { icon: 'M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941', text: "What's the market context for BTC right now?" },
  { icon: 'M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z', text: 'Which holding is my biggest loser?' },
]

/* ------------------------------ live trace ------------------------------ */

interface LiveTool { id: string; tool: string; readOnly: boolean; done: boolean }
type Phase = 'idle' | 'thinking' | 'tools'

/* tool_calls JSON shape coming from the backend (OpenAI format). */
interface RawToolCall { id: string; type?: string; function?: { name?: string; arguments?: string } }

function parseToolCalls(raw: string | null): { id: string; name: string; args: string }[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as RawToolCall[]
    return arr.map(c => ({ id: c.id, name: c.function?.name ?? 'tool', args: c.function?.arguments ?? '' }))
  } catch { return [] }
}

/* ------------------------------ thread model ------------------------------ */
// Fold the raw message list into render items: user bubbles, assistant bubbles,
// and "tool run" chips (an assistant tool_call paired with its tool result).

interface ToolRun { name: string; args: string; result: string | null; readOnly: boolean }
type Item =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'tools'; id: number; runs: ToolRun[]; note: string | null }

function buildItems(messages: AgentMessage[], toolMeta: Map<string, boolean>): Item[] {
  const items: Item[] = []
  const resultByCallId = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) resultByCallId.set(m.tool_call_id, m.content ?? '')
  }
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ kind: 'user', id: m.id, text: m.content ?? '' })
    } else if (m.role === 'assistant' && m.tool_calls) {
      const calls = parseToolCalls(m.tool_calls)
      items.push({
        kind: 'tools',
        id: m.id,
        note: m.content?.trim() ? m.content.trim() : null,
        runs: calls.map(c => ({
          name: c.name,
          args: c.args,
          result: resultByCallId.get(c.id) ?? null,
          readOnly: toolMeta.get(c.name) ?? true,
        })),
      })
    } else if (m.role === 'assistant') {
      items.push({ kind: 'assistant', id: m.id, text: m.content ?? '' })
    }
    // standalone 'tool' messages are folded into the chips above
  }
  return items
}

/* ------------------------------ components ------------------------------ */

function ToolChip({ run, live }: { run: { name: string; args?: string; result?: string | null; readOnly: boolean; done?: boolean }; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const pending = live && !run.done
  let argStr = ''
  try { const a = run.args ? JSON.parse(run.args) : {}; argStr = Object.keys(a).length ? JSON.stringify(a) : '' } catch { argStr = run.args ?? '' }
  return (
    <div className="rounded-xl border border-border bg-surface-elevated/60 overflow-hidden">
      <button
        onClick={() => !live && setOpen(o => !o)}
        className={cn('w-full flex items-center gap-2 px-3 py-2 text-left', !live && 'hover:bg-surface-elevated transition-colors')}
      >
        <span className={cn(
          'flex items-center justify-center w-5 h-5 rounded-md shrink-0',
          run.readOnly ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn',
        )}>
          {pending ? (
            <span className="w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d={run.readOnly ? 'M4.5 12.75l6 6 9-13.5' : 'M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5'} />
            </svg>
          )}
        </span>
        <span className="text-[13px] font-medium text-foreground">{prettyToolName(run.name)}</span>
        {!run.readOnly && <span className="text-[10px] uppercase tracking-wider font-semibold text-warn px-1.5 py-0.5 rounded bg-warn/10">action</span>}
        {argStr && <span className="text-[11px] text-muted font-mono truncate hidden sm:block">{argStr}</span>}
        {!live && (
          <svg className={cn('ml-auto w-3.5 h-3.5 text-muted shrink-0 transition-transform', open && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </button>
      {open && !live && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-border">
          {argStr && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">Arguments</p>
              <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all">{argStr}</pre>
            </div>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">Result</p>
            <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{run.result ?? '—'}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  if (role === 'user') {
    return (
      <div className="w-8 h-8 rounded-xl bg-surface-elevated border border-border flex items-center justify-center shrink-0">
        <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
        </svg>
      </div>
    )
  }
  return (
    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-accent to-accent2 flex items-center justify-center shrink-0 shadow-glow">
      <svg className="w-4 h-4 text-surface-base" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
      </svg>
    </div>
  )
}

/* --------------------------------- page --------------------------------- */

export default function Agent() {
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [liveTools, setLiveTools] = useState<LiveTool[]>([])
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<string>('')
  const [tools, setTools] = useState<AgentToolInfo[]>([])

  const activeIdRef = useRef<number | null>(null)
  activeIdRef.current = activeId
  const threadRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const toolMeta = useMemo(() => new Map(tools.map(t => [t.name, t.readOnly])), [tools])
  const items = useMemo(() => buildItems(messages, toolMeta), [messages, toolMeta])
  const active = useMemo(() => conversations.find(c => c.id === activeId) ?? null, [conversations, activeId])

  /* load meta + conversation list once */
  useEffect(() => {
    api<{ model: { model: string }; tools: AgentToolInfo[] }>('/api/agent/meta')
      .then(d => { setModel(d.model.model); setTools(d.tools) })
      .catch(() => {})
    api<AgentConversation[]>('/api/agent/conversations')
      .then(list => {
        setConversations(list)
        if (list.length) selectConversation(list[0].id)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* autoscroll on new content */
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [items, pendingUser, liveTools, phase])

  const selectConversation = useCallback(async (id: number) => {
    setActiveId(id)
    setError(null)
    setPendingUser(null)
    setLiveTools([])
    setPhase('idle')
    try {
      const d = await api<{ messages: AgentMessage[] }>(`/api/agent/conversations/${id}`)
      setMessages(d.messages)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load conversation')
    }
  }, [])

  /* live step stream for the in-flight turn + live title updates */
  const onWs = useCallback((event: string, data: unknown) => {
    if (event === 'agent_conversation_updated') {
      const u = data as { id: number; title: string }
      setConversations(prev => prev.map(c => (c.id === u.id ? { ...c, title: u.title } : c)))
      return
    }
    if (event !== 'agent_step') return
    const d = data as { conversation_id: number; type: string; tool?: string; tool_call_id?: string; read_only?: boolean; error?: string }
    if (d.conversation_id !== activeIdRef.current) return
    switch (d.type) {
      case 'thinking':
        setPhase(p => (p === 'tools' ? p : 'thinking'))
        break
      case 'tool_call':
        setPhase('tools')
        setLiveTools(prev => [...prev, { id: d.tool_call_id ?? `${Date.now()}`, tool: d.tool ?? 'tool', readOnly: d.read_only ?? true, done: false }])
        break
      case 'tool_result':
        setLiveTools(prev => prev.map(t => (t.id === d.tool_call_id ? { ...t, done: true } : t)))
        setPhase('thinking')
        break
      case 'error':
        setError(d.error ?? 'Something went wrong')
        break
    }
  }, [])
  useWebSocket(onWs)

  async function newConversation() {
    try {
      const convo = await api<AgentConversation>('/api/agent/conversations', { method: 'POST' })
      setConversations(prev => [convo, ...prev])
      setActiveId(convo.id)
      setMessages([])
      setPendingUser(null)
      setLiveTools([])
      setPhase('idle')
      setError(null)
      taRef.current?.focus()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create conversation')
    }
  }

  async function removeConversation(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await api(`/api/agent/conversations/${id}`, { method: 'DELETE' })
      setConversations(prev => prev.filter(c => c.id !== id))
      if (activeId === id) {
        setActiveId(null)
        setMessages([])
      }
    } catch { /* ignore */ }
  }

  async function send(textArg?: string) {
    const text = (textArg ?? input).trim()
    if (!text || sending) return

    let convId = activeId
    if (convId == null) {
      try {
        const convo = await api<AgentConversation>('/api/agent/conversations', { method: 'POST' })
        setConversations(prev => [convo, ...prev])
        setActiveId(convo.id)
        convId = convo.id
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create conversation')
        return
      }
    }

    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    setError(null)
    setPendingUser(text)
    setLiveTools([])
    setPhase('thinking')
    setSending(true)

    try {
      await api(`/api/agent/conversations/${convId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      // Refetch authoritative transcript + refresh the rail (title/order).
      const [d, list] = await Promise.all([
        api<{ messages: AgentMessage[] }>(`/api/agent/conversations/${convId}`),
        api<AgentConversation[]>('/api/agent/conversations'),
      ])
      setMessages(d.messages)
      setConversations(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to get a response')
    } finally {
      setSending(false)
      setPendingUser(null)
      setLiveTools([])
      setPhase('idle')
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const empty = items.length === 0 && !pendingUser

  return (
    <div className="h-full flex gap-5 animate-fade-in">
      {/* Conversation rail */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col gap-3">
        <button
          onClick={newConversation}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-accent to-accent2 text-surface-base font-semibold text-sm hover:brightness-110 hover:shadow-glow transition-all active:scale-[0.98]"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New chat
        </button>
        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {conversations.map(c => (
            <button
              key={c.id}
              onClick={() => selectConversation(c.id)}
              className={cn(
                'group w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-left transition-all',
                c.id === activeId
                  ? 'bg-accent/10 border border-accent/30'
                  : 'border border-transparent hover:bg-surface-elevated',
              )}
            >
              <svg className={cn('w-4 h-4 shrink-0', c.id === activeId ? 'text-accent' : 'text-muted')} fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
              <span className="text-[13px] text-foreground truncate flex-1">{c.title}</span>
              <span className="text-[10px] text-muted shrink-0 group-hover:hidden">{relTime(c.updated_at)}</span>
              <span
                onClick={(e) => removeConversation(c.id, e)}
                className="hidden group-hover:flex w-5 h-5 items-center justify-center rounded-md text-muted hover:text-sell hover:bg-sell/10 shrink-0"
                title="Delete"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* Chat column */}
      <div className="flex-1 min-w-0 flex flex-col rounded-2xl border border-border bg-surface-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 h-14 border-b border-border shrink-0 glass">
          <div className="flex items-center gap-2.5 min-w-0">
            <Avatar role="assistant" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground leading-tight">Trading Assistant</p>
              <p className="text-[11px] text-muted truncate">
                {model ? <span className="font-mono">{model}</span> : 'reads your portfolio, positions & markets'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {active && active.last_context_tokens > 0 && (
              <span
                title={`Context window: ~${active.last_context_tokens.toLocaleString()} tokens in the latest request.\nThis grows as the conversation gets longer — watch it against your model's context limit (start a new chat to reset).\nTotal used this chat: ${active.total_tokens.toLocaleString()} tokens.`}
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-surface-elevated border border-border text-muted cursor-default"
              >
                <svg className="w-3.5 h-3.5 text-accent2" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
                </svg>
                <span className="tabular-nums">{fmtTokens(active.last_context_tokens)}</span>
                <span className="text-muted/60">ctx</span>
              </span>
            )}
            <button
              onClick={newConversation}
              className="md:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-elevated border border-border text-xs font-medium text-foreground"
            >
              New
            </button>
          </div>
        </div>

        {/* Thread */}
        <div ref={threadRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-6">
          {empty ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-accent to-accent2 flex items-center justify-center shadow-glow mb-4">
                <svg className="w-7 h-7 text-surface-base" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-foreground">Ask your trading assistant</h2>
              <p className="text-sm text-muted mt-1.5 mb-6">
                It can read your portfolio, positions, trades, the watchlist and live markets — and run safe actions like tweaking the watchlist or kicking off an engine.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s.text}
                    onClick={() => send(s.text)}
                    className="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border bg-surface-elevated/50 hover:bg-surface-elevated hover:border-accent/30 transition-all text-left active:scale-[0.99]"
                  >
                    <svg className="w-4 h-4 text-accent shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d={s.icon} />
                    </svg>
                    <span className="text-[13px] text-foreground">{s.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {items.map(item => {
                if (item.kind === 'user') {
                  return (
                    <div key={`u${item.id}`} className="flex gap-3 justify-end">
                      <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-tr-md bg-accent/15 border border-accent/20 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                        {item.text}
                      </div>
                      <Avatar role="user" />
                    </div>
                  )
                }
                if (item.kind === 'tools') {
                  return (
                    <div key={`t${item.id}`} className="flex gap-3">
                      <Avatar role="assistant" />
                      <div className="min-w-0 flex-1 space-y-1.5 max-w-[80%]">
                        {item.note && <p className="text-[13px] text-muted italic mb-1">{item.note}</p>}
                        {item.runs.map((r, i) => <ToolChip key={i} run={r} />)}
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={`a${item.id}`} className="flex gap-3">
                    <Avatar role="assistant" />
                    <div className="min-w-0 max-w-[80%] px-4 py-2.5 rounded-2xl rounded-tl-md bg-surface-elevated border border-border text-sm text-foreground">
                      <RichText text={item.text} />
                    </div>
                  </div>
                )
              })}

              {/* Optimistic pending user bubble */}
              {pendingUser && (
                <div className="flex gap-3 justify-end">
                  <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-tr-md bg-accent/15 border border-accent/20 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                    {pendingUser}
                  </div>
                  <Avatar role="user" />
                </div>
              )}

              {/* Live activity for the in-flight turn */}
              {sending && (
                <div className="flex gap-3">
                  <Avatar role="assistant" />
                  <div className="min-w-0 flex-1 space-y-1.5 max-w-[80%]">
                    {liveTools.map(t => (
                      <ToolChip key={t.id} live run={{ name: t.tool, readOnly: t.readOnly, done: t.done }} />
                    ))}
                    {(phase !== 'tools' || liveTools.length === 0) && (
                      <div className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-2xl rounded-tl-md bg-surface-elevated border border-border">
                        <span className="flex gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
                        </span>
                        <span className="text-xs text-muted">{phase === 'tools' ? 'Reading results…' : 'Thinking…'}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {error && (
            <div className="flex gap-3">
              <Avatar role="assistant" />
              <div className="px-4 py-2.5 rounded-2xl rounded-tl-md bg-sell/10 border border-sell/30 text-sm text-sell">{error}</div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-border p-3 sm:p-4">
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface-elevated focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20 transition-all px-3 py-2">
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              onChange={onInput}
              onKeyDown={onKeyDown}
              placeholder="Ask about your portfolio, a coin, your positions…"
              className="flex-1 bg-transparent resize-none outline-none text-sm text-foreground placeholder:text-muted py-1.5 max-h-[200px]"
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || sending}
              className={cn(
                'shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all',
                input.trim() && !sending
                  ? 'bg-gradient-to-r from-accent to-accent2 text-surface-base hover:brightness-110 active:scale-95'
                  : 'bg-surface-card text-muted cursor-not-allowed',
              )}
            >
              {sending ? (
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
            </button>
          </div>
          <p className="text-[10px] text-muted text-center mt-2">
            The assistant reads live app data. It can't place trades — only read &amp; safe actions (watchlist, engine runs).
          </p>
        </div>
      </div>
    </div>
  )
}
