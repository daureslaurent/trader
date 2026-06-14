// Persistence for Agent conversations and messages. Thin DB layer kept separate
// from the chat orchestration (service.ts) so the loop stays focused on the LLM.
import { agentConversations, agentMessages, nowSql } from '../db/index.js'
import type { AgentConversation, AgentMessage } from '../types.js'

export async function listConversations(limit = 100): Promise<AgentConversation[]> {
  return agentConversations.find(
    {}, { sort: { updated_at: -1 }, limit: Math.min(Math.max(limit, 1), 500) },
  ) as unknown as Promise<AgentConversation[]>
}

export async function getConversation(id: number): Promise<AgentConversation | null> {
  return agentConversations.findById(id) as unknown as Promise<AgentConversation | null>
}

export async function createConversation(title = 'New chat'): Promise<AgentConversation> {
  const now = nowSql()
  const id = await agentConversations.insert({
    title: title.slice(0, 200), total_tokens: 0, last_context_tokens: 0,
    created_at: now, updated_at: now,
  })
  return (await getConversation(Number(id)))!
}

export async function renameConversation(id: number, title: string): Promise<void> {
  await agentConversations.update({ _id: id }, { title: title.slice(0, 200) })
}

export async function touchConversation(id: number): Promise<void> {
  await agentConversations.update({ _id: id }, { updated_at: nowSql() })
}

// Record one finished turn's token usage on the conversation: add to the cumulative
// counter, and replace last_context_tokens with this turn's peak single-request size
// (the number that approaches the model's context window as the thread grows).
export async function recordConversationUsage(id: number, turnTokens: number, peakContextTokens: number): Promise<void> {
  await agentConversations.update(
    { _id: id },
    { $inc: { total_tokens: Math.max(0, Math.round(turnTokens)) }, $set: { last_context_tokens: Math.max(0, Math.round(peakContextTokens)) } },
  )
}

// Add to the cumulative token counter only (used by title generation, whose tiny
// request should count toward cost but must not move the context-window figure).
export async function addConversationTokens(id: number, tokens: number): Promise<void> {
  await agentConversations.update({ _id: id }, { $inc: { total_tokens: Math.max(0, Math.round(tokens)) } })
}

export async function deleteConversation(id: number): Promise<void> {
  await agentMessages.deleteMany({ conversation_id: id })
  await agentConversations.deleteOne({ _id: id })
}

export async function getMessages(conversationId: number): Promise<AgentMessage[]> {
  return agentMessages.find(
    { conversation_id: conversationId }, { sort: { id: 1 } },
  ) as unknown as Promise<AgentMessage[]>
}

export interface NewMessage {
  role: AgentMessage['role']
  content?: string | null
  tool_calls?: string | null
  tool_call_id?: string | null
  name?: string | null
}

export async function addMessage(conversationId: number, msg: NewMessage): Promise<AgentMessage> {
  const id = await agentMessages.insert({
    conversation_id: conversationId,
    role: msg.role,
    content: msg.content ?? null,
    tool_calls: msg.tool_calls ?? null,
    tool_call_id: msg.tool_call_id ?? null,
    name: msg.name ?? null,
    created_at: nowSql(),
  })
  return (await agentMessages.findById(Number(id))) as unknown as AgentMessage
}
