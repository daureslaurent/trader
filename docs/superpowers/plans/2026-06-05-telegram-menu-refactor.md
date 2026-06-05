# Telegram Menu Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal 51-line Telegram bot with a modular inline-keyboard menu system exposing all frontend data, plus push notifications for key events.

**Architecture:** MenuController dispatches to isolated view modules; a separate notifier module subscribes to the event bus for push messages. Each view module exports a `render()` function returning `{ text, buttons }`. Data fetched directly via existing `db/` layer, mutations go through `bus.emit()` or `runSQL()`.

**Tech Stack:** TypeScript, telegraf (existing), sql.js (existing)

---

### Task 1: Create formatting utilities

**Files:**
- Create: `backend/src/telegram/components/formatting.ts`

- [ ] **Step 1: Create file**

```typescript
export function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatPnlPct(pct: number): string {
  const prefix = pct >= 0 ? '+' : ''
  return `${prefix}${pct.toFixed(2)}%`
}

export function formatTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

export function tradeStatusEmoji(status: string): string {
  switch (status) {
    case 'EXECUTED': return '✅'
    case 'FAILED': return '❌'
    case 'PENDING': return '⏳'
    default: return '❓'
  }
}

export function actionEmoji(action: string): string {
  switch (action) {
    case 'BUY': return '🟢'
    case 'SELL': return '🔴'
    case 'HOLD': return '⚪'
    default: return '❓'
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/telegram/components/formatting.ts
git commit -m "feat(telegram): add formatting utilities"
```

---

### Task 2: Create pagination component

**Files:**
- Create: `backend/src/telegram/components/pagination.ts`

- [ ] **Step 1: Create file**

```typescript
import { Markup } from 'telegraf'

export interface PaginationMeta {
  page: number
  totalPages: number
}

export function paginationButtons(meta: PaginationMeta, viewName: string) {
  const buttons: ReturnType<typeof Markup.button.callback>[] = []
  if (meta.page > 0) {
    buttons.push(Markup.button.callback('◀️ Prev', `page:${viewName}:prev`))
  }
  buttons.push(Markup.button.callback(`📄 ${meta.page + 1}/${meta.totalPages}`, 'noop'))
  if (meta.page < meta.totalPages - 1) {
    buttons.push(Markup.button.callback('Next ▶️', `page:${viewName}:next`))
  }
  return buttons
}

export function paginate<T>(items: T[], page: number, perPage: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage))
  const start = page * perPage
  return {
    pageItems: items.slice(start, start + perPage),
    totalPages,
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/telegram/components/pagination.ts
git commit -m "feat(telegram): add pagination component"
```

---

### Task 3: Refactor bot.ts — session middleware, menu registration, preserve approval

**Files:**
- Modify: `backend/src/telegram/bot.ts`

- [ ] **Step 1: Rewrite bot.ts with session + menu wiring**

```typescript
import { Telegraf, session } from 'telegraf'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { ApprovalRequest } from '../types.js'
import { MenuController } from './menu/index.js'

export interface MenuSession {
  menuStack: string[]
  pagination: Record<string, { page: number }>
}

let bot: Telegraf<{ session: MenuSession }> | null = null

export function startTelegramBot() {
  if (!config.telegram.botToken) {
    logger.warn('No TELEGRAM_BOT_TOKEN set, skipping Telegram bot')
    return null
  }

  bot = new Telegraf<{ session: MenuSession }>(config.telegram.botToken)

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
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/telegram/bot.ts
git commit -m "refactor(telegram): session middleware, menu registration, keep approvals"
```

---

### Task 4: Create MenuController and dashboard view

**Files:**
- Create: `backend/src/telegram/menu/index.ts`
- Create: `backend/src/telegram/menu/views/dashboard.ts`

- [ ] **Step 1: Create MenuController**

