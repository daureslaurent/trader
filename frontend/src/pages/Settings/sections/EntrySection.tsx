import { Toggle } from '../../../components/ui/Toggle'
import { Input } from '../../../components/ui/Input'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

export function EntrySection({ settings, set, toggle }: SectionProps) {
  return (
    <Panel>
      <Row label="Smart entry timing" hint="When on, a BUY signal becomes a pending intent: the bot watches the live price and fills on a pullback (or in-band) instead of buying wherever price sits at the cron tick. Turn off to fill immediately (legacy behavior).">
        <Toggle label="Smart entry timing" checked={settings.entry_timing_enabled} onChange={() => toggle('entry_timing_enabled')} />
      </Row>

      {settings.entry_timing_enabled && (
        <>
          <Row
            label="Entry model"
            hint="Who decides the per-coin entry band. Static = the fixed levels below (no LLM). Entry Agent = a per-coin tool-calling agent that reasons about the best entry and adapts the band / fires / cancels as the market moves; the static levels below become the safe fallback. Configure its model under LLM Models → Entry Agent; watch it on the Entry Agent page."
          >
            <select
              value={settings.entry_model}
              onChange={e => set('entry_model', e.target.value as 'static' | 'agent')}
              className="w-full text-sm bg-surface-elevated border border-border rounded-xl px-2.5 py-2 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
            >
              <option value="static">Static (fixed levels)</option>
              <option value="agent">Entry Agent (agentic)</option>
            </select>
          </Row>

          {settings.entry_model === 'agent' && (
            <div className="flex items-start gap-2.5 rounded-xl border border-accent/25 bg-accent/5 px-3.5 py-3 text-xs text-muted leading-relaxed">
              <svg className="h-4 w-4 shrink-0 mt-0.5 text-accent" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                The <span className="font-medium text-foreground">Entry Agent</span> drives each deferred BUY — adjusting the band, firing, or cancelling per coin. The values below are the
                <span className="font-medium text-foreground"> fallback</span> band used at registration and whenever the agent errors. Each pass is shown on the Entry Agent page.
              </span>
            </div>
          )}

          {settings.entry_model === 'agent' && (
            <>
              <Row label="Re-evaluation cron" hint="How often the routing graph re-fires the Entry Agent to re-evaluate every active intent. The fast static gates still fire urgently between passes. A freshly deferred BUY also gets an immediate first pass.">
                <Input value={settings.entry_agent_cron} onChange={e => set('entry_agent_cron', e.target.value)} className="w-40 font-mono" placeholder="*/1 * * * *" />
              </Row>
              <Row label="Price history" hint="Candle timeframe and count fed to the Entry Agent as price-action context so it can anchor the band on recent structure. A shorter timeframe suits entry timing, since the band fires within minutes.">
                <div className="flex items-center gap-2">
                  <select
                    value={settings.entry_agent_candle_tf}
                    onChange={e => set('entry_agent_candle_tf', e.target.value)}
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
                    value={settings.entry_agent_candle_count}
                    onChange={e => set('entry_agent_candle_count', parseInt(e.target.value) || 24)}
                    className="w-28"
                  />
                </div>
              </Row>
              <Row label="Retain passes" hint="How many of the most recent Entry Agent run records to keep (older ones are pruned). These back the Entry Agent page's pass history.">
                <UnitInput type="number" step="10" min="10" max="2000" unit="runs" value={settings.entry_agent_retain_runs} onChange={e => set('entry_agent_retain_runs', parseInt(e.target.value) || 200)} />
              </Row>
            </>
          )}

          <Row
            label={settings.entry_model === 'agent' ? 'Pullback target (fallback)' : 'Pullback target'}
            hint={settings.entry_confirm_rebound
              ? 'Aim to buy this % below the signal price (the dip). With rebound confirmation on, reaching the target arms the intent — the actual buy waits for a bounce off the low.'
              : 'Aim to buy this % below the signal price (the dip). Fires as soon as price reaches the target.'}
          >
            <UnitInput type="number" step="0.1" min="0" max="10" unit="%" value={settings.entry_pullback_pct} onChange={e => set('entry_pullback_pct', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row
            label="Confirm rebound before buying"
            hint="Don't buy while price is still falling. When price reaches the target the intent arms and the engine tracks the running low (trailing it down as new lows print), buying only once price bounces back up off that low. The invalidate level below stays the give-up floor. Off = fill immediately at the target (legacy)."
          >
            <Toggle label="Confirm rebound before buying" checked={settings.entry_confirm_rebound} onChange={() => toggle('entry_confirm_rebound')} />
          </Row>
          {settings.entry_confirm_rebound && (
            <Row
              label="Rebound confirmation"
              hint="How far price must bounce off its tracked low to confirm the dip has stabilized and fire the buy. Smaller = quicker, more sensitive fills; larger = waits for a stronger bounce."
            >
              <UnitInput type="number" step="0.1" min="0.1" max="5" unit="%" value={settings.entry_rebound_pct} onChange={e => set('entry_rebound_pct', parseFloat(e.target.value) || 0)} />
            </Row>
          )}
          <Row
            label={settings.entry_model === 'agent' ? 'Invalidate / falling knife (fallback)' : 'Invalidate (falling knife)'}
            hint="Abandon the intent if price drops this % below the signal price before filling — likely a breakdown, not a dip."
          >
            <UnitInput type="number" step="0.5" min="0.5" max="50" unit="%" value={settings.entry_invalidate_pct} onChange={e => set('entry_invalidate_pct', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row
            label={settings.entry_model === 'agent' ? 'Chase cap (fallback)' : 'Chase cap'}
            hint="Abandon the intent if price runs this % above the signal price — the move got away; wait for the next cycle rather than chasing."
          >
            <UnitInput type="number" step="0.5" min="0.5" max="50" unit="%" value={settings.entry_max_chase_pct} onChange={e => set('entry_max_chase_pct', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row
            label={settings.entry_model === 'agent' ? 'Intent lifetime (fallback)' : 'Intent lifetime'}
            hint="How long to wait for a good entry before the intent expires."
          >
            <UnitInput type="number" step="1" min="1" max="240" unit="min" value={settings.entry_ttl_minutes} onChange={e => set('entry_ttl_minutes', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row
            label="Max intent lifetime"
            hint="Hard ceiling on an intent's TTL, applied to every source — static, Entry Agent, and manual edits. Any longer lifetime is clamped to this. Set 0 to disable the cap."
          >
            <UnitInput type="number" step="10" min="0" max="600" unit="min" value={settings.entry_max_ttl_minutes} onChange={e => set('entry_max_ttl_minutes', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row
            label="Max pullback depth"
            hint="Hard ceiling on how far below the live price the buy target may sit, applied to every source — static and Entry Agent. A deeper target is clamped to this (moved nearer to market) so an over-greedy entry can't park the target so low the pullback never plays out and the intent just expires. Set 0 to disable the cap."
          >
            <UnitInput type="number" step="0.1" min="0" max="10" unit="%" value={settings.entry_max_pullback_pct} onChange={e => set('entry_max_pullback_pct', parseFloat(e.target.value) || 0)} />
          </Row>
          <Row label="On expiry" hint="When the intent expires still in-band: fill at market so you don't keep missing valid setups, or cancel and wait for a fresh signal.">
            <select
              value={settings.entry_on_expiry}
              onChange={e => set('entry_on_expiry', e.target.value as 'market' | 'cancel')}
              className="w-full text-sm bg-surface-elevated border border-border rounded-xl px-2.5 py-2 text-foreground cursor-pointer hover:border-accent/50 focus:outline-none focus:border-accent transition-colors"
            >
              <option value="market">Fill at market</option>
              <option value="cancel">Cancel</option>
            </select>
          </Row>
          <Row label="Price check interval" hint="How often the engine re-checks the live price against pending intents.">
            <UnitInput type="number" step="1" min="1" max="60" unit="sec" value={settings.entry_poll_seconds} onChange={e => set('entry_poll_seconds', parseFloat(e.target.value) || 0)} />
          </Row>
        </>
      )}
    </Panel>
  )
}
