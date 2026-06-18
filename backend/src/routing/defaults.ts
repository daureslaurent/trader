import { BotSettings } from '../types.js'
import { RoutingGraph, RouteNode, RouteEdge } from './types.js'

/**
 * The default routing graph, seeded from the existing cron settings so that a
 * fresh install behaves exactly like the legacy scheduler: four engine timers
 * wired to their four engines, monitor/summary gated by their auto-run flags.
 *
 * Plus a few DISABLED examples (manual trigger, Binance price → price-move gate
 * → monitor, startup) so the palette/processor concept is discoverable in the
 * UI without doing anything until the user enables them.
 */
export function defaultGraph(settings: BotSettings): RoutingGraph {
  const nodes: RouteNode[] = [
    // Managed engine timers (cron mirrors the Settings page).
    { id: 'timer.pipeline', kind: 'input', type: 'timer', label: 'Pipeline timer', enabled: true, managed: true, config: { cron: settings.pipeline_cron }, position: { x: 60, y: 60 } },
    { id: 'timer.discovery', kind: 'input', type: 'timer', label: 'Discovery timer', enabled: true, managed: true, config: { cron: settings.discover_cron }, position: { x: 60, y: 170 } },
    { id: 'timer.monitor', kind: 'input', type: 'timer', label: 'Monitor timer', enabled: settings.monitor_auto_run, managed: true, config: { cron: settings.monitor_cron }, position: { x: 60, y: 280 } },
    { id: 'timer.summary', kind: 'input', type: 'timer', label: 'Summary timer', enabled: settings.summary_auto_run, managed: true, config: { cron: settings.summary_cron }, position: { x: 60, y: 390 } },

    // Example inputs (off by default).
    { id: 'input.manual', kind: 'input', type: 'manual', label: 'Manual trigger', enabled: true, config: {}, position: { x: 60, y: 500 } },
    { id: 'input.binance', kind: 'input', type: 'binance_price', label: 'Binance price', enabled: false, config: { dataMode: true, symbol: '' }, position: { x: 60, y: 610 } },
    { id: 'input.kline', kind: 'input', type: 'binance_kline', label: 'Binance 1m kline', enabled: false, config: { dataMode: true, symbol: '', interval: '1m' }, position: { x: 60, y: 720 } },
    { id: 'input.startup', kind: 'input', type: 'system_startup', label: 'On startup', enabled: false, config: {}, position: { x: 60, y: 830 } },

    // Example processors (off by default).
    { id: 'proc.pricemove', kind: 'processor', type: 'price_move', label: 'Price move > 2%', enabled: false, config: { pct: 2, windowSec: 300, direction: 'any' }, position: { x: 440, y: 610 } },
    { id: 'proc.debug', kind: 'processor', type: 'debug', label: 'Debug tap', enabled: false, config: { note: '', sampleN: 1, logData: true, passThrough: true }, position: { x: 440, y: 760 } },

    // Engine outputs.
    { id: 'out.pipeline', kind: 'output', type: 'module_pipeline', label: 'Run Pipeline', enabled: true, managed: true, config: {}, position: { x: 820, y: 60 } },
    { id: 'out.discovery', kind: 'output', type: 'module_discovery', label: 'Run Discovery', enabled: true, managed: true, config: {}, position: { x: 820, y: 200 } },
    { id: 'out.monitor', kind: 'output', type: 'module_monitor', label: 'Run Monitor', enabled: true, managed: true, config: {}, position: { x: 820, y: 340 } },
    { id: 'out.summary', kind: 'output', type: 'module_summary', label: 'Run Summary', enabled: true, managed: true, config: {}, position: { x: 820, y: 480 } },
  ]

  const edges: RouteEdge[] = [
    { id: 'e.pipeline', from: 'timer.pipeline', to: 'out.pipeline', enabled: true },
    { id: 'e.discovery', from: 'timer.discovery', to: 'out.discovery', enabled: true },
    { id: 'e.monitor', from: 'timer.monitor', to: 'out.monitor', enabled: true },
    { id: 'e.summary', from: 'timer.summary', to: 'out.summary', enabled: true },
    // Example route: Binance tick → price-move gate → monitor (all off until enabled).
    { id: 'e.binance_pricemove', from: 'input.binance', to: 'proc.pricemove', enabled: true },
    { id: 'e.pricemove_monitor', from: 'proc.pricemove', to: 'out.monitor', enabled: true, cooldownSec: 300 },
    // Example tap: kline closes → debug log (enable both nodes to see records).
    { id: 'e.kline_debug', from: 'input.kline', to: 'proc.debug', enabled: true },
  ]

  return { enabled: true, nodes, edges }
}

/** The ids of the four managed engine timers, keyed by the setting that drives them. */
export const MANAGED_TIMERS: { id: string; cronKey: keyof BotSettings; enabledKey?: keyof BotSettings }[] = [
  { id: 'timer.pipeline', cronKey: 'pipeline_cron' },
  { id: 'timer.discovery', cronKey: 'discover_cron' },
  { id: 'timer.monitor', cronKey: 'monitor_cron', enabledKey: 'monitor_auto_run' },
  { id: 'timer.summary', cronKey: 'summary_cron', enabledKey: 'summary_auto_run' },
]
