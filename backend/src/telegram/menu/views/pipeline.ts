import { Markup } from 'telegraf'
import { queryAll } from '../../../db/index.js'
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
