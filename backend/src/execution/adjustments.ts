import { positionAdjustments, positions as positionsRepo, nowSql, getSettings } from '../db/index.js'
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
  const adj = (await positionAdjustments.findOne({ _id: adjId, status: 'PENDING' })) as
    | { id: number; position_id: number; coin: string; new_stop_loss: number | null; new_take_profit: number | null }
    | null
  if (!adj) return

  const pos = (await positionsRepo.findOne(
    { _id: adj.position_id, status: 'OPEN' },
    { projection: { id: 1, stop_loss: 1, take_profit: 1 } },
  )) as { id: number; stop_loss: number; take_profit: number | null } | null
  if (!pos) {
    await positionAdjustments.update({ _id: adjId }, { status: 'REJECTED' })
    broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'REJECTED', reason: 'Position no longer open' })
    return
  }

  const newSl = adj.new_stop_loss != null ? adj.new_stop_loss : pos.stop_loss
  const newTp = adj.new_take_profit != null ? adj.new_take_profit : pos.take_profit
  const price = priceCache.getPrice(adj.coin)?.price ?? null

  // stop_loss drives the SL-hit check; keep current_sl in sync.
  await positionsRepo.update({ _id: adj.position_id }, { stop_loss: newSl, current_sl: newSl, take_profit: newTp })
  await recordSlTpUpdate(adj.position_id, adj.coin, newSl, newTp, price)
  await positionAdjustments.update({ _id: adjId }, { status: 'APPLIED' })

  // Push the new levels to the exchange-side OCO (cancel + replace).
  await replaceProtection(adj.position_id)

  logger.info('Position SL/TP adjusted', { coin: adj.coin, positionId: adj.position_id, stop_loss: newSl, take_profit: newTp })
  broadcast('position_adjusted', { coin: adj.coin, positionId: adj.position_id, old_stop_loss: pos.stop_loss, old_take_profit: pos.take_profit, stop_loss: newSl, take_profit: newTp })
  broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'APPLIED' })
  bus.emit('portfolio_updated')
  const adjPos = (await positionsRepo.findOne({ _id: adj.position_id }, { projection: { entry_price: 1 } })) as { entry_price: number } | null
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
export async function proposeAdjustment(p: SlTpAdjustmentProposal): Promise<void> {
  // Position must still be open.
  const open = await positionsRepo.findOne({ _id: p.positionId, status: 'OPEN' }, { projection: { id: 1 } })
  if (!open) return

  const adjId = Number(await positionAdjustments.insert({
    position_id: p.positionId, coin: p.coin, old_stop_loss: p.oldStopLoss, old_take_profit: p.oldTakeProfit,
    new_stop_loss: p.newStopLoss, new_take_profit: p.newTakeProfit, reasoning: p.reasoning, confidence: p.confidence,
    status: 'PENDING', model: p.model, cycle_id: p.cycleId, created_at: nowSql(),
  }))

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
      void positionAdjustments.update({ _id: adjId, status: 'PENDING' }, { status: 'EXPIRED' })
        .then(() => broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'EXPIRED' }))
        .catch(err => logger.error('Failed to expire SL/TP adjustment', { adjId, error: err instanceof Error ? err.message : String(err) }))
      adjustmentTimers.delete(adjId)
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
export async function rejectAdjustment(adjId: number): Promise<void> {
  const timer = adjustmentTimers.get(adjId)
  if (timer) clearTimeout(timer)
  adjustmentTimers.delete(adjId)
  await positionAdjustments.update({ _id: adjId, status: 'PENDING' }, { status: 'REJECTED' })
  broadcast('adjustment_resolved', { adjustmentId: adjId, status: 'REJECTED' })
  logger.info('SL/TP adjustment rejected by user', { adjId })
}
