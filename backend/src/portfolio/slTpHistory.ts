import { ClientSession } from 'mongodb'
import { slTpHistory, positions as positionsRepo, nowSql } from '../db/index.js'

export interface SlTpEvent {
  position_id: number
  coin: string
  stop_loss: number
  take_profit: number | null
  event: 'open' | 'update' | 'close'
  price: number | null
  created_at: string
}

type Opts = { session?: ClientSession }

async function record(
  positionId: number,
  coin: string,
  stopLoss: number,
  takeProfit: number | null,
  event: SlTpEvent['event'],
  price: number | null,
  opts: Opts = {},
): Promise<void> {
  await slTpHistory.insert({
    position_id: positionId, coin, stop_loss: stopLoss, take_profit: takeProfit ?? null,
    event, price: price ?? null, created_at: nowSql(),
  }, opts)
}

/** Record the initial SL/TP when a position is opened. */
export async function recordPositionOpen(
  positionId: number, coin: string, stopLoss: number, takeProfit: number | null, price: number, opts: Opts = {},
): Promise<void> {
  await record(positionId, coin, stopLoss, takeProfit, 'open', price, opts)
}

/** Record a SL/TP change (e.g. trailing stop or monitor adjustment) while a position is open. */
export async function recordSlTpUpdate(
  positionId: number, coin: string, stopLoss: number, takeProfit: number | null, price?: number | null, opts: Opts = {},
): Promise<void> {
  await record(positionId, coin, stopLoss, takeProfit, 'update', price ?? null, opts)
}

/** Record the terminating event for a position, using its last known SL/TP. */
export async function recordPositionClose(positionId: number, price?: number, opts: Opts = {}): Promise<void> {
  const pos = (await positionsRepo.findOne(
    { _id: positionId },
    { projection: { coin: 1, current_sl: 1, take_profit: 1 }, ...opts },
  )) as { coin: string; current_sl: number; take_profit: number | null } | null
  if (!pos) return
  await record(positionId, pos.coin, pos.current_sl, pos.take_profit, 'close', price ?? null, opts)
}

/** Full SL/TP event history for a coin, oldest first. */
export async function getSlTpHistory(coin: string): Promise<SlTpEvent[]> {
  return slTpHistory.find(
    { coin },
    { sort: { created_at: 1, id: 1 }, projection: { position_id: 1, coin: 1, stop_loss: 1, take_profit: 1, event: 1, price: 1, created_at: 1 } },
  ) as unknown as Promise<SlTpEvent[]>
}
