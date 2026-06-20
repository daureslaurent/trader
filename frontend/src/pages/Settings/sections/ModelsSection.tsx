import { useState } from 'react'
import { Toggle } from '../../../components/ui/Toggle'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { cn } from '../../../lib/utils'
import { LLMEndpoint, LLMDefaults } from '../../../types'
import { SectionProps, SettingsData, SetFn } from '../types'
import { LLM_MODULES, LLMModule } from '../constants'
import { Panel, Row, UnitInput, EndpointSelect } from '../widgets'

// One row in the LLM Models section: a primary endpoint picker + max-tokens, plus a
// collapsible "failover" block. The fallback only fires when the primary call
// throws, so it's a subordinate, opt-in panel — auto-expanded when already
// configured, with a live status dot so an active fallback reads at a glance.
function LLMModuleRow({ m, settings, set, def, endpoints, onManage }: {
  m: LLMModule
  settings: SettingsData
  set: SetFn
  def?: { model: string; baseURL: string; maxTokens: number }
  endpoints: LLMEndpoint[]
  onManage: () => void
}) {
  const maxTokens = settings[m.maxTokensKey] as number
  const fbEndpoint = (settings[m.fbEndpointKey] as string) ?? ''
  const fbMaxTokens = settings[m.fbMaxTokensKey] as number
  const fbActive = !!fbEndpoint && endpoints.some(e => e.id === fbEndpoint)
  const [open, setOpen] = useState(fbActive)

  // The env-var default the module uses when no endpoint is picked.
  const envLabel = def ? `Env default · ${def.model}` : 'Env default'

  // What a blank max-tokens field resolves to: the selected endpoint's own default
  // if set, else the env default. Mirrors resolveMaxTokens() on the backend so the
  // placeholder honestly previews the effective budget.
  const selectedEp = endpoints.find(e => e.id === (settings[m.endpointKey] as string))
  // Selected primary is disabled in the catalog → the backend treats it as offline
  // and routes to the fallback (or the env default when none is configured).
  const primaryDisabled = !!selectedEp?.disabled
  const primaryDefaultTokens = (selectedEp?.maxTokens && selectedEp.maxTokens > 0)
    ? selectedEp.maxTokens
    : def?.maxTokens
  const primaryEffectiveTokens = maxTokens > 0 ? maxTokens : primaryDefaultTokens
  const fbEp = endpoints.find(e => e.id === fbEndpoint)
  const fbDefaultTokens = (fbEp?.maxTokens && fbEp.maxTokens > 0)
    ? fbEp.maxTokens
    : primaryEffectiveTokens

  function clearFallback() {
    set(m.fbEndpointKey, '' as SettingsData[typeof m.fbEndpointKey])
    set(m.fbMaxTokensKey, 0 as SettingsData[typeof m.fbMaxTokensKey])
  }

  // No endpoints defined yet — nudge the user to the catalog modal instead of
  // showing an empty dropdown.
  if (endpoints.length === 0) {
    return (
      <Row label={m.label} hint={m.hint} stacked>
        <button
          type="button"
          onClick={onManage}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted transition-colors hover:border-accent/40 hover:text-foreground"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add an endpoint to assign — falls back to {def ? def.model : 'the env default'} until then
        </button>
      </Row>
    )
  }

  return (
    <Row label={m.label} hint={m.hint} stacked>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px]">
        <EndpointSelect
          value={settings[m.endpointKey] as string}
          onChange={v => set(m.endpointKey, v as SettingsData[typeof m.endpointKey])}
          endpoints={endpoints}
          emptyLabel={envLabel}
          ariaLabel={`${m.label} endpoint`}
        />
        <UnitInput
          type="number"
          min="0"
          step="256"
          unit="tok"
          value={maxTokens || ''}
          onChange={e => set(m.maxTokensKey, (parseInt(e.target.value) || 0) as SettingsData[typeof m.maxTokensKey])}
          placeholder={primaryDefaultTokens ? `${primaryDefaultTokens}` : 'max'}
          className="font-mono text-xs"
          aria-label={`${m.label} max tokens`}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted">
          Stream tokens <span className="text-muted/60">— keeps the socket warm (avoids idle "Premature close" drops) and shows live tokens in LLM Debug.</span>
        </span>
        <Toggle
          checked={(settings[m.streamKey] as boolean) !== false}
          onChange={() => set(m.streamKey, ((settings[m.streamKey] as boolean) === false) as SettingsData[typeof m.streamKey])}
          label={`${m.label} streaming`}
        />
      </div>

      {primaryDisabled && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          <svg className="mt-px h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            This endpoint is disabled — calls route to {fbActive ? 'the fallback below' : 'the env default'}.
          </span>
        </div>
      )}

      {/* Failover disclosure */}
      <div className="mt-1.5">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="group flex items-center gap-2 text-xs text-muted transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          <svg
            className={cn('h-3 w-3 shrink-0 transition-transform duration-150', open && 'rotate-90')}
            fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-medium">Fallback</span>
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full transition-colors',
              fbActive ? 'bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15' : 'bg-border',
            )}
            aria-hidden
          />
          <span className={cn('text-[11px]', fbActive ? 'text-emerald-500' : 'text-muted/70')}>
            {fbActive ? 'active' : 'off'}
          </span>
        </button>

        {open && (
          <div className="mt-2 space-y-2 rounded-lg border border-border/60 border-l-2 border-l-accent/50 bg-surface-elevated/40 p-3">
            <p className="text-[11px] leading-relaxed text-muted">
              Used only if the primary call fails (endpoint down, timeout, 5xx, unknown model).
              Pick an endpoint to enable failover.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px]">
              <EndpointSelect
                value={fbEndpoint}
                onChange={v => set(m.fbEndpointKey, v as SettingsData[typeof m.fbEndpointKey])}
                endpoints={endpoints}
                emptyLabel="No fallback"
                ariaLabel={`${m.label} fallback endpoint`}
              />
              <UnitInput
                type="number"
                min="0"
                step="256"
                unit="tok"
                value={fbMaxTokens || ''}
                onChange={e => set(m.fbMaxTokensKey, (parseInt(e.target.value) || 0) as SettingsData[typeof m.fbMaxTokensKey])}
                placeholder={fbDefaultTokens ? `${fbDefaultTokens}` : 'max'}
                className="font-mono text-xs"
                aria-label={`${m.label} fallback max tokens`}
              />
            </div>
            {fbActive && (
              <button
                type="button"
                onClick={clearFallback}
                className="text-[11px] text-muted underline-offset-2 transition-colors hover:text-danger hover:underline"
              >
                Clear fallback
              </button>
            )}
          </div>
        )}
      </div>
    </Row>
  )
}

