import { Markup } from 'telegraf'
import { queryAll, queryOne } from '../../../db/index.js'
import { formatCurrency, formatPnlPct, pnlEmoji, esc } from '../../components/formatting.js'

async function fetchLivePrice(coin: string, fallback: number): Promise<number> {
  try {
    const { getExchange } = await import('../../../trader/service.js')
    const exchange = getExchange()
    const ticker = await exchange.fetchTicker(coin as string)
    return ticker.last || fallback
  } catch {
    return fallback
  }
}

export async function render(_ctx: any) {
  const positions = queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as any[]
  const snap = queryOne('SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any

  const lines: string[] = ['💼 <b>Portfolio</b>', '']

  if (positions.length === 0) {
    lines.push('No open positions.')
  } else {
    lines[0] = `💼 <b>Portfolio</b> — ${positions.length} open position${positions.length > 1 ? 's' : ''}`

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]
      const entryPrice = Number(p.entry_price)
      const currentPrice = await fetchLivePrice(p.coin as string, entryPrice)
      const qty = Number(p.quantity)
      const pnl = qty * (currentPrice - entryPrice)
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100
      const emoji = pnlEmoji(pnlPct)

      lines.push(
        `<b>${esc((p.coin as string).replace('/USDC', ''))}</b>`,
        `  Qty: ${qty.toFixed(6)}  ·  Entry: ${formatCurrency(entryPrice)}`,
        `  Now: ${formatCurrency(currentPrice)}  ${emoji} <b>${formatPnlPct(pnlPct)}</b> (${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)})`,
        `  SL: ${formatCurrency(Number(p.stop_loss))}  TP: ${p.take_profit ? formatCurrency(Number(p.take_profit)) : '—'}`
      )
      if (i < positions.length - 1) lines.push('')
    }
  }

  if (snap) {
    const holdings = JSON.parse(snap.holdings as string) as Record<string, number>
    const usdc = holdings['USDC']
    if (usdc !== undefined && usdc > 0) {
      lines.push('', `💵 USDC Balance: <b>${formatCurrency(usdc)}</b>`)
    }
    const total = Number(snap.total_value_usd)
    if (total > 0) {
      lines.push(`📊 Total: <b>${formatCurrency(total)}</b>`)
    }
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
