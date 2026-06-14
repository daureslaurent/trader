import OpenAI from 'openai'
import { config } from './index.js'
import { getClient } from '../core/llm.js'
import type { LLMTarget } from '../core/llm.js'
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
  | 'summary'
  | 'agent'

interface ModuleSpec {
  urlKey: keyof BotSettings
  modelKey: keyof BotSettings
  /** Settings key holding the max-tokens override (0 = use the env fallback). */
  maxTokensKey: keyof BotSettings
  /** Settings keys for the optional failover endpoint/model/max-tokens. Blank =
   *  not configured; the corresponding primary value is reused where a field is
   *  left blank so a fallback can change only the endpoint *or* only the model. */
  fbUrlKey: keyof BotSettings
  fbModelKey: keyof BotSettings
  fbMaxTokensKey: keyof BotSettings
  /** Env-var fallback used when a setting is blank / zero. */
  fallback: { baseURL: string; model: string; maxTokens: number }
}

// Single source of truth mapping each overridable module to its settings keys
// and its env-config fallback. Keep in sync with the Settings UI field list.
const SPECS: Record<LLMModule, ModuleSpec> = {
  analyst: {
    urlKey: 'llm_analyst_base_url',
    modelKey: 'llm_analyst_model',
    maxTokensKey: 'llm_analyst_max_tokens',
    fbUrlKey: 'llm_analyst_fb_base_url',
    fbModelKey: 'llm_analyst_fb_model',
    fbMaxTokensKey: 'llm_analyst_fb_max_tokens',
    fallback: config.analyst,
  },
  extractor: {
    urlKey: 'llm_extractor_base_url',
    modelKey: 'llm_extractor_model',
    maxTokensKey: 'llm_extractor_max_tokens',
    fbUrlKey: 'llm_extractor_fb_base_url',
    fbModelKey: 'llm_extractor_fb_model',
    fbMaxTokensKey: 'llm_extractor_fb_max_tokens',
    fallback: config.extractor,
  },
  discoverer: {
    urlKey: 'llm_discoverer_base_url',
    modelKey: 'llm_discoverer_model',
    maxTokensKey: 'llm_discoverer_max_tokens',
    fbUrlKey: 'llm_discoverer_fb_base_url',
    fbModelKey: 'llm_discoverer_fb_model',
    fbMaxTokensKey: 'llm_discoverer_fb_max_tokens',
    fallback: config.discoverer,
  },
  discovererExtractor: {
    urlKey: 'llm_discoverer_extractor_base_url',
    modelKey: 'llm_discoverer_extractor_model',
    maxTokensKey: 'llm_discoverer_extractor_max_tokens',
    fbUrlKey: 'llm_discoverer_extractor_fb_base_url',
    fbModelKey: 'llm_discoverer_extractor_fb_model',
    fbMaxTokensKey: 'llm_discoverer_extractor_fb_max_tokens',
    fallback: config.discovererExtractor,
  },
  monitorA: {
    urlKey: 'llm_monitor_a_base_url',
    modelKey: 'llm_monitor_a_model',
    maxTokensKey: 'llm_monitor_a_max_tokens',
    fbUrlKey: 'llm_monitor_a_fb_base_url',
    fbModelKey: 'llm_monitor_a_fb_model',
    fbMaxTokensKey: 'llm_monitor_a_fb_max_tokens',
    fallback: { baseURL: config.monitor.baseURL, model: config.monitor.model, maxTokens: config.monitor.maxTokens },
  },
  monitorB: {
    urlKey: 'llm_monitor_b_base_url',
    modelKey: 'llm_monitor_b_model',
    maxTokensKey: 'llm_monitor_b_max_tokens',
    fbUrlKey: 'llm_monitor_b_fb_base_url',
    fbModelKey: 'llm_monitor_b_fb_model',
    fbMaxTokensKey: 'llm_monitor_b_fb_max_tokens',
    fallback: { baseURL: config.monitor.baseURLB, model: config.monitor.modelB, maxTokens: config.monitor.maxTokens },
  },
  summary: {
    urlKey: 'llm_summary_base_url',
    modelKey: 'llm_summary_model',
    maxTokensKey: 'llm_summary_max_tokens',
    fbUrlKey: 'llm_summary_fb_base_url',
    fbModelKey: 'llm_summary_fb_model',
    fbMaxTokensKey: 'llm_summary_fb_max_tokens',
    fallback: config.summary,
  },
  agent: {
    urlKey: 'llm_agent_base_url',
    modelKey: 'llm_agent_model',
    maxTokensKey: 'llm_agent_max_tokens',
    fbUrlKey: 'llm_agent_fb_base_url',
    fbModelKey: 'llm_agent_fb_model',
    fbMaxTokensKey: 'llm_agent_fb_max_tokens',
    fallback: config.agent,
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

// Resolves a module's effective LLM endpoint/model/max-tokens: a non-blank (or,
// for max-tokens, positive) Settings value wins, otherwise the env-var fallback.
// Read fresh on every call so Settings changes apply without a restart.
export function resolveLLM(module: LLMModule): ResolvedLLM {
  const spec = SPECS[module]
  const settings = getSettings()
  const baseURL = (settings[spec.urlKey] as string)?.trim() || spec.fallback.baseURL
  const model = (settings[spec.modelKey] as string)?.trim() || spec.fallback.model
  const maxTokensOverride = settings[spec.maxTokensKey] as number
  const maxTokens = maxTokensOverride > 0 ? maxTokensOverride : spec.fallback.maxTokens

  const fallback = resolveFallback(spec, settings, { baseURL, model, maxTokens })
  return { client: getClient(baseURL), baseURL, model, maxTokens, fallback }
}

// Builds the failover target from the `*_fb_*` settings. A blank fb endpoint or
// model inherits the primary's value, so a fallback can redirect only the URL,
// only the model, or both. Returns undefined when nothing is configured or when
// the result is identical to the primary (failing over to the same target is a
// no-op that would only double the latency on an outage).
function resolveFallback(
  spec: ModuleSpec,
  settings: BotSettings,
  primary: { baseURL: string; model: string; maxTokens: number },
): LLMTarget | undefined {
  const fbUrl = (settings[spec.fbUrlKey] as string)?.trim() ?? ''
  const fbModel = (settings[spec.fbModelKey] as string)?.trim() ?? ''
  if (!fbUrl && !fbModel) return undefined

  const baseURL = fbUrl || primary.baseURL
  const model = fbModel || primary.model
  if (baseURL === primary.baseURL && model === primary.model) return undefined

  const fbMaxTokens = settings[spec.fbMaxTokensKey] as number
  const maxTokens = fbMaxTokens > 0 ? fbMaxTokens : primary.maxTokens
  return { client: getClient(baseURL), baseURL, model, maxTokens }
}
