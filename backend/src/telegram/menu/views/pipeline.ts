import { Markup } from 'telegraf'
import { pipelineEvents } from '../../../db/index.js'
import { actionEmoji, formatDate, esc } from '../../components/formatting.js'

export async function render(_ctx: any) {
  const cycles = await pipelineEvents.aggregate([
    {
      $group: {
        _id: '$cycle_id',
        coin: { $first: '$coin' },
        has_error: { $max: { $cond: [{ $in: ['$stage', ['pipeline_error', 'pipeline_failed', 'pipeline_timeout', 'pipeline_cancelled', 'discovery_error']] }, 1, 0] } },
        is_cancelled: { $max: { $cond: [{ $eq: ['$stage', 'pipeline_cancelled'] }, 1, 0] } },
        has_signal: { $max: { $cond: [{ $in: ['$stage', ['signal_generated', 'discovery_completed']] }, 1, 0] } },
        last_event: { $max: '$created_at' },
      },
    },
    { $sort: { last_event: -1 } },
    { $limit: 10 },
    { $project: { _id: 0, cycle_id: '$_id', coin: 1, has_error: 1, is_cancelled: 1, has_signal: 1, last_event: 1 } },
  ]) as any[]

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
  const events = await pipelineEvents.find(
    { cycle_id: cycleId }, { sort: { created_at: 1 } },
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
