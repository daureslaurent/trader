import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

export function ChartSection({ settings, set }: SectionProps) {
  return (
    <Panel>
      <Row
        label="Candle window"
        hint="Number of candles the chart loads. This sets the visible time span, so a larger value keeps signal / trade / monitor markers on screen further back in time (the actual span depends on the selected timeframe). Default 150."
      >
        <UnitInput
          type="number"
          step="10"
          min="10"
          max="1000"
          unit="candles"
          value={settings.chart_candle_limit}
          onChange={e => set('chart_candle_limit', parseInt(e.target.value) || 150)}
        />
      </Row>
      <Row
        label="Marker history depth"
        hint="Max number of analyst signals and monitor reviews the chart fetches per coin. Higher keeps more markers available within the candle window, independent of the global activity feed. Default 200."
      >
        <UnitInput
          type="number"
          step="10"
          min="10"
          max="1000"
          unit="marks"
          value={settings.chart_marker_limit}
          onChange={e => set('chart_marker_limit', parseInt(e.target.value) || 200)}
        />
      </Row>
      <Row
        label="Monitor review retention"
        hint="How many monitor cycles of position-review history to keep in the database. Older cycles are pruned after each run, so this caps how far back the diamond monitor markers can appear. Default 20."
      >
        <UnitInput
          type="number"
          step="1"
          min="1"
          max="500"
          unit="cycles"
          value={settings.monitor_review_retain_cycles}
          onChange={e => set('monitor_review_retain_cycles', parseInt(e.target.value) || 20)}
        />
      </Row>
    </Panel>
  )
}
