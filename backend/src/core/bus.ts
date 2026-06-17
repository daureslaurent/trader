/**
 * The reactive system event bus — the observability heartbeat.
 *
 * This is intentionally SEPARATE from the trade-orchestration bus in
 * `core/events.ts`. That bus is a command channel: engines emit intents and
 * `index.ts` handlers execute trades off them. This bus is a telemetry channel:
 * a strictly-typed, append-only stream of "something happened" facts that feed
 * the Event Stream visualiser (ring buffer + throttled WebSocket fan-out).
 *
 * Keeping them apart means telemetry can never accidentally drive execution,
 * and the stream can be firehosed/coalesced without touching trade logic.
 */

import { EventEmitter } from 'events'

/** Routing keys. Dotted namespaces group related events for filtering/colour. */
export enum SystemEvent {
  // MARKET.* — high-frequency price/candle data (coalesced on the wire).
  MARKET_KLINE_CLOSED = 'MARKET.KLINE_CLOSED',
  MARKET_PRICE_TICK = 'MARKET.PRICE_TICK',

  // STRATEGY.* — analyst / pipeline decisions.
  STRATEGY_SIGNAL_GENERATED = 'STRATEGY.SIGNAL_GENERATED',
  STRATEGY_ENTRY_PLANNED = 'STRATEGY.ENTRY_PLANNED',

  // EXECUTION.* — real exchange order lifecycle.
  EXECUTION_ORDER_SUBMITTED = 'EXECUTION.ORDER_SUBMITTED',
  EXECUTION_ORDER_FILLED = 'EXECUTION.ORDER_FILLED',
  EXECUTION_ORDER_FAILED = 'EXECUTION.ORDER_FAILED',

  // RISK.* — protective exits and position management.
  RISK_STOP_TRIGGERED = 'RISK.STOP_TRIGGERED',
  RISK_TAKE_PROFIT = 'RISK.TAKE_PROFIT',
  RISK_POSITION_ADJUSTED = 'RISK.POSITION_ADJUSTED',

  // SYSTEM.* — engine ticks and operational alerts.
  SYSTEM_ENGINE_TICK = 'SYSTEM.ENGINE_TICK',
  SYSTEM_ALERT = 'SYSTEM.ALERT',
}

/**
 * Coarse visual/handling class for an event. Drives:
 *   - frontend colour (mapped to theme tokens, not hard-coded neon)
 *   - wire policy: `market` events are coalesced; `critical` bypass throttle.
 */
export enum EventCategory {
  Market = 'market',
  Strategy = 'strategy',
  Execution = 'execution',
  Risk = 'risk',
  System = 'system',
  Critical = 'critical',
}

/** Type-safe payload for every SystemEvent. */
export interface SystemEventPayloads {
  [SystemEvent.MARKET_KLINE_CLOSED]: { symbol: string; interval: string; close: number; changePct: number }
  [SystemEvent.MARKET_PRICE_TICK]: { symbol: string; price: number; changePct?: number }
  [SystemEvent.STRATEGY_SIGNAL_GENERATED]: { symbol: string; action: 'BUY' | 'SELL' | 'HOLD'; confidence: number; reason?: string }
  [SystemEvent.STRATEGY_ENTRY_PLANNED]: { symbol: string; source: 'llm' | 'static'; pullbackPct: number; reason?: string }
  [SystemEvent.EXECUTION_ORDER_SUBMITTED]: { symbol: string; side: 'BUY' | 'SELL'; qty: number; price: number }
  [SystemEvent.EXECUTION_ORDER_FILLED]: { symbol: string; side: 'BUY' | 'SELL'; qty: number; price: number; notionalUsd: number }
  [SystemEvent.EXECUTION_ORDER_FAILED]: { symbol: string; side: 'BUY' | 'SELL'; error: string }
  [SystemEvent.RISK_STOP_TRIGGERED]: { symbol: string; positionId: number; price: number; pnl?: number | null }
  [SystemEvent.RISK_TAKE_PROFIT]: { symbol: string; positionId: number; price: number; pnl?: number | null }
  [SystemEvent.RISK_POSITION_ADJUSTED]: { symbol: string; positionId: number; stopLoss: number | null; takeProfit: number | null }
  [SystemEvent.SYSTEM_ENGINE_TICK]: { engine: string; cycleId?: string; detail?: string }
  [SystemEvent.SYSTEM_ALERT]: { level: 'info' | 'warn' | 'error'; message: string; source?: string }
}

/** Static event → category map. Anything unlisted falls back to System. */
const CATEGORY_OF: Record<SystemEvent, EventCategory> = {
  [SystemEvent.MARKET_KLINE_CLOSED]: EventCategory.Market,
  [SystemEvent.MARKET_PRICE_TICK]: EventCategory.Market,
  [SystemEvent.STRATEGY_SIGNAL_GENERATED]: EventCategory.Strategy,
  [SystemEvent.STRATEGY_ENTRY_PLANNED]: EventCategory.Strategy,
  [SystemEvent.EXECUTION_ORDER_SUBMITTED]: EventCategory.Execution,
  [SystemEvent.EXECUTION_ORDER_FILLED]: EventCategory.Execution,
  [SystemEvent.EXECUTION_ORDER_FAILED]: EventCategory.Critical,
  [SystemEvent.RISK_STOP_TRIGGERED]: EventCategory.Critical,
  [SystemEvent.RISK_TAKE_PROFIT]: EventCategory.Risk,
  [SystemEvent.RISK_POSITION_ADJUSTED]: EventCategory.Risk,
  [SystemEvent.SYSTEM_ENGINE_TICK]: EventCategory.System,
  [SystemEvent.SYSTEM_ALERT]: EventCategory.System,
}

export function categoryOf(event: SystemEvent): EventCategory {
  return CATEGORY_OF[event] ?? EventCategory.System
}

/** The shape an `onAny` subscriber receives for every emitted event. */
export interface SystemEnvelope<E extends SystemEvent = SystemEvent> {
  event: E
  category: EventCategory
  payload: SystemEventPayloads[E]
}

const ANY = '*'

class SystemBus extends EventEmitter {
  /** Strictly-typed emit. Also fans out to `onAny` subscribers via a meta-event. */
  emitEvent<E extends SystemEvent>(event: E, payload: SystemEventPayloads[E]): void {
    const category = categoryOf(event)
    super.emit(event, payload)
    super.emit(ANY, { event, category, payload } as SystemEnvelope)
  }

  /** Subscribe to one specific event with a correctly-typed payload. */
  onEvent<E extends SystemEvent>(event: E, listener: (payload: SystemEventPayloads[E]) => void): this {
    return super.on(event, listener as (payload: unknown) => void)
  }

  /** Subscribe to EVERY event — used by the WS/buffer bridge. */
  onAny(listener: (envelope: SystemEnvelope) => void): this {
    return super.on(ANY, listener as (envelope: unknown) => void)
  }
}

export const systemBus = new SystemBus()
// The bridge subscribes once; lots of engines can emit. Lift the default
// 10-listener warning so wiring many producers never trips a false leak warning.
systemBus.setMaxListeners(50)
