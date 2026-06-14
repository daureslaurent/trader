import { runSQL, getSettings } from '../db/index.js'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { sendApprovalMessage } from '../telegram/index.js'
import { Signal, ApprovalRequest } from '../types.js'
import { submitTrade } from './submitTrade.js'

interface PendingApproval { signal: Signal; estimatedPrice: number; atr?: number; settings?: ReturnType<typeof getSettings>; req: ApprovalRequest }

const pendingApprovals: Map<number, PendingApproval> = new Map()
const approvalTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

export function getPendingApprovals(): ApprovalRequest[] {
  return Array.from(pendingApprovals.values()).map(p => p.req)
}

/**
 * Route a trade signal: when approvals are on, record a PENDING trade and stash
 * the signal for later execution; otherwise execute immediately via submitTrade.
 */
export async function handleTradeSignal(signal: Signal, price: number, atr?: number, settings?: any): Promise<{ outcome: 'ok' | 'pending' | 'failed'; error?: string }> {
  if (signal.action === 'HOLD') return { outcome: 'ok' }

  const s = getSettings()

  if (s.approval_required || config.approvalsEnabled) {
    const total = price * signal.quantity
    const info = runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
      [signal.coin, signal.action, signal.quantity, price, total]
    )

    const tradeId = info.lastInsertRowid
    const req: ApprovalRequest = {
      tradeId,
      coin: signal.coin,
      side: signal.action,
      quantity: signal.quantity,
      estimatedPrice: price,
      reason: signal.reason,
      confidence: signal.confidence,
      expiresAt: new Date(Date.now() + config.approvalTimeoutMs).toISOString(),
    }

    pendingApprovals.set(tradeId, { signal, estimatedPrice: price, atr, settings: s, req })
    bus.emit('approval_requested', req)
    broadcast('approval_requested', req)
    sendApprovalMessage(req)

    const timer = setTimeout(() => {
      bus.emit('trade_rejected', tradeId)
      pendingApprovals.delete(tradeId)
      approvalTimers.delete(tradeId)
    }, config.approvalTimeoutMs)
    approvalTimers.set(tradeId, timer)
    return { outcome: 'pending' }
  } else {
    const result = await submitTrade(signal, price, undefined, atr, s)
    return result.ok ? { outcome: 'ok' } : { outcome: 'failed', error: result.error }
  }
}

/** Resolve a human approval: execute the stashed trade signal. */
export async function approveTrade(tradeId: number): Promise<void> {
  logger.info('Trade approval received, executing', { tradeId })
  const pending = pendingApprovals.get(tradeId)
  if (!pending) {
    // In-memory state is gone (e.g. server restarted) — mark FAILED so the DB doesn't stay PENDING
    logger.error('Trade approval failed: in-memory state not found', { tradeId })
    runSQL("UPDATE trades SET status = 'FAILED', error = 'Approval state lost (server restart)' WHERE id = ? AND status = 'PENDING'", [tradeId])
    broadcast('trade_failed', { tradeId, error: 'Approval state lost after server restart' })
    return
  }

  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)

  const result = await submitTrade(pending.signal, pending.estimatedPrice, tradeId, pending.atr, pending.settings)
  logger.info('Trade execution result', { tradeId, success: result.ok, error: result.error })
  bus.emit('trade_result', { tradeId, success: result.ok, error: result.error })
}

/** Reject a pending approval: mark the trade FAILED and clear in-memory state. */
export function rejectTrade(tradeId: number): void {
  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)

  runSQL("UPDATE trades SET approved = 0, status = 'FAILED' WHERE id = ? AND status = 'PENDING'", [tradeId])
  broadcast('trade_rejected', tradeId)
  logger.info('Trade rejected by user', { tradeId })
}
