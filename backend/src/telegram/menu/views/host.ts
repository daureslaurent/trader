import { Markup } from 'telegraf'
import { getHostStats } from '../../../host/index.js'
import { esc, progressBar, formatBytes, formatUptime } from '../../components/formatting.js'

function gauge(label: string, pct: number): string {
  const hot = pct >= 90 ? '🔴' : pct >= 70 ? '🟠' : '🟢'
  return `${label}  ${hot} <code>${progressBar(pct)}</code> <b>${pct.toFixed(0)}%</b>`
}

export async function render(_ctx: any) {
  const h = await getHostStats()

  const lines = [
    '🖥️ <b>Host</b>',
    '',
    `<b>${esc(h.system.hostname)}</b>  ·  ${esc(h.system.platform)}/${esc(h.system.arch)}`,
    `Uptime ${formatUptime(h.system.uptimeSeconds)}  ·  Node ${esc(h.system.nodeVersion)}`,
    '',
    gauge('CPU ', h.cpu.usage),
    `  ${esc(h.cpu.model)}`,
    `  ${h.cpu.cores} cores @ ${(h.cpu.speedMhz / 1000).toFixed(1)} GHz  ·  load ${h.cpu.loadAvg.map(n => n.toFixed(2)).join(' / ')}`,
    '',
    gauge('RAM ', h.memory.usedPct),
    `  ${formatBytes(h.memory.usedBytes)} / ${formatBytes(h.memory.totalBytes)} used`,
  ]

  if (h.temperature.maxCelsius != null) {
    const t = h.temperature.maxCelsius
    const emoji = t >= 80 ? '🔥' : t >= 60 ? '🌡️' : '❄️'
    lines.push('', `${emoji} Temp <b>${t.toFixed(1)}°C</b> (max)`)
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
