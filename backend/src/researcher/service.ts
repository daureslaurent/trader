import { logger } from '../core/logger.js'
import { fetchPageText } from '../scraper/utils/fetchPageText.js'

export interface ArticleContent {
  title: string
  url: string
  content: string
}

export interface ResearchResult {
  coin: string
  headlines: string[]
  articles: ArticleContent[]
  sentiment: 'positive' | 'negative' | 'neutral'
  summary: string
}

export async function researchCoin(coin: string): Promise<ResearchResult> {
  const symbol = coin.replace('/USDT', '')

  try {
    const { search } = await import('../scraper/search.js')
    const results = await search(`${symbol} crypto 2026`, { count: 3 })

    const headlines = results.map((r: { title: string }) => r.title)

    const topResults = results.slice(0, 3)
    const articleResults = await Promise.allSettled(
      topResults.map(async (r: { title: string; url: string }) => ({
        title: r.title,
        url: r.url,
        content: await fetchPageText(r.url),
      }))
    )

    const articles: ArticleContent[] = []
    for (const result of articleResults) {
      if (result.status === 'fulfilled' && result.value.content) {
        articles.push(result.value)
      }
    }

    const summaryParts = [...headlines]
    if (articles.length > 0) {
      summaryParts.push('')
      summaryParts.push('--- Article Details ---')
      for (const a of articles) {
        summaryParts.push(`\n${a.title}\n${a.content.substring(0, 500)}...`)
      }
    }

    logger.debug('Research results', {
      coin,
      headlineCount: headlines.length,
      articleCount: articles.length,
    })

    return {
      coin,
      headlines,
      articles,
      sentiment: 'neutral',
      summary: summaryParts.join('. '),
    }
  } catch (err) {
    logger.warn(`Research failed for ${symbol}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      coin,
      headlines: [],
      articles: [],
      sentiment: 'neutral',
      summary: 'Research unavailable.',
    }
  }
}
