import { useEffect, useState, useCallback } from 'react'
import { CacheCoin, CachedArticle } from '../types'
import { Badge, actionBadge } from '../components/ui/Badge'
import { cn, formatDate } from '../lib/utils'

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function ExpiryCountdown({ cachedAt, ttlHours }: { cachedAt: string; ttlHours: number }) {
  const now = useNow(30_000)
  const cachedMs = new Date(cachedAt.includes('T') ? cachedAt : cachedAt + 'Z').getTime()
  const expiresMs = cachedMs + ttlHours * 3_600_000
  const diffMs = expiresMs - now

  if (diffMs <= 0) {
    return <span className="text-xs font-medium text-sell">Expired</span>
  }

  const totalMins = Math.floor(diffMs / 60_000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60

  const label = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
  const urgency = diffMs < 60 * 60_000 // < 1 hour
  const warning = diffMs < 3 * 60 * 60_000 // < 3 hours

  return (
    <span className={cn(
      'text-xs font-medium tabular-nums',
      urgency ? 'text-sell' : warning ? 'text-warn' : 'text-muted',
    )}>
      expires in {label}
    </span>
  )
}

function SentimentBadge({ s }: { s?: string }) {
  if (!s) return null
  const v = s === 'positive' ? 'buy' : s === 'negative' ? 'sell' : 'neutral'
  return <Badge variant={v as any}>{s}</Badge>
}

function RelevanceBar({ score }: { score?: number }) {
  if (score === undefined) return null
  const pct = Math.round(score * 100)
  const color = score >= 0.7 ? 'bg-buy' : score >= 0.4 ? 'bg-warn' : 'bg-sell'
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-surface-card rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted">{pct}% relevant</span>
    </div>
  )
}

function TrashIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  )
}

