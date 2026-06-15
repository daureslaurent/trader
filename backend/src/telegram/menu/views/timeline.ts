import { Markup } from 'telegraf'
import { getSchedulerState } from '../../../core/llmScheduler.js'
import { esc } from '../../components/formatting.js'

// Telegram can't do per-pixel Gantt bars, so each endpoint becomes a fixed-width row of
// colored squares: one cell per time slot over the retention window, colored by the model
// that was running in that slot (empty = idle). This is the Control Room's "Endpoint model
// timeline" rendered for a monospace-ish chat client — same idea, chat-native pixels.

const WIDTH = 22 // cells per row — fits a phone screen without wrapping
// Square emojis stand in for the web palette's hues; a model hashes to a stable square,
// so the same model keeps its color across every row and the legend.
const SQUARES = ['🟦', '🟩', '🟧', '🟪', '🟥', '🟨', '🟫', '⬛']
const EMPTY = '⬜'

function modelSquare(model: string): string {
  if (!model) return EMPTY
  let h = 0
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0
  return SQUARES[h % SQUARES.length]
}

interface Call { model: string; startAgoMs: number; durationMs: number; state: string }

// Paint each call's duration span onto the cell grid. Cells are indexed left→right as
// oldest→now; a slot covered by a call takes that call's model (last writer wins on overlap).
function buildCells(calls: Call[], windowMs: number): (string | null)[] {
  const cells: (string | null)[] = new Array(WIDTH).fill(null)
  for (const c of calls) {
    const endAgo = Math.max(0, c.startAgoMs - Math.max(0, c.durationMs))
    const startFrac = (windowMs - c.startAgoMs) / windowMs // position of call start (0..1)
    const endFrac = (windowMs - endAgo) / windowMs          // position of call end (→1 while running)
    const i0 = Math.max(0, Math.floor(startFrac * WIDTH))
    const i1 = Math.min(WIDTH, Math.max(Math.ceil(endFrac * WIDTH), i0 + 1)) // ≥1 cell
    for (let i = i0; i < i1; i++) cells[i] = c.model
  }
  return cells
}

export async function render(_ctx: any) {
  const snap = getSchedulerState()
  const retainHours = snap.retainHours > 0 ? snap.retainHours : 3
  const windowMs = retainHours * 3_600_000
  const endpoints = snap.endpoints ?? []

  const lines: string[] = [`📊 <b>Endpoint model timeline</b> — last ${retainHours}h`]

  if (endpoints.length === 0) {
    lines.push('', '<i>No LLM calls in the window yet — trigger the pipeline or a monitor run.</i>')
    return {
      text: lines.join('\n'),
      buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
    }
  }

  const cellMin = Math.round((windowMs / WIDTH) / 60_000)
  lines.push(`<i>each cell ≈ ${cellMin}min · oldest → now</i>`, '')

  const seen = new Set<string>()
  for (const ep of endpoints) {
    const cells = buildCells(ep.calls as Call[], windowMs)
    const bar = cells.map(m => (m ? modelSquare(m) : EMPTY)).join('')
    for (const m of ep.calls.map(c => c.model)) if (m) seen.add(m)

    const live = ep.active > 0 ? `  🔴 ${ep.active} live` : ''
    const resident = ep.residentModel ? `  <code>${esc(ep.residentModel)}</code>` : ''
    lines.push(`<b>${esc(ep.host)}</b>${resident}${live}`)
    lines.push(bar)
    lines.push('')
  }

  const models = Array.from(seen).sort()
  if (models.length > 0) {
    lines.push('<b>Models</b>')
    lines.push(models.map(m => `${modelSquare(m)} <code>${esc(m)}</code>`).join('   '))
  }

  return {
    text: lines.join('\n').trimEnd(),
    buttons: [[Markup.button.callback('🔄 Refresh', 'menu:refresh')]],
  }
}
