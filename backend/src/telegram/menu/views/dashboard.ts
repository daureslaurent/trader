import { Markup } from 'telegraf'
import { queryAll, queryOne } from '../../db/index.js'
import { formatCurrency } from '../../components/formatting.js'

export async function render(ctx: any) {
  const snap = queryOne('SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any
  const tradesToday = queryAll("SELECT COUNT(*) as count FROM trades WHERE date(created_at) = date('now')") as any
  const pendingCount = queryAll("SELECT COUNT(*) as count FROM trades WHERE status = 'PENDING'") as any
  const openPos = queryAll("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'") as any
  const maxRow = queryOne('SELECT value FROM settings WHERE key = ?', ['max_open_positions']) as any

  const totalValue = snap ? Number(snap.total_value_usd) : 0
  const openCount = (openPos?.[0] as any)?.count ?? 0
  const maxOpen = maxRow ? parseInt(maxRow.value as string) : 5
  const tradesCount = (tradesToday?.[0] as any)?.count ?? 0
  const pending = (pendingCount?.[0] as any)?.count ?? 0

  const lines = [
    '📊 Dashboard',
    '━━━━━━━━━━━━━━━━━━',
    `💰 Portfolio: ${formatCurrency(totalValue)}`,
    `📈 Open Positions: ${openCount} / ${maxOpen}`,
    `🔄 Trades Today: ${tradesCount}`,
    `⏳ Pending Approvals: ${pending}`,
  ]

  const hits = queryAll(
    "SELECT coin, status, created_at FROM positions WHERE status IN ('SL_HIT','TP_HIT') ORDER BY created_at DESC LIMIT 5"
  ) as any[]
  if (hits.length > 0) {
    lines.push('')
    for (const h of hits) {
      const icon = h.status === 'SL_HIT' ? '🛑' : '✅'
      lines.push(`${icon} ${h.coin} — ${h.status === 'SL_HIT' ? 'Stop Loss' : 'Take Profit'}`)
    }
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
