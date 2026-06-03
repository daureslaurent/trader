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
  return val ? parseInt(val, 10) : def
}

const stubMode = process.argv.includes('--stub')

export const config = {
  stub: stubMode,
  binance: {
    apiKey: stubMode ? 'stub' : req('BINANCE_API_KEY'),
    secret: stubMode ? 'stub' : req('BINANCE_SECRET'),
  },
  llama: {
    baseURL: req('LLAMA_BASE_URL'),
    model: req('LLAMA_MODEL'),
  },
  telegram: { botToken: opt('TELEGRAM_BOT_TOKEN', '') },
  approvalTimeoutMs: num('APPROVAL_TIMEOUT_MINUTES', 5) * 60 * 1000,
  port: num('PORT', 3000),
  approvalsEnabled: process.argv.includes('--approval'),
}
