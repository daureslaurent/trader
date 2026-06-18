import { logger } from '../core/logger.js'
import { getSettings } from '../db/index.js'
import { runPipeline, runSingleCoinPipeline } from '../pipeline/index.js'
import { runDiscovery } from '../discoverer/index.js'
import { runMonitor } from '../monitor/index.js'
import { runMonitorD, runAgentSignal, runAgentSignalCoin } from '../agent/index.js'
import { runPortfolioSummary } from '../summary/index.js'
import { RouteNode, FireContext } from './types.js'

/**
 * Output handlers — the single path through which a routed trigger starts an
 * engine. Each tracks an in-flight flag so the "skip if already running"
 * guardrail can drop overlapping fires (engines take seconds-to-minutes and are
 * LLM-costly, so re-entrancy must be avoided).
 */

const running = new Map<string, boolean>()

export function isModuleRunning(moduleType: string): boolean {
  return running.get(moduleType) === true
}

function cycle(tag: string): string {
  return `${Date.now().toString(36)}-${tag}`
}

/**
 * Start an engine run under the in-flight guard and return immediately.
 * Returns false (skipped) if a run of this module is already in flight — the
 * router must not block on a multi-minute engine run while propagating.
 */
function guarded(moduleType: string, run: () => Promise<unknown>): boolean {
  if (running.get(moduleType)) return false
  running.set(moduleType, true)
  run()
    .catch((err) => logger.error('Routed engine run failed', { module: moduleType, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => running.set(moduleType, false))
  return true
}

// Same A/B/…/D dispatch as the legacy monitor cron, kept local to avoid a
// circular import through app/scheduler.
function dispatchMonitor(cycleId: string): Promise<void> {
  return getSettings().monitor_model === 'd' ? runMonitorD(cycleId) : runMonitor(cycleId)
}

// Entry-signal dispatch: the agentic Agent Signal engine when signal_model === 'agent',
// otherwise the classic research pipeline. Kept local (same reason as dispatchMonitor).
function dispatchPipeline(): Promise<void> {
  return getSettings().signal_model === 'agent' ? runAgentSignal(cycle('signal')) : runPipeline()
}
function dispatchPipelineCoin(symbol: string): Promise<void> {
  return getSettings().signal_model === 'agent'
    ? runAgentSignalCoin(symbol, cycle('signal'))
    : runSingleCoinPipeline(symbol, cycle('pipeline'))
}

export interface OutputResult {
  ran: boolean
  /** Set when the run was suppressed by skip-if-running. */
  skippedReason?: string
}

type OutputHandler = (node: RouteNode, ctx: FireContext) => OutputResult

function result(ran: boolean): OutputResult {
  return ran ? { ran: true } : { ran: false, skippedReason: 'already_running' }
}

const HANDLERS: Record<string, OutputHandler> = {
  module_pipeline: () =>
    result(guarded('module_pipeline', () => dispatchPipeline())),

  module_pipeline_coin: (_node, ctx) => {
    const symbol = ctx.symbol
    if (!symbol) {
      logger.warn('module_pipeline_coin fired without a symbol in context', { trigger: ctx.trigger })
      return { ran: false, skippedReason: 'no_symbol' }
    }
    return result(guarded(`module_pipeline_coin:${symbol}`, () => dispatchPipelineCoin(symbol)))
  },

  module_monitor: () =>
    result(guarded('module_monitor', () => dispatchMonitor(cycle('monitor')))),

  module_discovery: () =>
    result(guarded('module_discovery', () => runDiscovery(cycle('discovery')))),

  module_summary: () =>
    result(guarded('module_summary', () => runPortfolioSummary(cycle('summary')))),
}

export function runOutput(node: RouteNode, ctx: FireContext): OutputResult {
  const handler = HANDLERS[node.type]
  if (!handler) {
    logger.warn('Unknown output node type', { type: node.type, nodeId: node.id })
    return { ran: false, skippedReason: 'unknown_type' }
  }
  return handler(node, ctx)
}
