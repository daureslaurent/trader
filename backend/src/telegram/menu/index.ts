import { Telegraf, Markup } from 'telegraf'
import { BotContext } from '../bot.js'
import { logger } from '../../core/logger.js'
import { getSettings, updateSetting } from '../../db/index.js'
import { bus } from '../../core/events.js'
import { approveDiscovery, rejectDiscovery } from '../../discoverer/index.js'
import { runChatTurn, createConversation, getConversation, isGenerating } from '../../agent/index.js'
import { esc, mdToHtml, chunkText } from '../components/formatting.js'
import * as dashboard from './views/dashboard.js'
import * as portfolio from './views/portfolio.js'
import * as trades from './views/trades.js'
import * as decisions from './views/decisions.js'
import * as pipeline from './views/pipeline.js'
import * as settings from './views/settings.js'
import * as approvals from './views/approvals.js'
import * as entry from './views/entry.js'
import * as summary from './views/summary.js'
import * as monitor from './views/monitor.js'
import * as discover from './views/discover.js'
import * as host from './views/host.js'
import * as agent from './views/agent.js'

type ViewModule = { render: (ctx: any) => Promise<{ text: string; buttons: ReturnType<typeof Markup.button.callback>[][] }> }

/** New cycle id for a manually-triggered engine run. */
const cycleId = (tag: string) => `${Date.now().toString(36)}-${tag}`

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
    this.views.set('entry', entry)
    this.views.set('summary', summary)
    this.views.set('monitor', monitor)
    this.views.set('discover', discover)
    this.views.set('host', host)
    this.views.set('agent', agent)
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

    this.bot.command('help', async (ctx) => {
      await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' })
    })

    // /ask <question> — one-shot agent query (starts a chat if none active).
    this.bot.command('ask', async (ctx) => {
      const question = ctx.message.text.replace(/^\/ask(@\S+)?\s*/, '').trim()
      if (!question) {
        return ctx.reply('💬 Usage: <code>/ask &lt;question&gt;</code>\nExample: <code>/ask how is my portfolio doing?</code>', { parse_mode: 'HTML' })
      }
      const convId = await this.ensureConversation(ctx)
      await this.handleAgentMessage(ctx, convId, question)
    })

    this.bot.action('menu:home', async (ctx) => {
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
      const id = ctx.match[1]
      ctx.session.menuStack.push(`cycle:${id}`)
      try {
        const view = this.views.get('pipeline') as any
        const { text, buttons } = await view.renderCycle(ctx, id)
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

    // ── Trigger engine runs ──────────────────────────────────────────────────
    this.bot.action('run:summary', async (ctx) => {
      bus.emit('summary_run_requested', { cycle_id: cycleId('tg') })
      await ctx.answerCbQuery('✨ Generating summary…')
      await this.renderView(ctx, 'summary')
    })

    this.bot.action('run:monitor', async (ctx) => {
      bus.emit('monitor_run_requested', { cycle_id: cycleId('tg') })
      await ctx.answerCbQuery('🩺 Monitor started…')
      await this.renderView(ctx, 'monitor')
    })

    this.bot.action('run:discovery', async (ctx) => {
      bus.emit('discovery_run_requested', { cycle_id: cycleId('discovery') })
      await ctx.answerCbQuery('🔍 Discovery started…')
      await this.renderView(ctx, 'discover')
    })

    // ── Discovery approve / reject ───────────────────────────────────────────
    this.bot.action(/^discover:(approve|reject):(\d+)$/, async (ctx) => {
      const action = ctx.match[1]
      const id = parseInt(ctx.match[2], 10)
      const res = action === 'approve' ? await approveDiscovery(id) : await rejectDiscovery(id)
      await ctx.answerCbQuery(res.ok
        ? (action === 'approve' ? '✅ Added to watchlist' : '❌ Rejected')
        : `⚠️ ${res.error ?? 'Failed'}`)
      await this.renderView(ctx, 'discover')
    })

    // ── Agent chat control ───────────────────────────────────────────────────
    this.bot.action('agent:new', async (ctx) => {
      const convo = await createConversation('Telegram chat')
      ctx.session.agent = { conversationId: convo.id }
      await ctx.answerCbQuery('💬 New chat started')
      await this.renderView(ctx, 'agent')
    })

    this.bot.action('agent:end', async (ctx) => {
      ctx.session.agent = undefined
      await ctx.answerCbQuery('⏹ Chat ended')
      if (ctx.session.menuStack[ctx.session.menuStack.length - 1] === 'agent') {
        await this.renderView(ctx, 'agent')
      }
    })

    this.bot.action(/^agent:conv:(\d+)$/, async (ctx) => {
      const id = parseInt(ctx.match[1], 10)
      ctx.session.agent = { conversationId: id }
      await ctx.answerCbQuery('💬 Resumed chat')
      await this.renderView(ctx, 'agent')
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

    // ── Free-text → Agent chat (must be last; passes non-chat text through) ───
    this.bot.on('text', async (ctx, next) => {
      const text = ctx.message?.text
      if (!text || text.startsWith('/')) return next()
      const convId = ctx.session.agent?.conversationId
      if (!convId) return next()
      await this.handleAgentMessage(ctx, convId, text)
    })
  }

  private async ensureConversation(ctx: any): Promise<number> {
    if (ctx.session.agent?.conversationId) return ctx.session.agent.conversationId
    const convo = await createConversation('Telegram chat')
    ctx.session.agent = { conversationId: convo.id }
    return convo.id
  }

  private async handleAgentMessage(ctx: any, conversationId: number, text: string) {
    if (isGenerating(conversationId)) {
      await ctx.reply('⏳ Still working on your previous question — one moment.')
      return
    }
    await ctx.sendChatAction('typing').catch(() => {})

    let result
    try {
      result = await runChatTurn(conversationId, text)
    } catch (err) {
      await ctx.reply(`⚠️ ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: 'HTML' })
      return
    }

    const finalMsg = [...result.produced].reverse().find(m => m.role === 'assistant' && m.content && m.content.trim())
    const toolCount = result.produced.filter(m => m.role === 'tool').length
    const body = finalMsg?.content?.trim() || '(no answer produced)'
    const footer = toolCount ? `\n\n<i>🔧 used ${toolCount} tool${toolCount !== 1 ? 's' : ''}</i>` : ''

    const chunks = chunkText(body)
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      const html = mdToHtml(chunks[i]) + (isLast ? footer : '')
      const opts: any = { parse_mode: 'HTML' }
      if (isLast) {
        opts.reply_markup = Markup.inlineKeyboard([[
          Markup.button.callback('⏹ End chat', 'agent:end'),
          Markup.button.callback('📋 Menu', 'menu:home'),
        ]]).reply_markup
      }
      try {
        await ctx.reply(html, opts)
      } catch {
        // Malformed HTML (rare): retry as plain text.
        await ctx.reply(chunks[i], isLast ? { reply_markup: opts.reply_markup } : {})
      }
    }
  }

  private async showMainMenu(ctx: any) {
    const inChat = !!ctx.session.agent?.conversationId
    const buttons = [
      [Markup.button.callback('📊 Dashboard', 'menu:dashboard'), Markup.button.callback('💼 Portfolio', 'menu:portfolio')],
      [Markup.button.callback('📜 Trades', 'menu:trades'), Markup.button.callback('🧠 Decisions', 'menu:decisions')],
      [Markup.button.callback('🎯 Entry Desk', 'menu:entry'), Markup.button.callback('🩺 Monitor', 'menu:monitor')],
      [Markup.button.callback('🔭 Discover', 'menu:discover'), Markup.button.callback('🔬 Pipeline', 'menu:pipeline')],
      [Markup.button.callback('🧭 Summary', 'menu:summary'), Markup.button.callback(`💬 Agent${inChat ? ' 🟢' : ''}`, 'menu:agent')],
      [Markup.button.callback('🖥️ Host', 'menu:host'), Markup.button.callback('⚙️ Settings', 'menu:settings')],
      [Markup.button.callback('✅ Approvals', 'menu:approvals'), Markup.button.callback('🔄 Refresh', 'menu:refresh')],
    ]
    const text = '🤖 <b>CryptoBot</b> — Main Menu\n\nSelect a section, or just type a question to ask the AI agent.'
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
      const { text: rawText, buttons } = await view.render(ctx)
      // Telegram caps messages at 4096 chars; keep headroom for safety.
      const text = rawText.length > 4096 ? rawText.slice(0, 4080) + '\n…' : rawText
      const fullButtons = [...buttons, [Markup.button.callback('🏠 Menu', 'menu:home'), Markup.button.callback('◀️ Back', 'menu:back')]]
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

const HELP_TEXT = [
  '🤖 <b>CryptoBot — Help</b>',
  '',
  '<b>Navigation</b>',
  '/menu — open the main menu',
  '',
  '<b>AI Agent</b>',
  'Just type any question (after starting a chat from the Agent menu), or:',
  '/ask &lt;question&gt; — one-shot question',
  '',
  '<b>Actions</b>',
  '/run &lt;SYMBOL&gt; — run the pipeline for a coin',
  '/discover — run coin discovery',
  '/approve &lt;id&gt; · /reject &lt;id&gt; — resolve a trade approval',
  '/set &lt;key&gt; &lt;value&gt; — update a setting',
  '',
  'Tip: the menu has Entry Desk, Monitor, Discover, Summary, Host and more — all live.',
].join('\n')
