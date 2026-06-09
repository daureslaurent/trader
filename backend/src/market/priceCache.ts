import WebSocket from 'ws'
import { logger } from '../core/logger.js'
import { broadcast } from '../api/ws.js'

export interface PriceSnapshot {
  price: number
  change24h: number
  volume: number
  updatedAt: number
}

const cache = new Map<string, PriceSnapshot>()
const subscribed = new Set<string>()

let binanceWs: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let msgId = 0

// 'BTC/USDC' → 'btcusdc@miniTicker'
function toStream(symbol: string): string {
  return symbol.replace('/', '').toLowerCase() + '@miniTicker'
}

// 'BTCUSDC' → 'BTC/USDC'
function fromBinance(raw: string): string {
  return raw.endsWith('USDC') ? `${raw.slice(0, -4)}/USDC` : raw
}

export function getPrice(symbol: string): PriceSnapshot | null {
  if (symbol === 'USDC') return { price: 1, change24h: 0, volume: 0, updatedAt: Date.now() }
  return cache.get(symbol) ?? null
}

export function getAll(): ReadonlyMap<string, PriceSnapshot> {
  return cache
}

export function subscribe(symbols: string[]): void {
  const fresh = symbols.filter(s => s !== 'USDC' && !subscribed.has(s))
  if (fresh.length === 0) return

  for (const s of fresh) subscribed.add(s)

  if (binanceWs?.readyState === WebSocket.OPEN) {
    sendSubscribe(fresh)
  }
  // else: will subscribe on next (re)connect via the open handler
}

function sendSubscribe(symbols: string[]): void {
  if (!binanceWs || binanceWs.readyState !== WebSocket.OPEN) return
  binanceWs.send(JSON.stringify({ method: 'SUBSCRIBE', params: symbols.map(toStream), id: ++msgId }))
  logger.info('PriceCache: subscribed to Binance streams', { symbols })
}

function handleMiniTicker(msg: Record<string, string>): void {
  const symbol = fromBinance(msg.s)
  if (!subscribed.has(symbol)) return
  const price = parseFloat(msg.c)
  const open = parseFloat(msg.o)
  const change24h = open > 0 ? ((price - open) / open) * 100 : 0
  const snap: PriceSnapshot = { price, change24h, volume: parseFloat(msg.q), updatedAt: Date.now() }
  cache.set(symbol, snap)
  broadcast('price_update', { symbol, price, change24h })
}

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  binanceWs = new WebSocket('wss://stream.binance.com:9443/ws')

  binanceWs.on('open', () => {
    logger.info('PriceCache: Binance WS connected')
    reconnectDelay = 1000
    if (subscribed.size > 0) sendSubscribe([...subscribed])
  })

  binanceWs.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.e === '24hrMiniTicker') handleMiniTicker(msg as Record<string, string>)
    } catch {}
  })

  binanceWs.on('close', (code) => {
    logger.warn('PriceCache: Binance WS closed, will reconnect', { code, delay: reconnectDelay })
    scheduleReconnect()
  })

  binanceWs.on('error', (err) => {
    logger.error('PriceCache: Binance WS error', { error: err.message })
    binanceWs?.terminate()
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    connect()
  }, reconnectDelay)
}

export function start(): void {
  logger.info('PriceCache: connecting to Binance WebSocket')
  connect()
}

export function stop(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  binanceWs?.terminate()
  binanceWs = null
}
