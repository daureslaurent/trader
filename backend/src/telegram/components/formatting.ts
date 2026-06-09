export function esc(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function bold(text: string): string {
  return `<b>${text}</b>`
}

export function code(text: string): string {
  return `<code>${esc(String(text))}</code>`
}

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

export function formatDate(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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

export function confidenceBar(confidence: number): string {
  const pct = Math.max(0, Math.min(1, confidence))
  const filled = Math.round(pct * 10)
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

export function pnlEmoji(pct: number): string {
  if (pct >= 5) return '🚀'
  if (pct > 0) return '📈'
  if (pct <= -5) return '💥'
  if (pct < 0) return '📉'
  return '➡️'
}

export function coinLabel(coin: string): string {
  return esc(coin.replace('/USDC', ''))
}
