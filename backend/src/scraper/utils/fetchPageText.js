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