```typescript
import { Telegraf, Markup } from 'telegraf'
import { MenuSession } from '../bot.js'
import { logger } from '../core/logger.js'
import * as dashboard from './views/dashboard.js'

interface ViewModule {
  render: (ctx: any) => Promise<{ text: string; buttons: ReturnType<typeof Markup.inlineKeyboard> }>
}

export class MenuController {
  private bot: Telegraf<{ session: MenuSession }>
  private views = new Map<string, ViewModule>()

  constructor(bot: Telegraf<{ session: MenuSession }>) {
    this.bot = bot
    this.views.set('dashboard', dashboard)
  }

  registerView(name: string, view: ViewModule) {
    this.views.set(name, view)
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
```

- [ ] **Step 2: Create dashboard view**

```typescript
import { Markup } from 'telegraf'
import { queryAll, queryOne } from '../../db/index.js'
import { formatCurrency } from '../../components/formatting.js'

export async function render(ctx: any) {
  const snap = queryOne('SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any
  const tradesToday = queryAll("SELECT COUNT(*) as count FROM trades WHERE date(created_at) = date('now')") as any
  const pendingCount = queryAll("SELECT COUNT(*) as count FROM trades WHERE status = 'PENDING'") as any
  const openPos = queryAll("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'") as any
  const maxRow = queryOne('SELECT value FROM settings WHERE key = ?', ['max_open_positions']) as any

  const totalValue = snap ? Number(snap.total_value_usd) : 0
  const openCount = (openPos?.[0] as any)?.count ?? 0
  const maxOpen = maxRow ? parseInt(maxRow.value as string) : 5
  const tradesCount = (tradesToday?.[0] as any)?.count ?? 0
  const pending = (pendingCount?.[0] as any)?.count ?? 0

  const lines = [
    '📊 Dashboard',
    '━━━━━━━━━━━━━━━━━━',
    `💰 Portfolio: ${formatCurrency(totalValue)}`,
    `📈 Open Positions: ${openCount} / ${maxOpen}`,
    `🔄 Trades Today: ${tradesCount}`,
    `⏳ Pending Approvals: ${pending}`,
  ]

  const hits = queryAll(
    "SELECT coin, status, created_at FROM positions WHERE status IN ('SL_HIT','TP_HIT') ORDER BY created_at DESC LIMIT 5"
  ) as any[]
  if (hits.length > 0) {
    lines.push('')
    for (const h of hits) {
      const icon = h.status === 'SL_HIT' ? '🛑' : '✅'
      lines.push(`${icon} ${h.coin} — ${h.status === 'SL_HIT' ? 'Stop Loss' : 'Take Profit'}`)
    }
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/telegram/menu/index.ts backend/src/telegram/menu/views/dashboard.ts
git commit -m "feat(telegram): MenuController + dashboard view"
```

---

### Task 5: Create portfolio view

**Files:**
- Create: `backend/src/telegram/menu/views/portfolio.ts`

- [ ] **Step 1: Create portfolio view**

