export function sanitizeResult(raw) {
  return {
    title: (raw.title || '').trim(),
    url: (raw.url || '').trim(),
    description: (raw.description || '').trim()
  };
}
