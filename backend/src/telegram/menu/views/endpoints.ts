import { Markup } from 'telegraf'
import { getEndpointHealth, runEndpointHealthCheck } from '../../../core/endpointHealth.js'
import { esc, timeAgo } from '../../components/formatting.js'

const STATUS_EMOJI: Record<string, string> = { up: '🟢', degraded: '🟡', down: '🔴', disabled: '⚪' }

function host(baseURL: string): string {
  try { return new URL(baseURL).host } catch { return baseURL.replace(/^https?:\/\//, '') }
}

export async function render(_ctx: any) {
  // Use the cached snapshot; probe on a cold cache so the view is never blank.
  let health = getEndpointHealth()
  if (health.length === 0) health = await runEndpointHealthCheck()

  const lines = ['🔌 <b>LLM Endpoints</b>', '']

  if (health.length === 0) {
    lines.push('<i>No endpoints configured.</i>')
    return {
      text: lines.join('\n'),
      buttons: [[Markup.button.callback('🔄 Re-check', 'run:endpoint-health')]],
    }
  }

  const counts = { up: 0, degraded: 0, down: 0, disabled: 0 }
  for (const h of health) counts[h.status]++
  lines[0] = `🔌 <b>LLM Endpoints</b> — 🟢 ${counts.up}  🟡 ${counts.degraded}  🔴 ${counts.down}  ⚪ ${counts.disabled}`

  for (const h of health) {
    const emoji = STATUS_EMOJI[h.status] ?? '❓'
    const latency = (h.status === 'up' || h.status === 'degraded') ? `  ·  ${h.latencyMs}ms` : ''
    lines.push(`${emoji} <b>${esc(h.name)}</b>  <i>(${esc(h.status)})</i>${latency}`)
    lines.push(`  <code>${esc(h.model || '—')}</code> @ ${esc(host(h.baseURL))}`)
    if (h.status === 'degraded' && !h.modelPresent) lines.push('  <i>⚠️ model not advertised by server</i>')
    if (h.status === 'down' && h.error) lines.push(`  <i>⚠️ ${esc(h.error)}</i>`)
    lines.push('')
  }

  const checkedAt = health[0]?.checkedAt
  if (checkedAt) lines.push(`<i>Last checked ${timeAgo(checkedAt)}</i>`)

  return {
    text: lines.join('\n').trimEnd(),
    buttons: [[Markup.button.callback('🔄 Re-check', 'run:endpoint-health')]],
  }
}
