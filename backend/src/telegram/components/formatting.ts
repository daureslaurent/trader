export function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatPnlPct(pct: number): string {
  const prefix = pct >= 0 ? '+' : ''
  return `${prefix}${pct.toFixed(2)}%`
}

export function formatTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

export function tradeStatusEmoji(status: string): string {
  switch (status) {
    case 'EXECUTED': return '✅'
    case 'FAILED': return '❌'
    case 'PENDING': return '⏳'
    default: return '❓'
  }
}

export function actionEmoji(action: string): string {
  switch (action) {
    case 'BUY': return '🟢'
    case 'SELL': return '🔴'
    case 'HOLD': return '⚪'
    default: return '❓'
  }
}
