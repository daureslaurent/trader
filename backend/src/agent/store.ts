// Persistence for Agent conversations and messages. Thin DB layer kept separate
// from the chat orchestration (service.ts) so the loop stays focused on the LLM.
import { queryAll, queryOne, runSQL } from '../db/index.js'
import type { AgentConversation, AgentMessage } from '../types.js'

export function listConversations(limit = 100): AgentConversation[] {
  return queryAll(
    'SELECT * FROM agent_conversations ORDER BY updated_at DESC LIMIT ?',
    [Math.min(Math.max(limit, 1), 500)],
  ) as unknown as AgentConversation[]
}

export function getConversation(id: number): AgentConversation | null {
  return queryOne('SELECT * FROM agent_conversations WHERE id = ?', [id]) as AgentConversation | null
}

export function createConversation(title = 'New chat'): AgentConversation {
  const { lastInsertRowid } = runSQL(
    'INSERT INTO agent_conversations (title) VALUES (?)',
    [title.slice(0, 200)],
  )
  return getConversation(Number(lastInsertRowid))!
}

export function renameConversation(id: number, title: string): void {
  runSQL('UPDATE agent_conversations SET title = ? WHERE id = ?', [title.slice(0, 200), id])
}

export function touchConversation(id: number): void {
  runSQL("UPDATE agent_conversations SET updated_at = datetime('now') WHERE id = ?", [id])
}

// Record one finished turn's token usage on the conversation: add to the cumulative
// counter, and replace last_context_tokens with this turn's peak single-request size
// (the number that approaches the model's context window as the thread grows).
export function recordConversationUsage(id: number, turnTokens: number, peakContextTokens: number): void {
  runSQL(
    'UPDATE agent_conversations SET total_tokens = total_tokens + ?, last_context_tokens = ? WHERE id = ?',
    [Math.max(0, Math.round(turnTokens)), Math.max(0, Math.round(peakContextTokens)), id],
  )
}

// Add to the cumulative token counter only (used by title generation, whose tiny
// request should count toward cost but must not move the context-window figure).
export function addConversationTokens(id: number, tokens: number): void {
  runSQL('UPDATE agent_conversations SET total_tokens = total_tokens + ? WHERE id = ?', [Math.max(0, Math.round(tokens)), id])
}

export function deleteConversation(id: number): void {
  runSQL('DELETE FROM agent_messages WHERE conversation_id = ?', [id])
  runSQL('DELETE FROM agent_conversations WHERE id = ?', [id])
}

export function getMessages(conversationId: number): AgentMessage[] {
  return queryAll(
    'SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY id ASC',
    [conversationId],
  ) as unknown as AgentMessage[]
}

export interface NewMessage {
  role: AgentMessage['role']
  content?: string | null
  tool_calls?: string | null
  tool_call_id?: string | null
  name?: string | null
}

export function addMessage(conversationId: number, msg: NewMessage): AgentMessage {
  const { lastInsertRowid } = runSQL(
    `INSERT INTO agent_messages (conversation_id, role, content, tool_calls, tool_call_id, name)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      conversationId,
      msg.role,
      msg.content ?? null,
      msg.tool_calls ?? null,
      msg.tool_call_id ?? null,
      msg.name ?? null,
    ],
  )
  return queryOne('SELECT * FROM agent_messages WHERE id = ?', [Number(lastInsertRowid)]) as unknown as AgentMessage
}
