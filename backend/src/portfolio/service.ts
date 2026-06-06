import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { MarketData, PortfolioEntry, PortfolioState, BotSettings } from '../types.js'

const USDT_COIN = 'USDC'

export function getOpenEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown as PortfolioEntry[]
}

export function getCoinEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries WHERE status = 'OPEN' AND coin != ? ORDER BY created_at ASC", [USDT_COIN]) as unknown as PortfolioEntry[]
}

export function getUsdtEntry(): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [USDT_COIN]) as PortfolioEntry | null
}

export function seedUsdtIfAbsent(amount: number): void {
  if (getUsdtEntry()) return
  const today = new Date().toISOString().split('T')[0]
  addEntry(USDT_COIN, amount, 1.0, today, 'manual')
  logger.info('USDC entry seeded', { amount })
}

// Compares the real Binance USDC balance against the local ledger.
// Only acts when a local entry already exists — never auto-seeds.
// If Binance < local, an external withdrawal happened — reduce local accordingly.
// Deposits must be done explicitly via the deposit endpoint.
export function detectExternalWithdrawal(binanceUsdt: number): void {
  const existing = getUsdtEntry()
  if (!existing) return
  if (binanceUsdt < existing.quantity) {
    const withdrawn = existing.quantity - binanceUsdt
    logger.info('External USDC withdrawal detected', { withdrawn, localBefore: existing.quantity, binanceNow: binanceUsdt })
    reduceEntryQuantity(existing.id, withdrawn)
  }
}

export function depositUsdt(amount: number): number {
  const entry = getUsdtEntry()
  if (entry) {
    increaseEntryQuantity(entry.id, amount)
    return entry.quantity + amount
  } else {
    const today = new Date().toISOString().split('T')[0]
    addEntry(USDT_COIN, amount, 1.0, today, 'manual')
    return amount
  }
}

export function withdrawUsdt(amount: number): { ok: boolean; balance: number; error?: string } {
  const entry = getUsdtEntry()
  if (!entry) return { ok: false, balance: 0, error: 'No USDC balance' }
  if (entry.quantity < amount) return { ok: false, balance: entry.quantity, error: 'Insufficient balance' }
  reduceEntryQuantity(entry.id, amount)
  return { ok: true, balance: entry.quantity - amount }
}

export function getEntryByCoin(coin: string): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC LIMIT 1", [coin]) as PortfolioEntry | null
}

export function updatePortfolioForTrade(
  fromCoin: string,
  fromAmount: number,
  toCoin: string,
  toAmount: number,
  toPrice: number,
  buyTradeId: number,
): void {
  const fromEntry = fromCoin === USDT_COIN ? getUsdtEntry() : getEntryByCoin(fromCoin)
  if (!fromEntry) throw new Error(`updatePortfolioForTrade: no open entry for ${fromCoin}`)
  if (fromEntry.quantity < fromAmount) throw new Error(`updatePortfolioForTrade: insufficient balance for ${fromCoin}`)

  reduceEntryQuantity(fromEntry.id, fromAmount)

  const toEntry = toCoin === USDT_COIN ? getUsdtEntry() : getEntryByCoin(toCoin)
  if (toEntry) {
    increaseEntryQuantity(toEntry.id, toAmount)
  } else {
    const today = new Date().toISOString().split('T')[0]
    addEntry(toCoin, toAmount, toPrice, today, 'trade', buyTradeId)
  }
}

export function getAllEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries ORDER BY created_at DESC") as unknown as PortfolioEntry[]
}

export function getEntryById(id: number): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE id = ?", [id]) as PortfolioEntry | null
}

