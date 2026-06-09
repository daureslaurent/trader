import { Markup } from 'telegraf'
import { getSettings } from '../../../db/index.js'

export async function render(_ctx: any) {
  const s = getSettings()

  const watchlist = s.watchlist.map(c => c.replace('/USDC', '')).join(', ') || '(empty)'

  const lines = [
    '⚙️ <b>Settings</b>',
    '',
    `📋 Watchlist: <code>${watchlist}</code>`,
    `⏱️ Pipeline Cron: <code>${s.pipeline_cron}</code>`,
    `🎯 Min Confidence: <b>${(s.min_confidence * 100).toFixed(0)}%</b>`,
    `💰 Max Position: <b>$${s.max_position_size_usd}</b>`,
    `✅ Approval Required: <b>${s.approval_required ? 'Yes' : 'No'}</b>`,
    `🛑 Stop Loss ATR: <b>${s.stop_loss_atr.toFixed(1)}×</b>`,
    `🎯 Take Profit ATR: <b>${s.take_profit_atr.toFixed(1)}×</b>`,
    `⚠️ Max Risk/Trade: <b>${(s.max_risk_per_trade * 100).toFixed(0)}%</b>`,
    `📊 Max Positions: <b>${s.max_open_positions}</b>`,
  ]

  const buttons = [
    [
      Markup.button.callback('📋 Watchlist', 'setting:edit:watchlist'),
      Markup.button.callback(s.approval_required ? '✅ Approval ON' : '❌ Approval OFF', 'setting:toggle:approval_required'),
    ],
    [
      Markup.button.callback('⏱️ Cron', 'setting:edit:pipeline_cron'),
      Markup.button.callback('🎯 Min Confidence', 'setting:edit:min_confidence'),
    ],
    [
      Markup.button.callback('💰 Max Position', 'setting:edit:max_position_size_usd'),
      Markup.button.callback('⚠️ Max Risk', 'setting:edit:max_risk_per_trade'),
    ],
    [
      Markup.button.callback('🛑 Stop Loss', 'setting:edit:stop_loss_atr'),
      Markup.button.callback('🎯 Take Profit', 'setting:edit:take_profit_atr'),
    ],
    [
      Markup.button.callback('📊 Max Positions', 'setting:edit:max_open_positions'),
    ],
  ]

  return { text: lines.join('\n'), buttons }
}
