import dotenv from 'dotenv'
import { ConfigError } from '../core/errors.js'

dotenv.config()

function req(key: string): string {
  const val = process.env[key]
  if (!val) throw new ConfigError(key)
  return val
}

function opt(key: string, def: string): string {
  return process.env[key] || def
}

function num(key: string, def: number): number {
  const val = process.env[key]
  if (!val) return def
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? def : parsed
}

const llamaBaseURL = req('LLAMA_BASE_URL')
const llamaModel = req('LLAMA_MODEL')

export const config = {
  binance: {
    apiKey: req('BINANCE_API_KEY'),
    secret: req('BINANCE_SECRET'),
  },
  llama: {
    baseURL: llamaBaseURL,
    model: llamaModel,
  },
  extractor: {
    baseURL: opt('EXTRACTOR_BASE_URL', llamaBaseURL),
    model: opt('EXTRACTOR_MODEL', llamaModel),
    maxTokens: num('EXTRACTOR_MAX_TOKENS', 8192),
    maxArticleChars: num('EXTRACTOR_MAX_ARTICLE_CHARS', 1200),
    maxChallengeChars: num('EXTRACTOR_MAX_CHALLENGE_CHARS', 600),
  },
  analyst: {
    baseURL: opt('ANALYST_BASE_URL', llamaBaseURL),
    model: opt('ANALYST_MODEL', llamaModel),
    maxTokens: num('ANALYST_MAX_TOKENS', 2048),
  },
  discoverer: {
    baseURL: opt('DISCOVERER_BASE_URL', llamaBaseURL),
    model: opt('DISCOVERER_MODEL', llamaModel),
    maxTokens: num('DISCOVERER_MAX_TOKENS', 512),
  },
  discovererExtractor: {
    baseURL: opt('DISCOVERER_EXTRACTOR_BASE_URL', llamaBaseURL),
    model: opt('DISCOVERER_EXTRACTOR_MODEL', llamaModel),
    maxTokens: num('DISCOVERER_EXTRACTOR_MAX_TOKENS', 8192),
  },
  monitor: {
    // Slot A (primary) and slot B (alternate) monitor models. Each can target its
    // own endpoint; B falls back to A's values, which fall back to the llama defaults.
    // The active slot is chosen at runtime via the `monitor_model` setting.
    baseURL: opt('MONITOR_BASE_URL', llamaBaseURL),
    model: opt('MONITOR_MODEL', llamaModel),
    baseURLB: opt('MONITOR_BASE_URL_B', opt('MONITOR_BASE_URL', llamaBaseURL)),
    modelB: opt('MONITOR_MODEL_B', opt('MONITOR_MODEL', llamaModel)),
    maxTokens: num('MONITOR_MAX_TOKENS', 2048),
  },
  summary: {
    // Portfolio-summary engine model. A larger context window helps here since the
    // prompt bundles the whole portfolio + per-coin market context. Falls back to llama.
    baseURL: opt('SUMMARY_BASE_URL', llamaBaseURL),
    model: opt('SUMMARY_MODEL', llamaModel),
    maxTokens: num('SUMMARY_MAX_TOKENS', 3072),
  },
  entryPlanner: {
    // Entry Planner — decides the per-coin entry-timing band (pullback / invalidate /
    // chase cap / TTL) for a deferred BUY. A small, fast model is plenty; it returns
    // a tiny JSON object. Falls back to the llama defaults.
    baseURL: opt('ENTRY_PLANNER_BASE_URL', llamaBaseURL),
    model: opt('ENTRY_PLANNER_MODEL', llamaModel),
    maxTokens: num('ENTRY_PLANNER_MAX_TOKENS', 1024),
  },
  agent: {
    // Conversational agent (the Agent page). Drives a native tool-calling loop, so
    // it should point at a model that supports OpenAI function/tool calling. A roomy
    // token budget helps since each turn may carry tool results + chat history.
    // Falls back to the llama defaults.
    baseURL: opt('AGENT_BASE_URL', llamaBaseURL),
    model: opt('AGENT_MODEL', llamaModel),
    maxTokens: num('AGENT_MAX_TOKENS', 4096),
  },
  telegram: {
    botToken: opt('TELEGRAM_BOT_TOKEN', ''),
    chatId: opt('TELEGRAM_CHAT_ID', ''),
  },
  approvalTimeoutMs: num('APPROVAL_TIMEOUT_MINUTES', 5) * 60 * 1000,
  port: num('PORT', 3000),
  approvalsEnabled: process.argv.includes('--approval'),
  pipelineCron: opt('PIPELINE_CRON', ''),
}
