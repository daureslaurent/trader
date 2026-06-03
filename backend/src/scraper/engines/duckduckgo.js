import { createPage } from '../browser.js';
import { sanitizeResult } from './base.js';

export async function search(query, count = 10) {
  const page = await createPage();

  try {
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    await page.waitForSelector('article[data-testid="result"]', { timeout: 10000 });

    const results = await page.evaluate((maxCount) => {
      const items = [];
      const articles = document.querySelectorAll('article[data-testid="result"]');

      for (const article of articles) {
        if (items.length >= maxCount) break;

        const titleEl = article.querySelector('a[data-testid="result-title-a"]');
        if (!titleEl) continue;

        const children = article.querySelectorAll(':scope > div');
        let description = '';
        for (let i = 2; i < children.length; i++) {
          const text = children[i].textContent.trim();
          if (text.includes(titleEl.textContent)) continue;
          if (text.length > 20) {
            description = text;
            break;
          }
        }

        items.push({
          title: titleEl.textContent,
          url: titleEl.href,
          description
        });
      }
      return items;
    }, count);

    return results.map(sanitizeResult);
  } finally {
    await page.close();
  }
}
