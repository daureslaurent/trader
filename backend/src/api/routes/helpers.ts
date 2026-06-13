/** Normalize a coin into a `<BASE>/USDC` pair (USDC passes through unchanged). */
export function normalizeSymbol(coin: string): string {
  const upper = coin.trim().toUpperCase()
  if (upper === 'USDC') return 'USDC'
  return upper.includes('/') ? upper : `${upper}/USDC`
}
