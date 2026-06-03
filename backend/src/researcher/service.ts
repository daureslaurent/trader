import axios from 'axios'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'

export interface ResearchResult {
  coin: string
  headlines: string[]
  sentiment: 'positive' | 'negative' | 'neutral'
  summary: string
}

export async function researchCoin(coin: string): Promise<ResearchResult> {
  const symbol = coin.replace('/USDT', '')

  if (!config.serpApiKey) {
    return { coin, headlines: [], sentiment: 'neutral', summary: 'No search API key configured.' }
  }

  try {
    const resp = await axios.get('https://serpapi.com/search', {
      params: {
        q: `${symbol} crypto news`,
        api_key: config.serpApiKey,
        engine: 'google_news',
        num: 5,
      },
      timeout: 15000,
    })

    const headlines: string[] = []
    if (resp.data?.news_results) {
      for (const item of resp.data.news_results.slice(0, 5)) {
        if (item.title) headlines.push(item.title)
      }
    }

    logger.debug('Research results', { coin, headlineCount: headlines.length })
    return { coin, headlines, sentiment: 'neutral', summary: headlines.join('. ') }
  } catch (err) {
    logger.warn(`Research failed for ${symbol}`, { error: (err as Error).message })
    return { coin, headlines: [], sentiment: 'neutral', summary: 'Research unavailable.' }
  }
}
