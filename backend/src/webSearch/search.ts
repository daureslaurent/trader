import { logger } from '../core/logger.js'
import { fetchPageText } from '../scraper/utils/fetchPageText.js'
import type { ArticleContent } from '../researcher/index.js'

/** A single search to run: the query string plus an optional recency filter. */
export interface SearchQuery {
  query: string
  /** DuckDuckGo date filter: 'd' (day), 'w' (week), 'm' (month), '' (any). */
  dateFilter?: 'd' | 'w' | 'm' | ''
}

export interface SearchFetchOptions {
  /** Results requested per query before merge/dedupe. Default 6. */
  perQuery?: number
  /** Hard cap on URLs fetched after merge/dedupe. Default 10. */
  maxResults?: number
}

// The generalized search/fetch core shared by the coin researcher and the generic
// web_search tool. Runs each query in parallel, merges + dedupes by URL (earlier
// queries win — so callers order their queries by priority), caps the count, then
// fetches readable page text for each in parallel. Failed searches/fetches are
// dropped, never thrown.
export async function searchAndFetch(
  queries: SearchQuery[],
  options: SearchFetchOptions = {},
): Promise<ArticleContent[]> {
  const perQuery = options.perQuery ?? 6
  const maxResults = options.maxResults ?? 10
  if (queries.length === 0) return []

  try {
    const { search } = await import('../scraper/search.js')

    const batches = await Promise.allSettled(
      queries.map(q => search(q.query, { count: perQuery, dateFilter: q.dateFilter ?? '' })),
    )

    // Merge + dedupe by URL, preserving query order (first occurrence wins).
    const seen = new Set<string>()
    const merged: { title: string; url: string }[] = []
    for (const batch of batches) {
      if (batch.status !== 'fulfilled') continue
      for (const r of batch.value as { title: string; url: string }[]) {
        if (r?.url && !seen.has(r.url)) {
          seen.add(r.url)
          merged.push({ title: r.title, url: r.url })
        }
      }
    }

    const toFetch = merged.slice(0, maxResults)
    const fetched = await Promise.allSettled(
      toFetch.map(async r => ({ title: r.title, url: r.url, content: await fetchPageText(r.url) })),
    )

    const articles: ArticleContent[] = []
    for (const result of fetched) {
      if (result.status === 'fulfilled' && result.value.content) articles.push(result.value)
    }

    logger.debug('web search/fetch complete', {
      queries: queries.length, found: merged.length, fetched: articles.length,
    })
    return articles
  } catch (err) {
    logger.warn('web search/fetch failed', { error: (err as Error).message })
    return []
  }
}
