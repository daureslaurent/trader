import { useState, useCallback } from 'react'
import { useWebSocket } from './useWebSocket'

export interface LivePrice {
  price: number
  change24h: number
}

export function usePrices(): ReadonlyMap<string, LivePrice> {
  const [prices, setPrices] = useState<Map<string, LivePrice>>(new Map())

  const handleMessage = useCallback((event: string, data: unknown) => {
    if (event !== 'price_update') return
    const { symbol, price, change24h } = data as { symbol: string; price: number; change24h: number }
    if (!symbol || typeof price !== 'number') return
    setPrices(prev => {
      const next = new Map(prev)
      next.set(symbol, { price, change24h: change24h ?? 0 })
      return next
    })
  }, [])

  useWebSocket(handleMessage)

  return prices
}
