import { Telegraf, Markup } from 'telegraf'
import { MenuSession } from '../bot.js'
import { logger } from '../core/logger.js'
import { getSettings, updateSetting } from '../db/index.js'
import { bus } from '../core/events.js'
import * as dashboard from './views/dashboard.js'
import * as portfolio from './views/portfolio.js'
import * as trades from './views/trades.js'
import * as decisions from './views/decisions.js'
import * as pipeline from './views/pipeline.js'
import * as settings from './views/settings.js'
import * as approvals from './views/approvals.js'

export class MenuController {
  private bot: Telegraf<{ session: MenuSession }>
  private views = new Map<string, { render: (ctx: any) => Promise<{ text: string; buttons: ReturnType<typeof Markup.button.callback>[][] }> }>()

  constructor(bot: Telegraf<{ session: MenuSession }>) {
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
        await ctx.editMessageText(text, { reply_markup: Markup.inlineKeyboard(fullButtons).reply_markup })
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
      const text = ctx.message.text.trim()
      const parts = text.split(' ').filter(Boolean)
      if (parts.length < 3) {
        return ctx.reply('Usage: /set <key> <value>\nExample: /set interval_minutes 30')
      }
      const key = parts[1]
      const value = parts.slice(2).join(' ')
      try {
        updateSetting(key, value)
        ctx.reply(`✅ ${key} updated to ${value}`)
      } catch (err) {
        ctx.reply(`❌ Failed to update: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    this.bot.action('setting:toggle:approval_required', async (ctx) => {
      const settings = getSettings()
      updateSetting('approval_required', String(!settings.approval_required))
      await ctx.answerCbQuery(`Approval required: ${!settings.approval_required}`)
      await this.renderView(ctx, 'settings')
    })

    this.bot.action(/^setting:edit:(.+)$/, async (ctx) => {
      const labels: Record<string, string> = {
        interval_minutes: 'Interval (min)',
        min_confidence: 'Min Confidence',
        max_position_size_usd: 'Max Position ($)',
        stop_loss_atr: 'Stop Loss ATR',
        take_profit_atr: 'Take Profit ATR',
        max_risk_per_trade: 'Max Risk (%)',
        max_open_positions: 'Max Positions',
      }
      const key = ctx.match[1]
      await ctx.editMessageText(
        `Send the new value for "${labels[key] || key}" as a message.\n\nReply with /set ${key} <value> to update.`
      )
      await ctx.answerCbQuery()
    })

    this.bot.action(/^approve:(\d+)$/, async (ctx) => {
      const id = parseInt(ctx.match[1], 10)
      bus.emit('trade_approved', id)
      await ctx.answerCbQuery(`Trade ${id} approved`)
      await this.renderView(ctx, 'approvals')
    })

    this.bot.action(/^reject:(\d+)$/, async (ctx) => {
      const id = parseInt(ctx.match[1], 10)
      bus.emit('trade_rejected', id)
      await ctx.answerCbQuery(`Trade ${id} rejected`)
      await this.renderView(ctx, 'approvals')
    })
  }

  private async showMainMenu(ctx: any) {
    const buttons = [
      [Markup.button.callback('📊 Dashboard', 'menu:dashboard')],
      [Markup.button.callback('💼 Portfolio', 'menu:portfolio')],
      [Markup.button.callback('📜 Trade History', 'menu:trades')],
      [Markup.button.callback('🧠 LLM Decisions', 'menu:decisions')],
      [Markup.button.callback('🔬 Pipeline', 'menu:pipeline')],
      [Markup.button.callback('⚙️ Settings', 'menu:settings')],
      [Markup.button.callback('✅ Approvals', 'menu:approvals')],
      [Markup.button.callback('🔄 Refresh', 'menu:refresh')],
    ]
    const text = '🤖 CryptoBot — Main Menu\n\nSelect a section:'
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: Markup.inlineKeyboard(buttons).reply_markup })
    } else {
      await ctx.reply(text, { reply_markup: Markup.inlineKeyboard(buttons).reply_markup })
    }
    await ctx.answerCbQuery().catch(() => {})
  }

  private async renderView(ctx: any, viewName: string) {
    const view = this.views.get(viewName)
    if (!view) {
      await ctx.editMessageText('View not found. Use /menu to return.')
      await ctx.answerCbQuery()
      return
    }
    try {
      const { text, buttons } = await view.render(ctx)
      const fullButtons = [...buttons, [Markup.button.callback('◀️ Back', 'menu:back')]]
      await ctx.editMessageText(text, { reply_markup: Markup.inlineKeyboard(fullButtons).reply_markup })
    } catch (err) {
      logger.error('View render error', { view: viewName, error: err instanceof Error ? err.message : String(err) })
      await ctx.editMessageText('Error loading data. Try again later.')
    }
    await ctx.answerCbQuery()
  }
}
