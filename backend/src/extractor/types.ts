export type ArticleSkipReason = 'captcha' | 'cloudflare' | 'irrelevant'

export interface ExtractedArticle {
  title: string
  url: string
  relevance_score: number
  sentiment: 'positive' | 'negative' | 'neutral'
  summary: string
  key_points: string[]
  metrics?: {
    price_target?: { min: number | null; max: number | null } | null
    market_cap?: number | null
    circulating_supply?: number | null
    volume_trend?: 'increasing' | 'decreasing' | 'stable' | null
  }
  preliminary_signal?: 'BUY' | 'SELL' | 'HOLD'
  skip_reason?: ArticleSkipReason
  from_cache?: boolean
}

export interface ExtractedResearch {
  coin: string
  articles: ExtractedArticle[]
  skipped_articles: ExtractedArticle[]
  aggregated_sentiment: 'positive' | 'negative' | 'neutral'
  top_headlines: string[]
}
