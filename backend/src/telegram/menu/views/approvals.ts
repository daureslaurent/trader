import { Markup } from 'telegraf'
import { trades, decisions as decisionsRepo } from '../../../db/index.js'
import { formatCurrency, confidenceBar, esc } from '../../components/formatting.js'

export async function render(_ctx: any) {
  const pending = await trades.find({ status: 'PENDING' }, { sort: { created_at: 1 } }) as any[]
  if (pending.length === 0) {
    return { text: '✅ <b>Pending Approvals</b>\n\nNo pending approvals.', buttons: [] }
  }

  const lines = [`⚠️ <b>Pending Approvals</b> (${pending.length})`, '']
  const buttons: ReturnType<typeof Markup.button.callback>[][] = []

  for (const t of pending) {
    // Fetch latest decision for this coin to get reason + confidence
    const decision = await decisionsRepo.findOne(
      { coin: t.coin },
      { sort: { created_at: -1 }, projection: { confidence: 1, reason: 1 } },
    ) as { confidence: number; reason: string } | null

    const coin = esc((t.coin as string).replace('/USDC', ''))
    const sideEmoji = t.side === 'BUY' ? '🟢' : '🔴'
    const total = formatCurrency(Number(t.total))

    lines.push(`${sideEmoji} <b>${t.side}</b> ${t.quantity} ${coin}  ·  ${total}`)

    if (decision) {
      const confidence = Number(decision.confidence)
      const bar = confidenceBar(confidence)
      const pct = (confidence * 100).toFixed(0)
      const reason = String(decision.reason).length > 80
        ? String(decision.reason).slice(0, 77) + '...'
        : String(decision.reason)
      lines.push(`  <code>${bar}</code> ${pct}%`)
      lines.push(`  <i>${esc(reason)}</i>`)
    }

    lines.push('')

    buttons.push([
      Markup.button.callback(`✅ Approve #${t.id}`, `approve:${t.id}`),
      Markup.button.callback(`❌ Reject #${t.id}`, `reject:${t.id}`),
    ])
  }

  return { text: lines.join('\n').trimEnd(), buttons }
}
