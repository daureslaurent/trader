import { EventEmitter } from 'events'
import { Signal, ApprovalRequest, TradeRecord, BotSettings, SlTpAdjustmentProposal, PositionRecord, PortfolioSummary } from '../types.js'

interface EventMap {
  signal_generated: [Signal]
  trade_approved: [number]
  trade_rejected: [number]
  trade_executed: [TradeRecord]
  approval_requested: [ApprovalRequest]
  portfolio_updated: []
  settings_updated: [BotSettings]
  stop_loss_hit: [{ positionId: number; coin: string; price: number }]
  take_profit_hit: [{ positionId: number; coin: string; price: number }]
  pipeline_run_requested: [{ symbol: string; cycle_id: string }]
  pipeline_run_all_requested: [Record<string, never>]
  pipeline_cancel_requested: [{ cycle_id: string }]
  trade_signal_simulated: [{ symbol: string; action: 'BUY' | 'SELL'; confidence: number; reason: string; cycle_id: string }]
  discovery_run_requested: [{ cycle_id: string }]
  monitor_run_requested: [{ cycle_id: string }]
  summary_run_requested: [{ cycle_id: string }]
  portfolio_summary_created: [PortfolioSummary]
  position_adjustment_proposed: [SlTpAdjustmentProposal]
  adjustment_approved: [number]
  adjustment_rejected: [number]
  monitor_close_requested: [{ positionId: number; coin: string; currentPrice: number; reasoning: string; confidence: number; cycleId: string }]
  coin_discovered: [{ id: number; coin: string; score: number; reasoning: string; market_data: string; status: string; cycle_id: string; created_at: string }]
  entry_fire: [{ signal: Signal; price: number; atr: number }]
  /** A deferred BUY was just registered on the Entry Desk — the Entry Agent does an
   *  immediate first pass for this coin (no-op when entry_model !== 'agent'). */
  entry_intent_registered: [{ coin: string; cycle_id: string }]
  trade_failed: [{ coin: string; side: string; error: string }]
  trade_result: [{ tradeId: number; success: boolean; error?: string }]
  pipeline_completed: [{ total_value_usd: number; trades_initiated: number; holdings: Record<string, number> }]
  error: [Error]
  position_opened: [PositionRecord]
  position_closed: [{ positionId: number; coin: string; status: string; fillPrice: number; fillQty: number; pnl: number | null; reason: string; entryPrice: number | null; openedAt: string | null }]
  sl_tp_adjusted: [{ coin: string; positionId: number; oldStopLoss: number | null; oldTakeProfit: number | null; newStopLoss: number | null; newTakeProfit: number | null; currentPrice: number | null; entryPrice: number | null }]
  update_available: [{ updateCount: number; currentShortSha: string; remoteShortSha: string; latestSubject: string }]
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