import WebSocket from 'ws'
import { logger } from '../core/logger.js'
import { systemBus, SystemEvent } from '../core/bus.js'

/**
 * On-demand manager for the richer Binance market streams used as routing inputs
 * (kline closes, best bid/ask, aggregate trades, partial order-book depth).
 *
 * Separate from priceCache's miniTicker feed so the high-volume streams only run
 * when a matching input node is enabled in the routing graph. `setStreams()` is
 * driven by routing/binanceSync — it reconciles the desired stream set against
 * what's currently subscribed, opening the socket on demand and closing it when
 * nothing is wanted.
 *
 * Uses the combined-stream endpoint so every frame is `{ stream, data }` and we
 * always know the source symbol/type (bookTicker & partial-depth frames carry no
 * event-type field of their own).
 */

const ENDPOINT = 'wss://stream.binance.com:9443/stream'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let msgId = 0

// The desired set of fully-qualified Binance stream names (lowercase), e.g.
// 'btcusdc@kline_1m', 'btcusdc@bookTicker', 'btcusdc@aggTrade', 'btcusdc@depth5@100ms'.
let desired = new Set<string>()
// What we've actually sent SUBSCRIBE for on the current socket.
let active = new Set<string>()

// 'BTCUSDC' → 'BTC/USDC'
function fromBinance(raw: string): string {
  const up = raw.toUpperCase()
  return up.endsWith('USDC') ? `${up.slice(0, -4)}/USDC` : up
}

export function setStreams(next: Set<string>): void {
  desired = next
  if (desired.size === 0) {
    if (ws) { active = new Set(); ws.close() }
    return
  }
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connect()
    return
  }
  if (ws.readyState === WebSocket.OPEN) reconcile()
  // CONNECTING → reconciled by the open handler.
}

function reconcile(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const toAdd = [...desired].filter((s) => !active.has(s))
  const toRemove = [...active].filter((s) => !desired.has(s))
  if (toAdd.length) {
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: toAdd, id: ++msgId }))
    logger.info('BinanceStreams: subscribed', { count: toAdd.length })
  }
  if (toRemove.length) {
    ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: toRemove, id: ++msgId }))
    logger.info('BinanceStreams: unsubscribed', { count: toRemove.length })
  }
  active = new Set(desired)
}

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  ws = new WebSocket(ENDPOINT)

  ws.on('open', () => {
    logger.info('BinanceStreams: connected')
    reconnectDelay = 1000
    active = new Set()
    reconcile()
  })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { stream?: string; data?: Record<string, unknown> }
      if (msg.stream && msg.data) handleFrame(msg.stream, msg.data)
    } catch { /* ignore malformed */ }
  })

  ws.on('close', () => {
    ws = null
    if (desired.size === 0) return
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    reconnectTimer = setTimeout(connect, reconnectDelay)
  })

  ws.on('error', (err) => {
    logger.warn('BinanceStreams: socket error', { error: err.message })
    ws?.close()
  })
}

function handleFrame(stream: string, data: Record<string, unknown>): void {
  const base = stream.split('@')[0]
  const symbol = fromBinance(base)

  if (stream.includes('@kline')) {
    const k = data.k as Record<string, unknown> | undefined
    if (!k || k.x !== true) return // only on candle close
    const open = Number(k.o), close = Number(k.c)
    systemBus.emitEvent(SystemEvent.MARKET_KLINE_CLOSED, {
      symbol, interval: String(k.i), open, high: Number(k.h), low: Number(k.l), close,
      volume: Number(k.v), changePct: open > 0 ? ((close - open) / open) * 100 : 0,
    })
  } else if (stream.includes('@bookTicker')) {
    const bid = Number(data.b), ask = Number(data.a)
    systemBus.emitEvent(SystemEvent.MARKET_BOOK_TICKER, {
      symbol, bid, bidQty: Number(data.B), ask, askQty: Number(data.A), spread: ask - bid,
    })
  } else if (stream.includes('@aggTrade')) {
    systemBus.emitEvent(SystemEvent.MARKET_AGG_TRADE, {
      symbol, price: Number(data.p), qty: Number(data.q), side: data.m === true ? 'sell' : 'buy',
    })
  } else if (stream.includes('@depth')) {
    const lvls = (raw: unknown): [number, number][] =>
      Array.isArray(raw) ? raw.slice(0, 3).map((l) => [Number((l as string[])[0]), Number((l as string[])[1])] as [number, number]) : []
    systemBus.emitEvent(SystemEvent.MARKET_DEPTH, { symbol, bids: lvls(data.bids), asks: lvls(data.asks) })
  }
}

export function stopStreams(): void {
  desired = new Set()
  active = new Set()
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (ws) { ws.close(); ws = null }
}