export function addEntry(
  coin: string,
  quantity: number,
  buyPrice: number,
  buyDate: string,
  source: 'trade' | 'manual' | 'transfer' = 'trade',
  tradeId?: number,
): number {
  const { lastInsertRowid } = runSQL(
    `INSERT INTO portfolio_entries (coin, quantity, buy_price, buy_date, source, trade_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [coin, quantity, buyPrice, buyDate, source, tradeId ?? null]
  )
  logger.info('Portfolio entry added', { coin, quantity, buyPrice, id: lastInsertRowid })
  return lastInsertRowid
}

export function closeEntry(id: number): void {
  runSQL("UPDATE portfolio_entries SET status = 'CLOSED' WHERE id = ? AND status = 'OPEN'", [id])
  const entry = getEntryById(id)
  if (entry) {
    logger.info('Portfolio entry closed', { coin: entry.coin, id })
  }
}

export function reduceEntryQuantity(id: number, sellQty: number): void {
  const entry = getEntryById(id)
  if (!entry) return
  const newQty = entry.quantity - sellQty
  if (newQty <= 0) {
    closeEntry(id)
  } else {
    runSQL("UPDATE portfolio_entries SET quantity = ? WHERE id = ?", [newQty, id])
  }
}

export function removeEntry(id: number): void {
  runSQL("DELETE FROM portfolio_entries WHERE id = ?", [id])
}

export function updateEntryQuantity(id: number, quantity: number): void {
  runSQL("UPDATE portfolio_entries SET quantity = ? WHERE id = ?", [quantity, id])
}

export function increaseEntryQuantity(id: number, additionalQty: number): void {
  runSQL("UPDATE portfolio_entries SET quantity = quantity + ? WHERE id = ?", [additionalQty, id])
}

export function updateEntry(id: number, updates: Partial<Pick<PortfolioEntry, 'quantity' | 'buy_price' | 'buy_date'>>): void {
  const setClauses: string[] = []
  const params: (string | number)[] = []
  if (updates.quantity !== undefined) {
    setClauses.push('quantity = ?')
    params.push(updates.quantity)
  }
  if (updates.buy_price !== undefined) {
    setClauses.push('buy_price = ?')
    params.push(updates.buy_price)
  }
  if (updates.buy_date !== undefined) {
    setClauses.push('buy_date = ?')
    params.push(updates.buy_date)
  }
  if (setClauses.length === 0) return
  params.push(id)
  runSQL(`UPDATE portfolio_entries SET ${setClauses.join(', ')} WHERE id = ?`, params)
}

export function getPortfolioState(
  marketData: MarketData[],
  settings: BotSettings,
): PortfolioState {
  const usdtEntry = getUsdtEntry()
  const coinEntries = getCoinEntries()
  const usdtTotal = usdtEntry ? usdtEntry.quantity : 0
  let totalValue = usdtTotal

  for (const entry of coinEntries) {
    const md = marketData.find(d => d.symbol === entry.coin)
    if (md) {
      totalValue += entry.quantity * md.price
    }
  }

  const positions = coinEntries.map(e => {
    const md = marketData.find(d => d.symbol === e.coin)
    const currentPrice = md?.price || e.buy_price
    const currentValue = e.quantity * currentPrice
    const allocationPct = totalValue > 0 ? currentValue / totalValue : 0
    const deltaPct = e.buy_price > 0 ? ((currentPrice - e.buy_price) / e.buy_price) * 100 : 0
    return {
      coin: e.coin,
      allocationPct,
      deltaPct,
      entryPrice: e.buy_price,
      currentPrice,
      quantity: e.quantity,
    }
  })

  const coinCount = positions.length + 1
  const targetAllocationPct = coinCount > 0 ? 1 / coinCount : 1

  const allocs = positions.map(p => p.allocationPct)
  const idealAlloc = 1 / coinCount
  const deviations = allocs.map(a => Math.abs(a - idealAlloc))
  const avgDeviation = deviations.length > 0 ? deviations.reduce((s, d) => s + d, 0) / deviations.length : 0
  const diversificationScore = Math.max(0, 1 - avgDeviation)

  // openPositionCount tracks only bot-managed positions (positions table, status=OPEN).
  // portfolio_entries includes manual/transfer holdings which don't consume a bot slot.
  const botPositionCount = (queryAll("SELECT COUNT(*) AS cnt FROM positions WHERE status = 'OPEN'")[0]?.cnt as number) ?? 0

  return {
    totalValueUsd: totalValue,
    positions,
    diversificationScore,
    openPositionCount: botPositionCount,
    maxOpenPositions: settings.max_open_positions,
    targetAllocationPct,
  }
}

export interface CoinPortfolioContext {
  currentQuantity: number
  avgBuyPrice: number | null
  recentTrades: { side: 'BUY' | 'SELL'; quantity: number; price: number; date: string }[]
}

export function getCoinPortfolioContext(coin: string): CoinPortfolioContext {
  const entries = queryAll(
    "SELECT quantity, buy_price FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'",
    [coin]
  ) as { quantity: number; buy_price: number }[]

  const currentQuantity = entries.reduce((sum, e) => sum + e.quantity, 0)
  const avgBuyPrice = currentQuantity > 0
    ? entries.reduce((sum, e) => sum + e.buy_price * e.quantity, 0) / currentQuantity
    : null

  const trades = queryAll(
    "SELECT side, quantity, price, created_at FROM trades WHERE coin = ? AND status = 'EXECUTED' ORDER BY created_at DESC LIMIT 5",
    [coin]
  ) as { side: string; quantity: number; price: number; created_at: string }[]

  return {
    currentQuantity,
    avgBuyPrice,
    recentTrades: trades.map(t => ({
      side: t.side as 'BUY' | 'SELL',
      quantity: t.quantity,
      price: t.price,
      date: t.created_at.split('T')[0] ?? t.created_at.split(' ')[0] ?? t.created_at,
    })),
  }
}

export function enrichPortfolioEntriesWithPrices(
  entries: PortfolioEntry[],
  marketData: MarketData[],
): PortfolioEntry[] {
  return entries.map(e => {
    const isUsdt = e.coin === USDT_COIN
    const currentPrice = isUsdt ? 1.0 : (marketData.find(d => d.symbol === e.coin)?.price ?? null)
    const deltaUsd = currentPrice !== null && e.buy_price > 0
      ? (currentPrice - e.buy_price) * e.quantity
      : null
    const deltaPct = currentPrice !== null && e.buy_price > 0
      ? ((currentPrice - e.buy_price) / e.buy_price) * 100
      : null
    return {
      ...e,
      current_price: currentPrice,
      delta_usd: deltaUsd !== null ? Math.round(deltaUsd * 100) / 100 : null,
      delta_pct: deltaPct !== null ? Math.round(deltaPct * 100) / 100 : null,
    }
  })
}
