import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { MarketData, PortfolioEntry, PortfolioState, BotSettings } from '../types.js'

const USDT_COIN = 'USDT'

export function getOpenEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown as PortfolioEntry[]
}

export function getCoinEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries WHERE status = 'OPEN' AND coin != ? ORDER BY created_at ASC", [USDT_COIN]) as unknown as PortfolioEntry[]
}

export function getUsdtEntry(): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE coin = ? AND status = 'OPEN'", [USDT_COIN]) as PortfolioEntry | null
}

export function syncUsdtEntry(usdtBalance: number): void {
  const existing = getUsdtEntry()
  if (existing) {
    runSQL("UPDATE portfolio_entries SET quantity = ? WHERE id = ?", [usdtBalance, existing.id])
  } else {
    const today = new Date().toISOString().split('T')[0]
    addEntry(USDT_COIN, usdtBalance, 1.0, today, 'manual')
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
  source: 'trade' | 'manual' = 'trade',
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

  return {
    totalValueUsd: totalValue,
    positions,
    diversificationScore,
    openPositionCount: positions.length,
    maxOpenPositions: settings.max_open_positions,
    targetAllocationPct,
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
