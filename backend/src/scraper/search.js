import { search as duckduckgoSearch } from './engines/duckduckgo.js';

export async function search(query, options = {}) {
  const { count = 10, dateFilter = '' } = options;

  const results = await duckduckgoSearch(query, count, dateFilter);
  return results.slice(0, count);
}
