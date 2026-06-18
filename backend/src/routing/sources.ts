import { logger } from '../core/logger.js'
import { systemBus, SystemEvent } from '../core/bus.js'
import { bus } from '../core/events.js'
import { fireInputsOfType } from './engine.js'
import { RouteNode } from './types.js'
import { isHeld, noteOpened, noteClosed } from './heldCoins.js'

/**
 * Non-timer input sources: live Binance price ticks and the one-shot startup
 * pulse. Each maps an external signal onto the matching enabled input nodes.
 * Binance ticks are high-frequency by nature — they're cheap when no
 * `binance_price` node is wired, and otherwise expected to feed a `price_move`
 * / `cooldown_gate` processor before reaching any output.
 */

let wired = false

// Whether a Binance input emits the per-coin DATA signal (default) or the plain
// SIMPLE trigger. A node opts out of data mode with `dataMode: false`.
const isDataMode = (node: RouteNode): boolean => node.config.dataMode !== false

// A data-mode binance input fires for a symbol when its symbol filter matches
// AND, if `heldOnly` is set, the coin is currently held in the portfolio.
function inputMatches(node: RouteNode, symbol: string): boolean {
  const filter = String(node.config.symbol ?? '').trim()
  if (filter !== '' && filter !== symbol) return false
  if (node.config.heldOnly === true && !isHeld(symbol)) return false
  return true
}

/**
 * Map one stream event onto the matching inputs of `type`, fanning out to both
 * flavours: data-mode nodes get the per-coin payload (and honour symbol/held
 * filters); simple-mode nodes get a bare trigger with no coin (one for all).
 * `extraMatch` adds a per-flavour predicate (e.g. kline interval).
 */
function fire(type: string, symbol: string, ctx: Record<string, unknown>, extraMatch?: (node: RouteNode) => boolean): void {
  const onErr = (err: unknown) => logger.warn(`${type} source fire failed`, { error: err instanceof Error ? err.message : String(err) })
  const extra = (node: RouteNode) => !extraMatch || extraMatch(node)
  void fireInputsOfType(type, { trigger: 'binance', symbol, ...ctx }, (node) => isDataMode(node) && extra(node) && inputMatches(node, symbol)).catch(onErr)
  void fireInputsOfType(type, { trigger: 'binance' }, (node) => !isDataMode(node) && extra(node)).catch(onErr)
}

export function wireSources(): void {
  if (wired) return
  wired = true

  systemBus.onEvent(SystemEvent.MARKET_PRICE_TICK, ({ symbol, price, changePct }) => {
    fire('binance_price', symbol, { price, changePct })
  })

  systemBus.onEvent(SystemEvent.MARKET_KLINE_CLOSED, (k) => {
    // Kline nodes also match on the configured interval (both flavours).
    fire('binance_kline', k.symbol, { price: k.close, ...k }, (node) => String(node.config.interval ?? '1m') === k.interval)
  })

  // Keep the held-coins cache live for the `heldOnly` toggle.
  bus.on('position_opened', (pos) => noteOpened((pos as { coin: string }).coin))
  bus.on('position_closed', ({ coin }) => noteClosed(coin))

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
