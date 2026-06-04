# Full Article Content for LLM Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open top 3 search result URLs, extract ~5000 chars of visible text each, and include it in the LLM prompt alongside headlines.

**Architecture:** Add a `fetchPageText()` Puppeteer utility to scrape article bodies, wire it into `researchCoin()` via `Promise.allSettled`, pass results through `ResearchResult.articles` to `buildAnalysisPrompt()`.

**Tech Stack:** Puppeteer (existing), Node.js TypeScript, sql.js, OpenAI-compatible LLM client

---

### Task 1: Create `fetchPageText.js` scraper utility

**Files:**
- Create: `backend/src/scraper/utils/fetchPageText.js`

- [ ] **Create `fetchPageText.js`**

```js
import { createPage } from '../browser.js'

const MAX_CHARS = 5000

export async function fetchPageText(url) {
  const page = await createPage()
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 })
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true)
      const script = document.querySelector('script')
      const style = document.querySelector('style')
      if (script) script.remove()
      if (style) style.remove()
      return clone.textContent
        .replace(/\s+/g, ' ')
        .trim()
    })
    return text.slice(0, MAX_CHARS)
  } finally {
    await page.close()
  }
}
```

Note: The `script`/`style` removal via `querySelector` only removes the first match. Let's fix this to remove all:

```js
import { createPage } from '../browser.js'

const MAX_CHARS = 5000

export async function fetchPageText(url) {
  const page = await createPage()
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 })
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true)
      clone.querySelectorAll('script, style, noscript, nav, footer, header')
        .forEach(el => el.remove())
      return clone.textContent
        .replace(/\s+/g, ' ')
        .trim()
    })
    return text.slice(0, MAX_CHARS)
  } finally {
    await page.close()
  }
}
```

---

### Task 2: Update `ResearchResult` type and `researchCoin()` to fetch articles

**Files:**
- Modify: `backend/src/researcher/service.ts`
- Modify: `backend/src/researcher/index.ts`

- [ ] **Update `ResearchResult` interface in `researcher/service.ts`**

```ts
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
```

- [ ] **Update `researchCoin()` to fetch top 3 article bodies**

Import `fetchPageText` at the top:
```ts
import { fetchPageText } from '../scraper/utils/fetchPageText.js'
```

Replace the function body:

```ts
export async function researchCoin(coin: string): Promise<ResearchResult> {
  const symbol = coin.replace('/USDT', '')

  try {
    const { search } = await import('../scraper/search.js')
    const results = await search(`${symbol} crypto 2026`, { count: 5 })

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
      error: (err as Error).message,
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
```

- [ ] **Update `researcher/index.ts` to export new type**

```ts
export { researchCoin } from './service.js'
export type { ResearchResult, ArticleContent } from './service.js'
```

---

### Task 3: Update `buildAnalysisPrompt()` to include article content

**Files:**
- Modify: `backend/src/analyst/prompts.ts`

- [ ] **Update `buildAnalysisPrompt()` user prompt to include articles**

```ts
import { ResearchResult, ArticleContent } from '../researcher/index.js'

export function buildAnalysisPrompt(
  coin: string,
  price: number,
  change24h: number,
  volume: number,
  research: ResearchResult,
  portfolioPercent: number,
): { system: string; user: string } {
  const system = `You are a conservative crypto portfolio manager. Analyze the given data and respond with ONLY a JSON object.
Rules:
- Only recommend BUY if confidence > 0.6
- Only recommend SELL if the coin has negative news AND is over 5% of portfolio
- Prefer HOLD over uncertain trades
- quantity should be in the base coin (e.g. BTC, ETH, SOL)
- Keep position sizes reasonable (max 100 USDT worth)`

  let articlesText = ''
  if (research.articles.length > 0) {
    articlesText = '\n\nFull Article Content:\n'
    for (const a of research.articles) {
      articlesText += `\n--- ${a.title} ---\n${a.content}\n`
    }
  }

  const user = `Coin: ${coin}
Price: $${price}
24h Change: ${change24h}%
Volume: $${volume}
Portfolio Allocation: ${portfolioPercent.toFixed(1)}%
News: ${research.summary}${articlesText}

Respond with JSON only:
{ "action": "BUY"|"SELL"|"HOLD", "coin": "${coin}", "quantity": number, "reason": "string", "confidence": 0.0-1.0 }`

  return { system, user }
}
```

---

### Verification

- [ ] **TypeScript compile check**

Run: `npx tsc --noEmit` from `backend/` directory. Expected: no errors.

- [ ] **Manual integration test**

The trading loop already wires `researchCoin` → `analyzeSignal`. Start the bot and observe logs for article count and LLM outputs including article content.
