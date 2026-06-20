import { Toggle } from '../../../components/ui/Toggle'
import { SectionProps, ToggleKey } from '../types'
import { TELEGRAM_EVENTS } from '../constants'
import { Panel, Row } from '../widgets'

export function TelegramSection({ settings, toggle }: SectionProps) {
  return (
    <Panel>
      <Row
        label="Notifications"
        hint="Master switch for all outbound Telegram push notifications. Trade-approval prompts are always sent regardless — you reply to those to approve or reject a trade."
      >
        <Toggle
          label="Enable Telegram notifications"
          checked={settings.telegram_notify_enabled}
          onChange={() => toggle('telegram_notify_enabled')}
        />
      </Row>

      {settings.telegram_notify_enabled && TELEGRAM_EVENTS.map(ev => (
        <Row key={ev.key} label={ev.label} hint={ev.hint}>
          <Toggle
            label={ev.label}
            checked={settings[ev.key] as boolean}
            onChange={() => toggle(ev.key as ToggleKey)}
          />
        </Row>
      ))}
    </Panel>
  )
}
