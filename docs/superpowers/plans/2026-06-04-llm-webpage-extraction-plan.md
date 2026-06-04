# LLM Webpage Data Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a new `extractor` module between researcher and analyst that uses an LLM to extract structured data (relevance, sentiment, key points, metrics) from each article before passing it to the trading signal analysis.

**Architecture:** New `backend/src/extractor/` module with types, prompts, and service. The trading loop calls `extractResearch()` between `researchCoin()` and `analyzeSignal()`. The analyst receives `ExtractedResearch` instead of `ResearchResult` and uses structured per-article data instead of raw text.

**Tech Stack:** Node.js TypeScript, OpenAI-compatible LLM client (existing), existing config

---

### Task 1: Create extractor types

**Files:**
- Create: `backend/src/extractor/types.ts`

- [ ] **Create `backend/src/extractor/types.ts`**

```typescript
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
}

export interface ExtractedResearch {
  coin: string
  articles: ExtractedArticle[]
  aggregated_sentiment: 'positive' | 'negative' | 'neutral'
  top_headlines: string[]
}
```

---

### Task 2: Create extractor prompts

**Files:**
- Create: `backend/src/extractor/prompts.ts`

- [ ] **Create `backend/src/extractor/prompts.ts`**

```typescript
import { ArticleContent } from '../researcher/index.js'

export function buildExtractionPrompt(
  coin: string,
  articles: ArticleContent[],
): { system: string; user: string } {
  const system = `You are a crypto research analyst. Extract structured data from cryptocurrency news articles.

For each article, analyze the content and return a JSON array of objects with these fields:
- title: the article title
- url: the article URL
- relevance_score: 0.0-1.0 how relevant this article is to the coin's price/market outlook
- sentiment: "positive", "negative", or "neutral" — the article's overall tone toward the coin
- summary: 2-3 sentence concise summary of key information
- key_points: array of 3-5 specific bullet points with concrete facts/claims
- metrics: object with fields (use null when not mentioned):
  - price_target: { min: number | null, max: number | null } or null
  - market_cap: number or null
  - circulating_supply: number or null
  - volume_trend: "increasing" | "decreasing" | "stable" | null
- preliminary_signal: "BUY", "SELL", or "HOLD" — based solely on this article's content

Be conservative:
- If data is not clearly present in the article, use null
- Only flag BUY if the news is directly positive about the coin's fundamentals
- Only flag SELL if the news contains concrete negative developments
- Default to HOLD for neutral or mixed articles`

  let articlesText = ''
  for (const a of articles) {
    articlesText += `\n\n### ${a.title}\nURL: ${a.url}\nContent:\n${a.content}\n`
  }

  const user = `Coin: ${coin}\n\nArticles:${articlesText}\n\nReturn a JSON array of extracted articles. Example format:
[
  {
    "title": "Article title",
    "url": "https://...",
    "relevance_score": 0.85,
    "sentiment": "positive",
    "summary": "2-3 sentence summary",
    "key_points": ["Point 1", "Point 2", "Point 3"],
    "metrics": {
      "price_target": { "min": 50000, "max": 80000 },
      "market_cap": 1000000000,
      "circulating_supply": 19000000,
      "volume_trend": "increasing"
    },
    "preliminary_signal": "BUY"
  }
]`

  return { system, user }
}
```

---

### Task 3: Create extractor service

**Files:**
- Create: `backend/src/extractor/service.ts`

- [ ] **Create `backend/src/extractor/service.ts`**

```typescript
import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { ResearchResult } from '../researcher/index.js'
import { buildExtractionPrompt } from './prompts.js'
import { ExtractedResearch, ExtractedArticle } from './types.js'

const client = new OpenAI({
  baseURL: config.llama.baseURL,
  apiKey: 'ollama',
})

function computeAggregatedSentiment(
  articles: ExtractedArticle[],
): 'positive' | 'negative' | 'neutral' {
  if (articles.length === 0) return 'neutral'
  const counts = { positive: 0, negative: 0, neutral: 0 }
  for (const a of articles) {
    counts[a.sentiment]++
  }
  if (counts.positive > counts.negative && counts.positive > counts.neutral) return 'positive'
  if (counts.negative > counts.positive && counts.negative > counts.neutral) return 'negative'
  return 'neutral'
}

