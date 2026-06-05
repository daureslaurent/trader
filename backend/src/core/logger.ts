const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LOG_LEVELS

const level = (process.env.LOG_LEVEL || 'info') as LogLevel

function log(levelName: LogLevel, message: string, data?: unknown) {
  if (LOG_LEVELS[levelName] < LOG_LEVELS[level]) return
  const entry = { t: new Date().toISOString(), level: levelName, msg: message, ...(data ? { data } : {}) }
  if (levelName === 'warn' || levelName === 'error') console.error(JSON.stringify(entry))
  else console.log(JSON.stringify(entry))
}

export const logger = {
  debug: (msg: string, data?: unknown) => log('debug', msg, data),
  info: (msg: string, data?: unknown) => log('info', msg, data),
  warn: (msg: string, data?: unknown) => log('warn', msg, data),
  error: (msg: string, data?: unknown) => log('error', msg, data),
}