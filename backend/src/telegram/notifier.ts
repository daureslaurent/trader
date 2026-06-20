import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { positions as positionsRepo, portfolioSnapshots, getSettings } from '../db/index.js'
import { formatCurrency, esc, coinLabel, formatPnlPct, pnlEmoji } from './components/formatting.js'
import { getBot, getChatId } from './bot.js'
import type { PositionRecord, PortfolioSummary, BotSettings } from '../types.js'

function send(text: string): void {
  const bot = getBot()
  const chatId = getChatId()
  if (!bot || !chatId) return
  bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch((err) => {
    logger.warn('Telegram send failed', { error: err.message })
  })
}

// Per-event notification keys (each a boolean in settings). A notification is
// sent only when the master switch and the event's own toggle are both on.
type NotifyKey = Extract<keyof BotSettings, `telegram_notify_${string}`>

function notify(key: NotifyKey, text: string): void {
  const settings = getSettings()
  if (!settings.telegram_notify_enabled || !settings[key]) return
  send(text)
}

const SEP = '─────────────────'

function pct(value: number, base: number): string {
  const p = ((value - base) / base) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`
}

function duration(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h < 24) return `${h}h ${rem}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function formatSlTp(value: number | null, entry: number | null, label: string): string {
  if (value == null) return `  ${label.padEnd(12)} —`
  const pctStr = entry ? ` <i>(${pct(value, entry)})</i>` : ''
  return `  ${label.padEnd(12)} ${formatCurrency(value)}${pctStr}`
}

export function startNotifier() {
  notify('telegram_notify_startup', `✅ <b>CryptoBot started</b>\nMarkets are being monitored.`)

  // ── New position opened ──────────────────────────────────────────────────────
  bus.on('position_opened', (pos: PositionRecord) => {
    const coin = coinLabel(pos.coin)
    const total = pos.entry_price * pos.quantity
    const horizonTag = pos.horizon ? ` · <i>${pos.horizon}</i>` : ''

    const lines = [
      `🟢 <b>POSITION OPENED</b>`,
      `<code>${SEP}</code>`,
      `  <b>${coin}</b>${horizonTag}`,
      ``,
      `  Entry         ${formatCurrency(pos.entry_price)}`,
      `  Qty           ${pos.quantity.toFixed(6)}  <i>(~${formatCurrency(total)})</i>`,
      ``,
      formatSlTp(pos.stop_loss, pos.entry_price, 'Stop Loss'),
      formatSlTp(pos.take_profit ?? null, pos.entry_price, 'Take Profit'),
    ]
    notify('telegram_notify_position_opened', lines.join('\n'))
  })

  // ── Position closed (SL / TP / monitor / manual) ─────────────────────────────
  bus.on('position_closed', ({ coin, status, fillPrice, fillQty, pnl, entryPrice, openedAt }: {
    coin: string
    status: string
    fillPrice: number
    fillQty: number
    pnl: number | null
    entryPrice: number | null
    openedAt: string | null
  }) => {
    const label = status === 'SL_HIT' ? '🛑 STOP LOSS HIT'
      : status === 'TP_HIT' ? '✅ TAKE PROFIT HIT'
      : '🔴 POSITION CLOSED'
    const sym = coinLabel(coin)
    const pnlPct = (pnl != null && fillQty > 0 && entryPrice)
      ? ((fillPrice - entryPrice) / entryPrice) * 100
      : null
    const pnlLine = pnl != null
      ? `  PnL           ${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)}  ${pnlPct != null ? `<i>(${formatPnlPct(pnlPct)})</i>` : ''}  ${pnlPct != null ? pnlEmoji(pnlPct) : ''}`
      : ''
    const entryLine = entryPrice ? `  Entry         ${formatCurrency(entryPrice)}` : ''
    const dur = openedAt ? `\n  Duration      ${duration(openedAt)}` : ''

    const lines = [
      `${label}`,
      `<code>${SEP}</code>`,
      `  <b>${sym}</b>  ·  ${fillQty.toFixed(6)}`,
      ``,
      entryLine,
      `  Exit          ${formatCurrency(fillPrice)}`,
      ``,
      pnlLine,
      dur ? dur.trim() : '',
    ].filter(Boolean)

    notify('telegram_notify_position_closed', lines.join('\n'))
  })

  // ── SL/TP adjusted by monitor ────────────────────────────────────────────────
  bus.on('sl_tp_adjusted', ({ coin, oldStopLoss, oldTakeProfit, newStopLoss, newTakeProfit, currentPrice, entryPrice }: {
    coin: string
    oldStopLoss: number | null
    oldTakeProfit: number | null
    newStopLoss: number | null
    newTakeProfit: number | null
    currentPrice: number | null
    entryPrice: number | null
  }) => {
    const sym = coinLabel(coin)
    const base = entryPrice

    function fmtChange(oldVal: number | null, newVal: number | null): string {
      const oldStr = oldVal ? formatCurrency(oldVal) : '—'
      const newStr = newVal ? formatCurrency(newVal) : '—'
      const delta = (base && newVal && oldVal)
        ? `  <i>(${pct(newVal, oldVal)} vs prev)</i>`
        : ''
      const fromEntry = (base && newVal) ? `  <i>(${pct(newVal, base)} from entry)</i>` : ''
      return `${oldStr} → <b>${newStr}</b>${delta}${fromEntry}`
    }

    const priceStr = currentPrice ? `  Current       ${formatCurrency(currentPrice)}` : ''

    const lines = [
      `⚙️ <b>SL/TP ADJUSTED</b>`,
      `<code>${SEP}</code>`,
      `  <b>${sym}</b>`,
      ``,
      priceStr,
      ``,
      `  Stop Loss     ${fmtChange(oldStopLoss, newStopLoss)}`,
      `  Take Profit   ${fmtChange(oldTakeProfit, newTakeProfit)}`,
    ].filter(l => l !== undefined && l !== null)

    notify('telegram_notify_sl_tp_adjusted', lines.join('\n'))
  })

  // ── Portfolio snapshot ───────────────────────────────────────────────────────
  bus.on('portfolio_updated', async () => {
    const s = getSettings()
    if (!s.telegram_notify_enabled || !s.telegram_notify_portfolio) return
    const snapshots = await portfolioSnapshots.find(
      {}, { sort: { created_at: -1 }, limit: 2, projection: { total_value_usd: 1 } },
    ) as { total_value_usd: number }[]
    if (!snapshots.length) return

    const current = Number(snapshots[0].total_value_usd)
    const openCount = await positionsRepo.count({ status: 'OPEN' })

    let changeStr = ''
    if (snapshots[1]) {
      const prev = Number(snapshots[1].total_value_usd)
      if (prev > 0) {
        const p = ((current - prev) / prev) * 100
        changeStr = `  <i>${p >= 0 ? '+' : ''}${p.toFixed(2)}%</i>`
      }
    }

    notify('telegram_notify_portfolio',
      `📊 <b>Portfolio</b>  ${formatCurrency(current)}${changeStr}\n` +
      `  ${openCount} open position${openCount !== 1 ? 's' : ''}`
    )
  })

  // ── Trade failed ─────────────────────────────────────────────────────────────
  bus.on('trade_failed', ({ coin, side, error }: { coin: string; side: string; error: string }) => {
    notify('telegram_notify_trade_failed',
      `❌ <b>Trade Failed</b>  ${side} ${coinLabel(coin)}\n` +
      `<code>${SEP}</code>\n` +
      `<code>${esc(error)}</code>`
    )
  })

  // ── System error ─────────────────────────────────────────────────────────────
  bus.on('error', (err: Error) => {
    notify('telegram_notify_errors', `❌ <b>Error:</b> ${esc(err.message)}`)
  })

  // ── Portfolio summary produced ───────────────────────────────────────────────
  bus.on('portfolio_summary_created', (s: PortfolioSummary) => {
    const healthEmoji: Record<string, string> = { strong: '🟢', stable: '🟢', cautious: '🟡', at_risk: '🔴' }
    const riskEmoji: Record<string, string> = { low: '🟢', moderate: '🟡', elevated: '🟠', high: '🔴' }
    let totalLine = ''
    try {
      const snap = JSON.parse(s.snapshot) as { totalValueUsd?: number; valueChangePct?: number | null }
      if (typeof snap.totalValueUsd === 'number') {
        const chg = typeof snap.valueChangePct === 'number' ? `  <i>(${snap.valueChangePct >= 0 ? '+' : ''}${snap.valueChangePct.toFixed(2)}%)</i>` : ''
        totalLine = `  Value         ${formatCurrency(snap.totalValueUsd)}${chg}`
      }
    } catch { /* snapshot not parseable — skip the value line */ }

    const parseList = (raw: string | null): string[] => {
      if (!raw) return []
      try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
    }
    const suggestions = parseList(s.suggestions).slice(0, 3)

    const lines = [
      `🧭 <b>PORTFOLIO SUMMARY</b>`,
      `<code>${SEP}</code>`,
      s.health ? `  Health        ${healthEmoji[s.health] ?? ''} ${esc(s.health.replace('_', ' '))}` : '',
      s.risk_level ? `  Risk          ${riskEmoji[s.risk_level] ?? ''} ${esc(s.risk_level)}` : '',
      totalLine,
      ``,
      `${esc(s.summary)}`,
      s.what_happened ? `\n<b>What happened</b>\n${esc(s.what_happened)}` : '',
      suggestions.length ? `\n<b>Suggestions</b>\n${suggestions.map(x => `  • ${esc(x)}`).join('\n')}` : '',
    ].filter(Boolean)

    notify('telegram_notify_summary', lines.join('\n'))
  })

  // ── App update available ─────────────────────────────────────────────────────
  bus.on('update_available', ({ updateCount, currentShortSha, remoteShortSha, latestSubject }) => {
    const plural = updateCount === 1 ? 'commit' : 'commits'
    const lines = [
      `⬆️ <b>UPDATE AVAILABLE</b>`,
      `<code>${SEP}</code>`,
      `  <b>${updateCount}</b> new ${plural} on <code>main</code>`,
      `  <code>${esc(currentShortSha)}</code> → <code>${esc(remoteShortSha)}</code>`,
      latestSubject ? `\n  Latest: ${esc(latestSubject)}` : '',
      `\n  Open <b>System</b> in the app to review and update.`,
    ].filter(Boolean)
    notify('telegram_notify_update', lines.join('\n'))
  })

  // ── New coin discovered ───────────────────────────────────────────────────────
  bus.on('coin_discovered', (result: { coin: string; score: number; status: string }) => {
    const coin = coinLabel(result.coin)
    const score = Number(result.score).toFixed(1)
    const tag = result.status === 'auto_added' ? '\n  → <b>Auto-added to watchlist</b>' : ''
    notify('telegram_notify_discovery', `🔍 <b>Discovered</b>  ${coin}  ·  score <b>${score}</b>${tag}`)
  })

  logger.info('Telegram notifier started')
}
