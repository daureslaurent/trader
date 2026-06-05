import { Markup } from 'telegraf'
import { queryAll, queryOne } from '../../../db/index.js'
import { formatCurrency, formatPnlPct } from '../../components/formatting.js'

export async function render(ctx: any) {
  const positions = queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as any[]

  let lines: string[] = []
  if (positions.length === 0) {
    lines.push('💼 Portfolio', '', 'No open positions.')
  } else {
    let { getExchange } = await import('../../../trader/service.js')
    let exchange: any
    try { exchange = getExchange() } catch { exchange = null }

    lines.push(`💼 Portfolio — ${positions.length} Open Position${positions.length > 1 ? 's' : ''}`, '')
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]
      let currentPrice = Number(p.entry_price)
      if (exchange) {
        try {
          const ticker = await exchange.fetchTicker(p.coin as string)
          currentPrice = ticker.last || currentPrice
        } catch {}
      }
      const pnl = Number(p.quantity) * (currentPrice - Number(p.entry_price))
      const pnlPct = ((currentPrice - Number(p.entry_price)) / Number(p.entry_price)) * 100
      const emoji = pnl >= 0 ? '🟢' : '🔴'
      lines.push(
        `#${i + 1} ${p.coin}`,
        `   ${Number(p.quantity)} @ ${formatCurrency(Number(p.entry_price))}`,
        `   → ${formatCurrency(currentPrice)}  ${emoji} ${formatPnlPct(pnlPct)}`,
        `   SL: ${formatCurrency(Number(p.stop_loss))}  TP: ${p.take_profit ? formatCurrency(Number(p.take_profit)) : '—'}`
      )
      if (i < positions.length - 1) lines.push('')
    }
  }

  const snap = queryOne('SELECT holdings FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any
  if (snap) {
    const holdings = JSON.parse(snap.holdings as string)
    const entries = Object.entries(holdings).filter(([, v]) => Number(v) > 0)
    if (entries.length > 0) {
      lines.push('', 'Holdings:')
      for (const [coin, qty] of entries) {
        lines.push(`   ${coin}: ${Number(qty)}`)
      }
    }
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
