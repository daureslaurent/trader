import OpenAI from 'openai'
import { config } from './index.js'
import { getClient } from '../core/llm.js'
import type { LLMTarget } from '../core/llm.js'
import { isEndpointDown } from '../core/endpointHealth.js'
import { getSettings } from '../db/index.js'
import type { BotSettings } from '../types.js'

// Modules whose LLM endpoint/model/max-tokens can be overridden at runtime from
// Settings. The monitor exposes its two slots (A/B) as separate modules; which
// slot a cycle uses is still chosen by the `monitor_model` setting.
export type LLMModule =
  | 'analyst'
  | 'extractor'
  | 'discoverer'
  | 'discovererExtractor'
  | 'monitorA'
  | 'monitorB'
  | 'monitorC'
  | 'summary'
  | 'entryPlanner'
  | 'agent'
  | 'monitorD'
  | 'agentSignal'

interface ModuleSpec {
  /** Settings key holding the selected endpoint id (blank = use the env fallback). */
  endpointKey: keyof BotSettings
  /** Settings key holding the max-tokens override (0 = use the env fallback). */
  maxTokensKey: keyof BotSettings
  /** Settings key for the optional failover endpoint id (blank = no fallback). */
  fbEndpointKey: keyof BotSettings
  /** Settings key for the failover max-tokens (0 = reuse the primary's effective value). */
  fbMaxTokensKey: keyof BotSettings
  /** Env-var fallback used when no endpoint is selected. */
  fallback: { baseURL: string; model: string; maxTokens: number }
}

// Single source of truth mapping each overridable module to its settings keys
// and its env-config fallback. Keep in sync with the Settings UI field list.
const SPECS: Record<LLMModule, ModuleSpec> = {
  analyst: {
    endpointKey: 'llm_analyst_endpoint',
    maxTokensKey: 'llm_analyst_max_tokens',
    fbEndpointKey: 'llm_analyst_fb_endpoint',
    fbMaxTokensKey: 'llm_analyst_fb_max_tokens',
    fallback: config.analyst,
  },
  extractor: {
    endpointKey: 'llm_extractor_endpoint',
    maxTokensKey: 'llm_extractor_max_tokens',
    fbEndpointKey: 'llm_extractor_fb_endpoint',
    fbMaxTokensKey: 'llm_extractor_fb_max_tokens',
    fallback: config.extractor,
  },
  discoverer: {
    endpointKey: 'llm_discoverer_endpoint',
    maxTokensKey: 'llm_discoverer_max_tokens',
    fbEndpointKey: 'llm_discoverer_fb_endpoint',
    fbMaxTokensKey: 'llm_discoverer_fb_max_tokens',
    fallback: config.discoverer,
  },
  discovererExtractor: {
    endpointKey: 'llm_discoverer_extractor_endpoint',
    maxTokensKey: 'llm_discoverer_extractor_max_tokens',
    fbEndpointKey: 'llm_discoverer_extractor_fb_endpoint',
    fbMaxTokensKey: 'llm_discoverer_extractor_fb_max_tokens',
    fallback: config.discovererExtractor,
  },
  monitorA: {
    endpointKey: 'llm_monitor_a_endpoint',
    maxTokensKey: 'llm_monitor_a_max_tokens',
    fbEndpointKey: 'llm_monitor_a_fb_endpoint',
    fbMaxTokensKey: 'llm_monitor_a_fb_max_tokens',
    fallback: { baseURL: config.monitor.baseURL, model: config.monitor.model, maxTokens: config.monitor.maxTokens },
  },
  monitorB: {
    endpointKey: 'llm_monitor_b_endpoint',
    maxTokensKey: 'llm_monitor_b_max_tokens',
    fbEndpointKey: 'llm_monitor_b_fb_endpoint',
    fbMaxTokensKey: 'llm_monitor_b_fb_max_tokens',
    fallback: { baseURL: config.monitor.baseURLB, model: config.monitor.modelB, maxTokens: config.monitor.maxTokens },
  },
  monitorC: {
    endpointKey: 'llm_monitor_c_endpoint',
    maxTokensKey: 'llm_monitor_c_max_tokens',
    fbEndpointKey: 'llm_monitor_c_fb_endpoint',
    fbMaxTokensKey: 'llm_monitor_c_fb_max_tokens',
    fallback: { baseURL: config.monitor.baseURLC, model: config.monitor.modelC, maxTokens: config.monitor.maxTokens },
  },
  summary: {
    endpointKey: 'llm_summary_endpoint',
    maxTokensKey: 'llm_summary_max_tokens',
    fbEndpointKey: 'llm_summary_fb_endpoint',
    fbMaxTokensKey: 'llm_summary_fb_max_tokens',
    fallback: config.summary,
  },
  entryPlanner: {
    endpointKey: 'llm_entry_planner_endpoint',
    maxTokensKey: 'llm_entry_planner_max_tokens',
    fbEndpointKey: 'llm_entry_planner_fb_endpoint',
    fbMaxTokensKey: 'llm_entry_planner_fb_max_tokens',
    fallback: config.entryPlanner,
  },
  agent: {
    endpointKey: 'llm_agent_endpoint',
    maxTokensKey: 'llm_agent_max_tokens',
    fbEndpointKey: 'llm_agent_fb_endpoint',
    fbMaxTokensKey: 'llm_agent_fb_max_tokens',
    fallback: config.agent,
  },
  monitorD: {
    endpointKey: 'llm_monitor_d_endpoint',
    maxTokensKey: 'llm_monitor_d_max_tokens',
    fbEndpointKey: 'llm_monitor_d_fb_endpoint',
    fbMaxTokensKey: 'llm_monitor_d_fb_max_tokens',
    fallback: config.monitorD,
  },
  agentSignal: {
    endpointKey: 'llm_agentSignal_endpoint',
    maxTokensKey: 'llm_agentSignal_max_tokens',
    fbEndpointKey: 'llm_agentSignal_fb_endpoint',
    fbMaxTokensKey: 'llm_agentSignal_fb_max_tokens',
    fallback: config.agentSignal,
  },
}

