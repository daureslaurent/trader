import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { queryAll } from '../db/index.js'
import { formatCurrency, esc, coinLabel } from './components/formatting.js'
import { getBot, getChatId } from './bot.js'

function send(text: string): void {
  const bot = getBot()
  const chatId = getChatId()
  if (!bot || !chatId) return
  bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch((err) => {
    logger.warn('Telegram send failed', { error: err.message })
  })
}

export function startNotifier() {
  send('✅ <b>CryptoBot started</b> — monitoring markets')

  bus.on('trade_executed', (trade) => {
    const emoji = trade.side === 'BUY' ? '🟢' : '🔴'
    const coin = coinLabel(trade.coin)
    send(
      `${emoji} <b>${trade.side}</b> ${trade.quantity} ${coin} @ ${formatCurrency(Number(trade.price))}\n` +
      `Total: <b>${formatCurrency(Number(trade.total))}</b>`
    )
  })

  bus.on('stop_loss_hit', ({ coin, price }) => {
    send(`🛑 <b>Stop Loss</b> hit: <code>${coinLabel(coin)}</code> @ ${formatCurrency(price)}`)
  })

  bus.on('take_profit_hit', ({ coin, price }) => {
    send(`✅ <b>Take Profit</b> hit: <code>${coinLabel(coin)}</code> @ ${formatCurrency(price)}`)
  })

  bus.on('portfolio_updated', () => {
    const snapshots = queryAll(
      'SELECT total_value_usd FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 2'
    ) as { total_value_usd: number }[]
    if (!snapshots.length) return

    const current = Number(snapshots[0].total_value_usd)
    const openCount = (queryAll(
      "SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'"
    ) as { count: number }[])[0]?.count ?? 0

    let changeStr = ''
    if (snapshots[1]) {
      const prev = Number(snapshots[1].total_value_usd)
      if (prev > 0) {
        const pct = ((current - prev) / prev) * 100
        changeStr = ` <i>(${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</i>`
      }
    }

    send(
      `📊 <b>Portfolio:</b> ${formatCurrency(current)}${changeStr} · ` +
      `${openCount} open position${openCount !== 1 ? 's' : ''}`
    )
  })

  bus.on('trade_failed', ({ coin, side, error }) => {
    send(`❌ <b>Trade Failed:</b> ${side} ${coinLabel(coin)}\n<code>${esc(error)}</code>`)
  })

  bus.on('error', (err) => {
    send(`❌ <b>Error:</b> ${esc(err.message)}`)
  })

  bus.on('coin_discovered', (result) => {
    const coin = coinLabel(result.coin)
    const score = Number(result.score).toFixed(1)
    const status = result.status === 'auto_added' ? ' — <b>auto-added to watchlist</b>' : ''
    send(`🔍 <b>Discovered:</b> ${coin} · score <b>${score}</b>${status}`)
  })

  logger.info('Telegram notifier started')
}
