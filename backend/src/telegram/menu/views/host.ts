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

  const tempEmoji = (t: number) => (t >= 80 ? '🔥' : t >= 60 ? '🌡️' : '❄️')
  if (h.temperature.sensors.length > 0) {
    lines.push('', `<b>Temperature</b>`)
    for (const s of h.temperature.sensors) {
      lines.push(`  ${tempEmoji(s.celsius)} ${esc(s.label)}  <b>${s.celsius.toFixed(1)}°C</b>`)
    }
    if (h.temperature.maxCelsius != null) {
      lines.push(`  <i>max ${h.temperature.maxCelsius.toFixed(1)}°C</i>`)
    }
  } else if (h.temperature.maxCelsius != null) {
    const t = h.temperature.maxCelsius
    lines.push('', `${tempEmoji(t)} Temp <b>${t.toFixed(1)}°C</b> (max)`)
  } else {
    lines.push('', '<i>🌡️ No temperature sensors available.</i>')
  }

  return {
    text: lines.join('\n'),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
