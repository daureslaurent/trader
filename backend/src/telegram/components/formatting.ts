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

/** A generic 0–100 progress bar (used for CPU/memory gauges). */
export function progressBar(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, pct))
  const filled = Math.round((p / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Relative "time ago" from a SQL/ISO timestamp string. */
export function timeAgo(ts: string): string {
  const then = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime()
  const ms = Date.now() - then
  if (!Number.isFinite(ms)) return ts
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Convert a small subset of Markdown (what the LLM agent emits) to Telegram HTML.
 * Escapes first so the output is always valid HTML, then re-applies bold/italic/code.
 */
export function mdToHtml(md: string): string {
  let out = esc(md)
  // Fenced code blocks ```...``` → <pre>
  out = out.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code) => `<pre>${code.replace(/\n$/, '')}</pre>`)
  // Inline code `x`
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  // Bold **x** or __x__
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  out = out.replace(/__([^_\n]+)__/g, '<b>$1</b>')
  // Italic *x* (avoid touching ** already consumed)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  // Bullet markers → •
  out = out.replace(/^\s*[-*]\s+/gm, '• ')
  // Markdown headings → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  return out
}

/** Split a long body into Telegram-safe chunks (<= 4096 chars), preferring newlines. */
export function chunkText(text: string, max = 3900): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > max) {
      if (buf) chunks.push(buf)
      // A single line longer than max: hard-split it.
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max))
        buf = ''
      } else {
        buf = line
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}
