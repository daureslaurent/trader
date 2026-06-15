import { Markup } from 'telegraf'
import { positions as positionsRepo, portfolioSnapshots, getSettings } from '../../../db/index.js'
import { formatCurrency, formatPnlPct, pnlEmoji, esc } from '../../components/formatting.js'

/** Signed USDC amount, e.g. +$12.34 / −$5.00. */
function signedUsd(value: number): string {
  return `${value >= 0 ? '+' : '−'}${formatCurrency(Math.abs(value))}`
}

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
  const positions = await positionsRepo.find({ status: 'OPEN' }, { sort: { created_at: 1 } }) as any[]
  const snap = await portfolioSnapshots.findOne({}, { sort: { created_at: -1 } }) as any

  const lines: string[] = ['💼 <b>Portfolio</b>', '']

  if (positions.length === 0) {
    lines.push('No open positions.')
  } else {
    lines[0] = `💼 <b>Portfolio</b> — ${positions.length} open position${positions.length > 1 ? 's' : ''}`

    // Round-trip fee as a fraction of notional (entry + exit leg). A close nets
    // exactly zero P&L at entry × (1 + 2·feeRate) — the break-even price.
    const roundTripFee = getSettings().fee_rate * 2

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]
      const entryPrice = Number(p.entry_price)
      const currentPrice = await fetchLivePrice(p.coin as string, entryPrice)
      const qty = Number(p.quantity)
      const pnl = qty * (currentPrice - entryPrice)
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100
      const emoji = pnlEmoji(pnlPct)

      const breakEvenPrice = entryPrice * (1 + roundTripFee)
      const pastBreakEven = currentPrice >= breakEvenPrice
      const beBadge = pastBreakEven ? '  🟢 <i>B/E cleared</i>' : ''

      // P&L in USDC if the stop is hit now: (stop − entry) × qty.
      const stopLoss = p.stop_loss != null ? Number(p.stop_loss) : null
      const slPnl = stopLoss != null ? (stopLoss - entryPrice) * qty : null
      const slLine = stopLoss != null
        ? `  SL: ${formatCurrency(stopLoss)}  <i>(${signedUsd(slPnl as number)} at stop)</i>`
        : `  SL: —`
      const tpLine = `  TP: ${p.take_profit ? formatCurrency(Number(p.take_profit)) : '—'}`

      lines.push(
        `<b>${esc((p.coin as string).replace('/USDC', ''))}</b>${beBadge}`,
        `  Qty: ${qty.toFixed(6)}  ·  Entry: ${formatCurrency(entryPrice)}`,
        `  Now: ${formatCurrency(currentPrice)}  ${emoji} <b>${formatPnlPct(pnlPct)}</b> (${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)})`,
        `  B/E: ${formatCurrency(breakEvenPrice)}${pastBreakEven ? ' ✓' : ''}`,
        slLine,
        tpLine,
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
