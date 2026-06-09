import { Markup } from 'telegraf'
import { queryAll, queryOne } from '../../../db/index.js'
import { formatCurrency, formatDate, code } from '../../components/formatting.js'

export async function render(_ctx: any) {
  const snap = queryOne('SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any
  const prev = queryOne('SELECT total_value_usd FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1 OFFSET 1') as any
  const tradesToday = (queryAll("SELECT COUNT(*) as count FROM trades WHERE date(created_at) = date('now')") as any[])[0]
  const pendingCount = (queryAll("SELECT COUNT(*) as count FROM trades WHERE status = 'PENDING'") as any[])[0]
  const openPos = (queryAll("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'") as any[])[0]
  const maxRow = queryOne('SELECT value FROM settings WHERE key = ?', ['max_open_positions']) as any
  const lastRun = queryOne(
    "SELECT created_at FROM pipeline_events WHERE stage = 'signal_generated' ORDER BY created_at DESC LIMIT 1"
  ) as any

  const totalValue = snap ? Number(snap.total_value_usd) : 0
  const openCount = openPos?.count ?? 0
  const maxOpen = maxRow ? parseInt(maxRow.value as string) : 5
  const tradesCount = tradesToday?.count ?? 0
  const pending = pendingCount?.count ?? 0

  let changeStr = ''
  if (prev && Number(prev.total_value_usd) > 0) {
    const pct = ((totalValue - Number(prev.total_value_usd)) / Number(prev.total_value_usd)) * 100
    const sign = pct >= 0 ? '+' : ''
    changeStr = ` <i>(${sign}${pct.toFixed(2)}%)</i>`
  }

  const lines = [
    '📊 <b>Dashboard</b>',
    '',
    `💰 Portfolio: <b>${formatCurrency(totalValue)}</b>${changeStr}`,
    `📈 Open Positions: <b>${openCount}</b> / ${maxOpen}`,
    `🔄 Trades Today: <b>${tradesCount}</b>`,
    `⏳ Pending Approvals: <b>${pending}</b>`,
  ]

  if (lastRun) {
    lines.push(`🕐 Last Signal: <i>${formatDate(lastRun.created_at as string)}</i>`)
  }

  const hits = queryAll(
    "SELECT coin, status, created_at FROM positions WHERE status IN ('SL_HIT','TP_HIT') ORDER BY created_at DESC LIMIT 3"
  ) as any[]
  if (hits.length > 0) {
    lines.push('')
    lines.push('<b>Recent Exits</b>')
    for (const h of hits) {
      const icon = h.status === 'SL_HIT' ? '🛑' : '✅'
      const label = h.status === 'SL_HIT' ? 'Stop Loss' : 'Take Profit'
      lines.push(`${icon} ${code(h.coin.replace('/USDC', ''))} — ${label} · <i>${formatDate(h.created_at as string)}</i>`)
    }
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
