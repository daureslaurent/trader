# LLM Webpage Data Extraction Module

## Problem

The researcher fetches full article text via Puppeteer and passes raw text directly to the analyst. The analyst LLM receives ~15000 chars of raw, unstructured article text alongside price data and must extract relevant signal from it in a single pass. This has several issues:

1. **No relevance filtering** — low-quality or irrelevant articles waste tokens in the analyst prompt
2. **No structured extraction** — the LLM must do both extraction and trading decision in one call, making it harder to verify extraction quality independently
3. **Token inefficiency** — raw article text consumes most of the 28000 `max_tokens` budget
4. **No per-article signal** — there's no way to see what each article contributed to the final decision

## Goal

Add a dedicated `extractor` module between `researcher` and `analyst` that uses an LLM to:
1. Score each article for relevance to the coin
2. Extract structured data: sentiment, key points, metrics (price targets, market cap, supply, volume trends)
3. Generate concise per-article summaries
4. Generate a preliminary per-article signal
5. Filter out low-relevance articles before the analyst sees them

## Architecture

```
researcher.researchCoin(symbol)
       │
       ▼  ResearchResult { articles[], headlines, summary }
       │
extractor.extractResearch(result)
       │
       ▼  ExtractedResearch { articles[], aggregated_sentiment, top_headlines }
       │
analyst.analyzeSignal(coin, price, ..., extracted, portfolioPercent)
       │
       ▼  Signal { action, quantity, reason, confidence }
```

The extractor is a new module at `backend/src/extractor/` that sits between the existing researcher and analyst modules.

## New Module: `backend/src/extractor/`

### File Structure

```
backend/src/extractor/
  index.ts       — exports extractResearch() + types
  service.ts     — implementation
  prompts.ts     — system + user prompt builders
  types.ts       — ExtractedArticle, ExtractedResearch
```

### Types (`types.ts`)

```typescript
interface ExtractedArticle {
  title: string
  url: string
  relevance_score: number         // 0.0-1.0, articles < 0.3 are filtered out
  sentiment: 'positive' | 'negative' | 'neutral'
  summary: string                 // 2-3 sentence concise summary
  key_points: string[]            // 3-5 bullet points
  metrics?: {
    price_target?: { min: number | null; max: number | null }
    market_cap?: number | null
    circulating_supply?: number | null
    volume_trend?: 'increasing' | 'decreasing' | 'stable' | null
  }
  preliminary_signal?: 'BUY' | 'SELL' | 'HOLD'
}

interface ExtractedResearch {
  coin: string
  articles: ExtractedArticle[]        // filtered: relevance_score >= 0.3
  aggregated_sentiment: 'positive' | 'negative' | 'neutral'
  top_headlines: string[]
}
```

### Service (`service.ts`)

```typescript
export async function extractResearch(
  result: ResearchResult
): Promise<ExtractedResearch>
```

Implementation:
1. If `result.articles` is empty, return a default `ExtractedResearch` with empty articles array
2. Build a prompt with all articles and ask the LLM to extract structured data from each
3. Call the LLM (OpenAI-compatible client, same `config.llama.baseURL`)
4. Parse the JSON response into `ExtractedArticle[]`
5. Filter out articles with `relevance_score < 0.3`
6. Compute `aggregated_sentiment` from majority vote of per-article sentiments
7. Return the structured result

### Prompts (`prompts.ts`)

**System prompt:**
> "You are a crypto research analyst. Your task is to extract structured data from cryptocurrency news articles. Analyze each article and return a JSON array of objects. Be conservative — if data is not clearly present in the article, use null. Only flag a preliminary BUY signal if the news is directly positive about the coin's fundamentals."

**User prompt structure:**
- Coin name being analyzed
- For each article: title, URL, full text
- Expected JSON format with examples

**Temperature:** 0.2 (low, for consistent structured output)

### LLM Integration

Reuses the same OpenAI-compatible client from `config.llama.baseURL`:

```typescript
const client = new OpenAI({
  baseURL: config.llama.baseURL,
  apiKey: 'ollama',
})
```

Processes all articles in a single LLM call. With 3 articles at ~5000 chars each + instructions, total input is ~18000 chars — well within 8K+ token context windows.

## Changes to Existing Modules

### 1. Update `backend/src/index.ts` (trading loop)

```typescript
// Before:
const research = await researchCoin(symbol)
const signal = await analyzeSignal(coin, price, change24h, volume, research, portfolioPercent)

// After:
const research = await researchCoin(symbol)
const extracted = await extractResearch(research)
const signal = await analyzeSignal(coin, price, change24h, volume, extracted, portfolioPercent)
```

### 2. Update `backend/src/analyst/service.ts`

Change the `research` parameter type from `ResearchResult` to `ExtractedResearch`:

```typescript
export async function analyzeSignal(
  coin: string,
  price: number,
  change24h: number,
  volume: number,
  research: ExtractedResearch,    // was ResearchResult
  portfolioPercent: number,
): Promise<Signal>
```

### 3. Update `backend/src/analyst/prompts.ts`

The analyst prompt is restructured to use `ExtractedResearch` instead of `ResearchResult`:

| Old field | New replacement |
|-----------|----------------|
| `research.headlines` | `extracted.top_headlines` |
| `research.summary` | Per-article `summary` + `key_points` from each `ExtractedArticle` |
| `research.articles[].content` (raw, ~5000 chars) | Each `ExtractedArticle`'s `summary`, `key_points`, `sentiment`, `metrics`, `preliminary_signal` |
| `research.sentiment` (always 'neutral') | `extracted.aggregated_sentiment` (computed from per-article sentiments) |

The new prompt format:
- "Top headlines: ..."
- For each article: title, summary, key points (as bullet list), sentiment, metrics (price target, market cap, supply), preliminary signal
- Structured data: ~200-300 chars per article instead of ~5000 chars raw text
- Removes the need for the old `"Articles:"` section with raw body text

This reduces the analyst prompt login size by ~90% from the article section.

### 4. Update imports in affected files

- `backend/src/index.ts` imports `extractResearch` from `../extractor/index.js`
- `backend/src/analyst/service.ts` imports `ExtractedResearch` from `../extractor/index.js`

## Error Handling

- **No articles to extract:** Return `ExtractedResearch` with empty `articles`, `aggregated_sentiment: 'neutral'`, `top_headlines` from the original research
- **LLM call fails (timeout/network):** Catch error, return safe default as above
- **LLM returns unparseable JSON:** Attempt to extract JSON from markdown code fences, fall back to default on failure
- **LLM returns partial data (missing fields):** Accept what's present, fill missing fields with null/neutral defaults using `??` coalescing
- **All articles filtered out (relevance < 0.3):** Return empty articles array, analyst receives no article data and can make a price-only decision

## No New Dependencies

Reuses existing OpenAI client library and configuration. No npm packages to install.

## Future Considerations

- Could use a cheaper/faster LLM model for extraction vs a heavier model for trading decisions — configurable via `config`
- Could cache extraction results per-article-URL with a TTL to avoid re-extracting the same article in consecutive trading cycles
- Could add relevance score threshold to config settings
