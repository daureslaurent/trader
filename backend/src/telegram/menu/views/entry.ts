import { Markup } from 'telegraf'
import { getActiveIntents, getRecentEvents } from '../../../entry/index.js'
import { formatCurrency, esc, coinLabel, timeAgo } from '../../components/formatting.js'

function pctFrom(target: number, base: number): string {
  if (!base) return ''
  const p = ((target - base) / base) * 100
  return ` <i>(${p >= 0 ? '+' : ''}${p.toFixed(2)}%)</i>`
}

export async function render(_ctx: any) {
  const intents = getActiveIntents()
  const events = getRecentEvents()

  const lines = ['🎯 <b>Entry Desk</b>', '']

  if (intents.length === 0) {
    lines.push('<i>No deferred BUYs waiting for a fill.</i>')
  } else {
    lines[0] = `🎯 <b>Entry Desk</b> — ${intents.length} watching`
    for (const it of intents) {
      const coin = coinLabel(it.coin)
      const srcBadge = it.bandSource === 'llm' ? '🧠 AI levels' : '⚙️ static'
      lines.push(
        `<b>${coin}</b>  ·  ${srcBadge}`,
        `  Signal      ${formatCurrency(it.signalPrice)}`,
        `  🎯 Target   ${formatCurrency(it.targetPrice)}${pctFrom(it.targetPrice, it.signalPrice)}`,
        `  🛑 Invalid  ${formatCurrency(it.invalidatePrice)}${pctFrom(it.invalidatePrice, it.signalPrice)}`,
        `  🏃 Chase    ${formatCurrency(it.chaseCapPrice)}${pctFrom(it.chaseCapPrice, it.signalPrice)}`,
        `  💵 Deploy   ${formatCurrency(it.notionalUsdc)}  ·  TTL ${timeAgoUntil(it.expiresAt)}`,
      )
      if (it.planReason) lines.push(`  <i>${esc(it.planReason)}</i>`)
      lines.push('')
    }
  }

  if (events.length > 0) {
    lines.push('<b>Recent activity</b>')
    for (const e of events.slice(0, 6)) {
      const coin = coinLabel(e.coin)
      const when = timeAgo(new Date(e.at).toISOString())
      if (e.type === 'filled') {
        const slip = e.slippagePct != null ? `  <i>(${e.slippagePct >= 0 ? '+' : ''}${e.slippagePct.toFixed(2)}% vs signal)</i>` : ''
        lines.push(`✅ <b>${coin}</b> filled @ ${e.price != null ? formatCurrency(e.price) : '—'}${slip}  ·  <i>${when}</i>`)
      } else if (e.type === 'cancelled') {
        lines.push(`🚫 <b>${coin}</b> cancelled — ${esc(e.reason ?? '')}  ·  <i>${when}</i>`)
      } else {
        lines.push(`📝 <b>${coin}</b> registered @ ${formatCurrency(e.signalPrice)}  ·  <i>${when}</i>`)
      }
    }
  }

  return {
    text: lines.join('\n').trimEnd(),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}

function timeAgoUntil(epochMs: number): string {
  const ms = epochMs - Date.now()
  if (ms <= 0) return 'expired'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
