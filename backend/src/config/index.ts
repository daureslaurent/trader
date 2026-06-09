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
    baseURL: opt('MONITOR_BASE_URL', llamaBaseURL),
    model: opt('MONITOR_MODEL', llamaModel),
    maxTokens: num('MONITOR_MAX_TOKENS', 2048),
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
