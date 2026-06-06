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
// Resolved chat ID: prefer env var, fall back to the first chat that messages the bot
let resolvedChatId: string = config.telegram.chatId

export function getChatId(): string {
  return resolvedChatId
}

export function startTelegramBot() {
  if (!config.telegram.botToken) {
    logger.warn('No TELEGRAM_BOT_TOKEN set, skipping Telegram bot')
    return null
  }

  bot = new Telegraf<BotContext>(config.telegram.botToken)

  bot.use(session({ defaultSession: (): MenuSession => ({ menuStack: ['main'], pagination: {} }) }))

  // Auto-learn chat ID from the first incoming message if not set via env
  bot.use((ctx, next) => {
    if (!resolvedChatId && ctx.chat?.id) {
      resolvedChatId = String(ctx.chat.id)
      logger.info('Telegram chat ID learned from incoming message', { chatId: resolvedChatId })
    }
    return next()
  })

  bot.catch((err) => {
    logger.error('Telegram bot error', { error: err instanceof Error ? err.message : String(err) })
  })

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
  if (!bot || !resolvedChatId) return
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
  bot.telegram.sendMessage(resolvedChatId, msg).catch((err) => {
    logger.warn('Telegram approval message failed', { error: err.message })
  })
}

export function getBot() {
  return bot
}
