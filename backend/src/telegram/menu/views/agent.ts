import { Markup } from 'telegraf'
import { listConversations, getConversation } from '../../../agent/index.js'
import { esc, timeAgo } from '../../components/formatting.js'

export async function render(ctx: any) {
  const activeId: number | undefined = ctx.session.agent?.conversationId
  const conversations = await listConversations(8)

  const lines = ['💬 <b>AI Agent</b>', '']

  if (activeId) {
    const convo = await getConversation(activeId)
    lines.push(
      `🟢 <b>Active chat:</b> ${esc(convo?.title ?? `#${activeId}`)}`,
      '',
      'Just send a message and I’ll answer using your live portfolio, positions, market data, signals and more.',
    )
  } else {
    lines.push(
      'Ask me anything about your bot — portfolio, positions, market, signals, discoveries…',
      '',
      'Start a new chat or resume a recent one, then type your question.',
    )
  }

  const buttons: ReturnType<typeof Markup.button.callback>[][] = []
  buttons.push([Markup.button.callback('🆕 New chat', 'agent:new')])
  if (activeId) buttons.push([Markup.button.callback('⏹ End chat', 'agent:end')])

  if (conversations.length) {
    lines.push('', '<b>Recent chats</b>')
    for (const c of conversations) {
      const mark = c.id === activeId ? '🟢 ' : ''
      lines.push(`${mark}• ${esc(c.title)}  <i>${timeAgo(c.updated_at ?? c.created_at)}</i>`)
      if (c.id !== activeId) {
        buttons.push([Markup.button.callback(`💬 ${c.title.slice(0, 40)}`, `agent:conv:${c.id}`)])
      }
    }
  }

  return { text: lines.join('\n'), buttons }
}
