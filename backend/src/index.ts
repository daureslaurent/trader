// Process entry point. All behavior lives in focused modules:
//   pipeline/   — the entry engine (research → analyst → BUY gauntlet)
//   execution/  — the single path to real exchange orders, exits, adjustments
//   app/        — scheduler (crons/interval), wiring (bus handlers), lifecycle
// This file only registers the event handlers and starts/stops the process.
import { registerEventHandlers } from './app/wiring.js'
import { start, shutdown } from './app/lifecycle.js'

registerEventHandlers()

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
