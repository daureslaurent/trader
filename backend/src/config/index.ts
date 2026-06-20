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

// LLM defaults are OPTIONAL here so a fresh install boots into SETUP MODE with no
// env at all (the backend must come up to serve the setup wizard). When empty,
// modules with no selected catalog endpoint simply have no usable LLM until one
// is configured in Settings → LLM Models. Set these (or per-module *_BASE_URL /
// *_MODEL) to seed the fallback target.
const llamaBaseURL = opt('LLAMA_BASE_URL', '')
const llamaModel = opt('LLAMA_MODEL', '')

export const config = {
  // Binance keys are OPTIONAL here: when empty, the first-run setup wizard
  // collects them and stores them (encrypted) in the DB. When set, they seed the
  // credential store and skip the wizard. Read effective keys via the credentials
  // module (getBinanceKeys), not these raw values.
  binance: {
    apiKey: opt('BINANCE_API_KEY', ''),
    secret: opt('BINANCE_SECRET', ''),
  },
  // Master key for encrypting secrets at rest (the Binance secret). Optional —
  // when unset, a key is generated and stored in the DB (with a warning). Set
  // this (e.g. a k8s secret) for real protection against a DB dump.
  encryptionKey: opt('APP_ENCRYPTION_KEY', ''),
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
    // Agent Monitor — the agentic position monitor (the sole monitor engine). A native
    // tool-calling loop, so it needs a tool-calling-capable model. Env MONITOR_* falls back
    // to the llama defaults.
    baseURL: opt('MONITOR_BASE_URL', llamaBaseURL),
    model: opt('MONITOR_MODEL', llamaModel),
    maxTokens: num('MONITOR_MAX_TOKENS', 4096),
  },
  summary: {
    // Portfolio-summary engine model. A larger context window helps here since the
    // prompt bundles the whole portfolio + per-coin market context. Falls back to llama.
    baseURL: opt('SUMMARY_BASE_URL', llamaBaseURL),
    model: opt('SUMMARY_MODEL', llamaModel),
    maxTokens: num('SUMMARY_MAX_TOKENS', 3072),
  },
  entryAgent: {
    // Entry Agent — the agentic, per-coin entry-position engine. A native tool-calling loop
    // (one agent per active entry intent) that reads market context + the BUY thesis and
    // adapts the entry band / fires / cancels, so it needs a tool-calling-capable model.
    // Env ENTRY_AGENT_* falls back to the llama defaults.
    baseURL: opt('ENTRY_AGENT_BASE_URL', llamaBaseURL),
    model: opt('ENTRY_AGENT_MODEL', llamaModel),
    maxTokens: num('ENTRY_AGENT_MAX_TOKENS', 4096),
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
  agentSignal: {
    // Agent Signal — the agentic, single-coin entry engine. A native tool-calling loop
    // (one agent per watchlist coin), so it needs a tool-calling-capable model. Separate
    // from the chat agent / Agent Monitor so each can use its own model. Falls back to llama.
    baseURL: opt('AGENT_SIGNAL_BASE_URL', llamaBaseURL),
    model: opt('AGENT_SIGNAL_MODEL', llamaModel),
    maxTokens: num('AGENT_SIGNAL_MAX_TOKENS', 4096),
  },
  webSearch: {
    // Generic web_search agent tool — per-page extraction that summarizes search results
    // against the caller's free-text query (no coin coupling). Falls back to llama.
    baseURL: opt('WEB_SEARCH_BASE_URL', llamaBaseURL),
    model: opt('WEB_SEARCH_MODEL', llamaModel),
    maxTokens: num('WEB_SEARCH_MAX_TOKENS', 2048),
    maxArticleChars: num('WEB_SEARCH_MAX_ARTICLE_CHARS', 2000),
  },
  telegram: {
    botToken: opt('TELEGRAM_BOT_TOKEN', ''),
    chatId: opt('TELEGRAM_CHAT_ID', ''),
  },
  approvalTimeoutMs: num('APPROVAL_TIMEOUT_MINUTES', 5) * 60 * 1000,
  port: num('PORT', 3000),
  approvalsEnabled: process.argv.includes('--approval'),
  pipelineCron: opt('PIPELINE_CRON', ''),
  // Authentication gateway. Raw env values; resolved/validated in auth/config.ts.
  // Auth turns ON automatically once a password (hash or plaintext) is configured.
  auth: {
    enabled: process.env.AUTH_ENABLED, // explicit 'true'|'false' override (optional)
    username: opt('AUTH_USERNAME', 'admin'),
    password: opt('AUTH_PASSWORD', ''), // plaintext convenience — hashed at boot
    passwordHash: opt('AUTH_PASSWORD_HASH', ''), // preferred: a precomputed scrypt hash
    secret: opt('AUTH_SECRET', ''), // HMAC signing secret for bearer tokens
    tokenTtlMinutes: num('AUTH_TOKEN_TTL_MINUTES', 720), // 12h default
  },
}
