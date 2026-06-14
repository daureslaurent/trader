import { Markup } from 'telegraf'
import { positions as positionsRepo, trades, portfolioSnapshots, pipelineEvents, getSettings } from '../../../db/index.js'
import { formatCurrency, formatDate, code } from '../../components/formatting.js'

export async function render(_ctx: any) {
  const todayStart = new Date().toISOString().slice(0, 10) + ' 00:00:00'
  const [snap, prevRows, tradesCount, pending, openCount, lastRun] = await Promise.all([
    portfolioSnapshots.findOne({}, { sort: { created_at: -1 } }) as any,
    portfolioSnapshots.find({}, { sort: { created_at: -1 }, skip: 1, limit: 1, projection: { total_value_usd: 1 } }) as any,
    trades.count({ created_at: { $gte: todayStart } }),
    trades.count({ status: 'PENDING' }),
    positionsRepo.count({ status: 'OPEN' }),
    pipelineEvents.findOne({ stage: 'signal_generated' }, { sort: { created_at: -1 }, projection: { created_at: 1 } }) as any,
  ])
  const prev = prevRows[0] ?? null

  const totalValue = snap ? Number(snap.total_value_usd) : 0
  const maxOpen = getSettings().max_open_positions

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

  const hits = await positionsRepo.find(
    { status: { $in: ['SL_HIT', 'TP_HIT'] } },
    { sort: { created_at: -1 }, limit: 3, projection: { coin: 1, status: 1, created_at: 1 } },
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