export interface ResolvedLLM {
  client: OpenAI
  baseURL: string
  model: string
  maxTokens: number
  /** Failover target, present only when a distinct fallback is configured in
   *  Settings. Pass straight through to `llmChat(..., resolved.fallback)`. */
  fallback?: LLMTarget
}

// Looks up a catalog endpoint by id. Returns undefined for a blank id or one that
// no longer resolves (e.g. the endpoint was deleted), so callers fall back cleanly.
// `maxTokens` is the endpoint's own default budget (0 = none configured).
function findEndpoint(settings: BotSettings, id: string): { baseURL: string; model: string; maxTokens: number; disabled: boolean } | undefined {
  if (!id) return undefined
  const ep = settings.llm_endpoints.find(e => e.id === id)
  if (!ep) return undefined
  const baseURL = ep.baseURL.trim()
  const model = ep.model.trim()
  if (!baseURL || !model) return undefined
  return { baseURL, model, maxTokens: ep.maxTokens, disabled: ep.disabled === true }
}

// Resolves a module's effective LLM endpoint/model/max-tokens. A selected catalog
// endpoint wins for URL/model; otherwise the env-var fallback. Max-tokens follows
// a precedence chain: a positive per-module override > the endpoint's own default
// > the env default. Read fresh on every call so Settings changes apply live.
export function resolveLLM(module: LLMModule): ResolvedLLM {
  const spec = SPECS[module]
  const settings = getSettings()
  const ep = findEndpoint(settings, settings[spec.endpointKey] as string)
  const baseURL = ep?.baseURL || spec.fallback.baseURL
  const model = ep?.model || spec.fallback.model
  const maxTokens = resolveMaxTokens(settings[spec.maxTokensKey] as number, ep?.maxTokens, spec.fallback.maxTokens)

  const fallback = resolveFallback(spec, settings, { baseURL, model, maxTokens })

  // A primary explicitly disabled in the catalog is treated as permanently
  // offline: route to the configured failover and *never* keep the disabled
  // endpoint as a retry target (we must not send it traffic, even on a fallback
  // miss). With no usable failover we drop to the env default rather than the
  // disabled endpoint, mirroring an unselected slot.
  if (ep?.disabled) {
    if (fallback && !isEndpointDown(fallback.baseURL, fallback.model)) {
      return {
        client: fallback.client,
        baseURL: fallback.baseURL,
        model: fallback.model,
        maxTokens: fallback.maxTokens ?? maxTokens,
      }
    }
    const fb = spec.fallback
    const fbMaxTokens = resolveMaxTokens(settings[spec.maxTokensKey] as number, 0, fb.maxTokens)
    return { client: getClient(fb.baseURL), baseURL: fb.baseURL, model: fb.model, maxTokens: fbMaxTokens }
  }

  // If the background health monitor reports the primary endpoint as down and a
  // healthy fallback is configured, route to the fallback *first* — skip burning a
  // request timing out on a dead endpoint. The down primary stays as the failover
  // target so traffic returns to it automatically once it recovers (health-driven)
  // or, between checks, via llmChat's own throw-based failover.
  if (fallback && isEndpointDown(baseURL, model) && !isEndpointDown(fallback.baseURL, fallback.model)) {
    const downPrimary: LLMTarget = { client: getClient(baseURL), baseURL, model, maxTokens }
    return {
      client: fallback.client,
      baseURL: fallback.baseURL,
      model: fallback.model,
      maxTokens: fallback.maxTokens ?? maxTokens,
      fallback: downPrimary,
    }
  }

  return { client: getClient(baseURL), baseURL, model, maxTokens, fallback }
}

// max-tokens precedence: positive per-module override > endpoint default > env default.
function resolveMaxTokens(override: number, endpointDefault: number | undefined, envDefault: number): number {
  if (override > 0) return override
  if (endpointDefault && endpointDefault > 0) return endpointDefault
  return envDefault
}

// Builds the failover target from the selected fallback endpoint. Returns
// undefined when no fallback endpoint is selected (or it no longer resolves), when
// it is itself disabled, or when it's identical to the primary (failing over to
// the same target is a no-op that would only double the latency on an outage).
// Fallback max-tokens follows
// the same precedence, ultimately reusing the primary's effective budget.
function resolveFallback(
  spec: ModuleSpec,
  settings: BotSettings,
  primary: { baseURL: string; model: string; maxTokens: number },
): LLMTarget | undefined {
  const ep = findEndpoint(settings, settings[spec.fbEndpointKey] as string)
  if (!ep || ep.disabled) return undefined
  if (ep.baseURL === primary.baseURL && ep.model === primary.model) return undefined

  const maxTokens = resolveMaxTokens(settings[spec.fbMaxTokensKey] as number, ep.maxTokens, primary.maxTokens)
  return { client: getClient(ep.baseURL), baseURL: ep.baseURL, model: ep.model, maxTokens }
}
