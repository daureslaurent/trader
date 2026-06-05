import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { queryAll, queryOne } from '../db/index.js'
import { formatCurrency } from './components/formatting.js'
import { getBot, getChatId } from './bot.js'

function send(text: string) {
  const bot = getBot()
  const id = getChatId()
  if (!bot || !id) return
  bot.telegram.sendMessage(id, text).catch((err) => {
    logger.warn('Telegram send failed', { error: err.message })
  })
}

export function startNotifier() {

  bus.on('trade_executed', (trade: any) => {
    const emoji = trade.side === 'BUY' ? '🟢' : '🔴'
    send(`${emoji} ${trade.side} ${trade.quantity} ${trade.coin} @ ${formatCurrency(Number(trade.price))} — ${formatCurrency(Number(trade.total))}`)
  })

  bus.on('stop_loss_hit', ({ coin, price }) => {
    send(`🛑 Stop Loss hit: ${coin} @ ${formatCurrency(price)}`)
  })

  bus.on('take_profit_hit', ({ coin, price }) => {
    send(`✅ Take Profit hit: ${coin} @ ${formatCurrency(price)}`)
  })

  bus.on('portfolio_updated', () => {
    const snap = queryOne('SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any
    if (!snap) return
    const openCount = (queryAll("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'") as any[])?.[0]?.count ?? 0
    send(`📊 Portfolio: ${formatCurrency(Number(snap.total_value_usd))} | ${openCount} open positions`)
  })

  bus.on('error', (err: Error) => {
    send(`❌ Error: ${err.message}`)
  })

  logger.info('Telegram notifier started')
}
