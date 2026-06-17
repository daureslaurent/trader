import { logger } from '../core/logger.js'
import { getOpenPositions } from '../portfolio/index.js'

/**
 * A cached set of coins currently held in the portfolio, so the `heldOnly`
 * toggle on Binance input nodes can be evaluated synchronously on every
 * (high-frequency) market frame without a per-message DB read.
 *
 * Kept fresh three ways: an initial load at routing init, immediate updates from
 * the position-opened/closed bus events (see sources.ts), and a periodic refresh
 * from the 30s position-check loop as a safety net.
 */

const held = new Set<string>()

export function isHeld(symbol: string): boolean {
  return held.has(symbol)
}

export function noteOpened(coin: string): void {
  if (coin && coin !== 'USDC') held.add(coin)
}

export function noteClosed(coin: string): void {
  held.delete(coin)
}

export async function refreshHeldCoins(): Promise<void> {
  try {
    const positions = (await getOpenPositions()) as unknown as { coin: string }[]
    const next = positions.map((p) => p.coin).filter((c) => c && c !== 'USDC')
    held.clear()
    for (const c of next) held.add(c)
  } catch (err) {
    logger.warn('Failed to refresh held coins', { error: err instanceof Error ? err.message : String(err) })
  }
}
