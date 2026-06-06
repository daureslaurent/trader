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
  summary: string
}

// Common full names for better search coverage
const COIN_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB',
  XRP: 'XRP Ripple', ADA: 'Cardano', DOGE: 'Dogecoin', AVAX: 'Avalanche',
  DOT: 'Polkadot', LINK: 'Chainlink', MATIC: 'Polygon', UNI: 'Uniswap',
  LTC: 'Litecoin', ATOM: 'Cosmos', NEAR: 'NEAR Protocol', APT: 'Aptos',
  ARB: 'Arbitrum', OP: 'Optimism', INJ: 'Injective', SUI: 'Sui',
}

export async function researchCoin(coin: string): Promise<ResearchResult> {
  const symbol = coin.replace('/USDC', '')
  const fullName = COIN_NAMES[symbol] ?? symbol

  try {
    const { search } = await import('../scraper/search.js')

    // Two parallel queries: breaking news from today, deeper coverage from the week
    const [todayResults, weekResults] = await Promise.allSettled([
      search(`${fullName} crypto news price`, { count: 5, dateFilter: 'd' }),
      search(`${symbol} ${fullName} cryptocurrency latest update`, { count: 4, dateFilter: 'w' }),
    ])

    // Merge and deduplicate by URL — today's results take priority
    const seen = new Set<string>()
    const merged: { title: string; url: string }[] = []

    for (const batch of [todayResults, weekResults]) {
      if (batch.status !== 'fulfilled') continue
      for (const r of batch.value as { title: string; url: string }[]) {
        if (!seen.has(r.url)) {
          seen.add(r.url)
          merged.push(r)
        }
      }
    }

    const headlines = merged.map(r => r.title)

    // Fetch article content in parallel, cap at 6 to stay within extractor budget
    const toFetch = merged.slice(0, 6)
    const articleResults = await Promise.allSettled(
      toFetch.map(async r => ({
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

    logger.debug('Research results', {
      coin,
      headlineCount: headlines.length,
      articleCount: articles.length,
    })

    return { coin, headlines, articles, summary: headlines.join('. ') }
  } catch (err) {
    logger.warn(`Research failed for ${symbol}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return { coin, headlines: [], articles: [], summary: 'Research unavailable.' }
  }
}
