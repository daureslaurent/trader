// The agent registry — the single source of truth for the app's tool-calling agents
// and what each one is allowed to do with the SHARED tool belt (tools.ts).
//
// Every agent draws from the one `TOOLS` catalog; an agent's access to each tool is a
// per-(agent, tool) grant: 'off' (not exposed), 'read' (exposed; read-only tools run
// normally, write/action tools are exposed but their side effect is suppressed), or
// 'readwrite' (full access, only meaningful for write tools). Each agent has a built-in
// DEFAULT grant per tool; the user can override individual cells in
// Settings → Agent → Agentic Tools (persisted to the `agent_tool_permissions` setting).
//
// To add a new tool-calling agent: append an AgentDef here and have the engine build its
// schema with getAgentToolSchemas(id) and execute with runAgentTool(id, …). It then shows
// up automatically in the Agentic Tools settings UI (driven by getAgenticToolsConfig).
import { getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import type { AgentToolPermission } from '../types.js'
import {
  TOOLS, AgentTool, MONITOR_TOOL_NAMES, AGENT_SIGNAL_TOOL_NAMES, ENTRY_AGENT_TOOL_NAMES, COACH_TOOL_NAMES,
  getToolSchemas, runTool, isReadOnlyTool,
} from './tools.js'

export type ToolPermission = AgentToolPermission
export type ToolCapability = 'read' | 'write'

export interface AgentDef {
  /** Stable id used as the key in the `agent_tool_permissions` setting. */
  id: string
  label: string
  description: string
  /** The grant applied to a tool when the user hasn't overridden that cell. */
  defaultGrant: (tool: AgentTool) => ToolPermission
}

const MONITOR_SET = new Set<string>(MONITOR_TOOL_NAMES)
const AGENT_SIGNAL_SET = new Set<string>(AGENT_SIGNAL_TOOL_NAMES)
const ENTRY_AGENT_SET = new Set<string>(ENTRY_AGENT_TOOL_NAMES)
const COACH_SET = new Set<string>(COACH_TOOL_NAMES)

// The tool-calling agents. Order is the display order in the settings UI.
export const AGENTS: AgentDef[] = [
  {
    id: 'chat',
    label: 'Chat Agent',
    description: 'The conversational assistant on the Agent page. Reads app data and can take safe, non-trading actions (watchlist edits, engine triggers).',
    // Full belt — read tools readable, write/action tools fully enabled (the historic default).
    defaultGrant: t => (t.readOnly ? 'read' : 'readwrite'),
  },
  {
    id: 'monitor',
    label: 'Agent Monitor',
    description: 'The agentic per-position monitor. Investigates each open position with read-only tools before committing to a Hold / Adjust / Reduce / Close verdict — it never triggers engines or edits the watchlist mid-review.',
    // Curated read-only subset; everything else off.
    defaultGrant: t => (MONITOR_SET.has(t.name) ? 'read' : 'off'),
  },
  {
    id: 'agentSignal',
    label: 'Agent Signal',
    description: 'The agentic, single-coin entry engine. One agent per watchlist coin investigates with read tools + live news and keeps long-term per-coin memory before committing to a BUY or HOLD signal. Its memory tool is read-write; it never triggers engines or edits the watchlist mid-review.',
    // Curated coin-scoped belt: reads stay read-only, the memory write tool is fully enabled.
    defaultGrant: t => (AGENT_SIGNAL_SET.has(t.name) ? (t.readOnly ? 'read' : 'readwrite') : 'off'),
  },
  {
    id: 'entryAgent',
    label: 'Entry Agent',
    description: 'The agentic, per-coin entry-position engine. One agent per active entry intent reads live market structure + the BUY thesis / Agent Signal memory, then drives the deferred BUY — adjusting the entry band, firing now, or cancelling — via its final JSON verdict, which the engine executes (it has no action tools). Coin-scoped; it never triggers engines or edits the watchlist mid-pass.',
    // Curated, strictly read-only belt — the entry decision rides on the JSON verdict, not tools.
    defaultGrant: t => (ENTRY_AGENT_SET.has(t.name) ? 'read' : 'off'),
  },
  {
    id: 'coach',
    label: 'Coach Agent',
    description: 'The agentic, system-wide process auditor. One global pass reviews how the other agents are deciding (entry fills/misses, closed-position outcomes, monitor/analyst calls) with read-only tools, then writes corrections into the channels those agents read — per-coin signal memory and a global coach-memory log injected into the Monitor + Analyst prompts. Strictly read-only belt; its corrections ride on the final JSON verdict and the engine applies them.',
    // Curated, strictly read-only belt — corrections are carried by the JSON verdict, not tools.
    defaultGrant: t => (COACH_SET.has(t.name) ? 'read' : 'off'),
  },
]

const AGENT_MAP = new Map(AGENTS.map(a => [a.id, a]))

export function getAgentDef(agentId: string): AgentDef | undefined {
  return AGENT_MAP.get(agentId)
}

export function toolCapability(tool: AgentTool): ToolCapability {
  return tool.readOnly ? 'read' : 'write'
}

// Normalize a grant against a tool's nature so the stored/edited value can never be
// nonsensical: read-only tools collapse 'readwrite' → 'read'; write tools keep all three.
function sanitize(tool: AgentTool, grant: ToolPermission): ToolPermission {
  if (grant === 'off') return 'off'
  if (tool.readOnly) return 'read'
  return grant === 'readwrite' ? 'readwrite' : 'read'
}

/** The resolved grant for EVERY catalog tool for one agent: the saved override if present,
 *  otherwise the agent's registry default (unknown agents default to read-only reads). */
export function getAgentGrants(agentId: string): Map<string, ToolPermission> {
  const def = getAgentDef(agentId)
  const overrides = getSettings().agent_tool_permissions?.[agentId] ?? {}
  const out = new Map<string, ToolPermission>()
  for (const tool of TOOLS) {
    const base = overrides[tool.name] ?? (def ? def.defaultGrant(tool) : tool.readOnly ? 'read' : 'off')
    out.set(tool.name, sanitize(tool, base))
  }
  return out
}

/** The OpenAI `tools` array for one agent — only the tools it's granted (grant !== 'off'). */
export function getAgentToolSchemas(agentId: string): ReturnType<typeof getToolSchemas> {
  const grants = getAgentGrants(agentId)
  const allowed = TOOLS.filter(t => grants.get(t.name) !== 'off').map(t => t.name)
  return getToolSchemas(allowed)
}

/** "- name: description" bullets for every tool currently granted to this agent (grant !==
 *  'off'), pulled straight from the TOOLS catalog so an agent's system prompt can describe
 *  its toolset dynamically — never hardcode a tool's name/description in a prompt file, or
 *  it'll drift from the catalog and may describe a tool the agent isn't actually granted. */
export function getAgentToolPrompt(agentId: string): string {
  const grants = getAgentGrants(agentId)
  return TOOLS
    .filter(t => grants.get(t.name) !== 'off')
    .map(t => `- ${t.name}: ${t.description}`)
    .join('\n')
}

/** Run a tool on behalf of an agent, enforcing its grant. A disabled tool is refused; a
 *  write/action tool granted only 'read' is blocked (the read still flows to the model so
 *  it can explain that the action isn't permitted) — it never throws. */
export async function runAgentTool(agentId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const grant = getAgentGrants(agentId).get(name)
  if (!grant || grant === 'off') {
    return { error: `Tool "${name}" is not enabled for this agent under the current Agentic Tools settings.` }
  }
  if (!isReadOnlyTool(name) && grant === 'read') {
    logger.info('Agent tool blocked by read-only grant', { agentId, tool: name })
    return {
      blocked: true,
      error: `Read-only access: "${name}" is an action tool and this agent has read-only access, so no action was taken. Tell the user this action isn't permitted under the current Agentic Tools settings.`,
    }
  }
  return runTool(name, args)
}

// ── settings-UI payload ───────────────────────────────────────────────────────

export interface AgenticToolInfo {
  name: string
  description: string
  capability: ToolCapability
}
export interface AgenticAgentInfo {
  id: string
  label: string
  description: string
  /** Currently resolved grant per tool (defaults merged with saved overrides). */
  grants: Record<string, ToolPermission>
}

/** Catalog + each agent's resolved grants — everything the Agentic Tools settings UI needs
 *  to render the per-agent cards (the editable state) without hardcoding the tool list. */
export function getAgenticToolsConfig(): { tools: AgenticToolInfo[]; agents: AgenticAgentInfo[] } {
  const tools = TOOLS.map(t => ({ name: t.name, description: t.description, capability: toolCapability(t) }))
  const agents = AGENTS.map(a => ({
    id: a.id, label: a.label, description: a.description,
    grants: Object.fromEntries(getAgentGrants(a.id)),
  }))
  return { tools, agents }
}
