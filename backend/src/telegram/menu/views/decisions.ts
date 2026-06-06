import { Markup } from 'telegraf'
import { queryAll } from '../../../db/index.js'
import { actionEmoji } from '../../components/formatting.js'

export async function render(ctx: any) {
  const decisions = queryAll('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 20') as any[]
  if (decisions.length === 0) {
    return { text: '🧠 LLM Decisions\n\nNo decisions yet.', buttons: [] }
  }

  const lines = ['🧠 Recent Decisions', '']
  for (const d of decisions) {
    const coin = (d.coin as string).replace('/USDC', '')
    const pct = (Number(d.confidence) * 100).toFixed(0)
    const reason = (d.reason as string).length > 60 ? (d.reason as string).slice(0, 57) + '...' : d.reason
    lines.push(`${actionEmoji(d.action as string)} ${coin} → ${d.action}  ${pct}% — ${reason}`)
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
