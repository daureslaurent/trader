import { Toggle } from '../../../components/ui/Toggle'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

export function SystemSection({ settings, set, toggle }: SectionProps) {
  return (
    <Panel>
      <Row
        label="Force offline mode"
        hint="When on, the bot never calls an LLM: the Analyst, Monitor and Discoverer run deterministic technical-analysis rules instead, and Summary + the conversational Agent are disabled. All trade mechanics (sizing, ATR SL/TP, gates, OCO, exits) are unchanged. Use this to run fully rule-based even when endpoints are up."
      >
        <Toggle
          label="Force offline mode"
          checked={settings.offline_mode_forced}
          onChange={() => toggle('offline_mode_forced')}
        />
      </Row>
      <Row
        label="Auto offline fallback"
        hint="When on (default), the bot automatically switches to offline (rule-based) mode whenever every configured LLM endpoint is unreachable, and returns to LLM mode once one recovers. The manual force toggle always wins."
      >
        <Toggle
          label="Auto offline fallback"
          checked={settings.offline_auto}
          onChange={() => toggle('offline_auto')}
        />
      </Row>
      <Row
        label="Reuse recent LLM data within"
        hint="While offline, the rules analyst may blend the most recent LLM analyst decision / cached article sentiment for a coin as a confidence tilt when it is younger than this. Older data is ignored (pure technical analysis). Set 0 to never reuse."
      >
        <UnitInput
          type="number"
          step="5"
          min="0"
          max="1440"
          unit="min"
          value={settings.offline_reuse_max_age_min}
          onChange={e => set('offline_reuse_max_age_min', parseInt(e.target.value, 10) || 0)}
        />
      </Row>
      <Row
        label="Enable app updates"
        hint="Turn on the in-app host actions: periodic checks for new commits on main (driving the System page pin), the one-click rebuild, and the Reboot button. Requires the host watcher (tools/updater/install-updater.sh). Off by default so the rebuild can't be triggered by accident."
      >
        <Toggle
          label="Enable app updates"
          checked={settings.update_enabled}
          onChange={() => toggle('update_enabled')}
        />
      </Row>
      <Row
        label="Check for updates every"
        hint="How often to ask the host whether origin/main is ahead. A pin appears on the System entry in the sidebar when an update is available."
      >
        <UnitInput
          type="number"
          step="0.5"
          min="0.25"
          max="168"
          unit="hrs"
          value={settings.update_check_interval_hours}
          onChange={e => set('update_check_interval_hours', parseFloat(e.target.value) || 1)}
        />
      </Row>
      <div className="flex items-start gap-2 py-4 text-[11px] text-muted">
        <svg className="mt-px h-3.5 w-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
        </svg>
        <span>The version status, commits-ahead list and the <span className="text-foreground font-medium">Update app</span> / <span className="text-foreground font-medium">Reboot</span> actions live on the <span className="text-foreground font-medium">System</span> page.</span>
      </div>
    </Panel>
  )
}
