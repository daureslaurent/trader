import { Toggle } from '../../../components/ui/Toggle'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput, CronEditor } from '../widgets'

export function CoachSection({ settings, set, toggle }: SectionProps) {
  return (
    <Panel>
      <Row label="Auto-run" hint="Periodically run the Coach Agent: one agentic pass audits how the other agents (Analyst, Agent Signal, Entry Agent, Monitor) have been deciding, then writes corrections into their memory so they self-correct. Read-only on trading. Configure the model in the LLM Models section.">
        <Toggle label="Auto-run coach" checked={settings.coach_auto_run} onChange={() => toggle('coach_auto_run')} />
      </Row>

      {settings.coach_auto_run && (
        <Row stacked label="Audit schedule" hint="How often the Coach audit runs. Daily is a sensible default — the track record changes slowly and frequent runs add little.">
          <CronEditor value={settings.coach_cron} onChange={v => set('coach_cron', v)} />
        </Row>
      )}

      <Row label="Minimum closed trades" hint="The Coach skips an audit until at least this many positions have closed — too small a sample and any 'correction' just chases noise. Raise it to be more conservative.">
        <UnitInput
          type="number"
          step="1"
          min="0"
          max="500"
          unit="trades"
          value={settings.coach_min_trades}
          onChange={e => set('coach_min_trades', parseInt(e.target.value) || 0)}
        />
      </Row>

      <Row label="Retain audits" hint="How many of the most recent Coach audit records to keep (older ones are pruned). These back the Coach Agent page history.">
        <UnitInput
          type="number"
          step="10"
          min="10"
          max="1000"
          unit="runs"
          value={settings.coach_retain_runs}
          onChange={e => set('coach_retain_runs', parseInt(e.target.value) || 100)}
        />
      </Row>
    </Panel>
  )
}
