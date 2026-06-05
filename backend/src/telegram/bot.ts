import { Telegraf, session, Context } from 'telegraf'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { ApprovalRequest } from '../types.js'
import { MenuController } from './menu/index.js'

export interface MenuSession {
  menuStack: string[]
  pagination: Record<string, { page: number }>
}

export interface BotContext extends Context {
  session: MenuSession
}

let bot: Telegraf<BotContext> | null = null

export function startTelegramBot() {
  if (!config.telegram.botToken) {
    logger.warn('No TELEGRAM_BOT_TOKEN set, skipping Telegram bot')
    return null
  }

  bot = new Telegraf<BotContext>(config.telegram.botToken)

  bot.use(session({ defaultSession: (): MenuSession => ({ menuStack: ['main'], pagination: {} }) }))

  const menu = new MenuController(bot)
  menu.register()

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
  const msg = [
    `⚠️ Trade Approval Needed`,
    ``,
    `${req.side} ${req.quantity} ${req.coin}`,
    `Est: $${req.estimatedPrice.toFixed(2)}`,
    `Reason: ${req.reason}`,
    `Confidence: ${(req.confidence * 100).toFixed(0)}%`,
    `Expires: ${new Date(req.expiresAt).toLocaleTimeString()}`,
    ``,
    `Tap /approve ${req.tradeId} or /reject ${req.tradeId}`,
  ].join('\n')
  bot.telegram.sendMessage(config.telegram.chatId, msg).catch(() => {})
}

export function getBot() {
  return bot
}