```typescript
import { Markup } from 'telegraf'
import { queryAll, queryOne } from '../../db/index.js'
import { formatCurrency, formatPnlPct } from '../../components/formatting.js'

export async function render(ctx: any) {
  const positions = queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as any[]

  let lines: string[] = []
  if (positions.length === 0) {
    lines.push('💼 Portfolio', '', 'No open positions.')
  } else {
    let { getExchange } = await import('../../trader/service.js')
    let exchange: any
    try { exchange = getExchange() } catch { exchange = null }

    lines.push(`💼 Portfolio — ${positions.length} Open Position${positions.length > 1 ? 's' : ''}`, '')
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]
      let currentPrice = Number(p.entry_price)
      if (exchange) {
        try {
          const ticker = await exchange.fetchTicker(p.coin as string)
          currentPrice = ticker.last || currentPrice
        } catch {}
      }
      const pnl = Number(p.quantity) * (currentPrice - Number(p.entry_price))
      const pnlPct = ((currentPrice - Number(p.entry_price)) / Number(p.entry_price)) * 100
      const emoji = pnl >= 0 ? '🟢' : '🔴'
      lines.push(
        `#${i + 1} ${p.coin}`,
        `   ${Number(p.quantity)} @ ${formatCurrency(Number(p.entry_price))}`,
        `   → ${formatCurrency(currentPrice)}  ${emoji} ${formatPnlPct(pnlPct)}`,
        `   SL: ${formatCurrency(Number(p.stop_loss))}  TP: ${p.take_profit ? formatCurrency(Number(p.take_profit)) : '—'}`
      )
      if (i < positions.length - 1) lines.push('')
    }
  }

  const snap = queryOne('SELECT holdings FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1') as any
  if (snap) {
    const holdings = JSON.parse(snap.holdings as string)
    const entries = Object.entries(holdings).filter(([, v]) => Number(v) > 0)
    if (entries.length > 0) {
      lines.push('', 'Holdings:')
      for (const [coin, qty] of entries) {
        lines.push(`   ${coin}: ${Number(qty)}`)
      }
    }
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/telegram/menu/views/portfolio.ts
git commit -m "feat(telegram): portfolio view with live prices"
```

---

### Task 6: Create trades view with pagination

**Files:**
- Create: `backend/src/telegram/menu/views/trades.ts`

- [ ] **Step 1: Create trades view**

```typescript
import { Markup } from 'telegraf'
import { queryAll } from '../../db/index.js'
import { formatCurrency, formatTime, tradeStatusEmoji } from '../../components/formatting.js'
import { paginationButtons, paginate } from '../../components/pagination.js'

const PER_PAGE = 5

export async function render(ctx: any) {
  const allTrades = queryAll('SELECT * FROM trades ORDER BY created_at DESC LIMIT 50') as any[]
  if (allTrades.length === 0) {
    return { text: '📜 Trade History\n\nNo trades yet.', buttons: [] }
  }

  const viewKey = 'trades'
  const state = ctx.session.pagination[viewKey] || { page: 0 }
  const { pageItems, totalPages } = paginate(allTrades, state.page, PER_PAGE)
  ctx.session.pagination[viewKey] = { page: state.page }

  const lines = [`📜 Trade History (Page ${state.page + 1}/${totalPages})`, '']
  for (const t of pageItems) {
    const time = formatTime(t.created_at as string)
    lines.push(`${tradeStatusEmoji(t.status as string)} ${time} ${t.side} ${t.quantity} ${t.coin} @ ${formatCurrency(Number(t.price))} — ${formatCurrency(Number(t.total))}`)
  }

  const nav = paginationButtons({ page: state.page, totalPages }, viewKey)
  return { text: lines.join('\n'), buttons: [nav] }
}
```

- [ ] **Step 2: Wire pagination actions in MenuController**

Add the following action handlers in `menu/index.ts` inside the `register()` method, after the existing actions:

```typescript
this.bot.action(/^page:(.+):(prev|next)$/, async (ctx) => {
  const viewName = ctx.match[1]
  const dir = ctx.match[2]
  const state = ctx.session.pagination[viewName]
  if (!state) return ctx.answerCbQuery()
  state.page = dir === 'next' ? state.page + 1 : state.page - 1
  await this.renderView(ctx, viewName)
})
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/telegram/menu/views/trades.ts backend/src/telegram/menu/index.ts
git commit -m "feat(telegram): trades view with pagination"
```

---

### Task 7: Create decisions view

**Files:**
- Create: `backend/src/telegram/menu/views/decisions.ts`

- [ ] **Step 1: Create decisions view**

```typescript
import { Markup } from 'telegraf'
import { queryAll } from '../../db/index.js'
import { actionEmoji } from '../../components/formatting.js'

export async function render(ctx: any) {
  const decisions = queryAll('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 20') as any[]
  if (decisions.length === 0) {
    return { text: '🧠 LLM Decisions\n\nNo decisions yet.', buttons: [] }
  }

  const lines = ['🧠 Recent Decisions', '']
  for (const d of decisions) {
    const coin = (d.coin as string).replace('/USDT', '')
    const pct = (Number(d.confidence) * 100).toFixed(0)
    const reason = (d.reason as string).length > 60 ? (d.reason as string).slice(0, 57) + '...' : d.reason
    lines.push(`${actionEmoji(d.action as string)} ${coin} → ${d.action}  ${pct}% — ${reason}`)
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/telegram/menu/views/decisions.ts
git commit -m "feat(telegram): decisions view"
```

---

### Task 8: Create pipeline view with cycle drill-down

**Files:**
- Create: `backend/src/telegram/menu/views/pipeline.ts`

- [ ] **Step 1: Create pipeline view**

```typescript
import { Markup } from 'telegraf'
import { queryAll } from '../../db/index.js'
import { actionEmoji, formatTime } from '../../components/formatting.js'

export async function render(ctx: any) {
  const cycles = queryAll(
    `SELECT cycle_id, coin,
            MAX(CASE WHEN stage = 'pipeline_error' THEN 1 ELSE 0 END) as has_error,
            MAX(CASE WHEN stage = 'signal_generated' THEN 1 ELSE 0 END) as has_signal,
            MAX(created_at) as last_event
     FROM pipeline_events
     GROUP BY cycle_id
     ORDER BY last_event DESC
     LIMIT 10`
  ) as any[]

  if (cycles.length === 0) {
    return { text: '🔬 Pipeline Cycles\n\nNo pipeline activity yet.', buttons: [] }
  }

  const lines = ['🔬 Pipeline Cycles', '']
  const buttons: ReturnType<typeof Markup.button.callback>[] = []
  for (const c of cycles) {
    const coin = (c.coin as string).replace('/USDT', '')
    let status
    if (c.has_error) status = '🔴 ERROR'
    else if (c.has_signal) status = '✅ Complete'
    else status = '⏳ Active'
    const time = formatTime(c.last_event as string)
    lines.push(`${coin} — ${status} (${time})`)
    buttons.push(Markup.button.callback(`${coin} — ${status}`, `cycle:${c.cycle_id}`))
  }

  return {
    text: lines.join('\n'),
    buttons: [buttons],
  }
}

export async function renderCycle(ctx: any, cycleId: string) {
  const events = queryAll(
    'SELECT * FROM pipeline_events WHERE cycle_id = ? ORDER BY created_at ASC',
    [cycleId]
  ) as any[]

  if (events.length === 0) {
    return { text: 'Cycle not found.', buttons: [] }
  }

  const coin = (events[0].coin as string).replace('/USDT', '')
  const lines = [`🔬 Pipeline — ${coin}`, '']

  for (const e of events) {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    const stage = e.stage as string
    switch (stage) {
      case 'research_started':
        lines.push(`🔍 Research started...`)
        break
      case 'research_completed':
        lines.push(`📰 Research: ${data.headlines?.length || 0} articles (${data.sentiment || 'N/A'})`)
        if (data.headlines?.slice(0, 3).forEach((h: string) => lines.push(`   • ${h}`)))
        break
      case 'extraction_started':
        lines.push(`📋 Extracting from ${data.articleCount || 0} articles...`)
        break
      case 'extraction_completed':
        lines.push(`📋 Extraction done — sentiment: ${data.aggregated_sentiment || 'N/A'}`)
        break
      case 'analysis_started':
        lines.push(`📊 Analyzing ${coin} @ ${data.price}...`)
        if (data.rsi14) lines.push(`   RSI: ${data.rsi14} | Trend: ${data.trend}`)
        break
      case 'signal_generated':
        lines.push(`📈 Signal: ${actionEmoji(data.action)} ${data.action} @ ${(Number(data.confidence) * 100).toFixed(0)}%`)
        if (data.reason) lines.push(`   ${data.reason}`)
        break
      case 'pipeline_error':
        lines.push(`❌ Error: ${data.error || 'Unknown'}`)
        break
    }
  }

  return { text: lines.join('\n'), buttons: [] }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/telegram/menu/views/pipeline.ts
git commit -m "feat(telegram): pipeline view with cycle drill-down"
```

---

### Task 9: Create settings view with edit capability

**Files:**
- Create: `backend/src/telegram/menu/views/settings.ts`

- [ ] **Step 1: Create settings view**

```typescript
import { Markup } from 'telegraf'
import { getSettings, updateSetting } from '../../db/index.js'

const SETTING_LABELS: Record<string, string> = {
  interval_minutes: 'Interval (min)',
  min_confidence: 'Min Confidence',
  max_position_size_usd: 'Max Position ($)',
  stop_loss_atr: 'Stop Loss ATR',
  take_profit_atr: 'Take Profit ATR',
  max_risk_per_trade: 'Max Risk (%)',
  max_open_positions: 'Max Positions',
}

export async function render(ctx: any) {
  const settings = getSettings()
  const lines = ['⚙️ Settings', '']
  lines.push(`Watchlist: ${settings.watchlist.join(', ') || '(empty)'}`)
  lines.push(`Interval: ${settings.interval_minutes} min`)
  lines.push(`Min Confidence: ${(settings.min_confidence * 100).toFixed(0)}%`)
  lines.push(`Max Position: $${settings.max_position_size_usd}`)
  lines.push(`${settings.approval_required ? '✅' : '❌'} Approval Required`)
  lines.push(`Stop Loss ATR: ${settings.stop_loss_atr.toFixed(1)}`)
  lines.push(`Take Profit ATR: ${settings.take_profit_atr.toFixed(1)}`)
  lines.push(`Max Risk: ${(settings.max_risk_per_trade * 100).toFixed(0)}%`)
  lines.push(`Max Positions: ${settings.max_open_positions}`)

  const editButtons = [
    Markup.button.callback('✏️ Edit Watchlist', 'setting:edit:watchlist'),
    Markup.button.callback('✏️ Toggle Approval', 'setting:toggle:approval_required'),
    Markup.button.callback('✏️ Edit Interval', 'setting:edit:interval_minutes'),
  ]

  return {
    text: lines.join('\n'),
    buttons: [editButtons],
  }
}
```

- [ ] **Step 2: Wire settings actions in MenuController**

Add to `menu/index.ts` `register()` method:

```typescript
this.bot.action('setting:toggle:approval_required', async (ctx) => {
  const settings = getSettings()
  updateSetting('approval_required', String(!settings.approval_required))
  await ctx.answerCbQuery(`Approval required: ${!settings.approval_required}`)
  await this.renderView(ctx, 'settings')
})

this.bot.action(/^setting:edit:(.+)$/, async (ctx) => {
  const key = ctx.match[1]
  await ctx.editMessageText(
    `Send the new value for "${SETTING_LABELS[key] || key}" as a message.\n\nReply with /set ${key} <value> to update.`
  )
  await ctx.answerCbQuery()
})
```

Add `/set` command in `register()`:

```typescript
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
```

Add import at top:

```typescript
import { getSettings, updateSetting } from '../db/index.js'
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/telegram/menu/views/settings.ts backend/src/telegram/menu/index.ts
git commit -m "feat(telegram): settings view with toggle + edit"
```

---

### Task 10: Create approvals view

**Files:**
- Create: `backend/src/telegram/menu/views/approvals.ts`

- [ ] **Step 1: Create approvals view**

```typescript
import { Markup } from 'telegraf'
import { queryAll } from '../../db/index.js'
import { formatCurrency } from '../../components/formatting.js'
import { bus } from '../../core/events.js'

export async function render(ctx: any) {
  const pending = queryAll("SELECT * FROM trades WHERE status = 'PENDING' ORDER BY created_at ASC") as any[]
  if (pending.length === 0) {
    return { text: '✅ Pending Approvals\n\nNo pending approvals.', buttons: [] }
  }

  const lines = [`✅ Pending Approvals (${pending.length})`, '']
  const buttons: ReturnType<typeof Markup.button.callback>[][] = []

  for (const t of pending) {
    lines.push(
      `⚠️ ${t.side} ${t.quantity} ${t.coin} — ${formatCurrency(Number(t.total))}`,
      `Confidence: ${t.confidence || 'N/A'}`,
      ``
    )
    buttons.push([
      Markup.button.callback(`✅ Approve #${t.id}`, `approve:${t.id}`),
      Markup.button.callback(`❌ Reject #${t.id}`, `reject:${t.id}`),
    ])
  }

  return { text: lines.join('\n'), buttons }
}
```

- [ ] **Step 2: Wire approve/reject actions in MenuController**

Add to `menu/index.ts` `register()`:

```typescript
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
```

- [ ] **Step 3: Register approvals view in MenuController constructor**

In `menu/index.ts` constructor, add:

```typescript
import * as approvals from './views/approvals.js'
// in constructor:
this.views.set('approvals', approvals)
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/telegram/menu/views/approvals.ts backend/src/telegram/menu/index.ts
git commit -m "feat(telegram): approvals view with approve/reject buttons"
```

---

### Task 11: Register remaining views in MenuController

**Files:**
- Modify: `backend/src/telegram/menu/index.ts`

- [ ] **Step 1: Add all remaining view imports and registrations**

Update constructor in `menu/index.ts`:

```typescript
import * as dashboard from './views/dashboard.js'
import * as portfolio from './views/portfolio.js'
import * as trades from './views/trades.js'
import * as decisions from './views/decisions.js'
import * as pipeline from './views/pipeline.js'
import * as settings from './views/settings.js'
import * as approvals from './views/approvals.js'

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
```

- [ ] **Step 2: Remove `registerView` method if unused**

- [ ] **Step 3: Commit**

```bash
git add backend/src/telegram/menu/index.ts
git commit -m "feat(telegram): register all menu views"
```

---

### Task 12: Create notifier module for push notifications

**Files:**
- Create: `backend/src/telegram/notifier.ts`

- [ ] **Step 1: Create notifier.ts**

```typescript
import { bus } from '../core/events.js'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { queryAll, queryOne } from '../db/index.js'
import { formatCurrency, formatPnlPct } from '../components/formatting.js'
import { getBot } from './bot.js'

function send(text: string) {
  const bot = getBot()
  if (!bot || !config.telegram.chatId) return
  bot.telegram.sendMessage(config.telegram.chatId, text, { disable_web_page_preview: true }).catch((err) => {
    logger.warn('Telegram send failed', { error: err.message })
  })
}

export function startNotifier() {
  send('✅ CryptoBot started — monitoring markets')

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
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/telegram/notifier.ts
git commit -m "feat(telegram): push notifications for trades, alerts, errors"
```

---

### Task 13: Wire notifier in backend/index.ts

**Files:**
- Modify: `backend/src/telegram/index.ts` — export `startNotifier`
- Modify: `backend/src/index.ts` — call `startNotifier` after `startTelegramBot`

- [ ] **Step 1: Update telegram/index.ts exports**

```typescript
export { startTelegramBot, sendApprovalMessage, getBot } from './bot.js'
export { startNotifier } from './notifier.js'
```

- [ ] **Step 2: Wire notifier in backend/src/index.ts**

Add import:
```typescript
import { startTelegramBot, sendApprovalMessage, startNotifier } from './telegram/index.js'
```

After `startTelegramBot()` call, add:
```typescript
startNotifier()
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/telegram/index.ts backend/src/index.ts
git commit -m "feat: wire Telegram notifier on startup"
```

---

### Task 14: Verify build compiles

- [ ] **Step 1: Run TypeScript check**

```bash
cd backend && npx tsc --noEmit
```

Fix any compilation errors.

- [ ] **Step 2: Commit any fixes**

```bash
git add -A && git commit -m "fix: compilation fixes"
```
