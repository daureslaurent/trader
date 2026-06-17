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

export function wireSources(): void {
  if (wired) return
  wired = true

  systemBus.onEvent(SystemEvent.MARKET_PRICE_TICK, ({ symbol, price, changePct }) => {
    void fireInputsOfType(
      'binance_price',
      { trigger: 'binance', symbol, price, changePct },
      (node) => symbolMatches(node, symbol),
    ).catch((err) => logger.warn('binance_price source fire failed', { error: err instanceof Error ? err.message : String(err) }))
  })
}

/** Fire the one-shot startup inputs once the system is fully up. */
export function fireStartup(): void {
  void fireInputsOfType('system_startup', { trigger: 'startup' }).catch((err) =>
    logger.warn('system_startup source fire failed', { error: err instanceof Error ? err.message : String(err) }))
}
