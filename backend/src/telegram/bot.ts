import { Telegraf } from 'telegraf'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { queryOne } from '../db/index.js'
import { ApprovalRequest } from '../types.js'

let bot: Telegraf | null = null

export function startTelegramBot() {
  if (!config.telegram.botToken) {
    logger.warn('No TELEGRAM_BOT_TOKEN set, skipping Telegram bot')
    return null
  }

  bot = new Telegraf(config.telegram.botToken)

  bot.start((ctx) => ctx.reply('CryptoBot active. Use /status for portfolio, /approve <id> to confirm trades.'))
  bot.help((ctx) => ctx.reply('/status - Portfolio\n/approve <id> - Approve trade\n/reject <id> - Reject trade'))

  bot.command('status', async (ctx) => {
    const snap = queryOne('SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any
    if (!snap) return ctx.reply('No portfolio data yet.')
    ctx.reply(`Portfolio: $${Number(snap.total_value_usd).toFixed(2)}\nHoldings: ${snap.holdings}`)
  })

  bot.command('approve', (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1], 10)
    if (!id) return ctx.reply('Usage: /approve <trade_id>')
    bus.emit('trade_approved', id)
    ctx.reply(`Trade ${id} approved.`)
  })

  bot.command('reject', (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1], 10)
    if (!id) return ctx.reply('Usage: /reject <trade_id>')
    bus.emit('trade_rejected', id)
    ctx.reply(`Trade ${id} rejected.`)
  })

  bot.launch().then(() => logger.info('Telegram bot started'))
    .catch((err) => logger.error('Telegram bot failed', { error: err.message }))

  return bot
}

export function sendApprovalMessage(req: ApprovalRequest): void {
  if (!bot) return
  const msg = `⚠️ Trade Approval Needed\n\n${req.side} ${req.quantity} ${req.coin}\nEst: $${req.estimatedPrice}\nReason: ${req.reason}\nConfidence: ${(req.confidence * 100).toFixed(0)}%\n\n/approve ${req.tradeId}\n/reject ${req.tradeId}`
  bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID || '', msg).catch(() => {})
}
