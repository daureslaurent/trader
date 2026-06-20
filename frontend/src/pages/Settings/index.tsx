import { useEffect, useRef, useState, FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { LLMDefaults, AgenticToolsConfig, AgentToolPermissions, AgentToolPermission } from '../../types'
import { SettingsData, ToggleKey } from './types'
import { SECTIONS, SectionId } from './constants'
import { SectionIcon } from './widgets'
import { CategoryGrid } from './CategoryGrid'
import { TradingSection } from './sections/TradingSection'
import { EntrySection } from './sections/EntrySection'
import { RiskSection } from './sections/RiskSection'
import { MonitorSection } from './sections/MonitorSection'
import { ChartSection } from './sections/ChartSection'
import { SummarySection } from './sections/SummarySection'
import { ModelsSection } from './sections/ModelsSection'
import { AgentSection } from './sections/AgentSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { LLMDataSection } from './sections/LLMDataSection'
import { TelegramSection } from './sections/TelegramSection'
import { SystemSection } from './sections/SystemSection'
import { AccountSection } from './sections/AccountSection'
import { DatabaseSection } from './sections/DatabaseSection'

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [baseline, setBaseline] = useState<SettingsData | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [activeCategory, setActiveCategory] = useState<SectionId | null>(null)
  const [llmDefaults, setLlmDefaults] = useState<LLMDefaults | null>(null)
  const [endpointModalOpen, setEndpointModalOpen] = useState(false)
  const [toolsConfig, setToolsConfig] = useState<AgenticToolsConfig | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  // Guards the one-time seed of agent_tool_permissions from the resolved tools-config, so
  // it can't clobber the user's in-progress edits once both fetches have landed.
  const permsSeeded = useRef(false)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((data: SettingsData) => {
        setSettings(data)
        setBaseline(data)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/llm/defaults')
      .then(r => r.json())
      .then((data: LLMDefaults) => setLlmDefaults(data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/agent/tools-config')
      .then(r => r.json())
      .then((data: AgenticToolsConfig) => setToolsConfig(data))
      .catch(() => {})
  }, [])

  // Seed the editable permission map from the backend-resolved grants (defaults merged with
  // any saved overrides) once both the settings and the tools-config have loaded. Writing it
  // into settings AND baseline keeps the form pristine until the user actually changes a cell.
  useEffect(() => {
    if (permsSeeded.current || !settings || !toolsConfig) return
    permsSeeded.current = true
    const seeded: AgentToolPermissions = {}
    for (const a of toolsConfig.agents) seeded[a.id] = { ...a.grants }
    setSettings(s => (s ? { ...s, agent_tool_permissions: seeded } : s))
    setBaseline(b => (b ? { ...b, agent_tool_permissions: seeded } : b))
  }, [settings, toolsConfig])

  const dirty = !!settings && !!baseline && JSON.stringify(settings) !== JSON.stringify(baseline)

  function set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    setSettings(s => s ? { ...s, [key]: value } : s)
    setSaved(false)
  }

  // Update one agent's grant for one tool (part of the form — saved on the next Save).
  function setGrant(agentId: string, tool: string, perm: AgentToolPermission) {
    setSettings(s => {
      if (!s) return s
      const all = s.agent_tool_permissions ?? {}
      return { ...s, agent_tool_permissions: { ...all, [agentId]: { ...all[agentId], [tool]: perm } } }
    })
    setSaved(false)
  }

  // Bulk-apply a preset to every tool of one agent (respecting each tool's capability):
  // 'off' disables all; 'read' grants read-only access; 'max' gives writes R-W, reads read.
  function setAgentPreset(agentId: string, preset: 'off' | 'read' | 'max') {
    if (!toolsConfig) return
    setSettings(s => {
      if (!s) return s
      const next: Record<string, AgentToolPermission> = {}
      for (const t of toolsConfig.tools) {
        next[t.name] = preset === 'off' ? 'off'
          : preset === 'read' ? 'read'
          : t.capability === 'write' ? 'readwrite' : 'read'
      }
      return { ...s, agent_tool_permissions: { ...(s.agent_tool_permissions ?? {}), [agentId]: next } }
    })
    setSaved(false)
  }

  // Toggles save immediately and don't mark the form dirty
  async function toggle(key: ToggleKey) {
    if (!settings) return
    const next = !settings[key]
    setSettings(s => s ? { ...s, [key]: next } : s)
    setBaseline(b => b ? { ...b, [key]: next } : b)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: next }),
    }).catch(() => {})
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!settings) return
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      setBaseline(settings)
      setSaved(true)
      clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    if (baseline) setSettings(baseline)
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const sectionProps = { settings, set, toggle }
  const activeMeta = activeCategory ? SECTIONS.find(s => s.id === activeCategory) : null

  function renderSection(id: SectionId) {
    switch (id) {
      case 'trading':    return <TradingSection {...sectionProps} />
      case 'entry':      return <EntrySection {...sectionProps} />
      case 'risk':       return <RiskSection {...sectionProps} />
      case 'monitor':    return <MonitorSection {...sectionProps} />
      case 'chart':      return <ChartSection {...sectionProps} />
      case 'summary':    return <SummarySection {...sectionProps} />
      case 'models':     return <ModelsSection {...sectionProps} llmDefaults={llmDefaults} modalOpen={endpointModalOpen} setModalOpen={setEndpointModalOpen} />
      case 'agent':      return <AgentSection {...sectionProps} toolsConfig={toolsConfig} setGrant={setGrant} setAgentPreset={setAgentPreset} />
      case 'appearance': return <AppearanceSection />
      case 'llm':        return <LLMDataSection {...sectionProps} />
      case 'telegram':   return <TelegramSection {...sectionProps} />
      case 'account':    return <AccountSection />
      case 'system':     return <SystemSection {...sectionProps} />
      case 'database':   return <DatabaseSection {...sectionProps} />
    }
  }

  return (
    <form onSubmit={save} className="max-w-5xl pb-24">
      {activeCategory === null || !activeMeta ? (
        <CategoryGrid settings={settings} onOpen={setActiveCategory} />
      ) : (
        <div className="animate-fade-in">
          {/* Detail header */}
          <div className="mb-5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              aria-label="Back to all settings"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border text-muted transition-colors hover:border-accent/40 hover:text-foreground"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/15 to-accent2/10 ring-1 ring-accent/10 text-accent">
              <SectionIcon path={activeMeta.icon} className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">{activeMeta.label}</h2>
              <p className="text-xs text-muted mt-0.5">{activeMeta.subtitle}</p>
            </div>
          </div>

          {renderSection(activeCategory)}
        </div>
      )}

      {/* Floating save bar */}
      {(dirty || saved) && (
        <div className="fixed bottom-6 left-[220px] right-0 z-30 flex justify-center px-8 pointer-events-none">
          {dirty ? (
            <div className="pointer-events-auto flex items-center gap-4 bg-surface-card border border-border rounded-2xl shadow-2xl pl-5 pr-3 py-2.5 animate-slide-up">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
                <span className="text-sm text-foreground">Unsaved changes</span>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={discard}>
                  Discard
                </Button>
                <Button type="submit" variant="primary" size="md" loading={saving}>
                  Save changes
                </Button>
              </div>
            </div>
          ) : (
            <div className="pointer-events-auto flex items-center gap-2 bg-surface-card border border-buy/30 rounded-2xl shadow-2xl px-5 py-2.5 animate-slide-up">
              <svg className="w-4 h-4 text-buy" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-sm text-buy">Settings saved</span>
            </div>
          )}
        </div>
      )}
    </form>
  )
}
