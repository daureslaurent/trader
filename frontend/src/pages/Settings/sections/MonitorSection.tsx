import { Toggle } from '../../../components/ui/Toggle'
import { Input } from '../../../components/ui/Input'
import { cn } from '../../../lib/utils'
import { SectionProps, SettingsData } from '../types'
import { HORIZON_COLORS } from '../constants'
import { Panel, Row, UnitInput, CronEditor } from '../widgets'

export function MonitorSection({ settings, set, toggle }: SectionProps) {
  return (
    <Panel>
      <Row
        stacked
        label="Engine"
        hint="Open positions are reviewed by the Agent Monitor — a tool-calling agent that investigates each position before committing to a Hold / Adjust / Close verdict. Configure its model under LLM Models → “Agent Monitor”, and watch it work live on the Agent Monitor page."
      >
        <div className="px-3.5 py-3 rounded-xl border border-accent/40 bg-accent/10">
          <div className="flex items-center gap-2.5">
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/20 text-accent shrink-0">
              Agent Monitor
            </span>
            <span className="text-sm font-medium text-foreground">Agentic per-position review</span>
          </div>
        </div>
      </Row>

      <Row label="One position at a time" hint="Review positions sequentially (one full agent loop completes before the next starts). Disable to review all open positions concurrently.">
        <Toggle label="Sequential review" checked={settings.monitor_sequential} onChange={() => toggle('monitor_sequential')} />
      </Row>
      <Row label="Run history kept" hint="How many recent per-position run records (verdict + transcript) to keep for the Agent Monitor page. Older runs are pruned after each cycle.">
        <UnitInput type="number" step="10" min="10" max="2000" unit="runs" value={settings.monitor_retain_runs} onChange={e => set('monitor_retain_runs', parseInt(e.target.value) || 200)} />
      </Row>

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
