import { Toggle } from '../../../components/ui/Toggle'
import { SectionProps } from '../types'
import { Panel, Row, UnitInput, CronEditor } from '../widgets'

export function SummarySection({ settings, set, toggle }: SectionProps) {
  return (
    <Panel>
      <Row label="Auto-run" hint="Periodically generate a portfolio summary (narrative + health/risk read + suggestions) from your holdings and live Binance market data. Configure the model in the LLM Models section.">
        <Toggle label="Auto-run summary" checked={settings.summary_auto_run} onChange={() => toggle('summary_auto_run')} />
      </Row>

      {settings.summary_auto_run && (
        <Row stacked label="Summary schedule" hint="How often the portfolio summary is generated.">
          <CronEditor value={settings.summary_cron} onChange={v => set('summary_cron', v)} />
        </Row>
      )}

      <Row label="Retain summaries" hint="Delete portfolio summaries older than this many days. 0 = keep forever.">
        <UnitInput
          type="number"
          step="1"
          min="0"
          max="3650"
          unit="days"
          value={settings.summary_retain_days}
          onChange={e => set('summary_retain_days', parseInt(e.target.value) || 0)}
        />
      </Row>
    </Panel>
  )
}
