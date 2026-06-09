import { queryAll, queryOne, runSQL } from '../db/index.js'

export interface SlTpEvent {
  position_id: number
  coin: string
  stop_loss: number
  take_profit: number | null
  event: 'open' | 'update' | 'close'
  price: number | null
  created_at: string
}

function record(
  positionId: number,
  coin: string,
  stopLoss: number,
  takeProfit: number | null,
  event: SlTpEvent['event'],
  price: number | null,
): void {
  runSQL(
    'INSERT INTO sl_tp_history (position_id, coin, stop_loss, take_profit, event, price) VALUES (?, ?, ?, ?, ?, ?)',
    [positionId, coin, stopLoss, takeProfit ?? null, event, price ?? null]
  )
}

/** Record the initial SL/TP when a position is opened. */
export function recordPositionOpen(
  positionId: number, coin: string, stopLoss: number, takeProfit: number | null, price: number,
): void {
  record(positionId, coin, stopLoss, takeProfit, 'open', price)
}

/** Record a SL/TP change (e.g. trailing stop or monitor adjustment) while a position is open. */
export function recordSlTpUpdate(
  positionId: number, coin: string, stopLoss: number, takeProfit: number | null, price?: number | null,
): void {
  record(positionId, coin, stopLoss, takeProfit, 'update', price ?? null)
}

/** Record the terminating event for a position, using its last known SL/TP. */
export function recordPositionClose(positionId: number, price?: number): void {
  const pos = queryOne(
    'SELECT coin, current_sl, take_profit FROM positions WHERE id = ?',
    [positionId]
  ) as { coin: string; current_sl: number; take_profit: number | null } | null
  if (!pos) return
  record(positionId, pos.coin, pos.current_sl, pos.take_profit, 'close', price ?? null)
}

/** Full SL/TP event history for a coin, oldest first. */
export function getSlTpHistory(coin: string): SlTpEvent[] {
  return queryAll(
    'SELECT position_id, coin, stop_loss, take_profit, event, price, created_at FROM sl_tp_history WHERE coin = ? ORDER BY created_at ASC, id ASC',
    [coin]
  ) as unknown as SlTpEvent[]
}
