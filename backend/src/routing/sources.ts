import { logger } from '../core/logger.js'
import { systemBus, SystemEvent } from '../core/bus.js'
import { fireInputsOfType } from './engine.js'
import { RouteNode } from './types.js'

/**
 * Non-timer input sources: live Binance price ticks and the one-shot startup
 * pulse. Each maps an external signal onto the matching enabled input nodes.
 * Binance ticks are high-frequency by nature — they're cheap when no
 * `binance_price` node is wired, and otherwise expected to feed a `price_move`
 * / `cooldown_gate` processor before reaching any output.
 */

let wired = false

function symbolMatches(node: RouteNode, symbol: string): boolean {
  const filter = String(node.config.symbol ?? '').trim()
  return filter === '' || filter === symbol
}

function fire(type: string, symbol: string, ctx: Record<string, unknown>): void {
  void fireInputsOfType(type, { trigger: 'binance', symbol, ...ctx }, (node) => symbolMatches(node, symbol))
    .catch((err) => logger.warn(`${type} source fire failed`, { error: err instanceof Error ? err.message : String(err) }))
}

export function wireSources(): void {
  if (wired) return
  wired = true

  systemBus.onEvent(SystemEvent.MARKET_PRICE_TICK, ({ symbol, price, changePct }) => {
    fire('binance_price', symbol, { price, changePct })
  })

  systemBus.onEvent(SystemEvent.MARKET_KLINE_CLOSED, (k) => {
    // Kline nodes also match on the configured interval.
    void fireInputsOfType(
      'binance_kline',
      { trigger: 'binance', price: k.close, ...k },
      (node) => symbolMatches(node, k.symbol) && String(node.config.interval ?? '1m') === k.interval,
    ).catch((err) => logger.warn('binance_kline source fire failed', { error: err instanceof Error ? err.message : String(err) }))
  })

  systemBus.onEvent(SystemEvent.MARKET_BOOK_TICKER, (b) => {
    fire('binance_book', b.symbol, { price: (b.bid + b.ask) / 2, bid: b.bid, ask: b.ask, spread: b.spread })
  })

  systemBus.onEvent(SystemEvent.MARKET_AGG_TRADE, (t) => {
    fire('binance_trade', t.symbol, { price: t.price, qty: t.qty, side: t.side })
  })

  systemBus.onEvent(SystemEvent.MARKET_DEPTH, (d) => {
    fire('binance_depth', d.symbol, { bids: d.bids, asks: d.asks })
  })
}

/** Fire the one-shot startup inputs once the system is fully up. */
export function fireStartup(): void {
  void fireInputsOfType('system_startup', { trigger: 'startup' }).catch((err) =>
    logger.warn('system_startup source fire failed', { error: err instanceof Error ? err.message : String(err) }))
}
