import { Markup } from 'telegraf'
import { getLatestSummary, isRunning } from '../../../summary/index.js'
import { formatCurrency, esc, timeAgo } from '../../components/formatting.js'

const HEALTH_EMOJI: Record<string, string> = { strong: '🟢', stable: '🟢', cautious: '🟡', at_risk: '🔴' }
const RISK_EMOJI: Record<string, string> = { low: '🟢', moderate: '🟡', elevated: '🟠', high: '🔴' }

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
}

export async function render(_ctx: any) {
  const running = isRunning()
  const s = await getLatestSummary()

  const lines = ['🧭 <b>Portfolio Summary</b>', '']

  if (running) lines.push('⏳ <i>A new summary is being generated…</i>', '')

  if (!s) {
    lines.push('<i>No summaries yet.</i> Tap “Generate now” to create one.')
    return {
      text: lines.join('\n'),
      buttons: [[Markup.button.callback(running ? '⏳ Generating…' : '✨ Generate now', running ? 'noop' : 'run:summary')]],
    }
  }

  if (s.health) lines.push(`Health   ${HEALTH_EMOJI[s.health] ?? ''} <b>${esc(s.health.replace('_', ' '))}</b>`)
  if (s.risk_level) lines.push(`Risk     ${RISK_EMOJI[s.risk_level] ?? ''} <b>${esc(s.risk_level)}</b>`)

  try {
    const snap = JSON.parse(s.snapshot) as { totalValueUsd?: number; valueChangePct?: number | null }
    if (typeof snap.totalValueUsd === 'number') {
      const chg = typeof snap.valueChangePct === 'number' ? ` <i>(${snap.valueChangePct >= 0 ? '+' : ''}${snap.valueChangePct.toFixed(2)}%)</i>` : ''
      lines.push(`Value    <b>${formatCurrency(snap.totalValueUsd)}</b>${chg}`)
    }
  } catch { /* ignore */ }

  lines.push('', esc(s.summary))

  if (s.what_happened) lines.push('', '<b>What happened</b>', esc(s.what_happened))

  const observations = parseList(s.observations).slice(0, 5)
  if (observations.length) {
    lines.push('', '<b>Observations</b>')
    observations.forEach(o => lines.push(`  • ${esc(o)}`))
  }

  const suggestions = parseList(s.suggestions).slice(0, 5)
  if (suggestions.length) {
    lines.push('', '<b>Suggestions</b>')
    suggestions.forEach(x => lines.push(`  • ${esc(x)}`))
  }

  lines.push('', `<i>${timeAgo(s.created_at)}${s.model ? ` · ${esc(s.model)}` : ''}</i>`)

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback(running ? '⏳ Generating…' : '✨ Generate now', running ? 'noop' : 'run:summary')]],
  }
}
