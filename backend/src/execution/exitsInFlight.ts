// Exit claims: only one path (analyst SELL, monitor CLOSE/REDUCE, software SL/TP
// fallback) may be market-selling a given position at a time. Without this, two
// near-simultaneous triggers both pass the status='OPEN' check before either
// closes the position, and the same exit gets sold/recorded twice.
const exitsInFlight = new Set<number>()

/** True when an exit is already executing for this position. */
export function isExitInFlight(positionId: number): boolean {
  return exitsInFlight.has(positionId)
}

/**
 * Atomically claim the exit slot for a position. Returns false (without
 * claiming) when another path already holds it — the caller should bail out.
 */
export function claimExit(positionId: number): boolean {
  if (exitsInFlight.has(positionId)) return false
  exitsInFlight.add(positionId)
  return true
}

/** Release a previously claimed exit slot. Safe to call when not claimed. */
export function releaseExit(positionId: number): void {
  exitsInFlight.delete(positionId)
}
