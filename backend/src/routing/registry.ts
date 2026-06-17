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
    description: 'Fires on each live miniTicker price update from Binance for the matched symbol(s).',
    category: 'market',
    configFields: [
      { key: 'symbol', label: 'Symbol filter', type: 'text', placeholder: 'blank = all', help: 'e.g. BTC/USDC. Blank matches every subscribed symbol.' },
      { key: 'heldOnly', label: 'Portfolio coins only', type: 'boolean', help: 'Only fire for coins currently held in the portfolio.' },
    ],
    defaultConfig: { symbol: '', heldOnly: false },
  },
  binance_kline: {
    type: 'binance_kline',
    kind: 'input',
    label: 'Binance Kline Close',
    description: 'Fires when a candle closes on Binance for the chosen interval.',
    category: 'market',
    configFields: [
      { key: 'symbol', label: 'Symbol filter', type: 'text', placeholder: 'blank = all' },
      { key: 'interval', label: 'Interval', type: 'select', options: [
        { value: '1m', label: '1m' }, { value: '3m', label: '3m' }, { value: '5m', label: '5m' },
        { value: '15m', label: '15m' }, { value: '1h', label: '1h' }, { value: '4h', label: '4h' }, { value: '1d', label: '1d' },
      ] },
      { key: 'heldOnly', label: 'Portfolio coins only', type: 'boolean', help: 'Only fire for coins currently held in the portfolio.' },
    ],
    defaultConfig: { symbol: '', interval: '1m', heldOnly: false },
  },
  binance_book: {
    type: 'binance_book',
    kind: 'input',
    label: 'Binance Best Bid/Ask',
    description: 'Fires on every top-of-book change (bookTicker). High frequency — gate it before an output.',
    category: 'market',
    configFields: [
      { key: 'symbol', label: 'Symbol filter', type: 'text', placeholder: 'blank = all' },
      { key: 'heldOnly', label: 'Portfolio coins only', type: 'boolean', help: 'Only fire for coins currently held in the portfolio.' },
    ],
    defaultConfig: { symbol: '', heldOnly: false },
  },
  binance_trade: {
    type: 'binance_trade',
    kind: 'input',
    label: 'Binance Trades',
    description: 'Fires on each aggregate market trade (price/size/side). High frequency.',
    category: 'market',
    configFields: [
      { key: 'symbol', label: 'Symbol filter', type: 'text', placeholder: 'blank = all' },
      { key: 'heldOnly', label: 'Portfolio coins only', type: 'boolean', help: 'Only fire for coins currently held in the portfolio.' },
    ],
    defaultConfig: { symbol: '', heldOnly: false },
  },
  binance_depth: {
    type: 'binance_depth',
    kind: 'input',
    label: 'Binance Depth (L2)',
    description: 'Streams top-of-book partial depth. Very high volume — use sparingly.',
    category: 'market',
    configFields: [
      { key: 'symbol', label: 'Symbol filter', type: 'text', placeholder: 'blank = all' },
      { key: 'heldOnly', label: 'Portfolio coins only', type: 'boolean', help: 'Only fire for coins currently held in the portfolio.' },
    ],
    defaultConfig: { symbol: '', heldOnly: false },
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
  debug: {
    type: 'debug',
    kind: 'processor',
    label: 'Debug Tap',
    description: 'Records every event that reaches it to the debug log (sampled). Pass-through by default — drop it inline anywhere to inspect what is flowing.',
    category: 'system',
    configFields: [
      { key: 'note', label: 'Note', type: 'text', placeholder: 'optional label for these records' },
      { key: 'sampleN', label: 'Sample 1 in N', type: 'number', placeholder: '1', help: 'Log only 1 of every N events (1 = log all). Useful for high-frequency Binance streams.' },
      { key: 'logData', label: 'Log event data', type: 'boolean', help: 'On: record the full event payload. Off: record only metadata (node, symbol, time).' },
      { key: 'passThrough', label: 'Pass-through', type: 'boolean', help: 'On: log then propagate downstream. Off: terminal sink (logs only).' },
    ],
    defaultConfig: { note: '', sampleN: 1, logData: true, passThrough: true },
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
