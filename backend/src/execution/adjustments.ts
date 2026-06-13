import { queryOne, runSQL, getSettings } from '../db/index.js'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { recordSlTpUpdate, replaceProtection } from '../portfolio/index.js'
import * as priceCache from '../market/index.js'
import { SlTpAdjustmentProposal } from '../types.js'

// ── Position SL/TP adjustments (from the Position Monitor) ───────────────────
const adjustmentTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

/** Apply a pending SL/TP adjustment to the position and push it to the OCO. */
export async function applyAdjustment(adjId: number): Promise<void> {
  const adj = queryOne("SELECT * FROM position_adjustments WHERE id = ? AND status = 'PENDING'", [adjId]) as
    | { id: number; position_id: number; coin: string; new_stop_loss: number | null; new_take_profit: number | null }
    | null
  if (!adj) return

  const pos = queryOne("SELECT id, stop_loss, take_profit FROM positions WHERE id = ? AND status = 'OPEN'", [adj.position_id]) as
    | { id: number; stop_loss: number; take_profit: number | null }
    | null
  if (!pos) {
    runSQL("UPDATE position_adjustments SET status = 'REJECTED' WHERE id = ?", [adjId])
    broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'REJECTED', reason: 'Position no longer open' })
    return
  }

  const newSl = adj.new_stop_loss != null ? adj.new_stop_loss : pos.stop_loss
  const newTp = adj.new_take_profit != null ? adj.new_take_profit : pos.take_profit
  const price = priceCache.getPrice(adj.coin)?.price ?? null

  // stop_loss drives the SL-hit check; keep current_sl in sync.
  runSQL("UPDATE positions SET stop_loss = ?, current_sl = ?, take_profit = ? WHERE id = ?", [newSl, newSl, newTp, adj.position_id])
  recordSlTpUpdate(adj.position_id, adj.coin, newSl, newTp, price)
  runSQL("UPDATE position_adjustments SET status = 'APPLIED' WHERE id = ?", [adjId])

  // Push the new levels to the exchange-side OCO (cancel + replace).
  await replaceProtection(adj.position_id)

  logger.info('Position SL/TP adjusted', { coin: adj.coin, positionId: adj.position_id, stop_loss: newSl, take_profit: newTp })
  broadcast('position_adjusted', { coin: adj.coin, positionId: adj.position_id, old_stop_loss: pos.stop_loss, old_take_profit: pos.take_profit, stop_loss: newSl, take_profit: newTp })
  broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'APPLIED' })
  bus.emit('portfolio_updated')
  const adjPos = queryOne("SELECT entry_price FROM positions WHERE id = ?", [adj.position_id]) as { entry_price: number } | null
  bus.emit('sl_tp_adjusted', {
    coin: adj.coin,
    positionId: adj.position_id,
    oldStopLoss: pos.stop_loss,
    oldTakeProfit: pos.take_profit,
    newStopLoss: newSl,
    newTakeProfit: newTp,
    currentPrice: price,
    entryPrice: adjPos?.entry_price ?? null,
  })
}

/**
 * Record a monitor-proposed SL/TP adjustment. Applies immediately when
 * auto-approve is on (or approvals are off), otherwise queues it for human
 * approval with an expiry timer.
 */
export function proposeAdjustment(p: SlTpAdjustmentProposal): void {
  // Position must still be open.
  const open = queryOne("SELECT id FROM positions WHERE id = ? AND status = 'OPEN'", [p.positionId])
  if (!open) return

  const { lastInsertRowid } = runSQL(
    `INSERT INTO position_adjustments
      (position_id, coin, old_stop_loss, old_take_profit, new_stop_loss, new_take_profit, reasoning, confidence, status, model, cycle_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    [p.positionId, p.coin, p.oldStopLoss, p.oldTakeProfit, p.newStopLoss, p.newTakeProfit, p.reasoning, p.confidence, p.model, p.cycleId]
  )
  const adjId = Number(lastInsertRowid)

  const s = getSettings()
  if (!s.monitor_auto_approve && (s.approval_required || config.approvalsEnabled)) {
    const req = {
      adjustmentId: adjId,
      coin: p.coin,
      oldStopLoss: p.oldStopLoss,
      oldTakeProfit: p.oldTakeProfit,
      newStopLoss: p.newStopLoss,
      newTakeProfit: p.newTakeProfit,
      reasoning: p.reasoning,
      confidence: p.confidence,
      expiresAt: new Date(Date.now() + config.approvalTimeoutMs).toISOString(),
    }
    broadcast('adjustment_requested', req)
    logger.info('SL/TP adjustment awaiting approval', { adjId, coin: p.coin })

    const timer = setTimeout(() => {
      runSQL("UPDATE position_adjustments SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'", [adjId])
      adjustmentTimers.delete(adjId)
      broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'EXPIRED' })
    }, config.approvalTimeoutMs)
    adjustmentTimers.set(adjId, timer)
  } else {
    applyAdjustment(adjId).catch(err => logger.error('Failed to apply SL/TP adjustment', { adjId, error: err instanceof Error ? err.message : String(err) }))
  }
}

/** Resolve a human approval for a queued SL/TP adjustment. */
export function approveAdjustment(adjId: number): void {
  const timer = adjustmentTimers.get(adjId)
  if (timer) clearTimeout(timer)
  adjustmentTimers.delete(adjId)
  applyAdjustment(adjId).catch(err => logger.error('Failed to apply SL/TP adjustment', { adjId, error: err instanceof Error ? err.message : String(err) }))
}

/** Reject a queued SL/TP adjustment. */
export function rejectAdjustment(adjId: number): void {
  const timer = adjustmentTimers.get(adjId)
  if (timer) clearTimeout(timer)
  adjustmentTimers.delete(adjId)
  runSQL("UPDATE position_adjustments SET status = 'REJECTED' WHERE id = ? AND status = 'PENDING'", [adjId])
  broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'REJECTED' })
  logger.info('SL/TP adjustment rejected by user', { adjId })
}
