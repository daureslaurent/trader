import { Markup } from 'telegraf'
import { getSettings } from '../../db/index.js'

export async function render(ctx: any) {
  const settings = getSettings()
  const lines = ['⚙️ Settings', '']
  lines.push(`Watchlist: ${settings.watchlist.join(', ') || '(empty)'}`)
  lines.push(`Interval: ${settings.interval_minutes} min`)
  lines.push(`Min Confidence: ${(settings.min_confidence * 100).toFixed(0)}%`)
  lines.push(`Max Position: $${settings.max_position_size_usd}`)
  lines.push(`${settings.approval_required ? '✅' : '❌'} Approval Required`)
  lines.push(`Stop Loss ATR: ${settings.stop_loss_atr.toFixed(1)}`)
  lines.push(`Take Profit ATR: ${settings.take_profit_atr.toFixed(1)}`)
  lines.push(`Max Risk: ${(settings.max_risk_per_trade * 100).toFixed(0)}%`)
  lines.push(`Max Positions: ${settings.max_open_positions}`)

  const editButtons = [
    Markup.button.callback('✏️ Edit Watchlist', 'setting:edit:watchlist'),
    Markup.button.callback('✏️ Toggle Approval', 'setting:toggle:approval_required'),
    Markup.button.callback('✏️ Edit Interval', 'setting:edit:interval_minutes'),
  ]

  return {
    text: lines.join('\n'),
    buttons: [editButtons],
  }
}
