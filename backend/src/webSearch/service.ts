import { logger } from '../core/logger.js'
import { searchAndFetch } from './search.js'
import { extractForQuery } from './extract.js'
import type { WebSearchResult } from './types.js'

export interface WebSearchOptions {
  /** DuckDuckGo recency filter: 'd' (day), 'w' (week), 'm' (month), '' (any). Default ''. */
  dateFilter?: 'd' | 'w' | 'm' | ''
  /** Max pages to fetch + extract. Default 6. */
  maxResults?: number
}

// Generic, query-driven web research: search the web for `query`, fetch the top pages,
// and run a per-page LLM extraction that summarizes each against the query. Returns the
// relevant articles, most-relevant first. Heavy (a crawl + one LLM call per page), but
// per-page extractions are cached by query+URL so repeats are cheap.
export async function webSearch(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult> {
  const q = query.trim()
  if (!q) return { query, articles: [] }
  const maxResults = options.maxResults ?? 6

  try {
    const fetched = await searchAndFetch(
      [{ query: q, dateFilter: options.dateFilter ?? '' }],
      { perQuery: maxResults, maxResults },
    )
    if (fetched.length === 0) return { query: q, articles: [] }
    const articles = await extractForQuery(q, fetched)
    return { query: q, articles }
  } catch (err) {
    logger.warn('webSearch failed', { query: q, error: (err as Error).message })
    return { query: q, articles: [] }
  }
}
