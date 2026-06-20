import { Toggle } from '../../../components/ui/Toggle'
import { Input } from '../../../components/ui/Input'
import { cn } from '../../../lib/utils'
import { MonitorModelsResponse } from '../../../types'
import { SectionProps, SettingsData } from '../types'
import { HORIZON_COLORS } from '../constants'
import { Panel, Row, UnitInput, CronEditor } from '../widgets'

export function MonitorSection({ settings, set, toggle, monitorModels }: SectionProps & {
  monitorModels: MonitorModelsResponse | null
}) {
  return (
    <Panel>
      <Row
        stacked
        label="Monitor model"
        hint="Which LLM(s) review open positions. Configure each slot (model, endpoint, max tokens) in the LLM Models section. Single modes run one model; Alternate flips A/B each cycle; A+B runs both and keeps the higher-confidence verdict; A+B+C adds model C to synthesize the final decision from A and B."
      >
        {(() => {
          const mode = settings.monitor_model
          // Role of a slot under the current mode → drives its highlight + badge.
          const slotRole = (slot: 'a' | 'b' | 'c'): { active: boolean; badge: string } => {
            if (slot === 'c') return { active: mode === 'abc', badge: 'Synthesizer' }
            if (mode === slot) return { active: true, badge: 'Active' }
            if (mode === 'alternate') return { active: true, badge: 'In rotation' }
            if (mode === 'ab' || mode === 'abc') return { active: true, badge: 'Voter' }
            return { active: false, badge: '' }
          }
          // A/B are clickable (selects that single-model mode); C is informational.
          const renderSlot = (slot: 'a' | 'b' | 'c') => {
            const info = monitorModels?.[slot]
            const { active, badge } = slotRole(slot)
            const selectable = slot !== 'c'
            return (
              <button
                key={slot}
                type="button"
                disabled={!selectable}
                onClick={selectable ? () => set('monitor_model', slot) : undefined}
                className={cn(
                  'flex flex-col items-start gap-1.5 px-3.5 py-3 rounded-xl border text-left transition-all duration-150',
                  active ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20' : 'border-border',
                  selectable && !active && 'hover:border-foreground/20',
                  !selectable && 'cursor-default',
                )}
              >
                <div className="flex items-center justify-between gap-2 w-full">
                  <span className={cn(
                    'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded',
                    active ? 'bg-accent/20 text-accent' : 'bg-surface-elevated text-muted',
                  )}>
                    {`Slot ${slot.toUpperCase()}`}
                  </span>
                  {active && badge && (
                    <span className="text-[10px] font-semibold text-accent shrink-0">{badge}</span>
                  )}
                </div>
                <span className={cn(
                  'text-sm font-medium font-mono truncate w-full',
                  active ? 'text-foreground' : 'text-muted',
                )}>
                  {info?.model ?? '—'}
                </span>
                {info?.baseURL && (
                  <span className="text-[10px] text-muted truncate w-full" title={info.baseURL}>{info.baseURL}</span>
                )}
              </button>
            )
          }
          const modePills: { key: 'alternate' | 'ab' | 'abc' | 'd'; badge: string; title: string; sub: string }[] = [
            { key: 'alternate', badge: 'Alternate', title: 'A ⇄ B each cycle', sub: 'one model per run, flips on the next' },
            { key: 'ab', badge: 'A + B', title: 'Both run · higher-confidence wins', sub: 'A and B review every position; the more confident verdict is kept' },
            { key: 'abc', badge: 'A + B + C', title: 'C synthesizes A + B', sub: 'A and B vote, then C weighs both and writes the final call' },
            { key: 'd', badge: 'Agent D', title: 'Agentic per-position monitor', sub: 'a tool-calling agent investigates each position (configure its model under LLM Models → “Agent D”) — watch it live on the Agent Monitor page' },
          ]
          return (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {renderSlot('a')}
                {renderSlot('b')}
              </div>
              {mode === 'abc' && (
                <div className="mt-2">{renderSlot('c')}</div>
              )}
              <div className="mt-2 flex flex-col gap-2">
                {modePills.map(p => {
                  const on = mode === p.key
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => set('monitor_model', p.key)}
                      className={cn(
                        'flex items-center justify-between gap-2 w-full px-3.5 py-3 rounded-xl border text-left transition-all duration-150',
                        on ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20' : 'border-border hover:border-foreground/20',
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={cn(
                          'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
                          on ? 'bg-accent/20 text-accent' : 'bg-surface-elevated text-muted',
                        )}>
                          {p.badge}
                        </span>
                        <span className="text-sm font-medium text-foreground shrink-0">{p.title}</span>
                        <span className="text-[10px] text-muted hidden md:inline truncate">{p.sub}</span>
                      </div>
                      {on && (
                        <svg className="w-3.5 h-3.5 text-accent shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </div>
            </>
          )
        })()}
      </Row>

      {settings.monitor_model === 'd' && (
        <>
          <Row label="One position at a time" hint="Type D only: review positions sequentially (one full agent loop completes before the next starts). Disable to review all open positions concurrently.">
            <Toggle label="Sequential review" checked={settings.monitor_d_sequential} onChange={() => toggle('monitor_d_sequential')} />
          </Row>
          <Row label="Run history kept" hint="Type D only: how many recent per-position run records (verdict + transcript) to keep for the Agent Monitor page. Older runs are pruned after each cycle.">
            <UnitInput type="number" step="10" min="10" max="2000" unit="runs" value={settings.monitor_d_retain_runs} onChange={e => set('monitor_d_retain_runs', parseInt(e.target.value) || 200)} />
          </Row>
        </>
      )}

      <Row label="Auto-run" hint="Periodically run the monitor to check positions">
        <Toggle label="Auto-run monitor" checked={settings.monitor_auto_run} onChange={() => toggle('monitor_auto_run')} />
      </Row>

      {settings.monitor_auto_run && (
        <Row stacked label="Monitor schedule" hint="How often the monitor reviews open positions.">
          <CronEditor value={settings.monitor_cron} onChange={v => set('monitor_cron', v)} />
        </Row>
      )}

      <Row label="Adapt SL/TP" hint="Let the monitor LLM tighten stops / adjust take-profit on open positions (risk-checked)">
        <Toggle label="Adapt SL/TP" checked={settings.monitor_adjust_sltp} onChange={() => toggle('monitor_adjust_sltp')} />
      </Row>

      {settings.monitor_adjust_sltp && (
        <Row label="Auto-approve adjustments" hint="Apply SL/TP changes immediately without waiting for manual approval, even when approval mode is on">
          <Toggle label="Auto-approve adjustments" checked={settings.monitor_auto_approve} onChange={() => toggle('monitor_auto_approve')} />
        </Row>
      )}

      {settings.monitor_adjust_sltp && (
        <Row label="Trust LLM SL/TP" hint="Bypass risk validation — apply the monitor LLM's SL/TP values directly (only SL < price / TP > price enforced). Use with care: loosening stops is allowed.">
          <Toggle danger label="Trust LLM SL/TP" checked={settings.monitor_trust_llm_sltp} onChange={() => toggle('monitor_trust_llm_sltp')} />
        </Row>
      )}

      <Row label="Horizon guidance" hint="Inject per-horizon behavior rules and SL/TP targets into the monitor prompt. Disable to let the LLM decide freely.">
        <Toggle label="Horizon guidance" checked={settings.monitor_use_horizon} onChange={() => toggle('monitor_use_horizon')} />
      </Row>

      <Row label="Price history" hint="Candle timeframe and number of candles included in the monitor LLM prompt as market context.">
        <div className="flex items-center gap-2">
          <select
            value={settings.monitor_history_tf}
            onChange={e => set('monitor_history_tf', e.target.value)}
            className="text-sm bg-surface-elevated border border-border rounded-xl px-2.5 py-2 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
          >
            {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
          <span className="text-xs text-muted">×</span>
          <UnitInput
            type="number"
            step="1"
            min="1"
            max="100"
            unit="candles"
            value={settings.monitor_history_count}
            onChange={e => set('monitor_history_count', parseInt(e.target.value) || 24)}
            className="w-28"
          />
        </div>
      </Row>

      <Row label="Min confidence to sell" hint="Minimum LLM confidence (0–1) required to execute a monitor CLOSE. Lower-confidence proposals are recorded as HOLD instead.">
        <Input
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={settings.monitor_min_confidence}
          onChange={e => set('monitor_min_confidence', parseFloat(e.target.value) || 0)}
        />
      </Row>

      <Row label="Protect winners" hint="Downgrade a monitor CLOSE to HOLD when the position is in profit, its stop is not threatened (price far enough above the SL — see ATR buffer), and the trend is still up — unless the model itself flags the thesis invalidated or a risk-off regime. Stops the engine from exiting healthy winners on a thin reward:risk reading alone.">
        <Toggle label="Keep healthy winners" checked={settings.monitor_protect_winners} onChange={() => toggle('monitor_protect_winners')} />
      </Row>

      {settings.monitor_protect_winners && (
        <Row label="Protect-winners stop buffer" hint="A CLOSE is only protected while the current price sits at least this many ATR(14) multiples above the stop-loss (i.e. the stop is not imminent). Higher = protects more aggressively; with no stop set or no ATR the guard stays off.">
          <UnitInput
            type="number"
            step="0.25"
            min="0"
            max="10"
            unit="×ATR"
            value={settings.monitor_protect_winners_atr}
            onChange={e => set('monitor_protect_winners_atr', parseFloat(e.target.value) || 0)}
          />
        </Row>
      )}

      <Row label="Break-even trigger" hint="Once a position's P&L passes this %, the monitor LLM must move the stop-loss to break-even or better (profit protection). Below it, break-even stops are rejected by the engine. Used when horizon guidance is off or the position has the LLM horizon; with horizon guidance on, the trigger is half the horizon's TP target.">
        <UnitInput
          type="number"
          step="0.5"
          min="0.5"
          max="50"
          unit="%"
          value={settings.monitor_breakeven_pct}
          onChange={e => set('monitor_breakeven_pct', parseFloat(e.target.value) || 0)}
        />
      </Row>

      {settings.monitor_adjust_sltp && (
        <Row label="Adjustment cooldown" hint="Minimum minutes between applied SL/TP adjustments per position (halved for short horizon, doubled for long). Prevents the monitor from re-trailing the stop every review. 0 disables.">
          <UnitInput
            type="number"
            step="5"
            min="0"
            max="1440"
            unit="min"
            value={settings.monitor_adjust_cooldown_min}
            onChange={e => set('monitor_adjust_cooldown_min', parseFloat(e.target.value) || 0)}
          />
        </Row>
      )}

      {settings.monitor_use_horizon && (
        <Row
          stacked
          label="Horizon SL/TP targets"
          hint="Stop-loss and take-profit percentages from entry price the monitor LLM uses as guidance per investment horizon."
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(['short', 'medium', 'long'] as const).map(h => {
              const slKey = `monitor_sl_pct_${h}` as keyof SettingsData
              const tpKey = `monitor_tp_pct_${h}` as keyof SettingsData
              return (
                <div key={h} className="bg-surface-elevated border border-border rounded-xl p-3.5 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-1.5 w-1.5 rounded-full', HORIZON_COLORS[h].dot)} />
                    <p className={cn(
                      'text-xs font-semibold uppercase tracking-wide',
                      h === 'short' ? 'text-sell' : h === 'medium' ? 'text-accent' : 'text-buy',
                    )}>
                      {h}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-muted mb-1.5 block">Stop loss</label>
                    <UnitInput
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="50"
                      unit="%"
                      value={settings[slKey] as number}
                      onChange={e => set(slKey, parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted mb-1.5 block">Take profit</label>
                    <UnitInput
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="200"
                      unit="%"
                      value={settings[tpKey] as number}
                      onChange={e => set(tpKey, parseFloat(e.target.value) || 0)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </Row>
      )}
    </Panel>
  )
}