// Modal that manages the shared endpoint catalog: add / edit / delete named
// {URL, model, parallel} entries that the module dropdowns select from. Edits flow
// straight to the parent's settings state via `onChange`, so they join the dirty
// diff and persist with the main Save button (like the watchlist).
function EndpointModal({ open, onClose, endpoints, onChange, usage }: {
  open: boolean
  onClose: () => void
  endpoints: LLMEndpoint[]
  onChange: (next: LLMEndpoint[]) => void
  usage: (id: string) => string[]
}) {
  function update(id: string, patch: Partial<LLMEndpoint>) {
    onChange(endpoints.map(e => e.id === id ? { ...e, ...patch } : e))
  }
  function add() {
    const id = (crypto.randomUUID?.() ?? `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    onChange([...endpoints, { id, name: '', baseURL: '', model: '', maxTokens: 0, parallel: false, maxParallel: 0, disabled: false }])
  }
  function remove(id: string) {
    onChange(endpoints.filter(e => e.id !== id))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="LLM Endpoints"
      subtitle="Define each URL + model once; modules pick from these."
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted">Changes save with the page's Save button.</p>
          <Button variant="primary" size="md" onClick={onClose}>Done</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {endpoints.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted">
            No endpoints yet. Add one to start assigning models to modules.
          </div>
        )}

        {endpoints.map(ep => {
          const used = usage(ep.id)
          const incomplete = !ep.baseURL.trim() || !ep.model.trim()
          const isDisabled = ep.disabled
          return (
            <div
              key={ep.id}
              className={cn(
                'space-y-3 rounded-xl border p-4',
                isDisabled ? 'border-dashed border-border bg-surface-elevated/20' : 'border-border bg-surface-elevated/40',
              )}
            >
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={ep.name}
                  onChange={e => update(ep.id, { name: e.target.value })}
                  placeholder="Name (e.g. Local Ollama)"
                  className="flex-1 text-sm"
                  aria-label="Endpoint name"
                />
                {isDisabled && (
                  <span className="shrink-0 rounded-md bg-surface-elevated px-2 py-0.5 text-[11px] font-medium text-muted">
                    Disabled
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => remove(ep.id)}
                  className="shrink-0 rounded-lg p-2 text-muted transition-colors hover:bg-sell/10 hover:text-sell"
                  aria-label="Delete endpoint"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>

              <div className={cn('grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_120px]', isDisabled && 'opacity-50')}>
                <Input
                  type="text"
                  value={ep.baseURL}
                  onChange={e => update(ep.id, { baseURL: e.target.value })}
                  placeholder="Base URL (http://localhost:11434/v1)"
                  className="font-mono text-xs"
                  aria-label="Endpoint base URL"
                />
                <Input
                  type="text"
                  value={ep.model}
                  onChange={e => update(ep.id, { model: e.target.value })}
                  placeholder="Model (qwen2.5:14b)"
                  className="font-mono text-xs"
                  aria-label="Endpoint model"
                />
                <UnitInput
                  type="number"
                  min="0"
                  step="256"
                  unit="tok"
                  value={ep.maxTokens || ''}
                  onChange={e => update(ep.id, { maxTokens: parseInt(e.target.value) || 0 })}
                  placeholder="default"
                  className="font-mono text-xs"
                  aria-label="Endpoint default max tokens"
                />
              </div>

              <div className={cn('flex flex-wrap items-center justify-between gap-3', isDisabled && 'opacity-50')}>
                <div className="flex items-center gap-2.5">
                  <Toggle
                    label="Allow parallel calls"
                    checked={ep.parallel}
                    onChange={() => update(ep.id, { parallel: !ep.parallel })}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">Run in parallel</p>
                    <p className="text-[11px] leading-tight text-muted">Skip the per-URL queue even when serialization is on.</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {ep.parallel && (
                    <label className="flex items-center gap-1.5 text-[11px] text-muted">
                      Max concurrent
                      <UnitInput
                        type="number"
                        min="0"
                        step="1"
                        unit="∥"
                        value={ep.maxParallel || ''}
                        onChange={e => update(ep.id, { maxParallel: parseInt(e.target.value) || 0 })}
                        placeholder="∞"
                        className="w-20 font-mono text-xs"
                        aria-label="Max concurrent calls"
                      />
                    </label>
                  )}
                  {incomplete && (
                    <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500">Incomplete</span>
                  )}
                  {used.length > 0 && (
                    <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[11px] text-accent" title={used.join(', ')}>
                      Used by {used.length} {used.length === 1 ? 'module' : 'modules'}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2.5 border-t border-border pt-3">
                <Toggle
                  label="Disable endpoint"
                  danger
                  checked={isDisabled}
                  onChange={() => update(ep.id, { disabled: !isDisabled })}
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">Disable (take out of rotation)</p>
                  <p className="text-[11px] leading-tight text-muted">
                    {isDisabled
                      ? used.length > 0
                        ? `Treated as offline — ${used.length === 1 ? 'the module' : 'modules'} using it route to their failover.`
                        : 'Treated as offline. Modules selecting it route to their failover.'
                      : 'Stop sending it traffic without deleting it or re-pointing modules.'}
                  </p>
                </div>
              </div>
            </div>
          )
        })}

        <button
          type="button"
          onClick={add}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-sm text-muted transition-colors hover:border-accent/40 hover:text-foreground"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add endpoint
        </button>
      </div>
    </Modal>
  )
}

export function ModelsSection({ settings, set, toggle, llmDefaults, modalOpen, setModalOpen }: SectionProps & {
  llmDefaults: LLMDefaults | null
  modalOpen: boolean
  setModalOpen: (v: boolean) => void
}) {
  const endpoints = settings.llm_endpoints
  return (
    <Panel>
      <Row
        label="Endpoint catalog"
        hint={`Your reusable URL + model entries. ${endpoints.length} defined.`}
      >
        <Button type="button" variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
          Manage endpoints
        </Button>
      </Row>
      <Row
        label="Parallel calls per endpoint"
        hint="Off (recommended): calls to the same base URL queue and run one at a time — best for a local server that handles one request at a time. On: allow concurrent calls to the same endpoint. An endpoint flagged “Run in parallel” in the catalog bypasses the queue even when this is off. Different endpoints always run in parallel either way."
      >
        <Toggle
          label="Allow parallel same-endpoint calls"
          checked={settings.llm_allow_parallel_same_url}
          onChange={() => toggle('llm_allow_parallel_same_url')}
        />
      </Row>
      <Row
        label="Control Room history"
        hint="How much LLM-scheduler activity the Control Room retains — the feed and the per-endpoint model timeline. The page rebuilds this much scrollback when reopened or reloaded. Kept in memory only."
      >
        <UnitInput
          type="number"
          step="0.5"
          min="0.5"
          max="72"
          unit="hours"
          value={settings.control_room_retain_hours}
          onChange={e => set('control_room_retain_hours', parseFloat(e.target.value) || 3)}
        />
      </Row>
      {LLM_MODULES.map(m => (
        <LLMModuleRow
          key={m.key}
          m={m}
          settings={settings}
          set={set}
          def={llmDefaults?.[m.key]}
          endpoints={endpoints}
          onManage={() => setModalOpen(true)}
        />
      ))}

      <EndpointModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        endpoints={endpoints}
        onChange={next => set('llm_endpoints', next)}
        usage={id =>
          LLM_MODULES.flatMap(m =>
            settings[m.endpointKey] === id ? [m.label]
              : settings[m.fbEndpointKey] === id ? [`${m.label} (fallback)`]
              : [],
          )
        }
      />
    </Panel>
  )
}
