export type WebArticleSkipReason = 'captcha' | 'cloudflare' | 'irrelevant'

// One extracted page, scored against the caller's free-text query (NOT a coin).
export interface WebArticle {
  title: string
  url: string
  /** 0.0–1.0: how relevant this page is to the query. 0 → dropped as irrelevant. */
  relevance_score: number
  /** 1–2 sentence summary of the page's information relevant to the query. */
  summary: string
  /** 2–4 concrete facts/claims from the page (numbers, dates, named entities preferred). */
  key_points: string[]
  /** Set when the page was skipped without (or instead of) a useful extraction. */
  skip_reason?: WebArticleSkipReason
  from_cache?: boolean
}

export interface WebSearchResult {
  query: string
  articles: WebArticle[]
}
