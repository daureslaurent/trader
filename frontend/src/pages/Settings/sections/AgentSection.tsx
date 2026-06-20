import { ReactNode, useState } from 'react'
import { cn } from '../../../lib/utils'
import { AgentToolPermission, AgentToolPermissions, AgenticToolsConfig, AgenticAgentInfo, AgenticToolInfo } from '../../../types'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

// Segmented control for one tool's grant. Read-only tools show Off / On (On = 'read');
// write/action tools show Off / Read / R-W. Keyboard-accessible radio group.
function PermissionControl({ capability, value, onChange }: {
  capability: 'read' | 'write'
  value: AgentToolPermission
  onChange: (v: AgentToolPermission) => void
}) {
  const opts: { v: AgentToolPermission; label: string; title: string; active: string }[] =
    capability === 'read'
      ? [
          { v: 'off',  label: 'Off', title: 'Hidden from this agent',          active: 'bg-surface-hover text-foreground shadow-sm' },
          { v: 'read', label: 'On',  title: 'Agent can use this read tool',    active: 'bg-accent/15 text-accent shadow-sm' },
        ]
      : [
          { v: 'off',       label: 'Off',  title: 'Hidden from this agent',                                  active: 'bg-surface-hover text-foreground shadow-sm' },
          { v: 'read',      label: 'Read', title: 'Exposed, but the action is blocked (no side effect)',     active: 'bg-accent/15 text-accent shadow-sm' },
          { v: 'readwrite', label: 'R-W',  title: 'Full access — the agent may perform this action',        active: 'bg-buy/15 text-buy shadow-sm' },
        ]
  // A read-only tool can never carry a write grant — show it as 'read'.
  const current: AgentToolPermission = capability === 'read' && value === 'readwrite' ? 'read' : value
  return (
    <div role="radiogroup" className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface-base p-0.5">
      {opts.map(o => {
        const on = current === o.v
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.v)}
            className={cn(
              'px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors duration-150',
              on ? o.active : 'text-muted hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function PresetButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 text-[11px] rounded-full border border-border bg-surface-base text-muted hover:text-foreground hover:border-foreground/20 transition-colors duration-150"
    >
      {children}
    </button>
  )
}

// One collapsible agent card: header (label + live grant summary) and, when expanded, the
// shared tool catalog split into Reads / Actions, each row with its PermissionControl.
function AgentToolCard({ agent, tools, grants, onGrant, onPreset, defaultOpen }: {
  agent: AgenticAgentInfo
  tools: AgenticToolInfo[]
  grants: Record<string, AgentToolPermission>
  onGrant: (tool: string, v: AgentToolPermission) => void
  onPreset: (preset: 'off' | 'read' | 'max') => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  const grantOf = (name: string): AgentToolPermission => grants?.[name] ?? 'off'

  const reads = tools.filter(t => t.capability === 'read')
  const writes = tools.filter(t => t.capability === 'write')
  const enabled = tools.filter(t => grantOf(t.name) !== 'off').length
  const actionsLive = writes.filter(t => grantOf(t.name) === 'readwrite').length

  const Group = ({ title, items }: { title: string; items: AgenticToolInfo[] }) =>
    items.length ? (
      <div className="space-y-0.5">
        <p className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</p>
        {items.map(t => (
          <div key={t.name} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-elevated/60 transition-colors">
            <div className="min-w-0">
              <p className="font-mono text-xs text-foreground truncate">{t.name}</p>
              <p className="text-[11px] text-muted leading-snug line-clamp-2">{t.description}</p>
            </div>
            <PermissionControl capability={t.capability} value={grantOf(t.name)} onChange={v => onGrant(t.name, v)} />
          </div>
        ))}
      </div>
    ) : null

  return (
    <div className="rounded-xl border border-border overflow-hidden bg-surface-card">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-elevated/50 transition-colors"
      >
        <svg className={cn('h-4 w-4 shrink-0 text-muted transition-transform duration-150', open && 'rotate-90')} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{agent.label}</p>
          <p className="text-[11px] text-muted leading-snug mt-0.5 line-clamp-2">{agent.description}</p>
        </div>
        <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">{enabled}/{tools.length} enabled</span>
          {actionsLive > 0 && (
            <span className="rounded-full bg-buy/10 px-2 py-0.5 text-[10px] font-medium text-buy">{actionsLive} action{actionsLive === 1 ? '' : 's'}</span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border px-2.5 py-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1">
            <span className="mr-1 text-[11px] text-muted">Quick set:</span>
            <PresetButton onClick={() => onPreset('max')}>Enable all</PresetButton>
            <PresetButton onClick={() => onPreset('read')}>Read-only</PresetButton>
            <PresetButton onClick={() => onPreset('off')}>Disable all</PresetButton>
          </div>
          <Group title="Reads" items={reads} />
          <Group title="Actions" items={writes} />
        </div>
      )}
    </div>
  )
}

// The Agentic Tools subsection body: a short legend + one collapsible card per agent.
function AgenticToolsManager({ config, permissions, onGrant, onPreset }: {
  config: AgenticToolsConfig
  permissions: AgentToolPermissions
  onGrant: (agentId: string, tool: string, v: AgentToolPermission) => void
  onPreset: (agentId: string, preset: 'off' | 'read' | 'max') => void
}) {
  return (
    <div className="py-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-foreground">Agentic tools</p>
        <p className="mt-1 text-xs text-muted leading-relaxed">
          Every tool-calling agent draws from one shared tool belt. Grant access per tool —
          <span className="text-foreground"> Off</span> hides it from the agent,
          <span className="text-accent"> Read</span> exposes it (action tools run with their side effect suppressed), and
          <span className="text-buy"> R-W</span> lets the agent perform the action. Changes save with the rest of Settings.
        </p>
      </div>
      <div className="space-y-2.5">
        {config.agents.map((a, i) => (
          <AgentToolCard
            key={a.id}
            agent={a}
            tools={config.tools}
            grants={permissions[a.id] ?? a.grants}
            onGrant={(tool, v) => onGrant(a.id, tool, v)}
            onPreset={preset => onPreset(a.id, preset)}
            defaultOpen={i === 0}
          />
        ))}
      </div>
    </div>
  )
}

export function AgentSection({ settings, set, toolsConfig, setGrant, setAgentPreset }: SectionProps & {
  toolsConfig: AgenticToolsConfig | null
  setGrant: (agentId: string, tool: string, perm: AgentToolPermission) => void
  setAgentPreset: (agentId: string, preset: 'off' | 'read' | 'max') => void
}) {
  return (
    <Panel>
      <Row
        label="Auto-title context"
        hint="Conversations are auto-named by the Agent model, refreshed as the chat grows. To keep that cheap, only this many of the most recent messages are summarized for the title — lower uses fewer tokens, higher captures more context. The Agent model & endpoint are configured under LLM Models."
      >
        <UnitInput
          type="number"
          step="1"
          min="2"
          max="40"
          unit="messages"
          value={settings.agent_title_context_messages}
          onChange={e => set('agent_title_context_messages', parseInt(e.target.value) || 6)}
        />
      </Row>
      {toolsConfig && (
        <AgenticToolsManager
          config={toolsConfig}
          permissions={settings.agent_tool_permissions ?? {}}
          onGrant={setGrant}
          onPreset={setAgentPreset}
        />
      )}
    </Panel>
  )
}
