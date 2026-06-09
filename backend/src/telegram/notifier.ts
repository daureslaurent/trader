import { bus } from '../core/events.js'
import { logger } from '../core/logger.js'
import { queryAll } from '../db/index.js'
import { formatCurrency, esc, coinLabel, formatPnlPct, pnlEmoji } from './components/formatting.js'
import { getBot, getChatId } from './bot.js'
import type { PositionRecord } from '../types.js'

function send(text: string): void {
  const bot = getBot()
  const chatId = getChatId()
  if (!bot || !chatId) return
  bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch((err) => {
    logger.warn('Telegram send failed', { error: err.message })
  })
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
  send(`✅ <b>CryptoBot started</b>\nMarkets are being monitored.`)

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
    send(lines.join('\n'))
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

    send(lines.join('\n'))
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

    send(lines.join('\n'))
  })

  // ── Portfolio snapshot ───────────────────────────────────────────────────────
  bus.on('portfolio_updated', () => {
    const snapshots = queryAll(
      'SELECT total_value_usd FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 2'
    ) as { total_value_usd: number }[]
    if (!snapshots.length) return

    const current = Number(snapshots[0].total_value_usd)
    const openCount = (queryAll(
      "SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'"
    ) as { count: number }[])[0]?.count ?? 0

    let changeStr = ''
    if (snapshots[1]) {
      const prev = Number(snapshots[1].total_value_usd)
      if (prev > 0) {
        const p = ((current - prev) / prev) * 100
        changeStr = `  <i>${p >= 0 ? '+' : ''}${p.toFixed(2)}%</i>`
      }
    }

    send(
      `📊 <b>Portfolio</b>  ${formatCurrency(current)}${changeStr}\n` +
      `  ${openCount} open position${openCount !== 1 ? 's' : ''}`
    )
  })

  // ── Trade failed ─────────────────────────────────────────────────────────────
  bus.on('trade_failed', ({ coin, side, error }: { coin: string; side: string; error: string }) => {
    send(
      `❌ <b>Trade Failed</b>  ${side} ${coinLabel(coin)}\n` +
      `<code>${SEP}</code>\n` +
      `<code>${esc(error)}</code>`
    )
  })

  // ── System error ─────────────────────────────────────────────────────────────
  bus.on('error', (err: Error) => {
    send(`❌ <b>Error:</b> ${esc(err.message)}`)
  })

  // ── New coin discovered ───────────────────────────────────────────────────────
  bus.on('coin_discovered', (result: { coin: string; score: number; status: string }) => {
    const coin = coinLabel(result.coin)
    const score = Number(result.score).toFixed(1)
    const tag = result.status === 'auto_added' ? '\n  → <b>Auto-added to watchlist</b>' : ''
    send(`🔍 <b>Discovered</b>  ${coin}  ·  score <b>${score}</b>${tag}`)
  })

  logger.info('Telegram notifier started')
}
