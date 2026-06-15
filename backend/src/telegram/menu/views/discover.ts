import { Markup } from 'telegraf'
import { getDiscoveries, isRunning } from '../../../discoverer/index.js'
import { esc, coinLabel, timeAgo } from '../../components/formatting.js'
import { paginate, paginationButtons } from '../../components/pagination.js'

const PER_PAGE = 6

const STATUS_BADGE: Record<string, string> = {
  pending: '🆕 pending',
  approved: '✅ approved',
  rejected: '❌ rejected',
  auto_added: '⭐ auto-added',
}

function scoreEmoji(score: number): string {
  if (score >= 8) return '🔥'
  if (score >= 6) return '👍'
  if (score >= 4) return '🤔'
  return '🥶'
}

export async function render(ctx: any) {
  const running = isRunning()
  const all = await getDiscoveries(50)

  const viewKey = 'discover'
  const state = ctx.session.pagination[viewKey] || { page: 0 }
  const { pageItems, totalPages } = paginate(all, state.page, PER_PAGE)
  ctx.session.pagination[viewKey] = { page: Math.min(state.page, totalPages - 1) }

  const lines = ['🔭 <b>Discoveries</b>', '']
  if (running) lines.push('⏳ <i>Discovery run in progress…</i>', '')

  const buttons: ReturnType<typeof Markup.button.callback>[][] = []

  if (all.length === 0) {
    lines.push('<i>No discoveries yet.</i> Tap “Run discovery” to scan for candidates.')
  } else {
    lines[0] = `🔭 <b>Discoveries</b>  <i>Page ${state.page + 1}/${totalPages}</i>`
    for (const d of pageItems) {
      const coin = coinLabel(d.coin)
      const score = Number(d.score)
      lines.push(
        `${scoreEmoji(score)} <b>${coin}</b>  ·  score <b>${score.toFixed(1)}</b>  ·  ${STATUS_BADGE[d.status] ?? d.status}`,
      )
      const reason = String(d.reasoning).length > 130 ? String(d.reasoning).slice(0, 127) + '…' : String(d.reasoning)
      lines.push(`  <i>${esc(reason)}</i>`, `  <i>${timeAgo(d.created_at)}</i>`, '')
      if (d.status === 'pending') {
        buttons.push([
          Markup.button.callback(`✅ Add ${coin}`, `discover:approve:${d.id}`),
          Markup.button.callback(`❌ Reject`, `discover:reject:${d.id}`),
        ])
      }
    }
  }

  const nav = paginationButtons({ page: state.page, totalPages }, viewKey)
  buttons.push([Markup.button.callback(running ? '⏳ Running…' : '🔍 Run discovery', running ? 'noop' : 'run:discovery')])
  if (totalPages > 1) buttons.push(nav)

  return { text: lines.join('\n').trimEnd(), buttons }
}
