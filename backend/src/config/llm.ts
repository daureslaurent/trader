import OpenAI from 'openai'
import { config } from './index.js'
import { getClient } from '../core/llm.js'
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

interface ModuleSpec {
  urlKey: keyof BotSettings
  modelKey: keyof BotSettings
  /** Settings key holding the max-tokens override (0 = use the env fallback). */
  maxTokensKey: keyof BotSettings
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
    fallback: config.analyst,
  },
  extractor: {
    urlKey: 'llm_extractor_base_url',
    modelKey: 'llm_extractor_model',
    maxTokensKey: 'llm_extractor_max_tokens',
    fallback: config.extractor,
  },
  discoverer: {
    urlKey: 'llm_discoverer_base_url',
    modelKey: 'llm_discoverer_model',
    maxTokensKey: 'llm_discoverer_max_tokens',
    fallback: config.discoverer,
  },
  discovererExtractor: {
    urlKey: 'llm_discoverer_extractor_base_url',
    modelKey: 'llm_discoverer_extractor_model',
    maxTokensKey: 'llm_discoverer_extractor_max_tokens',
    fallback: config.discovererExtractor,
  },
  monitorA: {
    urlKey: 'llm_monitor_a_base_url',
    modelKey: 'llm_monitor_a_model',
    maxTokensKey: 'llm_monitor_a_max_tokens',
    fallback: { baseURL: config.monitor.baseURL, model: config.monitor.model, maxTokens: config.monitor.maxTokens },
  },
  monitorB: {
    urlKey: 'llm_monitor_b_base_url',
    modelKey: 'llm_monitor_b_model',
    maxTokensKey: 'llm_monitor_b_max_tokens',
    fallback: { baseURL: config.monitor.baseURLB, model: config.monitor.modelB, maxTokens: config.monitor.maxTokens },
  },
}

export interface ResolvedLLM {
  client: OpenAI
  baseURL: string
  model: string
  maxTokens: number
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
  return { client: getClient(baseURL), baseURL, model, maxTokens }
}
