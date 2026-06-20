import { Toggle } from '../../../components/ui/Toggle'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

export function SystemSection({ settings, set, toggle }: SectionProps) {
  return (
    <Panel>
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
