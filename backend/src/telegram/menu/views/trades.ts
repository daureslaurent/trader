import { Markup } from 'telegraf'
import { queryAll } from '../../../db/index.js'
import { formatCurrency, formatDate, tradeStatusEmoji, actionEmoji, esc } from '../../components/formatting.js'
import { paginationButtons, paginate } from '../../components/pagination.js'

const PER_PAGE = 5

export async function render(ctx: any) {
  const allTrades = queryAll('SELECT * FROM trades ORDER BY created_at DESC LIMIT 50') as any[]
  if (allTrades.length === 0) {
    return { text: '📜 <b>Trade History</b>\n\nNo trades yet.', buttons: [] }
  }

  const viewKey = 'trades'
  const state = ctx.session.pagination[viewKey] || { page: 0 }
  const { pageItems, totalPages } = paginate(allTrades, state.page, PER_PAGE)
  ctx.session.pagination[viewKey] = { page: state.page }

  const lines = [`📜 <b>Trade History</b>  <i>Page ${state.page + 1}/${totalPages}</i>`, '']

  for (const t of pageItems) {
    const statusEmoji = tradeStatusEmoji(t.status as string)
    const sideEmoji = actionEmoji(t.side as string)
    const coin = esc((t.coin as string).replace('/USDC', ''))
    const date = formatDate(t.created_at as string)
    lines.push(
      `${statusEmoji} ${sideEmoji} <b>${t.side}</b> ${t.quantity} ${coin}`,
      `  @ ${formatCurrency(Number(t.price))}  ·  Total: ${formatCurrency(Number(t.total))}`,
      `  <i>${date}</i>`
    )
  }

  const nav = paginationButtons({ page: state.page, totalPages }, viewKey)
  return { text: lines.join('\n'), buttons: [nav] }
}
