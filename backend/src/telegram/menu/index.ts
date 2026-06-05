import { Telegraf, Markup } from 'telegraf'
import { MenuSession } from '../bot.js'
import { logger } from '../core/logger.js'
import * as dashboard from './views/dashboard.js'

export class MenuController {
  private bot: Telegraf<{ session: MenuSession }>
  private views = new Map<string, { render: (ctx: any) => Promise<{ text: string; buttons: ReturnType<typeof Markup.button.callback>[][] }> }>()

  constructor(bot: Telegraf<{ session: MenuSession }>) {
    this.bot = bot
    this.views.set('dashboard', dashboard)
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
