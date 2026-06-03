import { logger } from '../core/logger.js'

export interface ResearchResult {
  coin: string
  headlines: string[]
  sentiment: 'positive' | 'negative' | 'neutral'
  summary: string
}

export async function researchCoin(coin: string): Promise<ResearchResult> {
  const symbol = coin.replace('/USDT', '')

  try {
    const { search } = await import('../scraper/search.js')
    const results = await search(`${symbol} crypto 2026`, { count: 5 })

    const headlines = results.map((r: { title: string }) => r.title)
    logger.debug('Research results', { coin, headlineCount: headlines.length })
    return { coin, headlines, sentiment: 'neutral', summary: headlines.join('. ') }
  } catch (err) {
    logger.warn(`Research failed for ${symbol}`, { error: (err as Error).message })
    return { coin, headlines: [], sentiment: 'neutral', summary: 'Research unavailable.' }
  }
}