export async function extractResearch(
  result: ResearchResult,
): Promise<ExtractedResearch> {
  if (result.articles.length === 0) {
    logger.debug('No articles to extract', { coin: result.coin })
    return {
      coin: result.coin,
      articles: [],
      aggregated_sentiment: 'neutral',
      top_headlines: result.headlines,
    }
  }

  logger.debug('Extracting article data', {
    coin: result.coin,
    articleCount: result.articles.length,
  })

  try {
    const { system, user } = buildExtractionPrompt(result.coin, result.articles)

    const resp = await client.chat.completions.create({
      model: config.llama.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    })

    const content = resp.choices[0]?.message?.content || ''
    if (!content.trim()) {
      logger.warn('LLM returned empty extraction', { coin: result.coin })
      return {
        coin: result.coin,
        articles: [],
        aggregated_sentiment: 'neutral',
        top_headlines: result.headlines,
      }
    }

    const cleaned = content
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```\s*$/g, '')
      .trim()

    const parsed = JSON.parse(cleaned) as ExtractedArticle[]

    const articles = Array.isArray(parsed) ? parsed : []
    const filtered = articles.filter(a => a.relevance_score >= 0.3)

    logger.debug('Extraction results', {
      coin: result.coin,
      totalExtracted: articles.length,
      afterFilter: filtered.length,
    })

    return {
      coin: result.coin,
      articles: filtered,
      aggregated_sentiment: computeAggregatedSentiment(filtered),
      top_headlines: result.headlines,
    }
  } catch (err) {
    logger.error('Article extraction failed', {
      coin: result.coin,
      error: (err as Error).message,
    })
    return {
      coin: result.coin,
      articles: [],
      aggregated_sentiment: 'neutral',
      top_headlines: result.headlines,
    }
  }
}
```

---

### Task 4: Create extractor barrel export

**Files:**
- Create: `backend/src/extractor/index.ts`

- [ ] **Create `backend/src/extractor/index.ts`**

```typescript
export { extractResearch } from './service.js'
export type { ExtractedResearch, ExtractedArticle } from './types.js'
```

---

### Task 5: Update analyst to use `ExtractedResearch`

**Files:**
- Modify: `backend/src/analyst/service.ts`
- Modify: `backend/src/analyst/prompts.ts`

- [ ] **Update `backend/src/analyst/service.ts`** — change import from `ResearchResult` to `ExtractedResearch`

```typescript
import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { Signal } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { buildAnalysisPrompt } from './prompts.js'
import { LLMError } from '../core/errors.js'

const client = new OpenAI({
  baseURL: config.llama.baseURL,
  apiKey: 'ollama',
})

export async function analyzeSignal(
  coin: string,
  price: number,
  change24h: number,
  volume: number,
  research: ExtractedResearch,
  portfolioPercent: number,
): Promise<Signal> {
  const { system, user } = buildAnalysisPrompt(coin, price, change24h, volume, research, portfolioPercent)
  logger.info('LLM input', { coin, system, user })

  try {
    const resp = await client.chat.completions.create({
      model: config.llama.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 28000,
    })

    const content = resp.choices[0]?.message?.content || ''
    logger.info('LLM output', { coin, content, finish_reason: resp.choices[0]?.finish_reason })
    if (!content.trim()) {
      const finish = resp.choices[0]?.finish_reason
      logger.warn('LLM empty response', { coin, finish_reason: finish })
      return { coin, action: 'HOLD', quantity: 0, reason: `LLM returned empty (${finish})`, confidence: 0 }
    }

    const cleaned = content
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```\s*$/g, '')
      .trim()

    const parsed = JSON.parse(cleaned) as Signal
    if (!parsed.action || !['BUY', 'SELL', 'HOLD'].includes(parsed.action)) {
      throw new LLMError(`Invalid action: ${parsed.action}, raw: ${content.substring(0, 200)}`)
    }
    logger.info('Signal from LLM', { coin, action: parsed.action, confidence: parsed.confidence })
    return parsed
  } catch (err) {
    logger.error('LLM analysis failed', { coin, error: (err as Error).message })
    return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0 }
  }
}
```

- [ ] **Update `backend/src/analyst/prompts.ts`** — use `ExtractedResearch` instead of `ResearchResult`

```typescript
import { ExtractedResearch, ExtractedArticle } from '../extractor/index.js'

