import { EventEmitter } from 'events'
import { Signal, ApprovalRequest, TradeRecord } from '../types.js'

interface EventMap {
  signal_generated: [Signal]
  trade_approved: [number]
  trade_rejected: [number]
  trade_executed: [TradeRecord]
  approval_requested: [ApprovalRequest]
  portfolio_updated: []
  stop_loss_hit: [{ positionId: number; coin: string; price: number }]
  take_profit_hit: [{ positionId: number; coin: string; price: number }]
  error: [Error]
}

class BotEventBus extends EventEmitter {
  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): boolean {
    return super.emit(event as string, ...args)
  }

  on<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
    return super.on(event as string, listener as (...args: unknown[]) => void)
  }
}

export const bus = new BotEventBus()