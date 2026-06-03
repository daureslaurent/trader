import { search as duckduckgoSearch } from './engines/duckduckgo.js';

export async function search(query, options = {}) {
  const { count = 10 } = options;

  const results = await duckduckgoSearch(query, count);
  return results.slice(0, count);
}