export function buildAnalysisPrompt(
  coin: string,
  price: number,
  change24h: number,
  volume: number,
  research: ExtractedResearch,
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
    articlesText = '\n\nExtracted Article Data:\n'
    for (const a of research.articles) {
      articlesText += `\n--- ${a.title} ---`
      articlesText += `\nRelevance: ${a.relevance_score}`
      articlesText += `\nSentiment: ${a.sentiment}`
      articlesText += `\nSummary: ${a.summary}`
      articlesText += `\nKey Points:\n${a.key_points.map(k => `  - ${k}`).join('\n')}`
      if (a.metrics) {
        articlesText += `\nMetrics: ${JSON.stringify(a.metrics)}`
      }
      if (a.preliminary_signal) {
        articlesText += `\nPreliminary Signal: ${a.preliminary_signal}`
      }
      articlesText += '\n'
    }
  }

  const user = `Coin: ${coin}
Price: $${price}
24h Change: ${change24h}%
Volume: $${volume}
Portfolio Allocation: ${portfolioPercent.toFixed(1)}%
Aggregated Sentiment: ${research.aggregated_sentiment}
Top Headlines: ${research.top_headlines.join('. ')}${articlesText}

Respond with JSON only:
{ "action": "BUY"|"SELL"|"HOLD", "coin": "${coin}", "quantity": number, "reason": "string", "confidence": 0.0-1.0 }`

  return { system, user }
}
```

---

### Task 6: Update trading loop to add extraction step

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Update `backend/src/index.ts`** — add import and extraction step

Add import at line 9:
```typescript
import { extractResearch } from './extractor/index.js'
```

Add extraction step between research and analysis (around line 31):
```typescript
const research = await researchCoin(data.symbol)
const extracted = await extractResearch(research)     // NEW
const portfolioPercent = ...

const signal = await analyzeSignal(
  data.symbol,
  data.price,
  data.change24h,
  data.volume,
  extracted,            // was: research
  portfolioPercent,
)
```

Also update the decision context on line 47 to reference `extracted` instead of `research`:
```typescript
runSQL(
  'INSERT INTO decisions (coin, action, reason, confidence, context) VALUES (?, ?, ?, ?, ?)',
  [data.symbol, signal.action, signal.reason, signal.confidence, JSON.stringify({ price: data.price, research: extracted })]
)
```

The full updated function body around the loop should look like this:
```typescript
  for (const data of marketData) {
    try {
      const research = await researchCoin(data.symbol)
      const extracted = await extractResearch(research)
      const portfolioPercent = balance[data.symbol.replace('/USDT', '')]
        ? ((balance[data.symbol.replace('/USDT', '')].total * data.price) / (Object.values(balance).reduce((s, b) => s + b.total * data.price, 0.01))) * 100
        : 0

      const signal = await analyzeSignal(
        data.symbol,
        data.price,
        data.change24h,
        data.volume,
        extracted,
        portfolioPercent,
      )

      runSQL(
        'INSERT INTO decisions (coin, action, reason, confidence, context) VALUES (?, ?, ?, ?, ?)',
        [data.symbol, signal.action, signal.reason, signal.confidence, JSON.stringify({ price: data.price, research: extracted })]
      )

      if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
        logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
        continue
      }

      await handleTradeSignal(signal, data.price)
    } catch (err) {
      logger.error('Error in trading loop', { coin: data.symbol, error: (err as Error).message })
    }
  }
```

---

### Verification

- [ ] **TypeScript compile check**

Run: `npx tsc --noEmit` from `backend/` directory. Expected: no errors.

- [ ] **Smoke test with --stub mode**

Run: `npx tsx src/index.ts --stub --approval` from `backend/` directory. Expected: bot starts, trading loop runs, logs show extraction happening between research and analysis.
