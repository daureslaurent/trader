import { Markup } from 'telegraf'
import { queryAll } from '../../../db/index.js'
import { formatCurrency, formatTime, tradeStatusEmoji } from '../../components/formatting.js'
import { paginationButtons, paginate } from '../../components/pagination.js'

const PER_PAGE = 5

export async function render(ctx: any) {
  const allTrades = queryAll('SELECT * FROM trades ORDER BY created_at DESC LIMIT 50') as any[]
  if (allTrades.length === 0) {
    return { text: '📜 Trade History\n\nNo trades yet.', buttons: [] }
  }

  const viewKey = 'trades'
  const state = ctx.session.pagination[viewKey] || { page: 0 }
  const { pageItems, totalPages } = paginate(allTrades, state.page, PER_PAGE)
  ctx.session.pagination[viewKey] = { page: state.page }

  const lines = [`📜 Trade History (Page ${state.page + 1}/${totalPages})`, '']
  for (const t of pageItems) {
    const time = formatTime(t.created_at as string)
    lines.push(`${tradeStatusEmoji(t.status as string)} ${time} ${t.side} ${t.quantity} ${t.coin} @ ${formatCurrency(Number(t.price))} — ${formatCurrency(Number(t.total))}`)
  }

  const nav = paginationButtons({ page: state.page, totalPages }, viewKey)
  return { text: lines.join('\n'), buttons: [nav] }
}
