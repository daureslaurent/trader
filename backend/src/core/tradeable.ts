export const FIAT_AND_STABLE = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'SGD',
  'USDC', 'USDT', 'BUSD', 'DAI', 'TUSD', 'USDP', 'USDD', 'FRAX', 'LUSD',
  'GUSD', 'PYUSD', 'FDUSD', 'EURC', 'EUROC',
])

export function isTradeable(symbol: string): boolean {
  const base = symbol.includes('/') ? symbol.split('/')[0] : symbol
  return !FIAT_AND_STABLE.has(base.toUpperCase())
}
