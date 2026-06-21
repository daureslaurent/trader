// The Coach Agent's global "lessons" channel, formatted for injection into the Analyst
// and Monitor prompts. The Coach (agent/coach.ts) audits how the agents are deciding and
// appends cross-cutting corrections to the coach_memory log; this is the read side those
// consumers use so the corrections actually reach the next decision.
//
// Lives in core/ (not agent/) on purpose: the Monitor must not import from agent/ — that
// would reverse the one-way agent → monitor dependency — so the guidance read goes through
// the db repo directly here, a neutral home both the Analyst and Monitor can import.
import { coachMemory } from '../db/index.js'
import type { CoachMemory } from '../types.js'

const COACH_MEMORY_ID = 'global'

/**
 * A short "Coach guidance" block (most recent lessons last) to append to a decision agent's
 * prompt, or '' when the Coach has recorded nothing yet (so the caller appends nothing).
 */
export async function getCoachGuidanceBlock(maxNotes = 12): Promise<string> {
  const row = await coachMemory.findOne(
    { _id: COACH_MEMORY_ID }, { projection: { notes: 1 } },
  ) as { notes?: CoachMemory['notes'] } | null
  const notes = Array.isArray(row?.notes) ? row!.notes! : []
  if (!notes.length) return ''
  const lines = notes.slice(-Math.max(1, maxNotes)).map(n => `- ${n.text}`).join('\n')
  return `Coach guidance — standing lessons from the desk's process auditor; apply where relevant to this decision:\n${lines}`
}
