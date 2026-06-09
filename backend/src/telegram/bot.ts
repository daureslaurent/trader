import { Telegraf, Markup, session, Context } from 'telegraf'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { ApprovalRequest } from '../types.js'
import { MenuController } from './menu/index.js'
import { formatCurrency, formatTime, confidenceBar, esc } from './components/formatting.js'

export interface MenuSession {
  menuStack: string[]
  pagination: Record<string, { page: number }>
}

export interface BotContext extends Context {
  session: MenuSession
}

let bot: Telegraf<BotContext> | null = null
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

  // #10: Track pending approvals so we can reply with the actual outcome.
  const pendingApprovalReplies = new Map<number, (msg: string) => void>()

  bus.on('trade_result', ({ tradeId, success, error }: { tradeId: number; success: boolean; error?: string }) => {
    const reply = pendingApprovalReplies.get(tradeId)
    if (!reply) return
    pendingApprovalReplies.delete(tradeId)
    reply(success
      ? `✅ Trade #${tradeId} executed successfully.`
      : `❌ Trade #${tradeId} failed: ${error ?? 'unknown error'}`
    )
  })

  // Inline keyboard button handlers (callback queries from approval messages)
  bot.action(/^approve:(\d+)$/, (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1], 10)
    pendingApprovalReplies.set(id, (msg) => ctx.reply(msg).catch(() => {}))
    bus.emit('trade_approved', id)
    ctx.answerCbQuery('Approving…').catch(() => {})
    ctx.reply(`⏳ Trade #${id} approved — executing…`)
  })

  bot.action(/^reject:(\d+)$/, (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1], 10)
    pendingApprovalReplies.delete(id)
    bus.emit('trade_rejected', id)
    ctx.answerCbQuery('Rejected').catch(() => {})
    ctx.reply(`❌ Trade #${id} rejected.`)
  })

  // Text command fallbacks (for manual use: /approve 123, /reject 123)
  bot.command('approve', (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1], 10)
    if (!id) return ctx.reply('Usage: /approve &lt;trade_id&gt;', { parse_mode: 'HTML' })
    pendingApprovalReplies.set(id, (msg) => ctx.reply(msg).catch(() => {}))
    bus.emit('trade_approved', id)
    ctx.reply(`⏳ Trade #${id} approved — executing...`)
  })

  bot.command('reject', (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1], 10)
    if (!id) return ctx.reply('Usage: /reject &lt;trade_id&gt;', { parse_mode: 'HTML' })
    pendingApprovalReplies.delete(id)
    bus.emit('trade_rejected', id)
    ctx.reply(`❌ Trade #${id} rejected.`)
  })

  bot.command('run', (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/)
    const raw = parts[1]
    if (!raw) {
      return ctx.reply(
        '▶️ Usage: /run &lt;SYMBOL&gt;\nExample: <code>/run BTC/USDC</code>',
        { parse_mode: 'HTML' }
      )
    }
    const symbol = raw.toUpperCase()
    const cycleId = `${Date.now().toString(36)}-manual`
    bus.emit('pipeline_run_requested', { symbol, cycle_id: cycleId })
    ctx.reply(`▶️ Pipeline started for <code>${esc(symbol)}</code>`, { parse_mode: 'HTML' })
  })

  bot.command('discover', (ctx) => {
    const cycleId = `${Date.now().toString(36)}-discovery`
    bus.emit('discovery_run_requested', { cycle_id: cycleId })
    ctx.reply('🔍 Discovery pipeline started.')
  })

  bot.launch().then(() => logger.info('Telegram bot started'))
    .catch((err) => logger.error('Telegram bot failed', { error: err.message }))

  return bot
}

export function sendApprovalMessage(req: ApprovalRequest): void {
  if (!bot || !resolvedChatId) return

  const side = req.side === 'BUY' ? '🟢 BUY' : '🔴 SELL'
  const coin = esc(req.coin.replace('/USDC', ''))
  const total = formatCurrency(req.estimatedPrice * req.quantity)
  const confidence = (req.confidence * 100).toFixed(0)
  const bar = confidenceBar(req.confidence)
  const expires = formatTime(req.expiresAt)

  const text = [
    `⚠️ <b>Trade Approval Needed</b>`,
    ``,
    `${side} <b>${req.quantity.toFixed(6)}</b> ${coin}`,
    `Price: ${formatCurrency(req.estimatedPrice)}   Total: <b>${total}</b>`,
    `Confidence: <code>${bar}</code> ${confidence}%`,
    `Reason: <i>${esc(req.reason)}</i>`,
    `Expires: ${expires}`,
  ].join('\n')

  bot.telegram.sendMessage(resolvedChatId, text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([[
      Markup.button.callback(`✅ Approve #${req.tradeId}`, `approve:${req.tradeId}`),
      Markup.button.callback(`❌ Reject #${req.tradeId}`, `reject:${req.tradeId}`),
    ]]).reply_markup,
  }).catch((err) => {
    logger.warn('Telegram approval message failed', { error: err.message })
  })
}

export function getBot() {
  return bot
}
