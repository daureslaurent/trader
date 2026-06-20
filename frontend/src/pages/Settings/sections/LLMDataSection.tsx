import { SectionProps } from '../types'
import { Panel, Row, UnitInput } from '../widgets'

export function LLMDataSection({ settings, set }: SectionProps) {
  return (
    <Panel>
      <Row
        label="Debug fetch limit"
        hint="Max LLM calls loaded in the LLM Stats and Debug pages. Higher values may slow the page."
      >
        <UnitInput
          type="number"
          step="50"
          min="50"
          max="2000"
          unit="calls"
          value={settings.llm_debug_fetch_limit}
          onChange={e => set('llm_debug_fetch_limit', parseInt(e.target.value) || 200)}
        />
      </Row>
      <Row
        label="Retain LLM data"
        hint="Delete raw LLM call records older than this many days, keeping aggregate stats. 0 = keep forever."
      >
        <UnitInput
          type="number"
          step="1"
          min="0"
          max="3650"
          unit="days"
          value={settings.llm_retain_days}
          onChange={e => set('llm_retain_days', parseInt(e.target.value) || 0)}
        />
      </Row>
    </Panel>
  )
}