function ArticleCard({
  article,
  ttlHours,
  onClear,
  clearing,
}: {
  article: CachedArticle
  ttlHours: number
  onClear: (url: string) => void
  clearing: boolean
}) {
  return (
    <div className={cn(
      'bg-surface-card border border-border rounded-2xl p-4 space-y-3 transition-opacity',
      clearing && 'opacity-40 pointer-events-none',
    )}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-foreground hover:text-accent transition-colors line-clamp-2 leading-snug"
          >
            {article.title ?? article.url}
          </a>
          <p className="text-xs text-muted font-mono truncate">{article.url}</p>
        </div>
        <button
          onClick={() => onClear(article.url)}
          className="shrink-0 p-1.5 rounded-lg text-muted hover:text-sell hover:bg-sell/10 transition-colors"
          title="Remove from cache"
        >
          <TrashIcon />
        </button>
      </div>

      {/* Badges row */}
      <div className="flex items-center gap-2 flex-wrap">
        <SentimentBadge s={article.sentiment} />
        {article.preliminary_signal && actionBadge(article.preliminary_signal)}
        <RelevanceBar score={article.relevance_score} />
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ExpiryCountdown cachedAt={article.cached_at} ttlHours={ttlHours} />
          <span className="text-muted/40">·</span>
          <span className="text-xs text-muted/60 font-mono">{formatDate(article.cached_at)}</span>
        </div>
      </div>

      {/* Summary */}
      {article.summary && (
        <p className="text-sm text-muted leading-relaxed border-l-2 border-border pl-3">
          {article.summary}
        </p>
      )}

      {/* Key points */}
      {article.key_points && article.key_points.length > 0 && (
        <div className="space-y-1">
          {article.key_points.map((kp, i) => (
            <p key={i} className="text-xs text-muted flex items-start gap-1.5">
              <span className="text-muted/50 shrink-0 mt-0.5">→</span>
              {kp}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CacheView() {
  const [coins, setCoins] = useState<CacheCoin[]>([])
  const [total, setTotal] = useState(0)
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null)
  const [articles, setArticles] = useState<CachedArticle[]>([])
  const [ttlHours, setTtlHours] = useState(13)
  const [loadingCoins, setLoadingCoins] = useState(true)
  const [loadingArticles, setLoadingArticles] = useState(false)
  const [clearingUrl, setClearingUrl] = useState<string | null>(null)
  const [clearingCoin, setClearingCoin] = useState(false)
  const [clearingAll, setClearingAll] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => { if (typeof s.cache_ttl_hours === 'number') setTtlHours(s.cache_ttl_hours) })
      .catch(() => {})
  }, [])

  const loadCoins = useCallback(async () => {
    setLoadingCoins(true)
    try {
      const res = await fetch('/api/cache')
      const json = await res.json()
      setCoins(json.coins ?? [])
      setTotal(json.total ?? 0)
    } finally {
      setLoadingCoins(false)
    }
  }, [])

  const loadArticles = useCallback(async (coin: string) => {
    setLoadingArticles(true)
    try {
      const res = await fetch(`/api/cache/${encodeURIComponent(coin)}`)
      const json = await res.json()
      setArticles(Array.isArray(json) ? json : [])
    } finally {
      setLoadingArticles(false)
    }
  }, [])

  useEffect(() => { loadCoins() }, [loadCoins])

  useEffect(() => {
    if (selectedCoin) loadArticles(selectedCoin)
    else setArticles([])
  }, [selectedCoin, loadArticles])

  const handleSelectCoin = useCallback((coin: string) => {
    setSelectedCoin(prev => prev === coin ? null : coin)
  }, [])

  const handleClearArticle = useCallback(async (url: string) => {
    setClearingUrl(url)
    try {
      await fetch('/api/cache/article', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      setArticles(prev => prev.filter(a => a.url !== url))
      setCoins(prev => prev.map(c =>
        c.coin === selectedCoin ? { ...c, count: Math.max(0, c.count - 1) } : c
      ).filter(c => c.count > 0))
      setTotal(prev => Math.max(0, prev - 1))
    } finally {
      setClearingUrl(null)
    }
  }, [selectedCoin])

  const handleClearCoin = useCallback(async () => {
    if (!selectedCoin) return
    setClearingCoin(true)
    try {
      await fetch(`/api/cache/coin/${encodeURIComponent(selectedCoin)}`, { method: 'DELETE' })
      const removed = coins.find(c => c.coin === selectedCoin)?.count ?? 0
      setTotal(prev => Math.max(0, prev - removed))
      setCoins(prev => prev.filter(c => c.coin !== selectedCoin))
      setArticles([])
      setSelectedCoin(null)
    } finally {
      setClearingCoin(false)
    }
  }, [selectedCoin, coins])

  const handleClearAll = useCallback(async () => {
    setClearingAll(true)
    try {
      await fetch('/api/cache', { method: 'DELETE' })
      setCoins([])
      setArticles([])
      setTotal(0)
      setSelectedCoin(null)
    } finally {
      setClearingAll(false)
    }
  }, [])

  return (
    <div className="flex gap-4 h-[calc(100vh-9rem)] animate-fade-in">

      {/* Left — coin list */}
      <div className="w-52 shrink-0 bg-surface-card border border-border rounded-2xl flex flex-col overflow-hidden neon-border">
        <div className="px-4 py-3 border-b border-border shrink-0 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider">Coins</p>
            <span className="text-xs text-muted">{total} articles</span>
          </div>
          <button
            onClick={handleClearAll}
            disabled={clearingAll || total === 0}
            className={cn(
              'w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              clearingAll || total === 0
                ? 'text-muted bg-surface-elevated cursor-not-allowed'
                : 'text-sell bg-sell/10 hover:bg-sell/20',
            )}
          >
            <TrashIcon />
            Clear all cache
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {loadingCoins && (
            <div className="flex items-center justify-center h-16">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {!loadingCoins && coins.length === 0 && (
            <p className="text-xs text-muted text-center px-3 py-6">No cached articles yet.</p>
          )}
          {coins.map(c => {
            const isActive = selectedCoin === c.coin
            return (
              <div
                key={c.coin}
                className={cn(
                  'group flex items-center gap-1 px-2 py-2 rounded-xl transition-colors duration-100 cursor-pointer',
                  isActive ? 'bg-accent/10' : 'hover:bg-surface-elevated',
                )}
                onClick={() => handleSelectCoin(c.coin)}
              >
                <span className={cn(
                  'flex-1 text-sm font-medium truncate',
                  isActive ? 'text-accent' : 'text-muted group-hover:text-foreground',
                )}>
                  {c.coin.replace('/USDC', '')}
                </span>
                <span className="text-xs text-muted shrink-0">{c.count}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Right — article list */}
      <div className="flex-1 bg-surface-card border border-border rounded-2xl flex flex-col overflow-hidden neon-border">
        {/* Panel header */}
        <div className="px-5 py-3 border-b border-border shrink-0 flex items-center justify-between gap-3">
          {selectedCoin ? (
            <>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {selectedCoin.replace('/USDC', '')}
                </p>
                <p className="text-xs text-muted">{articles.length} cached article{articles.length !== 1 ? 's' : ''}</p>
              </div>
              <button
                onClick={handleClearCoin}
                disabled={clearingCoin || articles.length === 0}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  clearingCoin || articles.length === 0
                    ? 'text-muted bg-surface-elevated cursor-not-allowed'
                    : 'text-sell bg-sell/10 hover:bg-sell/20',
                )}
              >
                <TrashIcon />
                Clear coin
              </button>
            </>
          ) : (
            <p className="text-sm text-muted">Select a coin to view cached articles</p>
          )}
        </div>

        {/* Article list */}
        <div className="flex-1 overflow-y-auto p-4">
          {!selectedCoin && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <svg className="w-10 h-10 text-muted/30 mb-3" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
              </svg>
              <p className="text-sm text-muted">Select a coin from the left to browse its cached articles</p>
            </div>
          )}

          {selectedCoin && loadingArticles && (
            <div className="flex items-center justify-center h-24">
              <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {selectedCoin && !loadingArticles && articles.length === 0 && (
            <div className="flex items-center justify-center h-24">
              <p className="text-sm text-muted">No cached articles for this coin.</p>
            </div>
          )}

          {selectedCoin && !loadingArticles && articles.length > 0 && (
            <div className="space-y-3">
              {articles.map(article => (
                <ArticleCard
                  key={article.url}
                  article={article}
                  ttlHours={ttlHours}
                  onClear={handleClearArticle}
                  clearing={clearingUrl === article.url}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
