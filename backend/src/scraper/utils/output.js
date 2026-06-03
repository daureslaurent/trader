export function formatTable(results) {
  return results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`
  ).join('\n\n');
}

export function formatJSON(results) {
  return JSON.stringify(results, null, 2);
}
