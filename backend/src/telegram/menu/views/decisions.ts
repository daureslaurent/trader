import { Markup } from 'telegraf'
import { queryAll } from '../../../db/index.js'
import { actionEmoji, confidenceBar, esc, formatDate } from '../../components/formatting.js'

export async function render(_ctx: any) {
  const decisions = queryAll('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 15') as any[]
  if (decisions.length === 0) {
    return { text: '🧠 <b>LLM Decisions</b>\n\nNo decisions yet.', buttons: [] }
  }

  const lines = ['🧠 <b>LLM Decisions</b>', '']

  for (const d of decisions) {
    const coin = esc((d.coin as string).replace('/USDC', ''))
    const confidence = Number(d.confidence)
    const pct = (confidence * 100).toFixed(0)
    const bar = confidenceBar(confidence)
    const reason = (d.reason as string).length > 80
      ? (d.reason as string).slice(0, 77) + '...'
      : (d.reason as string)
    const date = formatDate(d.created_at as string)

    lines.push(
      `${actionEmoji(d.action as string)} <b>${coin}</b> → <b>${d.action}</b>  ${pct}%`,
      `  <code>${bar}</code>`,
      `  <i>${esc(reason)}</i>`,
      `  <i>${date}</i>`,
      ''
    )
  }

  return {
    text: lines.join('\n').trimEnd(),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
