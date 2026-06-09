import { Markup } from 'telegraf'
import { queryAll } from '../../../db/index.js'
import { actionEmoji, formatDate, esc } from '../../components/formatting.js'

export async function render(_ctx: any) {
  const cycles = queryAll(
    `SELECT cycle_id, coin,
            MAX(CASE WHEN stage IN ('pipeline_error','pipeline_failed','pipeline_timeout','pipeline_cancelled','discovery_error') THEN 1 ELSE 0 END) as has_error,
            MAX(CASE WHEN stage = 'pipeline_cancelled' THEN 1 ELSE 0 END) as is_cancelled,
            MAX(CASE WHEN stage IN ('signal_generated','discovery_completed') THEN 1 ELSE 0 END) as has_signal,
            MAX(created_at) as last_event
     FROM pipeline_events
     GROUP BY cycle_id
     ORDER BY last_event DESC
     LIMIT 10`
  ) as any[]

  if (cycles.length === 0) {
    return { text: '🔬 <b>Pipeline Cycles</b>\n\nNo pipeline activity yet.', buttons: [] }
  }

  const lines = ['🔬 <b>Pipeline Cycles</b>', '']
  const buttons: ReturnType<typeof Markup.button.callback>[][] = []

  for (const c of cycles) {
    const coin = esc((c.coin as string).replace('/USDC', ''))
    let status: string
    if (c.is_cancelled) status = '🚫 Cancelled'
    else if (c.has_error) status = '🔴 Error'
    else if (c.has_signal) status = '✅ Done'
    else status = '⏳ Running'
    const time = formatDate(c.last_event as string)
    lines.push(`${status} <b>${coin}</b>  <i>${time}</i>`)
    buttons.push([Markup.button.callback(`${coin} — ${status}`, `cycle:${c.cycle_id}`)])
  }

  return { text: lines.join('\n'), buttons }
}

export async function renderCycle(_ctx: any, cycleId: string) {
  const events = queryAll(
    'SELECT * FROM pipeline_events WHERE cycle_id = ? ORDER BY created_at ASC',
    [cycleId]
  ) as any[]

  if (events.length === 0) {
    return { text: 'Cycle not found.', buttons: [] }
  }

  const coin = esc((events[0].coin as string).replace('/USDC', ''))
  const isDiscovery = cycleId.endsWith('-discovery') || events.some(e => String(e.stage).startsWith('discovery_'))
  const header = isDiscovery ? `🔍 <b>Discovery</b> — ${coin}` : `🔬 <b>Pipeline</b> — ${coin}`
  const lines = [header, '']

  for (const e of events) {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data ?? {})
    const stage = e.stage as string

    switch (stage) {
      // Trading pipeline stages
      case 'research_started':
        lines.push('🔍 Research started…')
        break
      case 'research_completed': {
        const count = data.headlines?.length ?? data.articles?.length ?? 0
        lines.push(`📰 Research done — ${count} articles`)
        if (Array.isArray(data.headlines)) {
          data.headlines.slice(0, 3).forEach((h: string) => lines.push(`  • ${esc(h)}`))
        }
        break
      }
      case 'extraction_started':
        lines.push(`📋 Extracting from ${data.articleCount ?? 0} articles…`)
        break
      case 'extraction_completed':
        lines.push(`📋 Extraction done  sentiment: <i>${esc(data.aggregated_sentiment ?? 'N/A')}</i>`)
        break
      case 'selection_started':
        lines.push(`🎯 Selecting from ${data.articleCount ?? 0} articles…`)
        break
      case 'selection_completed':
        lines.push(`🎯 Selected ${data.selectedCount ?? 0} / ${data.totalCount ?? 0} articles`)
        break
      case 'analysis_started':
        lines.push(
          `📊 Analysing ${esc(data.symbol ?? coin)} @ $${Number(data.price ?? 0).toFixed(2)}`,
          `  RSI: ${data.rsi14 ?? '—'}  Trend: ${esc(data.trend ?? '—')}  ATR: ${data.atr14 ?? '—'}`
        )
        break
      case 'signal_generated':
        lines.push(
          `📈 Signal: ${actionEmoji(data.action)} <b>${data.action}</b>  ${(Number(data.confidence ?? 0) * 100).toFixed(0)}%`,
          data.reason ? `  <i>${esc(String(data.reason))}</i>` : ''
        )
        break
      // Discovery stages
      case 'discovery_started':
        lines.push('🔍 Discovery started…')
        break
      case 'discovery_candidates_found':
        lines.push(`📡 Found ${data.count ?? 0} candidates`)
        break
      case 'discovery_evaluating':
        lines.push(`🔎 Evaluating ${esc(data.symbol ?? coin)}…`)
        break
      case 'discovery_scored':
        lines.push(`⭐ Score: <b>${Number(data.score ?? 0).toFixed(1)}</b>  ${esc(data.symbol ?? coin)}`)
        break
      case 'discovery_completed':
        lines.push(`✅ Discovery complete — ${data.count ?? 0} coins scored`)
        break
      // Error / status stages
      case 'pipeline_error':
      case 'discovery_error':
        lines.push(`❌ Error: ${esc(data.error ?? 'Unknown')}`)
        break
      case 'pipeline_failed':
        lines.push(`❌ Failed: ${esc(data.error ?? 'Unknown')}`)
        break
      case 'pipeline_cancelled':
        lines.push('🚫 Pipeline cancelled')
        break
      case 'pipeline_timeout':
        lines.push('⏱️ Pipeline timed out')
        break
    }
  }

  return { text: lines.filter(l => l !== '').join('\n'), buttons: [] }
}
