import { getAll, setBinanceStreams } from '../market/index.js'
import { getGraph } from './engine.js'
import { RoutingGraph } from './types.js'

/**
 * Translates the enabled Binance input nodes into the concrete set of Binance
 * stream subscriptions and hands it to the stream manager. Called whenever the
 * graph changes (so enabling a node opens its stream) and whenever the watched
 * symbol set changes (so blank-filter nodes pick up new coins).
 */

function toBase(symbol: string): string {
  return symbol.replace('/', '').toLowerCase()
}

/** Symbols currently tracked by the price cache (the watched/held universe). */
function watchedSymbols(): string[] {
  return [...getAll().keys()].filter((s) => s !== 'USDC')
}

function streamName(type: string, base: string, interval: string): string | null {
  switch (type) {
    case 'binance_kline': return `${base}@kline_${interval || '1m'}`
    case 'binance_book': return `${base}@bookTicker`
    case 'binance_trade': return `${base}@aggTrade`
    case 'binance_depth': return `${base}@depth5@100ms`
    default: return null
  }
}

export function syncBinanceStreams(graph: RoutingGraph): void {
  const streams = new Set<string>()
  if (graph.enabled) {
    const symbols = watchedSymbols()
    for (const node of graph.nodes) {
      if (node.kind !== 'input' || !node.enabled) continue
      if (!node.type.startsWith('binance_') || node.type === 'binance_price') continue
      const filter = String(node.config.symbol ?? '').trim()
      const syms = filter ? [filter] : symbols
      const interval = String(node.config.interval ?? '1m')
      for (const sym of syms) {
        const name = streamName(node.type, toBase(sym), interval)
        if (name) streams.add(name)
      }
    }
  }
  setBinanceStreams(streams)
}

/** Recompute from the active graph (e.g. after the watchlist changes). */
export function refreshBinanceStreams(): void {
  syncBinanceStreams(getGraph())
}
