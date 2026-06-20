import { useState } from 'react'
import { Toggle } from '../../../components/ui/Toggle'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { cn } from '../../../lib/utils'
import { LLMEndpoint, LLMModelEntry, LLMDefaults } from '../../../types'
import { SectionProps, SettingsData, SetFn } from '../types'
import { LLM_MODULES, LLMModule } from '../constants'
import { Panel, Row, UnitInput, findModelById } from '../widgets'
import { ModelPicker } from '../ModelPicker'

function uid(): string {
  return crypto.randomUUID?.() ?? `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// One row in the LLM Models section: a primary model picker + max-tokens, plus a
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
  const fbSelected = findModelById(endpoints, fbEndpoint)
  const fbActive = !!fbSelected
  const [open, setOpen] = useState(fbActive)

  // The env-var default the module uses when no model is picked.
  const envLabel = def ? `Env default · ${def.model}` : 'Env default'

  // What a blank max-tokens field resolves to: the selected model's own default
  // if set, else the env default. Mirrors resolveMaxTokens() on the backend so the
  // placeholder honestly previews the effective budget.
  const selected = findModelById(endpoints, settings[m.endpointKey] as string)
  // Selected primary is disabled in the catalog (model or its endpoint) → the
  // backend treats it as offline and routes to the fallback (or env default).
  const primaryDisabled = !!selected && (selected.ep.disabled || selected.m.disabled)
  const primaryDefaultTokens = (selected?.m.maxTokens && selected.m.maxTokens > 0)
    ? selected.m.maxTokens
    : def?.maxTokens
  const primaryEffectiveTokens = maxTokens > 0 ? maxTokens : primaryDefaultTokens
  const fbDefaultTokens = (fbSelected?.m.maxTokens && fbSelected.m.maxTokens > 0)
    ? fbSelected.m.maxTokens
    : primaryEffectiveTokens

  function clearFallback() {
    set(m.fbEndpointKey, '' as SettingsData[typeof m.fbEndpointKey])
    set(m.fbMaxTokensKey, 0 as SettingsData[typeof m.fbMaxTokensKey])
  }

  // No models defined anywhere yet — nudge the user to the catalog modal instead of
  // showing an empty picker.
  if (endpoints.every(e => e.models.length === 0)) {
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
          Add an endpoint &amp; model to assign — falls back to {def ? def.model : 'the env default'} until then
        </button>
      </Row>
    )
  }

  return (
    <Row label={m.label} hint={m.hint} stacked>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px]">
        <ModelPicker
          value={settings[m.endpointKey] as string}
          onChange={v => set(m.endpointKey, v as SettingsData[typeof m.endpointKey])}
          endpoints={endpoints}
          emptyLabel={envLabel}
          ariaLabel={`${m.label} model`}
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
            This model is disabled — calls route to {fbActive ? 'the fallback below' : 'the env default'}.
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
              Pick a model to enable failover.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px]">
              <ModelPicker
                value={fbEndpoint}
                onChange={v => set(m.fbEndpointKey, v as SettingsData[typeof m.fbEndpointKey])}
                endpoints={endpoints}
                emptyLabel="No fallback"
                ariaLabel={`${m.label} fallback model`}
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

// Modal that manages the shared catalog: each endpoint is a server URL holding a
// list of models. Edits flow straight to the parent's settings state via `onChange`,
// so they join the dirty diff and persist with the main Save button (like the watchlist).
function EndpointModal({ open, onClose, endpoints, onChange, usage }: {
  open: boolean
  onClose: () => void
  endpoints: LLMEndpoint[]
  onChange: (next: LLMEndpoint[]) => void
  usage: (modelId: string) => string[]
}) {
  function updateEp(id: string, patch: Partial<LLMEndpoint>) {
    onChange(endpoints.map(e => e.id === id ? { ...e, ...patch } : e))
  }
  function addEp() {
    onChange([...endpoints, { id: uid(), name: '', baseURL: '', parallel: false, maxParallel: 0, disabled: false, models: [] }])
  }
  function removeEp(id: string) {
    onChange(endpoints.filter(e => e.id !== id))
  }
  function addModel(epId: string) {
    onChange(endpoints.map(e => e.id === epId
      ? { ...e, models: [...e.models, { id: uid(), model: '', maxTokens: 0, disabled: false }] }
      : e))
  }
  function updateModel(epId: string, modelId: string, patch: Partial<LLMModelEntry>) {
    onChange(endpoints.map(e => e.id === epId
      ? { ...e, models: e.models.map(mm => mm.id === modelId ? { ...mm, ...patch } : mm) }
      : e))
  }
  function removeModel(epId: string, modelId: string) {
    onChange(endpoints.map(e => e.id === epId
      ? { ...e, models: e.models.filter(mm => mm.id !== modelId) }
      : e))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="LLM Endpoints"
      subtitle="Define each server URL once, then add the models it serves; modules pick from these."
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
            No endpoints yet. Add a server URL, then add the models it serves.
          </div>
        )}

        {endpoints.map(ep => {
          const isDisabled = ep.disabled
          const urlIncomplete = !ep.baseURL.trim()
          return (
            <div
              key={ep.id}
              className={cn(
                'space-y-3 rounded-xl border p-4',
                isDisabled ? 'border-dashed border-border bg-surface-elevated/20' : 'border-border bg-surface-elevated/40',
              )}
            >
              {/* Endpoint (server) header */}
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={ep.name}
                  onChange={e => updateEp(ep.id, { name: e.target.value })}
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
                  onClick={() => removeEp(ep.id)}
                  className="shrink-0 rounded-lg p-2 text-muted transition-colors hover:bg-sell/10 hover:text-sell"
                  aria-label="Delete endpoint"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>

              <div className={cn(isDisabled && 'opacity-50')}>
                <Input
                  type="text"
                  value={ep.baseURL}
                  onChange={e => updateEp(ep.id, { baseURL: e.target.value })}
                  placeholder="Base URL (http://localhost:11434/v1)"
                  className="font-mono text-xs"
                  aria-label="Endpoint base URL"
                />
              </div>

              {/* Server-level concurrency */}
              <div className={cn('flex flex-wrap items-center justify-between gap-3', isDisabled && 'opacity-50')}>
                <div className="flex items-center gap-2.5">
                  <Toggle
                    label="Allow parallel calls"
                    checked={ep.parallel}
                    onChange={() => updateEp(ep.id, { parallel: !ep.parallel })}
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
                        onChange={e => updateEp(ep.id, { maxParallel: parseInt(e.target.value) || 0 })}
                        placeholder="∞"
                        className="w-20 font-mono text-xs"
                        aria-label="Max concurrent calls"
                      />
                    </label>
                  )}
                  {urlIncomplete && (
                    <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500">No URL</span>
                  )}
                </div>
              </div>

              {/* Models list */}
              <div className={cn('space-y-2 border-t border-border pt-3', isDisabled && 'opacity-50')}>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Models</p>
                {ep.models.length === 0 && (
                  <p className="text-[11px] text-muted">No models yet — add one below.</p>
                )}
                {ep.models.map(mm => {
                  const used = usage(mm.id)
                  const modelIncomplete = !mm.model.trim()
                  return (
                    <div key={mm.id} className="flex items-center gap-2">
                      <Input
                        type="text"
                        value={mm.model}
                        onChange={e => updateModel(ep.id, mm.id, { model: e.target.value })}
                        placeholder="Model (qwen2.5:14b)"
                        className="flex-1 font-mono text-xs"
                        aria-label="Model id"
                      />
                      <UnitInput
                        type="number"
                        min="0"
                        step="256"
                        unit="tok"
                        value={mm.maxTokens || ''}
                        onChange={e => updateModel(ep.id, mm.id, { maxTokens: parseInt(e.target.value) || 0 })}
                        placeholder="default"
                        className="w-24 font-mono text-xs"
                        aria-label="Model default max tokens"
                      />
                      {modelIncomplete && (
                        <span className="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">empty</span>
                      )}
                      {used.length > 0 && (
                        <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent" title={used.join(', ')}>
                          {used.length} use{used.length === 1 ? '' : 's'}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => updateModel(ep.id, mm.id, { disabled: !mm.disabled })}
                        title={mm.disabled ? 'Model disabled — click to enable' : 'Disable this model'}
                        aria-label="Toggle model disabled"
                        className={cn(
                          'shrink-0 rounded-lg p-1.5 transition-colors',
                          mm.disabled ? 'text-sell hover:bg-sell/10' : 'text-muted hover:bg-surface-hover hover:text-foreground',
                        )}
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeModel(ep.id, mm.id)}
                        className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-sell/10 hover:text-sell"
                        aria-label="Delete model"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
                <button
                  type="button"
                  onClick={() => addModel(ep.id)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-accent/40 hover:text-foreground"
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Add model
                </button>
              </div>

              {/* Disable whole server */}
              <div className="flex items-center gap-2.5 border-t border-border pt-3">
                <Toggle
                  label="Disable endpoint"
                  danger
                  checked={isDisabled}
                  onChange={() => updateEp(ep.id, { disabled: !isDisabled })}
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">Disable server (take out of rotation)</p>
                  <p className="text-[11px] leading-tight text-muted">
                    Treated as offline — every module selecting one of its models routes to their failover.
                  </p>
                </div>
              </div>
            </div>
          )
        })}

        <button
          type="button"
          onClick={addEp}
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
  const modelCount = endpoints.reduce((n, e) => n + e.models.length, 0)
  return (
    <Panel>
      <Row
        label="Endpoint catalog"
        hint={`Your reusable server URLs and the models they serve. ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}, ${modelCount} model${modelCount === 1 ? '' : 's'}.`}
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
        usage={modelId =>
          LLM_MODULES.flatMap(m =>
            settings[m.endpointKey] === modelId ? [m.label]
              : settings[m.fbEndpointKey] === modelId ? [`${m.label} (fallback)`]
              : [],
          )
        }
      />
    </Panel>
  )
}
