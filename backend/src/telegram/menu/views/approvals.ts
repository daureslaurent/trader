import { Markup } from 'telegraf'
import { queryAll } from '../../../db/index.js'
import { formatCurrency } from '../../components/formatting.js'

export async function render(ctx: any) {
  const pending = queryAll("SELECT * FROM trades WHERE status = 'PENDING' ORDER BY created_at ASC") as any[]
  if (pending.length === 0) {
    return { text: '✅ Pending Approvals\n\nNo pending approvals.', buttons: [] }
  }

  const lines = [`✅ Pending Approvals (${pending.length})`, '']
  const buttons: ReturnType<typeof Markup.button.callback>[][] = []

  for (const t of pending) {
    lines.push(
      `⚠️ ${t.side} ${t.quantity} ${t.coin} — ${formatCurrency(Number(t.total))}`,
      `Confidence: ${t.confidence || 'N/A'}`,
      ``
    )
    buttons.push([
      Markup.button.callback(`✅ Approve #${t.id}`, `approve:${t.id}`),
      Markup.button.callback(`❌ Reject #${t.id}`, `reject:${t.id}`),
    ])
  }

  return { text: lines.join('\n'), buttons }
}
