import { logger } from '../core/logger.js'
import { searchAndFetch } from '../webSearch/index.js'

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
    // Delegate the crawl plumbing (search → dedupe → fetch) to the shared web-search
    // core. Two queries, today's breaking news prioritized over the week's coverage.
    const articles = await searchAndFetch(
      [
        { query: `${fullName} crypto news price`, dateFilter: 'd' },
        { query: `${symbol} ${fullName} cryptocurrency latest update`, dateFilter: 'w' },
      ],
      { perQuery: 6, maxResults: 10 },
    )

    const headlines = articles.map(a => a.title)

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
