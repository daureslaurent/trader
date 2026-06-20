export class BotError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'BotError'
  }
}

export class ConfigError extends BotError {
  constructor(key: string) {
    super(`Missing required config: ${key}`, 'CONFIG_MISSING')
  }
}

export class TradeError extends BotError {
  constructor(message: string) {
    super(message, 'TRADE_FAILED')
  }
}

/** Thrown when a Binance-mutating call is attempted while read-only mode is on. */
export class ReadOnlyError extends BotError {
  constructor(action: string) {
    super(`Binance read-only mode is on — refused to ${action}`, 'BINANCE_READ_ONLY')
  }
}

export class LLMError extends BotError {
  constructor(message: string) {
    super(message, 'LLM_FAILED')
  }
}