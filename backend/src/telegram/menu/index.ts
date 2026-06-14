import { Telegraf, Markup } from 'telegraf'
import { BotContext } from '../bot.js'
import { logger } from '../../core/logger.js'
import { getSettings, updateSetting } from '../../db/index.js'
import { bus } from '../../core/events.js'
import * as dashboard from './views/dashboard.js'
import * as portfolio from './views/portfolio.js'
import * as trades from './views/trades.js'
import * as decisions from './views/decisions.js'
import * as pipeline from './views/pipeline.js'
import * as settings from './views/settings.js'
import * as approvals from './views/approvals.js'

type ViewModule = { render: (ctx: any) => Promise<{ text: string; buttons: ReturnType<typeof Markup.button.callback>[][] }> }

export class MenuController {
  private bot: Telegraf<BotContext>
  private views = new Map<string, ViewModule>()

  constructor(bot: Telegraf<BotContext>) {
    this.bot = bot
    this.views.set('dashboard', dashboard)
    this.views.set('portfolio', portfolio)
    this.views.set('trades', trades)
    this.views.set('decisions', decisions)
    this.views.set('pipeline', pipeline)
    this.views.set('settings', settings)
    this.views.set('approvals', approvals)
  }

  register() {
    this.bot.start(async (ctx) => {
      ctx.session.menuStack = ['main']
      await this.showMainMenu(ctx)
    })

    this.bot.command('menu', async (ctx) => {
      ctx.session.menuStack = ['main']
      await this.showMainMenu(ctx)
    })

    this.bot.action('menu:back', async (ctx) => {
      ctx.session.menuStack.pop()
      const current = ctx.session.menuStack[ctx.session.menuStack.length - 1]
      if (!current || current === 'main') {
        ctx.session.menuStack = ['main']
        await this.showMainMenu(ctx)
      } else {
        await this.renderView(ctx, current)
      }
    })

    this.bot.action('menu:refresh', async (ctx) => {
      if (ctx.session.menuStack.length <= 1) {
        await this.showMainMenu(ctx)
      } else {
        const current = ctx.session.menuStack[ctx.session.menuStack.length - 1]
        await this.renderView(ctx, current)
      }
    })

    this.bot.action(/^menu:(.+)/, async (ctx) => {
      const viewName = ctx.match[1]
      ctx.session.menuStack.push(viewName)
      await this.renderView(ctx, viewName)
    })

    this.bot.action(/^cycle:(.+)/, async (ctx) => {
      const cycleId = ctx.match[1]
      ctx.session.menuStack.push(`cycle:${cycleId}`)
      try {
        const view = this.views.get('pipeline') as any
        const { text, buttons } = await view.renderCycle(ctx, cycleId)
        const fullButtons = [...buttons, [Markup.button.callback('◀️ Back', 'menu:back')]]
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(fullButtons).reply_markup,
        })
      } catch (err) {
        logger.error('Pipeline cycle error', { error: err instanceof Error ? err.message : String(err) })
        await ctx.editMessageText('Error loading cycle.')
      }
      await ctx.answerCbQuery()
    })

    this.bot.action(/^page:(.+):(prev|next)$/, async (ctx) => {
      const viewName = ctx.match[1]
      const dir = ctx.match[2]
      const state = ctx.session.pagination[viewName]
      if (!state) return ctx.answerCbQuery()
      state.page = dir === 'next' ? state.page + 1 : state.page - 1
      await this.renderView(ctx, viewName)
    })

    this.bot.action('noop', async (ctx) => {
      await ctx.answerCbQuery()
    })

    this.bot.command('set', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/).filter(Boolean)
      if (parts.length < 3) {
        return ctx.reply(
          'Usage: /set &lt;key&gt; &lt;value&gt;\nExample: <code>/set pipeline_cron "0 */2 * * *"</code>',
          { parse_mode: 'HTML' }
        )
      }
      const key = parts[1]
      const value = parts.slice(2).join(' ')
      try {
        await updateSetting(key, value)
        ctx.reply(`✅ <code>${key}</code> updated to <code>${value}</code>`, { parse_mode: 'HTML' })
      } catch (err) {
        ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    this.bot.action('setting:toggle:approval_required', async (ctx) => {
      const s = getSettings()
      const next = !s.approval_required
      await updateSetting('approval_required', String(next))
      await ctx.answerCbQuery(`Approval ${next ? 'enabled' : 'disabled'}`)
      await this.renderView(ctx, 'settings')
    })

    this.bot.action(/^setting:edit:(.+)$/, async (ctx) => {
      const labels: Record<string, string> = {
        watchlist: 'Watchlist (comma-separated symbols)',
        pipeline_cron: 'Pipeline Cron expression',
        min_confidence: 'Min Confidence (0–1)',
        max_position_size_usd: 'Max Position Size ($)',
        stop_loss_atr: 'Stop Loss ATR multiplier',
        take_profit_atr: 'Take Profit ATR multiplier',
        max_risk_per_trade: 'Max Risk per Trade (0–1)',
        max_open_positions: 'Max Open Positions',
      }
      const key = ctx.match[1]
      const label = labels[key] || key
      await ctx.editMessageText(
        `✏️ <b>${label}</b>\n\nSend: <code>/set ${key} &lt;value&gt;</code>`,
        { parse_mode: 'HTML' }
      )
      await ctx.answerCbQuery()
    })

    this.bot.action(/^approve:(\d+)$/, async (ctx) => {
      const id = parseInt(ctx.match[1], 10)
      bus.emit('trade_approved', id)
      await ctx.answerCbQuery(`✅ Trade #${id} approved`)
      await this.renderView(ctx, 'approvals')
    })

    this.bot.action(/^reject:(\d+)$/, async (ctx) => {
      const id = parseInt(ctx.match[1], 10)
      bus.emit('trade_rejected', id)
      await ctx.answerCbQuery(`❌ Trade #${id} rejected`)
      await this.renderView(ctx, 'approvals')
    })
  }

  private async showMainMenu(ctx: any) {
    const buttons = [
      [Markup.button.callback('📊 Dashboard', 'menu:dashboard'), Markup.button.callback('💼 Portfolio', 'menu:portfolio')],
      [Markup.button.callback('📜 Trades', 'menu:trades'), Markup.button.callback('🧠 Decisions', 'menu:decisions')],
      [Markup.button.callback('🔬 Pipeline', 'menu:pipeline'), Markup.button.callback('⚙️ Settings', 'menu:settings')],
      [Markup.button.callback('✅ Approvals', 'menu:approvals'), Markup.button.callback('🔄 Refresh', 'menu:refresh')],
    ]
    const text = '🤖 <b>CryptoBot</b> — Main Menu\n\nSelect a section:'
    const opts = { parse_mode: 'HTML' as const, reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, opts)
      await ctx.answerCbQuery().catch(() => {})
    } else {
      await ctx.reply(text, opts)
    }
  }

  private async renderView(ctx: any, viewName: string) {
    const view = this.views.get(viewName)
    if (!view) {
      if (ctx.callbackQuery) {
        await ctx.editMessageText('View not found. Use /menu to return.')
        await ctx.answerCbQuery()
      }
      return
    }
    try {
      const { text, buttons } = await view.render(ctx)
      const fullButtons = [...buttons, [Markup.button.callback('◀️ Back', 'menu:back')]]
      const opts = { parse_mode: 'HTML' as const, reply_markup: Markup.inlineKeyboard(fullButtons).reply_markup }
      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, opts)
        await ctx.answerCbQuery()
      } else {
        await ctx.reply(text, opts)
      }
    } catch (err) {
      logger.error('View render error', { view: viewName, error: err instanceof Error ? err.message : String(err) })
      if (ctx.callbackQuery) {
        await ctx.editMessageText('⚠️ Error loading data. Try again later.')
        await ctx.answerCbQuery()
      } else {
        await ctx.reply('⚠️ Error loading data. Try again later.')
      }
    }
  }
}
