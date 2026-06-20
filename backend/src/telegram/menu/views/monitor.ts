import { Markup } from 'telegraf'
import { getReviews, getNotes } from '../../../monitor/index.js'
import { isMonitorRunning } from '../../../agent/index.js'
import { formatCurrency, esc, coinLabel, confidenceBar, timeAgo } from '../../components/formatting.js'

const ACTION_EMOJI: Record<string, string> = { HOLD: '⚪', CLOSE: '🔴', ADJUST: '⚙️' }

function fmtChange(oldVal: number | null, newVal: number | null): string | null {
  if (oldVal == null && newVal == null) return null
  const o = oldVal != null ? formatCurrency(oldVal) : '—'
  const n = newVal != null ? formatCurrency(newVal) : '—'
  return `${o} → <b>${n}</b>`
}

export async function render(_ctx: any) {
  const running = isMonitorRunning()
  const [reviews, notes] = await Promise.all([getReviews(20), getNotes()])

  const lines = ['🩺 <b>Monitor</b>', '']
  if (running) lines.push('⏳ <i>Monitor run in progress…</i>', '')

  if (reviews.length === 0) {
    lines.push('<i>No position reviews yet.</i>')
  } else {
    // Keep the most recent review per coin for a clean overview.
    const seen = new Set<string>()
    const latest = reviews.filter(r => {
      if (seen.has(r.coin)) return false
      seen.add(r.coin)
      return true
    })

    for (const r of latest) {
      const coin = coinLabel(r.coin)
      const emoji = ACTION_EMOJI[r.action] ?? '❓'
      const conf = Number(r.confidence)
      lines.push(`${emoji} <b>${coin}</b> → <b>${r.action}</b>  ${(conf * 100).toFixed(0)}%`)
      lines.push(`  <code>${confidenceBar(conf)}</code>`)
      const sl = fmtChange(r.old_stop_loss, r.new_stop_loss)
      const tp = fmtChange(r.old_take_profit, r.new_take_profit)
      if (sl) lines.push(`  SL ${sl}`)
      if (tp) lines.push(`  TP ${tp}`)
      const reason = String(r.reasoning).length > 140 ? String(r.reasoning).slice(0, 137) + '…' : String(r.reasoning)
      lines.push(`  <i>${esc(reason)}</i>`)
      lines.push(`  <i>${timeAgo(r.created_at)}</i>`, '')
    }
  }

  if (notes.length) {
    lines.push('<b>Notes</b>')
    for (const n of notes.slice(0, 8)) {
      const note = String((n as any).notes ?? '').trim()
      if (note) lines.push(`• <b>${coinLabel(n.coin)}</b>: <i>${esc(note.length > 120 ? note.slice(0, 117) + '…' : note)}</i>`)
    }
  }

  return {
    text: lines.join('\n').trimEnd(),
    buttons: [[Markup.button.callback(running ? '⏳ Running…' : '🔄 Run monitor', running ? 'noop' : 'run:monitor')]],
  }
}
