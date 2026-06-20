import { Toggle } from '../../../components/ui/Toggle'
import { cn } from '../../../lib/utils'
import { SectionProps } from '../types'
import { HORIZONS, HORIZON_COLORS } from '../constants'
import { Panel, Row, UnitInput, WatchlistEditor, CronEditor } from '../widgets'

export function TradingSection({ settings, set, toggle }: SectionProps) {
  return (
    <Panel>
      <Row
        stacked
        label="Trading horizon"
        hint="Trade thesis for new positions — sets stop-loss / take-profit sizing and how aggressively the monitor manages the position. Auto: sized purely off ATR. LLM: the analyst picks short/medium/long per trade. Short/Medium/Long: forced on every trade. The horizon stays editable per position afterward."
      >
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {HORIZONS.map(({ id, label, hint }) => {
            const active = settings.default_horizon === id
            const colors = HORIZON_COLORS[id]
            return (
              <button
                key={id}
                type="button"
                onClick={() => set('default_horizon', id)}
                className={cn(
                  'flex flex-col items-center gap-1 px-3 py-3 rounded-xl border text-sm font-semibold transition-all duration-150',
                  active ? colors.active : colors.idle,
                )}
              >
                {label}
                <span className="text-[10px] font-normal opacity-70">{hint}</span>
              </button>
            )
          })}
        </div>
      </Row>

      <Row stacked label="Watchlist" hint="Coins the pipeline researches and trades. Press Enter or comma to add.">
        <WatchlistEditor value={settings.watchlist} onChange={v => set('watchlist', v)} />
      </Row>

      <Row stacked label="Pipeline schedule" hint="How often the research → analysis → trade pipeline runs.">
        <CronEditor value={settings.pipeline_cron} onChange={v => set('pipeline_cron', v)} />
      </Row>

      <Row
        stacked
        label="Entry signal engine"
        hint="What produces the BUY/HOLD signal for watchlist coins on each pipeline tick. Classic: the research → extractor → analyst pipeline. Agent Signal: one agentic, single-coin tool-calling agent per coin that keeps long-term per-coin memory and a thesis (see the Agent Signal page). Mutually exclusive."
      >
        <div className="grid grid-cols-2 gap-2">
          {([
            { id: 'classic', label: 'Classic pipeline', hint: 'Research → extractor → analyst' },
            { id: 'agent', label: 'Agent Signal', hint: 'One tool-calling agent per coin' },
          ] as const).map(({ id, label, hint }) => {
            const active = settings.signal_model === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => set('signal_model', id)}
                className={cn(
                  'flex flex-col items-center gap-1 px-3 py-3 rounded-xl border text-sm font-semibold transition-all duration-150',
                  active ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface-elevated text-muted hover:border-accent/50',
                )}
              >
                {label}
                <span className="text-[10px] font-normal opacity-70">{hint}</span>
              </button>
            )
          })}
        </div>
      </Row>

      {settings.signal_model === 'agent' && (
        <>
          <Row label="Skip held coins" hint="When on, Agent Signal skips coins already held in the portfolio (the monitor manages them) and coins already on the Entry Desk. Turn off to run an agent on every watchlist coin regardless of holdings.">
            <Toggle label="Skip held coins" checked={settings.agent_signal_check_portfolio} onChange={() => toggle('agent_signal_check_portfolio')} />
          </Row>
          <Row label="Run history retained" hint="How many of the most recent Agent Signal run records (per coin per cycle) to keep for the Agent Signal page. Older runs are pruned after each cycle.">
            <UnitInput type="number" step="10" min="10" max="2000" unit="runs" value={settings.agent_signal_retain_runs} onChange={e => set('agent_signal_retain_runs', parseInt(e.target.value) || 200)} />
          </Row>
        </>
      )}

      <Row label="Analyst price history" hint="Candle timeframe and count fed to the analyst (BUY/SELL/HOLD) prompt as price-action context alongside the indicators. Set count to 0 to omit the table.">
        <div className="flex items-center gap-2">
          <select
            value={settings.analyst_candle_tf}
            onChange={e => set('analyst_candle_tf', e.target.value)}
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
            min="0"
            max="100"
            unit="candles"
            value={settings.analyst_candle_count}
            onChange={e => set('analyst_candle_count', parseInt(e.target.value) || 0)}
            className="w-28"
          />
        </div>
      </Row>

      <Row
        label="UTC offset"
        hint="Applied to all timestamps in the monitor prompt — e.g. 5 for UTC+5, -3 for UTC-3, 5.5 for UTC+5:30"
      >
        <UnitInput
          type="number"
          step="0.5"
          min="-12"
          max="14"
          unit="hrs"
          value={settings.utc_offset_hours}
          onChange={e => set('utc_offset_hours', parseFloat(e.target.value) || 0)}
        />
      </Row>

      <Row label="Article cache TTL" hint="Hours before a cached article extraction expires">
        <UnitInput type="number" step="1" min="1" max="168" unit="hrs" value={settings.cache_ttl_hours} onChange={e => set('cache_ttl_hours', parseInt(e.target.value) || 13)} />
      </Row>

      <Row label="Require approval" hint="Pause for human approval before executing trades">
        <Toggle label="Require approval" checked={settings.approval_required} onChange={() => toggle('approval_required')} />
      </Row>

      <Row label="Binance read-only" hint="Safety lock: block all trades and OCO changes — only reads hit Binance. On by default.">
        <Toggle label="Binance read-only" checked={settings.binance_read_only} onChange={() => toggle('binance_read_only')} />
      </Row>
    </Panel>
  )
}
