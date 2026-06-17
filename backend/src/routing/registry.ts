import { NodeTypeMeta } from './types.js'

/**
 * The catalog of node types. Pure metadata: what each node is, how to colour it,
 * and which config fields the frontend should render. Runtime behaviour lives in
 * `processors.ts` / `outputs.ts` / `sources.ts`, keyed by the same `type`.
 */
export const NODE_TYPES: Record<string, NodeTypeMeta> = {
  // ── Inputs ────────────────────────────────────────────────────────────────
  timer: {
    type: 'timer',
    kind: 'input',
    label: 'Timer',
    description: 'Fires on a cron schedule. The replacement for a standalone cron.',
    category: 'system',
    configFields: [
      { key: 'cron', label: 'Schedule (cron)', type: 'cron', placeholder: '0 * * * *', help: 'Standard 5-field cron expression.' },
    ],
    defaultConfig: { cron: '0 * * * *' },
  },
  binance_price: {
    type: 'binance_price',
    kind: 'input',
    label: 'Binance Price',
    description: 'Fires on each live price update from Binance for the matched symbol(s).',
    category: 'market',
    configFields: [
      { key: 'symbol', label: 'Symbol filter', type: 'text', placeholder: 'blank = all', help: 'e.g. BTC/USDC. Blank matches every subscribed symbol.' },
    ],
    defaultConfig: { symbol: '' },
  },
  manual: {
    type: 'manual',
    kind: 'input',
    label: 'Manual',
    description: 'Fires when you press its trigger button or hit the API.',
    category: 'system',
    configFields: [],
    defaultConfig: {},
  },
  system_startup: {
    type: 'system_startup',
    kind: 'input',
    label: 'On Startup',
    description: 'Fires once when the bot process boots.',
    category: 'system',
    configFields: [],
    defaultConfig: {},
    singleton: true,
  },

  // ── Processors (conditional gates) ──────────────────────────────────────────
  price_move: {
    type: 'price_move',
    kind: 'processor',
    label: 'Price Move %',
    description: 'Passes the event through only when the price moved beyond a threshold within a window.',
    category: 'strategy',
    configFields: [
      { key: 'pct', label: 'Threshold %', type: 'number', placeholder: '2', help: 'Absolute move required to pass.' },
      { key: 'windowSec', label: 'Window (sec)', type: 'number', placeholder: '300' },
      { key: 'direction', label: 'Direction', type: 'select', options: [
        { value: 'any', label: 'Any' }, { value: 'up', label: 'Up only' }, { value: 'down', label: 'Down only' },
      ] },
    ],
    defaultConfig: { pct: 2, windowSec: 300, direction: 'any' },
  },
  holding_filter: {
    type: 'holding_filter',
    kind: 'processor',
    label: 'Holding Filter',
    description: 'Passes only when the portfolio does (or does not) hold open positions.',
    category: 'risk',
    configFields: [
      { key: 'mode', label: 'Pass when', type: 'select', options: [
        { value: 'has_positions', label: 'Holding ≥ 1 position' },
        { value: 'no_positions', label: 'Holding nothing' },
      ] },
    ],
    defaultConfig: { mode: 'has_positions' },
  },
  cooldown_gate: {
    type: 'cooldown_gate',
    kind: 'processor',
    label: 'Cooldown Gate',
    description: 'Throttles a busy input — passes at most once per N seconds.',
    category: 'system',
    configFields: [
      { key: 'seconds', label: 'Min interval (sec)', type: 'number', placeholder: '60' },
    ],
    defaultConfig: { seconds: 60 },
  },

  // ── Outputs (engine triggers) ───────────────────────────────────────────────
  module_pipeline: {
    type: 'module_pipeline',
    kind: 'output',
    label: 'Run Pipeline',
    description: 'Runs the full research→analyst pipeline over every watched coin.',
    category: 'execution',
    configFields: [],
    defaultConfig: {},
    singleton: true,
  },
  module_pipeline_coin: {
    type: 'module_pipeline_coin',
    kind: 'output',
    label: 'Run Pipeline (coin)',
    description: 'Runs the pipeline for the single coin carried by the triggering event.',
    category: 'execution',
    configFields: [],
    defaultConfig: {},
  },
  module_monitor: {
    type: 'module_monitor',
    kind: 'output',
    label: 'Run Monitor',
    description: 'Reviews open positions and proposes SL/TP / close / reduce.',
    category: 'execution',
    configFields: [],
    defaultConfig: {},
    singleton: true,
  },
  module_discovery: {
    type: 'module_discovery',
    kind: 'output',
    label: 'Run Discovery',
    description: 'Scores and proposes new candidate coins for the watchlist.',
    category: 'execution',
    configFields: [],
    defaultConfig: {},
    singleton: true,
  },
  module_summary: {
    type: 'module_summary',
    kind: 'output',
    label: 'Run Summary',
    description: 'Generates the portfolio strategist briefing (read-only).',
    category: 'execution',
    configFields: [],
    defaultConfig: {},
    singleton: true,
  },
}

export function getNodeType(type: string): NodeTypeMeta | undefined {
  return NODE_TYPES[type]
}

/** The serializable catalog the frontend palette consumes. */
export function getCatalog(): NodeTypeMeta[] {
  return Object.values(NODE_TYPES)
}
