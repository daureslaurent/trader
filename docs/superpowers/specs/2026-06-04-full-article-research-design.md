# Full Article Content for LLM Analysis

## Problem
The researcher currently fetches only headlines from DuckDuckGo search results and sends them to the LLM as a flat string. The LLM never sees article body content, limiting its ability to make informed trading decisions.

## Goal
Open the top 3 search result URLs, extract visible text content (~5000 chars each), and include it in the LLM analysis prompt.

## Changes

### 1. New Utility: `scraper/utils/fetchPageText.js`
- Takes a URL, opens it via existing Puppeteer `createPage()`
- Waits for `networkidle2`, timeout 15s
- Extracts visible text from `<body>` (strips `<script>`, `<style>` tags)
- Truncates to ~5000 characters
- Returns `{ title, url, content }` or `null` on failure

### 2. Update `ResearchResult` type (`researcher/service.ts`)
Add `articles` field:
```ts
interface ArticleContent {
  title: string
  url: string
  content: string
}

interface ResearchResult {
  coin: string
  headlines: string[]
  articles: ArticleContent[]
  sentiment: 'positive' | 'negative' | 'neutral'
  summary: string
}
```

### 3. Update `researchCoin()` (`researcher/service.ts`)
- After getting search results, call `Promise.allSettled()` on top 3 URLs via `fetchPageText()`
- Build a richer `summary` that includes both headlines and article excerpts
- Populate `articles` array with successful fetches

### 4. Update `buildAnalysisPrompt()` (`analyst/prompts.ts`)
- Include article content in the user prompt under a "Articles:" section
- Format: title, URL, and truncated content for each article

### Error Handling
- Per-URL failures are isolated (Promise.allSettled)
- If all 3 fetches fail, fall back to headline-only summary (current behavior)
- Each fetch has a 15s timeout to prevent blocking the trading loop

## No New Dependencies
All changes use existing Puppeteer infrastructure.
